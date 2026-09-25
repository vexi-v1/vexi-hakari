// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {HakariDeployers} from "./utils/HakariDeployers.sol";
import {HakariOracleHook} from "../src/HakariOracleHook.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

contract HakariOracleHookTest is HakariDeployers {
    using PoolIdLibrary for PoolKey;

    int24 constant DELTA = 100;
    HakariOracleHook hook;
    PoolId id;
    uint256 t0;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        hook = deployHook(DELTA, 0x4444);
        (key, id) = initPool(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
        addLiquidity(key, -6000, 6000, 1e18);
        hook.increaseObservationCardinalityNext(64, id);
        t0 = block.timestamp;
    }

    function test_twaps_pushUndoneWithinTheSameSecond_isNeverRecorded() public {
        int24 before = currentTick(id);
        // push ~500 ticks down and straight back, both at t0
        swapToPrice(key, true, TickMath.getSqrtPriceAtTick(before - 500));
        assertLt(currentTick(id), before - 400, "push did move the live price");
        swapToPrice(key, false, SQRT_PRICE_1_1);
        // the next second's first swap writes the observation the oracle will see
        vm.warp(t0 + 10);
        poke(key);
        (int24 raw, int24 trunc) = hook.twaps(id, 10);
        assertEq(raw, trunc, "both series agree");
        assertApproxEqAbs(raw, before, 1, "neither series saw the push");
    }

    function test_twaps_sustainedPush_rawFollowsAndTruncatedIsClippedToDelta() public {
        int24 before = currentTick(id);
        swapToPrice(key, false, TickMath.getSqrtPriceAtTick(before + 500));
        int24 pushed = currentTick(id);
        assertGt(pushed, before + 400, "push did move the live price");
        vm.warp(t0 + 1);
        poke(key); // records the pushed tick: raw as is, truncated clipped to DELTA
        vm.warp(t0 + 11);
        (int24 raw, int24 trunc) = hook.twaps(id, 10);
        assertApproxEqAbs(raw, pushed, 1, "raw TWAP follows the pushed tick");
        // Two observations since the push: the poke, and the read itself (observe() transforms the
        // last stored observation to `now`, and that transform is clipped too). So 2 * DELTA, not 500.
        assertEq(trunc, before + 2 * DELTA, "truncated TWAP moved DELTA per observation");
    }

    function test_twaps_truncatedMovesDeltaPerObservation_notPerSecond() public {
        int24 before = currentTick(id);
        swapToPrice(key, false, TickMath.getSqrtPriceAtTick(before + 2000));
        // three pokes in three consecutive seconds, then a read 100 s later: 4 observations
        for (uint256 i = 1; i <= 3; i++) {
            vm.warp(t0 + i);
            poke(key);
        }
        vm.warp(t0 + 103);
        (, int24 trunc) = hook.twaps(id, 100);
        assertEq(trunc, before + 4 * DELTA, "four observations, four steps, whatever the clock says");
    }

    function test_twaps_zeroWindow_reverts() public {
        vm.expectRevert(HakariOracleHook.WindowZero.selector);
        hook.twaps(id, 0);
    }
}
