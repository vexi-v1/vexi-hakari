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

    function ladder() external pure returns (int24[6] memory) {
        return CostModel.ladder();
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

    /// @dev Liquidity at every price, so no push can get past the book for free.
    function _fullRange(int256 liquidity) internal {
        addLiquidity(key, TickMath.minUsableTick(key.tickSpacing), TickMath.maxUsableTick(key.tickSpacing), liquidity);
    }

    function test_arbitrage_raisesTheBound_andALongerWindowRaisesItFurther() public {
        _fullRange(1e18);
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
        _fullRange(1e18);
        vm.warp(t0 + 601);
        poke(key);
        uint256 fast = settle.settlePrice(key, 600, 1, false, 2).maxSafeExposure;
        uint256 slow = settle.settlePrice(key, 600, 1, false, 60).maxSafeExposure;
        assertLt(slow, fast, "overstating arbitrage speed overstates the bound: callers pass a slow, measured one");
    }

    function test_onABookThatEnds_arbitrageSpeedStopsMattering() public {
        // Past ±6000 there is no liquidity: a push beyond it, wide enough to move the TWAP within one reversion
        // interval, costs two round trips to the edge however fast arbitrage is. Fast arbitrage buys nothing here.
        addLiquidity(key, -6000, 6000, 1e18);
        vm.warp(t0 + 601);
        poke(key);
        SafeSettle.Decision memory fast = settle.settlePrice(key, 600, 1, false, 2);
        SafeSettle.Decision memory slow = settle.settlePrice(key, 600, 1, false, 60);
        assertEq(fast.maxSafeExposure, slow.maxSafeExposure);
        assertGt(fast.bindingWidth, 6000, "set by a push past the book");
    }

    function test_aPushPastTheLastRange_heldUnderOneReversion_setsTheBound() public {
        // The UF review's measurement on TSLA/USDG: with the push width capped at 4x, the cheapest hold was missed. Past
        // the last LP range a wider push costs no more fees, and a push wide enough moves the TWAP in less than one
        // reversion interval: one push and one re-push. On a book that ends at ±600 ticks, a 20 % move over a 600 s
        // window against 5 s arbitrage (width ≥ 1823 × 600 / 5 ticks) costs at most two round trips past the edge.
        addLiquidity(key, -600, 600, 1e21);
        vm.warp(t0 + 601);
        poke(key);
        SafeSettle.Decision memory d = settle.settlePrice(key, 600, 1, false, 5);
        assertGt(d.bindingWidth, 600, "the binding push goes past the book");
        uint256 bound = d.maxSafeExposure;
        for (uint256 dir; dir < 2; dir++) {
            bool up = dir == 0;
            // any width past the book costs the same round trip; 300,000 ticks is past it and inside the walk cap
            (,, uint256 pastTheEdge, bool complete) = lens.roundTripCost(key, 300_000, up, settle.MAX_WALK_STEPS());
            assertTrue(complete);
            // + 4 wei: the one-walk round trip may round a few wei above a separate walk (PushCostLens.t.sol)
            uint256 ceiling = FullMath.mulDiv(2 * (pastTheEdge + 4), 1e18, model.gainIfFaked(1e18, 1823, up));
            assertLe(bound, ceiling, "a wide push held under one reversion interval is priced");
        }
    }

    function test_widthSearch_stopsOnlyWhenNoWiderPushCanBeCheaper() public {
        // two ranges, so the cheapest width is neither the first nor the last
        addLiquidity(key, -600, 600, 1e21);
        addLiquidity(key, -6000, 6000, 1e18);
        vm.warp(t0 + 601);
        poke(key);
        uint32[3] memory reversions = [uint32(2), 12, 60];
        for (uint256 r; r < reversions.length; r++) {
            assertEq(
                settle.settlePrice(key, 600, 1, false, reversions[r]).maxSafeExposure,
                _boundOverEveryWidth(600, reversions[r]),
                "the early stop never skips a cheaper width"
            );
        }
    }

    /// @dev CostModel's bound with no early stop: every move against every width on one grid (the ladder and 50
    ///      doubled up to MAX_TICK), each width priced by one walk each way, quote currency1.
    function _boundOverEveryWidth(uint32 window, uint32 reversion) internal view returns (uint256 best) {
        int24[6] memory xs = model.ladder();
        int24[] memory ds = new int24[](6 + 15);
        for (uint256 i; i < 6; i++) {
            ds[i] = xs[i];
        }
        uint256 n = 6;
        for (int24 d = 50; d < TickMath.MAX_TICK;) {
            d = d > TickMath.MAX_TICK / 2 ? TickMath.MAX_TICK : d * 2;
            ds[n++] = d;
        }
        // ascending: 50 100 200 [400] 488 [800] 953 [1600] 1823 [3200] …
        for (uint256 i = 1; i < n; i++) {
            for (uint256 j = i; j > 0 && ds[j - 1] > ds[j]; j--) {
                (ds[j - 1], ds[j]) = (ds[j], ds[j - 1]);
            }
        }
        assembly ("memory-safe") {
            mstore(ds, n)
        }
        int24[] memory grid = _dedupe(ds);
        uint256 upBest = _bestOneWay(grid, true, window, reversion);
        uint256 downBest = _bestOneWay(grid, false, window, reversion);
        best = upBest < downBest ? upBest : downBest;
    }

    function _bestOneWay(int24[] memory grid, bool up, uint32 window, uint32 reversion) internal view returns (uint256 best) {
        int24[6] memory xs = model.ladder();
        (, uint256[] memory rt,) = lens.roundTripCosts(key, grid, up, settle.MAX_WALK_STEPS());
        best = type(uint256).max;
        for (uint256 i; i < xs.length; i++) {
            uint256 gain = model.gainIfFaked(1e18, xs[i], up); // quote is currency1: the asset moves with the tick
            for (uint256 j; j < grid.length; j++) {
                if (grid[j] < xs[i]) continue;
                uint256 hold = (uint256(uint24(xs[i])) * window - 1) / uint256(uint24(grid[j])) + 1;
                uint256 n = FullMath.mulDiv(rt[j] * (1 + (hold - 1) / reversion + 1), 1e18, gain);
                if (n < best) best = n;
            }
        }
    }

    function _dedupe(int24[] memory a) internal pure returns (int24[] memory out) {
        uint256 m;
        out = new int24[](a.length);
        for (uint256 i; i < a.length; i++) {
            if (m == 0 || a[i] != out[m - 1]) out[m++] = a[i];
        }
        assembly ("memory-safe") {
            mstore(out, m)
        }
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
