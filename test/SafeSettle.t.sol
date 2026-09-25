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
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @dev Adds a liquidity wall inside an unlock and asks SafeSettle for a price before taking it back.
contract WallAttacker is IUnlockCallback {
    IPoolManager immutable manager;
    SafeSettle immutable settle;

    constructor(IPoolManager m, SafeSettle s) {
        manager = m;
        settle = s;
    }

    function attack(PoolKey calldata key, uint32 window) external {
        manager.unlock(abi.encode(key, window));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, uint32 window) = abi.decode(data, (PoolKey, uint32));
        manager.modifyLiquidity(key, ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 1e27, salt: 0}), "");
        settle.settlePrice(key, window, 1e18, false, 0);
        return "";
    }
}

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
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, 1);
        assertTrue(d.usedRaw);
        assertEq(d.tickUsed, d.rawTick);
        assertEq(d.costToFake, 0);
        assertEq(d.gainIfFaked, 0);
    }

    function test_thinPool_bigNotional_fakeIsCheap_useTruncated() public {
        addLiquidity(key, -6000, 6000, 1e15); // thin
        _sustainedPush(3000);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, 0);
        assertGt(d.rawTick, d.truncTick + 1000, "the series disagree by a lot");
        assertLt(d.costToFake, d.gainIfFaked, "faking the raw TWAP earns more than it costs");
        assertFalse(d.usedRaw, "so the truncated price settles");
        assertEq(d.tickUsed, d.truncTick);
    }

    function test_deepPool_smallNotional_fakeIsExpensive_useRaw() public {
        addLiquidity(key, -6000, 6000, 1e21); // deep
        _sustainedPush(3000);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e12, false, 0);
        assertGt(d.rawTick, d.truncTick + 1000, "the series disagree by a lot");
        assertGt(d.costToFake, d.gainIfFaked, "faking would cost more than it earns");
        assertTrue(d.usedRaw, "so this is a genuine move: settle on the raw price");
        assertEq(d.tickUsed, d.rawTick);
    }

    function test_arbitrageOpen_chargesOneRepushPerReversion() public {
        addLiquidity(key, -6000, 6000, 1e18);
        _sustainedPush(3000);
        SafeSettle.Decision memory closed = settle.settlePrice(key, WINDOW, 1e18, false, 0);
        SafeSettle.Decision memory every5s = settle.settlePrice(key, WINDOW, 1e18, false, 5);
        assertGt(every5s.costToFake, closed.costToFake, "arbitrageurs make holding cost something");
        // holding x for the whole 10 s window at one pull-back per 5 s is 1 push + 2 re-pushes; a wider, shorter
        // push can only be cheaper
        assertLe(every5s.costToFake, closed.costToFake * 3);
    }

    function test_slowerArbitrage_isCheaperToFake() public {
        addLiquidity(key, -6000, 6000, 1e18);
        _sustainedPush(3000);
        SafeSettle.Decision memory fast = settle.settlePrice(key, WINDOW, 1e18, false, 1);
        SafeSettle.Decision memory slow = settle.settlePrice(key, WINDOW, 1e18, false, 10);
        assertLt(slow.costToFake, fast.costToFake, "overstating arbitrage speed overstates the cost: callers pass a slow bound");
    }

    function test_costIsMeasuredFromTheTruncatedPrice_notFromThePushedOne() public {
        // deep near the honest price, thin beyond: the attacker parks the pool in the thin part
        addLiquidity(key, -1800, 1800, 1e20);
        addLiquidity(key, -6000, 6000, 1e15);
        _sustainedPush(3000);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, 0);
        assertLt(d.truncTick, 1800, "the truncated price is still inside the deep part");
        (uint256 honestSegment,,,) = lens.roundTripCostBetween(key, d.truncTick, d.rawTick, 64);
        (uint256 fromWhereItSits,,,) = lens.roundTripCost(key, d.rawTick - d.truncTick, true, 64);
        assertEq(d.costToFake, honestSegment, "priced over the stretch the attacker actually had to cross");
        assertGt(d.costToFake, fromWhereItSits * 100, "not over the empty stretch beyond the pushed price");
    }

    function test_settle_fromInsideAnUnlock_reverts() public {
        // the liquidity-wall attack: add a huge position inside an unlock, settle while the wall inflates
        // costToFake, remove it before the unlock ends. SafeSettle refuses to answer while the manager is unlocked.
        addLiquidity(key, -6000, 6000, 1e15);
        _sustainedPush(3000);
        WallAttacker attacker = new WallAttacker(manager, settle);
        vm.expectRevert(SafeSettle.PoolManagerUnlocked.selector);
        attacker.attack(key, WINDOW);
    }

    function test_costIsValuedInTheChosenQuote() public {
        addLiquidity(key, -6000, 6000, 1e18);
        _sustainedPush(3000);
        // pushing up pays currency1; valued in currency0 at the truncated price, where the walk starts
        SafeSettle.Decision memory q1 = settle.settlePrice(key, WINDOW, 1e18, false, 0);
        SafeSettle.Decision memory q0 = settle.settlePrice(key, WINDOW, 1e18, true, 0);
        uint160 sqrtNow = TickMath.getSqrtPriceAtTick(q1.truncTick);
        uint256 expected0 = FullMath.mulDiv(FullMath.mulDiv(q1.costToFake, 2 ** 96, sqrtNow), 2 ** 96, sqrtNow);
        assertApproxEqRel(q0.costToFake, expected0, 0.01e18);
    }

    function test_gain_followsTheAssetNotTheTick_whenTheQuoteIsCurrency0() public {
        addLiquidity(key, -6000, 6000, 1e15);
        _sustainedPush(3000);
        // The v4 price is currency1 per currency0, so tick up = currency0 dearer. With the quote as currency1 (TSLA/USDG)
        // the asset is currency0 and ROSE: a delta-1 payout moves by notional × (1.0001^x − 1). With the quote as
        // currency0 (USDG/HIMS) the asset is currency1 and FELL: notional × (1 − 1.0001^−x).
        SafeSettle.Decision memory quote0 = settle.settlePrice(key, WINDOW, 1e18, true, 0);
        SafeSettle.Decision memory quote1 = settle.settlePrice(key, WINDOW, 1e18, false, 0);
        uint256 x = uint256(int256(quote1.rawTick - quote1.truncTick));
        uint160 r = TickMath.getSqrtPriceAtTick(int24(int256(x)));
        uint256 up = FullMath.mulDiv(FullMath.mulDiv(1e18, r, 2 ** 96), r, 2 ** 96) - 1e18;
        uint256 down = 1e18 - FullMath.mulDiv(FullMath.mulDiv(1e18, 2 ** 96, r), 2 ** 96, r);
        assertEq(quote1.gainIfFaked, up, "quote is currency1: the asset (currency0) rose");
        assertEq(quote0.gainIfFaked, down, "quote is currency0: the asset (currency1) fell");
    }

    function test_settle_emitsTheReason() public {
        addLiquidity(key, -6000, 6000, 1e15);
        _sustainedPush(3000);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, 0);
        vm.expectEmit(true, false, false, true);
        emit SafeSettle.Settled(id, d.rawTick, d.truncTick, d.usedRaw, d.costToFake, d.gainIfFaked);
        settle.settle(key, WINDOW, 1e18, false, 0);
    }

    function test_wrongHook_reverts() public {
        PoolKey memory other = key;
        other.hooks = IHooks(address(0));
        vm.expectRevert(SafeSettle.WrongHook.selector);
        settle.settlePrice(other, WINDOW, 1e18, false, 0);
    }
}
