// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {HakariDeployers} from "./utils/HakariDeployers.sol";
import {HakariOracleHook} from "../src/HakariOracleHook.sol";
import {PushCostLens} from "../src/PushCostLens.sol";
import {SafeSettle} from "../src/SafeSettle.sol";
import {CostModel} from "../src/CostModel.sol";
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

/// @dev Exposes CostModel's pure pieces to the tests.
contract CostModelHarness {
    function gainIfFaked(uint256 exposure, int24 x, bool assetUp) external pure returns (uint256) {
        return CostModel.gainIfFaked(exposure, x, assetUp);
    }
}

contract SafeSettleTest is HakariDeployers {
    using PoolIdLibrary for PoolKey;

    int24 constant DELTA = 100;
    uint32 constant WINDOW = 10;
    HakariOracleHook hook;
    PushCostLens lens;
    SafeSettle settle;
    CostModelHarness model;
    PoolId id;
    uint256 t0;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        hook = deployHook(DELTA, 0x4444);
        lens = new PushCostLens(manager);
        settle = new SafeSettle(hook, lens);
        model = new CostModelHarness();
        (key, id) = initPool(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
        hook.increaseObservationCardinalityNext(64, id);
        t0 = block.timestamp;
    }

    /// @dev Push the price up by `ticks` at t0, poke once a second for `secs` seconds, stop one second later.
    function _heldPush(int24 ticks, uint256 secs) internal {
        swapToPrice(key, false, TickMath.getSqrtPriceAtTick(currentTick(id) + ticks));
        for (uint256 s = 1; s <= secs; s++) {
            vm.warp(t0 + s);
            poke(key);
        }
        vm.warp(t0 + secs + 1);
    }

    /// @dev Nothing happens for a window: one observation now, so the TWAP covers a quiet pool.
    function _quiet() internal {
        vm.warp(t0 + WINDOW + 1);
        poke(key);
    }

    // ───────────────────────── the rule ─────────────────────────

    function test_deepPool_isTrusted_andSettlesOnRaw() public {
        addLiquidity(key, -6000, 6000, 1e21);
        _quiet();
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, 5);
        assertTrue(d.trusted, "faking any move would cost more than 1e18 of exposure could earn");
        assertEq(d.tickUsed, d.rawTick);
        assertGt(d.maxSafeExposure, 1e18);
    }

    function test_thinPool_isRefused_evenWhenNothingHappened() public {
        addLiquidity(key, -6000, 6000, 1e15);
        _quiet();
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, 0);
        assertEq(d.rawTick, d.truncTick, "no push, the series agree");
        assertFalse(d.trusted, "but the pool is too thin for this exposure: it could have been faked cheaply");
        assertLt(d.maxSafeExposure, 1e18);
        assertEq(d.tickUsed, 0);
    }

    function test_pushHeldUntilTheSeriesConverge_isStillRefused() public {
        // the review's probe: with nobody pushing back, one dust swap a second catches the truncated series up in
        // x/Δ observations; the old rule saw no disagreement and settled on the fake with no check at all
        addLiquidity(key, -6000, 6000, 1e15);
        _heldPush(3000, 42);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, 0);
        assertApproxEqAbs(d.rawTick, d.truncTick, uint256(uint24(settle.TOLERANCE_TICKS())), "both series agree on the fake");
        assertGe(d.rawTick, 2990, "at the pushed price");
        assertFalse(d.trusted, "agreement is not evidence: the pool is still cheap to push");
    }

    function test_smallExposure_onAThinPool_isTrusted() public {
        addLiquidity(key, -6000, 6000, 1e15);
        _quiet();
        SafeSettle.Decision memory big = settle.settlePrice(key, WINDOW, 1e18, false, 0);
        uint256 small = big.maxSafeExposure / 2;
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, small, false, 0);
        assertTrue(d.trusted, "an exposure the pool's depth can carry");
        assertEq(d.maxSafeExposure, big.maxSafeExposure, "the bound does not depend on the exposure asked about");
    }

    // ───────────────────────── the bound ─────────────────────────

    function test_maxSafeExposure_isTheBindingCostOverTheBindingGain() public {
        addLiquidity(key, -6000, 6000, 1e18);
        _quiet();
        for (uint256 q; q < 2; q++) {
            bool quote0 = q == 0;
            SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, quote0, 0);
            // the payout follows the asset: with the quote as currency0 the asset moves against the tick
            uint256 gainPerUnit = model.gainIfFaked(1e18, d.bindingTicks, quote0 ? !d.bindingUp : d.bindingUp);
            assertEq(d.maxSafeExposure, FullMath.mulDiv(d.bindingCost, 1e18, gainPerUnit));
            (uint256 rt, uint256 in0, uint256 in1,) = lens.roundTripCost(key, d.bindingTicks, d.bindingUp, 64);
            rt; // the binding cost is that round trip, valued in the chosen quote, with no holding cost (arbitrage closed)
            assertEq(d.bindingCost, quote0 ? in0 : in1);
        }
    }

    function test_maxSafeExposure_growsWithDepth() public {
        addLiquidity(key, -6000, 6000, 1e18);
        _quiet();
        uint256 thin = settle.settlePrice(key, WINDOW, 1, false, 0).maxSafeExposure;
        addLiquidity(key, -6000, 6000, 9e18);
        uint256 deep = settle.settlePrice(key, WINDOW, 1, false, 0).maxSafeExposure;
        assertApproxEqRel(deep, thin * 10, 0.02e18, "ten times the liquidity, ten times the exposure it can carry");
    }

    function test_arbitrage_raisesTheBound_andALongerWindowRaisesItFurther() public {
        addLiquidity(key, -6000, 6000, 1e18);
        vm.warp(t0 + 601);
        poke(key);
        uint256 closed = settle.settlePrice(key, 600, 1, false, 0).maxSafeExposure;
        uint256 closedShort = settle.settlePrice(key, 10, 1, false, 0).maxSafeExposure;
        uint256 open10 = settle.settlePrice(key, 10, 1, false, 5).maxSafeExposure;
        uint256 open600 = settle.settlePrice(key, 600, 1, false, 5).maxSafeExposure;
        assertEq(closed, closedShort, "with nobody pushing back, holding is free: the window does not matter");
        assertGt(open10, closed, "arbitrage makes holding cost re-pushes");
        assertGt(open600, open10 * 10, "and a longer window means many more of them");
    }

    function test_slowerArbitrage_lowersTheBound() public {
        addLiquidity(key, -6000, 6000, 1e18);
        vm.warp(t0 + 601);
        poke(key);
        uint256 fast = settle.settlePrice(key, 600, 1, false, 2).maxSafeExposure;
        uint256 slow = settle.settlePrice(key, 600, 1, false, 60).maxSafeExposure;
        assertLt(slow, fast, "overstating arbitrage speed overstates the bound: callers pass a slow, measured one");
    }

    function test_gain_followsTheAsset() public view {
        // v4 price = currency1 per currency0. Asset up by x ticks: exposure × (1.0001^x − 1); down: × (1 − 1.0001^−x).
        uint160 r = TickMath.getSqrtPriceAtTick(953);
        uint256 up = FullMath.mulDiv(FullMath.mulDiv(1e18, r, 2 ** 96), r, 2 ** 96) - 1e18;
        uint256 down = 1e18 - FullMath.mulDiv(FullMath.mulDiv(1e18, 2 ** 96, r), 2 ** 96, r);
        assertEq(model.gainIfFaked(1e18, 953, true), up);
        assertEq(model.gainIfFaked(1e18, 953, false), down);
        assertGt(up, down);
    }

    // ───────────────────────── guards ─────────────────────────

    function test_settle_fromInsideAnUnlock_reverts() public {
        // a liquidity wall added and removed inside one unlock would inflate the bound; SafeSettle refuses to answer
        // while the manager is unlocked
        addLiquidity(key, -6000, 6000, 1e15);
        _quiet();
        WallAttacker attacker = new WallAttacker(manager, settle);
        vm.expectRevert(SafeSettle.PoolManagerUnlocked.selector);
        attacker.attack(key, WINDOW);
    }

    function test_knownLimit_aWallAcrossTransactions_buysTrust() public {
        // Documented limit (README § Limitations): the bound reads the liquidity present at settlement. A wall added
        // in one transaction, settled against in the next and removed in a third is not stopped here; the fix is
        // time-weighted liquidity recorded by the hook.
        addLiquidity(key, -6000, 6000, 1e15);
        _heldPush(3000, 42);
        assertFalse(settle.settlePrice(key, WINDOW, 1e18, false, 0).trusted);
        addLiquidity(key, 1200, 4800, 1e22); // tx 1: the wall around the held price
        assertTrue(settle.settlePrice(key, WINDOW, 1e18, false, 0).trusted, "tx 2: the fake is now trusted");
        addLiquidity(key, 1200, 4800, -1e22); // tx 3: the wall comes back out
    }

    function test_settle_emitsTheReason() public {
        addLiquidity(key, -6000, 6000, 1e15);
        _quiet();
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, 0);
        vm.expectEmit(true, false, false, true);
        emit SafeSettle.Settled(id, d.rawTick, d.truncTick, d.trusted, 1e18, d.maxSafeExposure, d.bindingTicks, d.bindingUp);
        settle.settle(key, WINDOW, 1e18, false, 0);
    }

    function test_wrongHook_reverts() public {
        PoolKey memory other = key;
        other.hooks = IHooks(address(0));
        vm.expectRevert(SafeSettle.WrongHook.selector);
        settle.settlePrice(other, WINDOW, 1e18, false, 0);
    }
}
