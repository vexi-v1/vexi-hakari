// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {HakariDeployers} from "./utils/HakariDeployers.sol";
import {MockVexiVenue, MockVexiSpotLeaf} from "./utils/MockVexi.sol";
import {MaxSafeHarness} from "./fixtures/WalkFixture.t.sol";
import {PushCostLens} from "../src/PushCostLens.sol";
import {SafeSettle} from "../src/SafeSettle.sol";
import {CostModel} from "../src/CostModel.sol";
import {ExposureGuard} from "../src/ExposureGuard.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @dev Adds a liquidity wall inside an unlock and asks the guard for a verdict before taking it back.
contract GuardWallAttacker is IUnlockCallback {
    IPoolManager immutable manager;
    ExposureGuard immutable guard;

    constructor(IPoolManager m, ExposureGuard g) {
        manager = m;
        guard = g;
    }

    /// @param ids empty: ask `verdict` on a stated exposure; else ask `venueVerdict` on these ids
    function attack(PoolKey calldata key, uint256[] calldata ids) external {
        manager.unlock(abi.encode(key, ids));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, uint256[] memory ids) = abi.decode(data, (PoolKey, uint256[]));
        manager.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -887220, tickUpper: 887220, liquidityDelta: 1e27, salt: 0}), ""
        );
        if (ids.length == 0) guard.verdict(key, true, 1, 300, 0);
        else guard.venueVerdict(ids, 0);
        return "";
    }
}

