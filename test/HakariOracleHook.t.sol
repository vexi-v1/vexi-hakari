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

    /// A push that lands just before a quiet window is what the window reads. `Oracle.write` credits the tick that
    /// stood since the previous observation to the whole span, so a window with no swap inside it is priced by the
    /// last swap before it opened: read while the window is still open (the record is extrapolated with the live
    /// tick) or after a later swap has written the span into storage. Found while reviewing a window rule the night
    /// before submission (FEEDBACK.md § 12).
    function test_observe_aPushBeforeAQuietWindow_isWhatTheWindowReads() public {
        // an honest price stands for most of the hour
        vm.warp(t0 + 1);
        swapToPrice(key, false, TickMath.getSqrtPriceAtTick(200));
        int24 honest = currentTick(id);
        uint256 expiry = t0 + 3600;
        // one second before the window [expiry - 300, expiry] opens, a push; then nobody swaps until after expiry
        vm.warp(expiry - 301);
        swapToPrice(key, false, TickMath.getSqrtPriceAtTick(honest + 500));
        int24 pushed = currentTick(id);
        assertGt(pushed, honest + 400, "the push moved the live price");
        // read at expiry: no observation inside the window; the record is extrapolated with the live, pushed tick
        vm.warp(expiry);
        assertApproxEqAbs(_avgTick(300, 0), pushed, 1, "read while open: the window is the pushed tick");
        // a swap after the window writes one observation crediting the pushed tick to (expiry - 301, expiry + 1]
        vm.warp(expiry + 1);
        poke(key);
        (uint16 index,,) = hook.stateById(id);
        (uint32 ts,, int56 cumAfter,,) = hook.observationsById(id, index);
        (uint32 tsBefore,, int56 cumBefore,,) = hook.observationsById(id, index - 1);
        assertEq(ts, uint32(expiry + 1), "the swap after the window wrote the newest observation");
        assertEq(tsBefore, uint32(expiry - 301), "the push wrote the one before it");
        assertEq(cumAfter - cumBefore, int56(pushed) * 302, "302 seconds of the pushed tick, in one observation");
        // read from storage: the window still reads the pushed tick, never the honest one
        assertApproxEqAbs(_avgTick(301, 1), pushed, 1, "read after a later swap: the same");
        assertGt(_avgTick(301, 1), honest + 400, "the honest price that stood for 55 minutes is not in the window");
    }

    /// Raw TWAP tick over [now - from, now - to].
    function _avgTick(uint32 from, uint32 to) internal view returns (int24) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = from;
        secondsAgos[1] = to;
        (int56[] memory raw,) = hook.observe(secondsAgos, id);
        return int24((raw[1] - raw[0]) / int56(uint56(from - to)));
    }
}
