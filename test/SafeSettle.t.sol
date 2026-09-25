// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {HakariDeployers} from "./utils/HakariDeployers.sol";
import {HakariOracleHook} from "../src/HakariOracleHook.sol";
import {PushCostLens} from "../src/PushCostLens.sol";
import {SafeSettle} from "../src/SafeSettle.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

contract SafeSettleTest is HakariDeployers {
    using PoolIdLibrary for PoolKey;

    int24 constant DELTA = 100;
    uint32 constant WINDOW = 10;
    HakariOracleHook hook;
    PushCostLens lens;
    SafeSettle settle;
    PoolId id;
    uint256 t0;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        hook = deployHook(DELTA, 0x4444);
        lens = new PushCostLens(manager);
        settle = new SafeSettle(hook, lens);
        (key, id) = initPool(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
        hook.increaseObservationCardinalityNext(64, id);
        t0 = block.timestamp;
    }

    /// @dev Push the price up by `ticks` at t0, poke once a second for WINDOW seconds, stop at t0 + WINDOW + 1.
    function _sustainedPush(int24 ticks) internal {
        swapToPrice(key, false, TickMath.getSqrtPriceAtTick(currentTick(id) + ticks));
        for (uint256 s = 1; s <= WINDOW; s++) {
            vm.warp(t0 + s);
            poke(key);
        }
        vm.warp(t0 + WINDOW + 1);
    }

    function test_agreeingSeries_useRaw_withNothingToExplain() public {
        addLiquidity(key, -6000, 6000, 1e18);
        vm.warp(t0 + WINDOW + 1);
        poke(key);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, true);
        assertTrue(d.usedRaw);
        assertEq(d.tickUsed, d.rawTick);
        assertEq(d.costToFake, 0);
        assertEq(d.gainIfFaked, 0);
    }

    function test_thinPool_bigNotional_fakeIsCheap_useTruncated() public {
        addLiquidity(key, -6000, 6000, 1e15); // thin
        _sustainedPush(3000);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, false);
        assertGt(d.rawTick, d.truncTick + 1000, "the series disagree by a lot");
        assertLt(d.costToFake, d.gainIfFaked, "faking the raw TWAP earns more than it costs");
        assertFalse(d.usedRaw, "so the truncated price settles");
        assertEq(d.tickUsed, d.truncTick);
    }

    function test_deepPool_smallNotional_fakeIsExpensive_useRaw() public {
        addLiquidity(key, -6000, 6000, 1e21); // deep
        _sustainedPush(3000);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e12, false, false);
        assertGt(d.rawTick, d.truncTick + 1000, "the series disagree by a lot");
        assertGt(d.costToFake, d.gainIfFaked, "faking would cost more than it earns");
        assertTrue(d.usedRaw, "so this is a genuine move: settle on the raw price");
        assertEq(d.tickUsed, d.rawTick);
    }

    function test_arbOpen_chargesTheHoldingCost() public {
        addLiquidity(key, -6000, 6000, 1e18);
        _sustainedPush(3000);
        SafeSettle.Decision memory closed = settle.settlePrice(key, WINDOW, 1e18, false, false);
        SafeSettle.Decision memory open = settle.settlePrice(key, WINDOW, 1e18, false, true);
        assertGt(open.costToFake, closed.costToFake, "arbitrageurs make holding expensive");
        assertGe(open.costToFake, closed.costToFake * 2, "at least one extra push");
    }

    function test_costIsValuedInTheChosenQuote() public {
        addLiquidity(key, -6000, 6000, 1e18);
        _sustainedPush(3000);
        // pushing up pays currency1; valued in currency0 at the pool's *current* (pushed) price, which is
        // 1.0001^tick above 1:1 after the push
        SafeSettle.Decision memory q1 = settle.settlePrice(key, WINDOW, 1e18, false, false);
        SafeSettle.Decision memory q0 = settle.settlePrice(key, WINDOW, 1e18, true, false);
        uint160 sqrtNow = TickMath.getSqrtPriceAtTick(currentTick(id));
        uint256 expected0 = FullMath.mulDiv(FullMath.mulDiv(q1.costToFake, 2 ** 96, sqrtNow), 2 ** 96, sqrtNow);
        assertApproxEqRel(q0.costToFake, expected0, 0.01e18);
    }

    function test_settle_emitsTheReason() public {
        addLiquidity(key, -6000, 6000, 1e15);
        _sustainedPush(3000);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, false);
        vm.expectEmit(true, false, false, true);
        emit SafeSettle.Settled(id, d.rawTick, d.truncTick, d.usedRaw, d.costToFake, d.gainIfFaked);
        settle.settle(key, WINDOW, 1e18, false, false);
    }

    function test_wrongHook_reverts() public {
        PoolKey memory other = key;
        other.hooks = IHooks(address(0));
        vm.expectRevert(SafeSettle.WrongHook.selector);
        settle.settlePrice(other, WINDOW, 1e18, false, false);
    }
}