/// @notice ExposureGuard on a fresh PoolManager: a PONS-shaped pool (a 6-decimal USDG-like quote as currency0, an
///         18-decimal base as currency1, one full-range position of 1e18, fee 3000, spacing 60) and its MU-shaped
///         mirror (the base as currency0), both at 0.64 quote per base; a mock venue keyed by option id.
///         Run: forge test --match-contract ExposureGuard -vv
contract ExposureGuardTest is HakariDeployers {
    using PoolIdLibrary for PoolKey;

    /// @dev 1 base = 0.64 quote with 18/6 decimals: raw base per raw quote is 1.5625e12, whose square root is exact.
    uint160 constant SQRT_PONS = uint160(uint256(1_250_000) << 96);
    /// @dev The mirror: raw quote per raw base is 1 / 1.5625e12 (rounded once, in the last of 96 fraction bits).
    uint160 constant SQRT_MU = uint160((uint256(1) << 192) / uint256(SQRT_PONS));
    uint256 constant BASE_UNIT = 1e18;
    uint256 constant QUOTE_UNIT = 1e6;
    uint256 constant SPOT_WAD = 0.64e18;
    uint32 constant FIX_WINDOW = 300;
    /// @dev Option ids are even; the deposit id of a series is its option id + 1.
    uint256 constant CALL_A = 0xa0;
    uint256 constant PUT_A = 0xb0;
    uint256 constant CALL_B = 0xc0;
    uint256 constant MU_CALL = 0xd0;
    uint256 constant MU_PUT = 0xe0;
    /// @dev The largest historical cell on the live venue: 1,287.03 contracts, a call and a put on one expiry.
    uint256 constant CONTRACTS_A = 1000e18;
    uint256 constant CONTRACTS_A_PUT = 28703e16;

    PushCostLens lens;
    ExposureGuard guard;
    MockVexiVenue venue;
    MockVexiSpotLeaf leaf;
    MaxSafeHarness harness;
    Currency usdg;
    Currency ponsBase;
    Currency muBase;
    PoolKey ponsKey;
    PoolKey muKey;
    uint64 expiry;

    function setUp() public {
        deployFreshManagerAndRouters();
        usdg = _token("USDG", 6);
        // one base token on either side of the quote's address: the pool sorts its currencies by address
        for (uint256 i; i < 16 && (_unset(ponsBase) || _unset(muBase)); i++) {
            Currency t = _token("BASE", 18);
            if (Currency.unwrap(t) > Currency.unwrap(usdg)) {
                if (_unset(ponsBase)) ponsBase = t;
            } else if (_unset(muBase)) {
                muBase = t;
            }
        }
        require(!_unset(ponsBase) && !_unset(muBase), "no base token on one side of the quote");
        lens = new PushCostLens(manager);
        venue = new MockVexiVenue();
        leaf = new MockVexiSpotLeaf();
        guard = new ExposureGuard(lens, manager, venue, leaf);
        harness = new MaxSafeHarness();
        (ponsKey,) = initPool(usdg, ponsBase, IHooks(address(0)), 3000, SQRT_PONS);
        (muKey,) = initPool(muBase, usdg, IHooks(address(0)), 3000, SQRT_MU);
        _fullRange(ponsKey, 1e18);
        _fullRange(muKey, 1e18);
        leaf.setPool(Currency.unwrap(ponsBase), Currency.unwrap(usdg), ponsKey);
        leaf.setPool(Currency.unwrap(muBase), Currency.unwrap(usdg), muKey);
        expiry = uint64(block.timestamp + 900);
        _series(CALL_A, 0, ponsBase, expiry, CONTRACTS_A);
        _series(PUT_A, 1, ponsBase, expiry, CONTRACTS_A_PUT);
        _series(CALL_B, 0, ponsBase, expiry, 5000e18);
        _series(MU_CALL, 0, muBase, expiry, CONTRACTS_A);
        _series(MU_PUT, 1, muBase, expiry, CONTRACTS_A_PUT);
    }

    // ───────────────────────── any pool ─────────────────────────

    function test_bound_onAHooklessPool_matchesTheHarness_whereSafeSettleRefuses() public {
        CostModel.Bound memory b = guard.bound(ponsKey, true, FIX_WINDOW, 0);
        CostModel.Bound memory h = harness.bound(lens, ponsKey, true);
        assertEq(b.maxSafeExposure, h.maxSafeExposure, "the fixture's bound: window and step cap do not matter here");
        assertEq(b.ticks, h.ticks);
        assertEq(b.up, h.up);
        assertEq(b.cost, h.cost);
        assertTrue(b.complete);
        // one full-range position: the bound is about the fee times the quote-side reserve (800,000 USDG here)
        assertApproxEqRel(b.maxSafeExposure, 8e11 * 3000 / 1e6, 0.15e18, "about fee x quote reserve");
        // SafeSettle cannot answer on this pool at all: no HAKARI hook, no TWAPs
        SafeSettle settle = new SafeSettle(deployHook(100, 0x4444), lens);
        vm.expectRevert(SafeSettle.WrongHook.selector);
        settle.settlePrice(ponsKey, FIX_WINDOW, 1, true, 0);
    }

    function test_verdict_trusted_flipsExactlyAtTheBound() public {
        uint256 b = guard.bound(ponsKey, true, FIX_WINDOW, 0).maxSafeExposure;
        ExposureGuard.Verdict memory v = guard.verdict(ponsKey, true, b - 1, FIX_WINDOW, 0);
        assertTrue(v.trusted);
        assertEq(v.maxSafeExposure, b);
        assertEq(v.source, 0);
        assertEq(v.nIds, 0);
        assertEq(v.poolId, PoolId.unwrap(ponsKey.toId()));
        assertFalse(guard.verdict(ponsKey, true, b, FIX_WINDOW, 0).trusted, "at the bound the pool is not deep enough");
        // and through the venue: contracts worth exactly the bound at 0.64 (b x 1e12 / 0.64 base units)
        venue.setSupply(CALL_A, b * 1_562_500_000_000);
        (ExposureGuard.Verdict memory atBound,,,,,) = guard.venueVerdict(_ids(CALL_A), 0);
        assertEq(atBound.exposure, b);
        assertFalse(atBound.trusted);
        venue.setSupply(CALL_A, (b - 1) * 1_562_500_000_000);
        (ExposureGuard.Verdict memory below,,,,,) = guard.venueVerdict(_ids(CALL_A), 0);
        assertEq(below.exposure, b - 1);
        assertTrue(below.trusted);
    }

    function test_verdict_fromInsideAnUnlock_reverts() public {
        // a liquidity wall added and removed inside one unlock would inflate the bound; the guard refuses to answer
        // while the manager is unlocked, on both ways in
        GuardWallAttacker attacker = new GuardWallAttacker(manager, guard);
        vm.expectRevert(ExposureGuard.PoolManagerUnlocked.selector);
        attacker.attack(ponsKey, new uint256[](0));
        vm.expectRevert(ExposureGuard.PoolManagerUnlocked.selector);
        attacker.attack(ponsKey, _ids(CALL_A));
        assertTrue(guard.verdict(ponsKey, true, 1, FIX_WINDOW, 0).trusted, "and answers again once the manager is locked");
    }

    // ───────────────────────── the venue ─────────────────────────

    function test_venueVerdict_sumsTheIdsGiven_callsAndPutsAlike() public view {
        (ExposureGuard.Verdict memory v, address base, address quote, uint64 exp, uint256 contracts, uint256 spot) =
            guard.venueVerdict(_ids(CALL_A, PUT_A), 0);
        assertEq(contracts, 128703e16, "the call and the put named, not the third series on that expiry");
        assertEq(spot, SPOT_WAD);
        assertEq(v.exposure, 823_699_200, "1,287.03 contracts x 0.64 = 823.6992 USDG in 6-decimal units");
        assertEq(v.source, 1);
        assertEq(v.nIds, 2);
        assertTrue(v.trusted);
        assertEq(v.maxSafeExposure, guard.bound(ponsKey, true, FIX_WINDOW, 0).maxSafeExposure);
        assertEq(base, Currency.unwrap(ponsBase));
        assertEq(quote, Currency.unwrap(usdg));
        assertEq(exp, expiry);
        // a deposit id names the same series as its option id
        (ExposureGuard.Verdict memory viaDeposit,,,, uint256 same,) = guard.venueVerdict(_ids(CALL_A | 1, PUT_A), 0);
        assertEq(same, contracts);
        assertEq(viaDeposit.exposure, v.exposure);
        // the third series counts only when named
        (ExposureGuard.Verdict memory all,,,, uint256 three,) = guard.venueVerdict(_ids(CALL_A, PUT_A, CALL_B), 0);
        assertEq(three, 628703e16);
        assertEq(all.nIds, 3);
    }

    function test_venueVerdict_refusesMixedExpiredDuplicateAndUnregistered() public {
        // MixedSeries: a later expiry on the same market, then another market on the same expiry
        _series(0xf0, 0, ponsBase, expiry + 900, 1e18);
        vm.expectRevert(abi.encodeWithSelector(ExposureGuard.MixedSeries.selector, 0xf0));
        guard.venueVerdict(_ids(CALL_A, 0xf0), 0);
        vm.expectRevert(abi.encodeWithSelector(ExposureGuard.MixedSeries.selector, MU_CALL));
        guard.venueVerdict(_ids(CALL_A, MU_CALL), 0);
        // DuplicateId: the option and deposit ids of one series would count it twice
        vm.expectRevert(abi.encodeWithSelector(ExposureGuard.DuplicateId.selector, CALL_A | 1));
        guard.venueVerdict(_ids(CALL_A, CALL_A | 1), 0);
        // UnknownSeries, NoIds
        vm.expectRevert(abi.encodeWithSelector(ExposureGuard.UnknownSeries.selector, 0xf2));
        guard.venueVerdict(_ids(0xf2), 0);
        vm.expectRevert(ExposureGuard.NoIds.selector);
        guard.venueVerdict(new uint256[](0), 0);
        // NoPool: a market the registry does not know
        _series(0xf4, 0, _token("ORPHAN", 18), expiry, 1e18);
        vm.expectRevert(ExposureGuard.NoPool.selector);
        guard.venueVerdict(_ids(0xf4), 0);
        // Expired: from expiry on the fix is being taken; the guard stops answering
        vm.warp(expiry);
        vm.expectRevert(abi.encodeWithSelector(ExposureGuard.Expired.selector, CALL_A));
        guard.venueVerdict(_ids(CALL_A), 0);
        // and a guard whose lens walks another manager is never deployed
        vm.expectRevert(ExposureGuard.ManagerMismatch.selector);
        new ExposureGuard(lens, IPoolManager(address(0xdead)), venue, leaf);
    }

    function test_muOrder_quoteAsCurrency1_mirrorsTheBound_andPricesTheSameContracts() public view {
        CostModel.Bound memory pons = guard.bound(ponsKey, true, FIX_WINDOW, 0);
        CostModel.Bound memory mu = guard.bound(muKey, false, FIX_WINDOW, 0);
        // the same book seen from the other side: the binding move is the same size in the opposite tick direction;
        // the two start ticks round on opposite sides of the price, one tick apart, hence the tolerance
        assertEq(mu.ticks, pons.ticks);
        assertTrue(mu.up != pons.up);
        assertApproxEqRel(mu.maxSafeExposure, pons.maxSafeExposure, 0.002e18);
        assertTrue(mu.complete);
        (ExposureGuard.Verdict memory a,,,, uint256 contractsA, uint256 spotA) = guard.venueVerdict(_ids(CALL_A, PUT_A), 0);
        (ExposureGuard.Verdict memory m,,,, uint256 contractsM, uint256 spotM) = guard.venueVerdict(_ids(MU_CALL, MU_PUT), 0);
        assertEq(contractsM, contractsA);
        assertApproxEqAbs(spotM, spotA, 1, "the mirror's sqrt price is rounded once");
        assertApproxEqAbs(m.exposure, a.exposure, 1);
        assertEq(m.poolId, PoolId.unwrap(muKey.toId()));
        assertTrue(m.trusted);
    }

    function test_spotWad_matchesTheGaugesPriceInQuote_onBothOrders() public view {
        (,,,,, uint256 pons) = guard.venueVerdict(_ids(CALL_A), 0);
        (,,,,, uint256 mu) = guard.venueVerdict(_ids(MU_CALL), 0);
        // priceInQuote (web/live/core.js): (sqrtP / 2^96)^2 x 10^(dec0 - dec1), inverted when the quote is currency0
        assertEq(pons, SPOT_WAD, "quote as currency0: 1 / (1.5625e12 x 10^(6 - 18))");
        assertApproxEqAbs(mu, SPOT_WAD, 1, "quote as currency1: 6.4e-13 x 10^(18 - 6)");
    }

    function test_pulledLiquidity_readsUntrusted() public {
        (ExposureGuard.Verdict memory before,,,,,) = guard.venueVerdict(_ids(CALL_A, PUT_A), 0);
        assertTrue(before.trusted);
        _fullRange(ponsKey, -1e18); // the one LP leaves
        (ExposureGuard.Verdict memory after_,,,,,) = guard.venueVerdict(_ids(CALL_A, PUT_A), 0);
        assertEq(after_.maxSafeExposure, 0, "nothing to push against: any move is free");
        assertFalse(after_.trusted);
        assertEq(after_.exposure, before.exposure, "the exposure is the venue's, unchanged");
        assertTrue(after_.complete);
    }

    function test_check_writesTheVerdict_andTheVenueRead() public {
        ExposureGuard.Verdict memory v = guard.verdict(ponsKey, true, 823_699_200, FIX_WINDOW, 0);
        vm.expectEmit(true, false, false, true);
        emit ExposureGuard.Checked(
            v.poolId, 0, v.exposure, v.maxSafeExposure, v.trusted, v.bindingTicks, v.bindingUp, v.bindingCost, v.complete
        );
        guard.check(ponsKey, true, 823_699_200, FIX_WINDOW, 0);

        uint256[] memory ids = _ids(CALL_A, PUT_A);
        (ExposureGuard.Verdict memory w, address base, address quote, uint64 exp, uint256 contracts, uint256 spot) =
            guard.venueVerdict(ids, 0);
        vm.expectEmit(false, false, false, true);
        emit ExposureGuard.VenueRead(base, quote, exp, contracts, spot, keccak256(abi.encodePacked(ids)));
        vm.expectEmit(true, false, false, true);
        emit ExposureGuard.Checked(
            w.poolId, 1, w.exposure, w.maxSafeExposure, w.trusted, w.bindingTicks, w.bindingUp, w.bindingCost, w.complete
        );
        (ExposureGuard.Verdict memory logged,,,,,) = guard.venueCheck(ids, 0);
        assertEq(logged.exposure, w.exposure);
        assertEq(w.exposure, v.exposure, "the what-if and the venue read agree on the number");
    }

    // ───────────────────────── helpers ─────────────────────────

    function _token(string memory symbol, uint8 decimals) internal returns (Currency) {
        MockERC20 t = new MockERC20(symbol, symbol, decimals);
        t.mint(address(this), 2 ** 255);
        t.approve(address(modifyLiquidityRouter), type(uint256).max);
        t.approve(address(swapRouter), type(uint256).max);
        return Currency.wrap(address(t));
    }

    function _unset(Currency c) internal pure returns (bool) {
        return Currency.unwrap(c) == address(0);
    }

    function _fullRange(PoolKey memory k, int256 liquidity) internal {
        addLiquidity(k, TickMath.minUsableTick(k.tickSpacing), TickMath.maxUsableTick(k.tickSpacing), liquidity);
    }

    function _series(uint256 id, uint8 kind, Currency base, uint64 exp, uint256 supply) internal {
        venue.setSeries(id, kind, Currency.unwrap(base), Currency.unwrap(usdg), exp, BASE_UNIT, QUOTE_UNIT);
        venue.setSupply(id, supply);
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        (ids[0], ids[1]) = (a, b);
    }

    function _ids(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (a, b, c);
    }
}
