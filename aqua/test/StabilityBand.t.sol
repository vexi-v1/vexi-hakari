// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, console2 } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { FullMath } from "@uniswap/v4-core/src/libraries/FullMath.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";

import { BandMath } from "../src/band/BandMath.sol";
import { StabilityBandPricer } from "../src/band/StabilityBandPricer.sol";
import { FixedPremium } from "../src/book/FixedPremium.sol";
import { BandPoolManagerMock, MockBandOracle } from "./helpers/BandMocks.sol";

/// @notice The stability band in front of a fixed premium, over a simulated HAKARI oracle and a mock PoolManager: no
///         fork. It proves the defaults; the taper (the spread widens as u², the size shrinks as 1 − u) at fixed points
///         and as a monotone property; that a quote is the inner ask widened, rounded up; the pauses (a reference
///         pushed past 5 %, no size left at the edge, a young pool or a broken oracle, a thin pool, raw and truncated
///         series apart); that a TWAP as `current` cannot see a push in the same second while slot0 sees it at once;
///         that a push held for the whole window becomes the center (a limitation, asserted); the bound on what a
///         buyer gains per call from a premium set at the center; and the owner's and the constructor's guards.
/// @dev The base is currency0, so a higher tick is a dearer base. The reference trades at 400 dollars per base and the
///      writer's fixed premium is 20 dollars per contract, set at that price.
contract StabilityBandTest is Test {
    address internal constant BASE = address(0x1000); // currency0, 18 decimals: a stock token
    address internal constant QUOTE = address(0x2000); // currency1, 6 decimals: a dollar
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant SERIES = 1;
    uint256 internal constant PREMIUM = 20e6; // 20 dollars per contract
    uint256 internal constant ODD_SERIES = 2;
    uint256 internal constant ODD_PREMIUM = 3; // three quote units: shows the ask is rounded up

    BandPoolManagerMock internal manager;
    MockBandOracle internal oracle;
    FixedPremium internal inner;
    StabilityBandPricer internal band;
    PoolKey internal key;
    address internal owner = makeAddr("owner");
    int24 internal tick0;
    uint256 internal center0;

    function setUp() public {
        vm.warp(T0);
        deployCodeTo("BandMocks.sol:BandToken", abi.encode("Stock", "STK", uint8(18)), BASE);
        deployCodeTo("BandMocks.sol:BandToken", abi.encode("Dollar", "USD", uint8(6)), QUOTE);
        manager = new BandPoolManagerMock();
        oracle = new MockBandOracle(manager);
        key = PoolKey(Currency.wrap(BASE), Currency.wrap(QUOTE), 3000, 60, IHooks(address(oracle)));
        // 400 dollars per base: raw quote per raw base = 400e6 / 1e18.
        tick0 = TickMath.getTickAtSqrtPrice(uint160(Math.sqrt(FullMath.mulDiv(400e6, 1 << 192, 1e18))));
        oracle.init(key.toId(), tick0);
        inner = new FixedPremium(owner);
        vm.startPrank(owner);
        inner.setPremium(SERIES, PREMIUM);
        inner.setPremium(ODD_SERIES, ODD_PREMIUM);
        vm.stopPrank();
        band = new StabilityBandPricer(inner, IPoolManager(address(manager)), key, BASE, QUOTE, _defaults(), owner);
        center0 = band.priceOf(TickMath.getSqrtPriceAtTick(tick0));
        vm.warp(T0 + 2 hours); // two quiet hours of history
    }

    function _defaults() internal pure returns (StabilityBandPricer.Params memory) {
        return StabilityBandPricer.Params({
            bandWindow: 3600,
            nowWindow: 0,
            halfWidthBps: 500,
            maxExtraBps: 2000,
            maxContracts: 50,
            minLiquidity: 0
        });
    }

    function _set(StabilityBandPricer.Params memory p) internal {
        vm.prank(owner);
        band.setParams(p);
    }

    function _pausedWith(StabilityBandPricer.Reason r) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(StabilityBandPricer.Paused.selector, r);
    }

    /// @dev The reference pool trades `ticks` away from where it started, now (one tick = 0.01 %).
    function _move(int256 ticks) internal {
        oracle.moveTo(tick0 + int24(ticks));
    }

    // ------------------------------------------------------------------ defaults and a quiet pool

    function test_TheDefaults() public view {
        StabilityBandPricer.Params memory d = band.defaultParams();
        assertEq(d.bandWindow, 3600, "a one-hour center");
        assertEq(d.nowWindow, 0, "current = the slot0 price");
        assertEq(d.halfWidthBps, 500, "a 5 % half-width");
        assertEq(d.maxExtraBps, 2000, "+20 % at the edge");
        assertEq(d.maxContracts, 50);
        assertEq(d.minLiquidity, 0);
        assertEq(abi.encode(d), abi.encode(_defaults()));
        assertEq(abi.encode(band.params()), abi.encode(d), "constructed with the defaults");
        assertEq(band.DEFAULT_HALF_WIDTH_BPS(), 500);
        assertEq(band.MAX_HALF_WIDTH_BPS(), 5000);

        assertEq(address(band.INNER()), address(inner));
        assertEq(address(band.POOL_MANAGER()), address(manager));
        assertEq(address(band.ORACLE()), address(oracle), "the key's hook is the oracle");
        assertEq(PoolId.unwrap(band.POOL_ID()), PoolId.unwrap(key.toId()));
        assertEq(PoolId.unwrap(band.poolKey().toId()), PoolId.unwrap(key.toId()));
        assertEq(band.BASE(), BASE);
        assertEq(band.QUOTE(), QUOTE);
        assertTrue(band.BASE_IS_CURRENCY0());
    }

    function test_AQuietPoolQuotesTheInnerAskAtFullSize() public view {
        StabilityBandPricer.Status memory s = band.status();
        assertTrue(s.quoting, "a quiet pool quotes");
        assertEq(uint8(s.reason), uint8(StabilityBandPricer.Reason.None));
        assertEq(s.centerTick, tick0);
        assertEq(s.truncatedCenterTick, tick0);
        assertEq(s.currentTick, tick0);
        assertEq(s.centerWad, center0);
        assertEq(s.truncatedCenterWad, center0);
        assertEq(s.currentWad, center0);
        assertApproxEqRel(center0, 400e18, 0.0001e18, "400 dollars per base, within a tick");
        assertEq(s.liquidity, 1e21);
        assertEq(s.halfWidthBps, 500);
        assertEq(s.uWad, 0);
        assertEq(s.extraBps, 0);
        assertEq(s.sizeCap, 50);
        assertEq(band.ask(SERIES, 50), inner.ask(SERIES, 50), "at the center the ask is the inner ask");
        assertEq(band.ask(SERIES, 50), 1000e6);
    }

    // ------------------------------------------------------------------ the taper

    /// @notice The taper's two curves at fixed points of u (maxExtra 20 %, maxContracts 50). The size reaches zero
    ///         just past u = 0.98, so with the defaults the band stops at 98 % of its half-width (4.9 %).
    function test_TheTaperAtFixedPoints() public view {
        uint256[8] memory u = [uint256(0), 0.25e18, 0.5e18, 0.75e18, 0.98e18, 1e18 - 1, 1e18, 1.2e18];
        uint256[8] memory extra = [uint256(0), 125, 500, 1125, 1921, 2000, 2000, 2000];
        uint256[8] memory cap = [uint256(50), 37, 25, 12, 1, 0, 0, 0];
        for (uint256 i = 0; i < u.length; i++) {
            assertEq(band.extraBpsAt(u[i], 2000), extra[i], "extra = 2000 x u^2, rounded up");
            assertEq(band.sizeCapAt(u[i], 50), cap[i], "cap = 50 x (1 - u), rounded down");
            console2.log("u (1e-4), extra bps, size cap", u[i] / 1e14, extra[i], cap[i]);
        }
        assertEq(band.sizeCapAt(0.98e18 + 1, 50), 0, "one wei past 0.98: not one contract left");
    }

    function testFuzz_TheSpreadOnlyWidensAndTheSizeOnlyShrinks(
        uint256 u1,
        uint256 u2,
        uint16 maxExtra,
        uint32 maxContracts
    ) public view {
        u1 = bound(u1, 0, 2e18);
        u2 = bound(u2, u1, 2e18);
        maxExtra = uint16(bound(maxExtra, 0, 9999));
        maxContracts = uint32(bound(maxContracts, 1, type(uint32).max));
        assertLe(band.extraBpsAt(u1, maxExtra), band.extraBpsAt(u2, maxExtra), "the spread widens toward the edge");
        assertGe(band.sizeCapAt(u1, maxContracts), band.sizeCapAt(u2, maxContracts), "the size shrinks toward it");
        assertLe(band.extraBpsAt(u2, maxExtra), maxExtra);
        assertLe(band.sizeCapAt(u1, maxContracts), maxContracts);
    }

    /// @notice Moving the reference away from the center, up or down, never narrows the ask or raises the size: the
    ///         quotes the book sees are monotone in the distance.
    function testFuzz_QuotesTaperWithDistanceFromTheCenter(uint256 a, uint256 b, bool up) public {
        a = bound(a, 0, 470); // 470 ticks up is +4.81 %, u = 0.96: one contract left
        b = bound(b, a, 470);
        _move(up ? int256(a) : -int256(a));
        StabilityBandPricer.Status memory near = band.status();
        uint256 nearAsk = band.ask(SERIES, 1);
        _move(up ? int256(b) : -int256(b));
        StabilityBandPricer.Status memory far = band.status();
        uint256 farAsk = band.ask(SERIES, 1);
        assertTrue(near.quoting && far.quoting, "inside the band");
        assertEq(near.centerTick, tick0, "a move in this second does not reach the center");
        assertLe(near.uWad, far.uWad);
        assertLe(near.extraBps, far.extraBps);
        assertGe(near.sizeCap, far.sizeCap);
        assertLe(nearAsk, farAsk);
    }

    /// @notice A quote is the inner ask times (1 + extra), rounded up, and nothing else: halfway to the edge the ask
    ///         is ~5 % over the fixed premium and a call takes at most 25 contracts.
    function test_TheQuotesAreTheInnerAskWidened() public {
        _move(246); // +2.49 %, u = 0.498
        StabilityBandPricer.Status memory s = band.status();
        assertTrue(s.quoting);
        assertApproxEqAbs(s.uWad, 0.5e18, 0.002e18, "halfway to the edge");
        assertEq(s.extraBps, band.extraBpsAt(s.uWad, 2000));
        assertEq(s.sizeCap, band.sizeCapAt(s.uWad, 50));
        assertEq(s.extraBps, 497);
        assertEq(s.sizeCap, 25);
        uint256 widened = Math.mulDiv(inner.ask(SERIES, 10), 10_000 + s.extraBps, 10_000, Math.Rounding.Ceil);
        assertEq(band.ask(SERIES, 10), widened);
        assertEq(band.ask(SERIES, 10), 209.94e6, "10 x 20 dollars x 1.0497");
        assertEq(band.ask(ODD_SERIES, 1), 4, "3 x 1.0497 = 3.15, rounded up to 4 in the writer's favor");
        console2.log("u (1e-4) at +246 ticks", s.uWad / 1e14);
        console2.log("  extra bps, size cap", s.extraBps, s.sizeCap);
        console2.log("  ask for 10, inner ask for 10 (1e-6 dollars)", band.ask(SERIES, 10), inner.ask(SERIES, 10));

        _move(0); // back at the center: the inner ask exactly
        assertEq(band.ask(SERIES, 10), inner.ask(SERIES, 10));
        assertEq(band.ask(ODD_SERIES, 1), ODD_PREMIUM);
    }

    function test_MoreThanTheSizeCapReverts() public {
        vm.expectRevert(abi.encodeWithSelector(StabilityBandPricer.SizeCapped.selector, 51, 50));
        band.ask(SERIES, 51);
        band.ask(SERIES, 50);
        _move(246);
        vm.expectRevert(abi.encodeWithSelector(StabilityBandPricer.SizeCapped.selector, 26, 25));
        band.ask(SERIES, 26);
        assertGt(band.ask(SERIES, 25), inner.ask(SERIES, 25));
    }

    // ------------------------------------------------------------------ pauses

    /// @notice A push of the reference 6 % either way, in the same second as the quote: the hour's center does not
    ///         move, slot0 does, u > 1, and the band stops quoting. Pushed back, it quotes the inner ask again.
    function test_APushOfTheReferencePastTheBandPauses() public {
        _move(583); // +6.00 %
        StabilityBandPricer.Status memory s = band.status();
        assertEq(s.centerTick, tick0, "the one-hour center did not move");
        assertEq(s.currentTick, tick0 + 583, "slot0 sees the push");
        assertGt(s.uWad, 1e18);
        assertFalse(s.quoting);
        assertEq(uint8(s.reason), uint8(StabilityBandPricer.Reason.OutsideBand));
        assertEq(s.sizeCap, 0);
        assertEq(s.extraBps, 0);
        vm.expectRevert(_pausedWith(StabilityBandPricer.Reason.OutsideBand));
        band.ask(SERIES, 1);
        console2.log(
            "push +583 ticks: price vs center (1e-4)", s.currentWad * 1e4 / s.centerWad, "u (1e-4)", s.uWad / 1e14
        );

        _move(-619); // -6.00 %
        s = band.status();
        assertGt(s.uWad, 1e18);
        vm.expectRevert(_pausedWith(StabilityBandPricer.Reason.OutsideBand));
        band.ask(SERIES, 1);

        _move(392); // +4.00 %: inside, tapered
        s = band.status();
        assertTrue(s.quoting);
        assertEq(s.sizeCap, 10);
        assertEq(s.extraBps, 1279);

        _move(0); // pushed back
        assertEq(band.ask(SERIES, 1), PREMIUM);
    }

    /// @notice Just inside the edge, where 50 × (1 − u) rounds to zero, the band reports paused rather than quoting
    ///         with no size, so `status().quoting` always means at least one contract.
    function test_AtTheEdgeWithNoSizeLeftItPauses() public {
        _move(480); // +4.92 %, u = 0.983
        StabilityBandPricer.Status memory s = band.status();
        assertLe(s.uWad, 1e18, "inside the band");
        assertGt(s.uWad, 0.98e18);
        assertFalse(s.quoting);
        assertEq(uint8(s.reason), uint8(StabilityBandPricer.Reason.OutsideBand));
        assertEq(s.sizeCap, 0);
        vm.expectRevert(_pausedWith(StabilityBandPricer.Reason.OutsideBand));
        band.ask(SERIES, 1);

        _move(478); // +4.90 %, u = 0.979: one contract left
        s = band.status();
        assertTrue(s.quoting);
        assertEq(s.sizeCap, 1);
        assertEq(s.extraBps, 1918);
        assertEq(band.ask(SERIES, 1), 23.836e6, "20 dollars x 1.1918");
        vm.expectRevert(abi.encodeWithSelector(StabilityBandPricer.SizeCapped.selector, 2, 1));
        band.ask(SERIES, 2);
    }

    /// @notice The hook's oracle cannot answer over the hour: the pool is younger than the window, or its ring is
    ///         gone. The band pauses until the window is covered.
    function test_AYoungPoolOrABrokenOracleIsUnavailable() public {
        vm.warp(T0 + 30 minutes);
        StabilityBandPricer.Status memory s = band.status();
        assertFalse(s.quoting);
        assertEq(uint8(s.reason), uint8(StabilityBandPricer.Reason.ReferenceUnavailable));
        vm.expectRevert(_pausedWith(StabilityBandPricer.Reason.ReferenceUnavailable));
        band.ask(SERIES, 1);
        vm.warp(T0 + 1 hours - 1);
        assertEq(uint8(band.status().reason), uint8(StabilityBandPricer.Reason.ReferenceUnavailable));
        vm.warp(T0 + 1 hours); // the window reaches the first observation exactly
        assertTrue(band.status().quoting, "one full hour of history is enough");

        vm.warp(T0 + 2 hours);
        oracle.setBroken(true);
        vm.expectRevert(_pausedWith(StabilityBandPricer.Reason.ReferenceUnavailable));
        band.ask(SERIES, 1);
        oracle.setBroken(false);
        assertEq(band.ask(SERIES, 1), PREMIUM);
    }

    function test_AThinReferencePauses() public {
        StabilityBandPricer.Params memory p = _defaults();
        p.minLiquidity = 1e22;
        _set(p);
        StabilityBandPricer.Status memory s = band.status();
        assertEq(uint8(s.reason), uint8(StabilityBandPricer.Reason.ReferenceTooThin));
        assertEq(s.liquidity, 1e21, "the liquidity it read is reported");
        assertEq(s.centerWad, 0, "nothing after the failed check is read");
        vm.expectRevert(_pausedWith(StabilityBandPricer.Reason.ReferenceTooThin));
        band.ask(SERIES, 1);
        oracle.setLiquidity(1e22);
        assertEq(band.ask(SERIES, 1), PREMIUM);
    }

    /// @notice The truncated series (which moves at most 250 ticks per observation) and the raw one disagree over
    ///         the hour. Up to a half-width apart the band quotes; past it, `SeriesDisagree`.
    function test_RawAndTruncatedDisagreeingPauses() public {
        vm.warp(T0 + 1 hours + 60);
        oracle.moveTo(tick0);
        oracle.shiftTruncated(400); // the truncated series sits 400 ticks off for the last 59 minutes
        vm.warp(T0 + 2 hours);
        StabilityBandPricer.Status memory s = band.status();
        assertEq(s.truncatedCenterTick, tick0 + 393, "400 x 59 / 60");
        assertTrue(s.quoting, "3.9 % apart: inside the half-width");
        assertEq(s.uWad, 0, "the raw series is what the band is drawn on");

        oracle.shiftTruncated(600); // now 1000 ticks off: 983 over the hour, 10.3 %
        s = band.status();
        assertFalse(s.quoting);
        assertEq(uint8(s.reason), uint8(StabilityBandPricer.Reason.SeriesDisagree));
        assertEq(s.centerTick, tick0);
        assertEq(s.truncatedCenterTick, tick0 + 983);
        assertGt(s.truncatedCenterWad, s.centerWad, "both centers are still reported");
        vm.expectRevert(_pausedWith(StabilityBandPricer.Reason.SeriesDisagree));
        band.ask(SERIES, 1);
    }

    /// @notice The natural way the series come apart: a jump of +16 % in one observation, held. The raw center
    ///         follows it; the truncated series moved only 250 ticks. After most of an hour the raw center sits near
    ///         the pushed price, so u alone would let the band quote there; the disagreement pauses it.
    function test_AJumpLargerThanTheTruncationAbsorbsPauses() public {
        vm.warp(T0 + 1 hours + 60);
        _move(1500);
        vm.warp(T0 + 2 hours);
        StabilityBandPricer.Status memory s = band.status();
        assertEq(s.centerTick, tick0 + 1475, "1500 x 59 / 60");
        assertEq(s.truncatedCenterTick, tick0 + 245, "250 x 59 / 60");
        assertLt(s.uWad, 0.1e18, "the raw center has nearly caught up with the pushed price");
        assertFalse(s.quoting);
        assertEq(uint8(s.reason), uint8(StabilityBandPricer.Reason.SeriesDisagree));
    }

    // ------------------------------------------------------------------ what `current` sees

    /// @notice slot0 as `current` (the default) sees a push of the reference at once and tapers the quote in the
    ///         same second; a TWAP as `current` does not see a push made in this second at all (the hook writes its
    ///         observation before the swap) and lags a move that stands by its window.
    function test_ATwapAsCurrentDoesNotSeeAPushInTheSameSecond() public {
        _move(296); // +3.00 %
        StabilityBandPricer.Status memory s = band.status();
        assertEq(s.currentTick, tick0 + 296, "slot0 sees the push at once");
        assertApproxEqAbs(s.uWad, 0.6e18, 0.002e18);
        assertEq(s.sizeCap, 19);
        assertEq(s.extraBps, 722);

        StabilityBandPricer.Params memory p = _defaults();
        p.nowWindow = 300;
        _set(p);
        s = band.status();
        assertEq(s.currentTick, tick0, "the five-minute TWAP does not see this second's push");
        assertEq(s.currentWad, center0);
        assertEq(s.uWad, 0);
        assertEq(s.sizeCap, 50);
        assertEq(band.ask(SERIES, 50), inner.ask(SERIES, 50), "a full-size quote at the center, blind to the push");

        uint256 t = vm.getBlockTimestamp();
        vm.warp(t + 60);
        assertEq(band.status().currentTick, tick0 + 59, "a minute later: 296 x 60 / 300");
        vm.warp(t + 300);
        assertEq(band.status().currentTick, tick0 + 296, "the whole window later: the move");
    }

    /// @notice A LIMITATION, asserted: a push that stands for the whole band window becomes the center. The reference
    ///         is moved +8 % and traded at for four seconds (so the truncated series, 250 ticks per observation,
    ///         catches up) and then left there. The band is paused while the center is more than ~4.9 % behind, quotes
    ///         again, tapered, 23 minutes in, and after an hour quotes the inner ask at full size at the pushed
    ///         price. The band bounds how fast a fixed premium can go stale, not how far: a writer must reprice.
    function test_APushThatStandsForTheWholeWindowBecomesTheCenter() public {
        uint256 start = vm.getBlockTimestamp();
        for (uint256 i = 0; i < 4; i++) {
            vm.warp(start + i);
            _move(770); // +8.00 %
        }
        assertEq(uint8(band.status().reason), uint8(StabilityBandPricer.Reason.OutsideBand));

        uint256 resumedAt;
        for (uint256 m = 1; m <= 60; m++) {
            vm.warp(start + m * 60);
            StabilityBandPricer.Status memory st = band.status();
            if (st.quoting && resumedAt == 0) {
                resumedAt = m;
                console2.log("held +8 % push: quoted again after minutes", m);
                console2.log(
                    "  center ticks behind, size cap", uint256(int256(770 - (st.centerTick - tick0))), st.sizeCap
                );
            }
        }
        assertEq(resumedAt, 23, "the center has come within 4.9 % of the pushed price");

        vm.warp(start + 3600 + 3);
        StabilityBandPricer.Status memory s = band.status();
        assertEq(s.centerTick, tick0 + 770, "the push is the center");
        assertEq(s.truncatedCenterTick, tick0 + 770);
        assertEq(s.uWad, 0);
        assertEq(s.sizeCap, 50);
        assertEq(s.extraBps, 0);
        assertEq(band.ask(SERIES, 50), inner.ask(SERIES, 50), "the stale premium, at full size");
    }

    // ------------------------------------------------------------------ the stale-premium bound

    /// @notice What the band bounds. A fixed premium is set at the center; a buyer of calls whose value moves at most
    ///         one-for-one with the price gains, per contract, at most the move |current − center| = u × halfWidth ×
    ///         center over it. The call takes at most n = maxContracts × (1 − u), so per call
    ///           n × u × halfWidth × center ≤ maxContracts × u(1 − u) × halfWidth × center ≤ maxContracts × halfWidth ×
    ///         center / 4,
    ///         whatever the push, the half-width or the size. (The taper's extra spread comes off on top.)
    function testFuzz_TheStalePremiumGainPerCallIsBounded(uint256 ticks, bool up, uint16 halfWidth, uint32 maxC)
        public
    {
        halfWidth = uint16(bound(halfWidth, 1, 5000));
        maxC = uint32(bound(maxC, 1, 10_000));
        StabilityBandPricer.Params memory p = _defaults();
        p.halfWidthBps = halfWidth;
        p.maxContracts = maxC;
        _set(p);
        ticks = bound(ticks, 0, halfWidth); // one tick is about one bps: the whole band and a little past it
        _move(up ? int256(ticks) : -int256(ticks));
        StabilityBandPricer.Status memory s = band.status();
        if (!s.quoting) {
            assertEq(uint8(s.reason), uint8(StabilityBandPricer.Reason.OutsideBand));
            assertEq(band.sizeCapAt(s.uWad, maxC), 0, "only where no contract is left");
            return;
        }
        uint256 n = s.sizeCap;
        assertEq(n, band.sizeCapAt(s.uWad, maxC));
        assertLe(n * s.uWad * 4, uint256(maxC) * 1e18, "n x u <= maxContracts / 4");
        uint256 halfWidthWad = s.centerWad * halfWidth / 10_000;
        uint256 move = BandMath.dist(s.currentWad, s.centerWad);
        assertLe(move * 1e18, s.uWad * halfWidthWad, "the move is at most u x halfWidth x center");
        assertLe(n * move * 4, uint256(maxC) * halfWidthWad, "n x move <= maxContracts x halfWidth x center / 4");
    }

    /// @notice The same bound walked across the default band in 5-tick steps, with the numbers: a 400-dollar center,
    ///         a 20-dollar half-width, 50 contracts.
    function test_TheStalePremiumGainAcrossTheBand() public {
        uint256 halfWidthWad = center0 * 500 / 10_000;
        uint256 limit = 50 * halfWidthWad / 4;
        uint256 worst;
        int256 worstTicks;
        for (int256 t = 0; t <= 490; t += 5) {
            _move(t);
            StabilityBandPricer.Status memory s = band.status();
            uint256 gain = s.sizeCap * BandMath.dist(s.currentWad, s.centerWad);
            if (gain > worst) (worst, worstTicks) = (gain, t);
        }
        assertLe(worst, limit, "the mechanism bound");
        assertApproxEqRel(worst, limit, 0.01e18, "and it is tight: the worst push is halfway, at 25 contracts");
        assertEq(worstTicks, 245);
        console2.log("worst gain per call over the premium, cents", worst / 1e16);
        console2.log("  at ticks above the center", uint256(worstTicks));
        console2.log("bound 50 x halfWidth x center / 4, cents", limit / 1e16);
        console2.log("no band, 50 contracts at a +20 % push, cents", 50 * (center0 * 2000 / 10_000) / 1e16);
    }

    // ------------------------------------------------------------------ guards

    function test_ParamGuards() public {
        StabilityBandPricer.Params[] memory bad = new StabilityBandPricer.Params[](8);
        for (uint256 i = 0; i < bad.length; i++) {
            bad[i] = _defaults();
        }
        bad[0].halfWidthBps = 0;
        bad[1].halfWidthBps = 5001; // wider than 50 %
        bad[2].nowWindow = 3600; // current's window as long as the center's
        bad[3].nowWindow = 7200;
        bad[4].maxExtraBps = 10_000; // a +100 % spread
        bad[5].maxContracts = 0;
        bad[6].bandWindow = 0;
        bad[7].maxExtraBps = type(uint16).max;
        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(owner);
            vm.expectRevert(StabilityBandPricer.BadParams.selector);
            band.setParams(bad[i]);
        }
        vm.expectRevert(StabilityBandPricer.BadParams.selector);
        new StabilityBandPricer(inner, IPoolManager(address(manager)), key, BASE, QUOTE, bad[0], owner);

        // The limits themselves are accepted.
        StabilityBandPricer.Params memory p = _defaults();
        p.halfWidthBps = 5000;
        p.nowWindow = 3599;
        p.maxExtraBps = 9999;
        p.maxContracts = 1;
        _set(p);
        assertEq(abi.encode(band.params()), abi.encode(p));
    }

    function test_ConstructorGuards() public {
        address other = address(0x3000);
        deployCodeTo("BandMocks.sol:BandToken", abi.encode("Other", "OTH", uint8(6)), other);
        PoolKey memory mismatched = PoolKey(Currency.wrap(BASE), Currency.wrap(other), 3000, 60, key.hooks);
        vm.expectRevert(
            abi.encodeWithSelector(
                StabilityBandPricer.PairMismatch.selector, BASE, QUOTE, Currency.wrap(BASE), Currency.wrap(other)
            )
        );
        new StabilityBandPricer(inner, IPoolManager(address(manager)), mismatched, BASE, QUOTE, _defaults(), owner);

        PoolKey memory noHook = PoolKey(Currency.wrap(BASE), Currency.wrap(QUOTE), 3000, 60, IHooks(address(0)));
        vm.expectRevert(StabilityBandPricer.NoOracleHook.selector);
        new StabilityBandPricer(inner, IPoolManager(address(manager)), noHook, BASE, QUOTE, _defaults(), owner);

        PoolKey memory uninit = PoolKey(Currency.wrap(BASE), Currency.wrap(QUOTE), 500, 10, key.hooks);
        vm.expectRevert(abi.encodeWithSelector(StabilityBandPricer.PoolNotInitialized.selector, uninit.toId()));
        new StabilityBandPricer(inner, IPoolManager(address(manager)), uninit, BASE, QUOTE, _defaults(), owner);

        address wide = address(0x4000);
        deployCodeTo("BandMocks.sol:BandToken", abi.encode("Wide", "WIDE", uint8(19)), wide);
        PoolKey memory wideKey = PoolKey(Currency.wrap(BASE), Currency.wrap(wide), 3000, 60, key.hooks);
        vm.expectRevert(abi.encodeWithSelector(StabilityBandPricer.BadDecimals.selector, 18, 19));
        new StabilityBandPricer(inner, IPoolManager(address(manager)), wideKey, BASE, wide, _defaults(), owner);

        // The pair read the other way round is the same pool: the base is currency1 and prices invert.
        StabilityBandPricer inverse =
            new StabilityBandPricer(inner, IPoolManager(address(manager)), key, QUOTE, BASE, _defaults(), owner);
        assertFalse(inverse.BASE_IS_CURRENCY0());
        assertApproxEqRel(inverse.status().centerWad, 0.0025e18, 0.0001e18, "1 / 400 base per dollar");
    }

    function test_OnlyTheOwnerSetsParams() public {
        StabilityBandPricer.Params memory p = _defaults();
        p.bandWindow = 1800;
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        band.setParams(p);
        vm.expectEmit(address(band));
        emit StabilityBandPricer.ParamsSet(p);
        _set(p);
        assertEq(band.params().bandWindow, 1800);
        assertTrue(band.status().quoting);
    }

    /// @notice `status` is what a board renders: it answers with a reason whatever the oracle does, and `ask` is the
    ///         one that reverts.
    function test_StatusNeverRevertsOnABrokenOracle() public {
        oracle.setBroken(true);
        StabilityBandPricer.Status memory s = band.status();
        assertFalse(s.quoting);
        assertEq(uint8(s.reason), uint8(StabilityBandPricer.Reason.ReferenceUnavailable));
        assertEq(s.liquidity, 1e21, "what was read before the oracle is still reported");
        assertEq(s.halfWidthBps, 500);
        assertEq(s.centerWad, 0);
        assertEq(s.currentWad, 0);
        assertEq(s.sizeCap, 0);
        assertEq(s.extraBps, 0);
        vm.expectRevert(_pausedWith(StabilityBandPricer.Reason.ReferenceUnavailable));
        band.ask(SERIES, 1);

        _move(5000); // and far outside the band with the oracle back
        oracle.setBroken(false);
        s = band.status();
        assertEq(uint8(s.reason), uint8(StabilityBandPricer.Reason.OutsideBand));
        assertGt(s.uWad, 1e18);
    }

    /// @dev A price absurdly far from a tiny center (a one-hour TWAP at tick -500,000, slot0 at the top of the tick
    ///      range) saturates u instead of overflowing, so `status` still answers and `ask` refuses with `Paused`.
    function test_StatusSaturatesFarFromATinyCenter() public {
        BandPoolManagerMock m = new BandPoolManagerMock();
        MockBandOracle o = new MockBandOracle(m);
        PoolKey memory k = PoolKey(Currency.wrap(BASE), Currency.wrap(QUOTE), 3000, 60, IHooks(address(o)));
        o.init(k.toId(), -500_000);
        StabilityBandPricer b =
            new StabilityBandPricer(inner, IPoolManager(address(m)), k, BASE, QUOTE, _defaults(), owner);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        o.moveTo(TickMath.MAX_TICK - 1);

        StabilityBandPricer.Status memory s = b.status();
        assertGt(s.centerWad, 0, "a tiny but nonzero center");
        assertEq(s.uWad, type(uint256).max, "u saturates");
        assertFalse(s.quoting);
        assertEq(uint8(s.reason), uint8(StabilityBandPricer.Reason.OutsideBand));
        vm.expectRevert(_pausedWith(StabilityBandPricer.Reason.OutsideBand));
        b.ask(SERIES, 1);
    }
}
