// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, Vm, console2 } from "forge-std/Test.sol";
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
import { HookTwapExpiryPrice } from "../src/band/HookTwapExpiryPrice.sol";
import { OptionBook } from "../src/book/OptionBook.sol";
import { BandPoolManagerMock, MockBandOracle } from "./helpers/BandMocks.sol";

/// @notice Settlement on the hook's TWAP inside a fixed 5 % band around the TWAP drawn before expiry, over a simulated
///         HAKARI oracle: no fork. It proves that a quiet pool settles on the first window at the pool price; that a
///         push through the settle window at expiry defers settlement by one window (`NotYet`) and then settles at the
///         honest price, also through a real `OptionBook`; that a push held through every window is never the price
///         with the band fixed before expiry (the default), while with a band per attempt a push held long enough
///         becomes its own center and is accepted; that `record` keeps the answer once the oracle can no longer
///         give it; where the band's edge falls in ticks; and the source's set-once, owner-only and parameter guards.
/// @dev The base is currency0, so a higher tick is a dearer base: a token with no price feed at 0.05 dollars.
contract StabilityTwapSettleTest is Test {
    address internal constant BASE = address(0x1000); // currency0, 18 decimals: a token with no price feed
    address internal constant QUOTE = address(0x2000); // currency1, 6 decimals: a dollar
    uint256 internal constant T0 = 1_800_000_000;
    uint32 internal constant S = 300; // settle window
    uint32 internal constant B = 1800; // band window
    uint16 internal constant ATTEMPTS = 6;
    int24 internal constant PUSH = 1823; // +20 %: 1.0001^1823 = 1.19996

    BandPoolManagerMock internal manager;
    MockBandOracle internal oracle;
    HookTwapExpiryPrice internal source;
    PoolKey internal key;
    int24 internal tick0;
    uint64 internal at;
    address internal owner = makeAddr("owner");

    function setUp() public {
        vm.warp(T0);
        deployCodeTo("BandMocks.sol:BandToken", abi.encode("Meme", "MEME", uint8(18)), BASE);
        deployCodeTo("BandMocks.sol:BandToken", abi.encode("Dollar", "USD", uint8(6)), QUOTE);
        manager = new BandPoolManagerMock();
        oracle = new MockBandOracle(manager);
        key = PoolKey(Currency.wrap(BASE), Currency.wrap(QUOTE), 3000, 60, IHooks(address(oracle)));
        // 0.05 dollars per MEME: raw quote per raw base = 0.05e6 / 1e18.
        tick0 = TickMath.getTickAtSqrtPrice(uint160(Math.sqrt(FullMath.mulDiv(0.05e6, 1 << 192, 1e18))));
        oracle.init(key.toId(), tick0);
        source = new HookTwapExpiryPrice(owner);
        vm.prank(owner);
        source.setSource(IPoolManager(address(manager)), key, BASE, QUOTE, _params(true));
        at = uint64(T0 + 2 hours);
    }

    function _params(bool bandFromExpiry) internal pure returns (HookTwapExpiryPrice.Params memory) {
        return HookTwapExpiryPrice.Params({
            settleWindow: S,
            bandWindow: B,
            attempts: ATTEMPTS,
            halfWidthBps: 500,
            bandFromExpiry: bandFromExpiry
        });
    }

    /// @dev WAD dollars per MEME at `tick` (scale 10^(18 + 18 − 6)).
    function _price(int24 tick) internal pure returns (uint256) {
        return BandMath.priceOf(TickMath.getSqrtPriceAtTick(tick), true, 1e30);
    }

    // ------------------------------------------------------------------ a quiet pool

    function test_AQuietPoolSettlesOnTheFirstWindow() public {
        vm.warp(at);
        uint256 p = source.priceAt(BASE, QUOTE, at);
        assertEq(p, _price(tick0), "the pool price");
        assertApproxEqRel(p, 0.05e18, 0.0001e18, "0.05 dollars per MEME, within a tick");
        HookTwapExpiryPrice.Attempt memory a = source.attempt(BASE, QUOTE, at, 0);
        assertTrue(a.accepted);
        assertEq(a.windowEnd, at);
        assertEq(a.settleTick, tick0);
        assertEq(a.centerTick, tick0);
        assertEq(a.centerWad, p);
        assertEq(a.priceWad, p);
        assertEq(a.halfWidthBps, 500);
        assertTrue(source.covers(BASE, QUOTE));
    }

    function test_NothingBeforeTheWindowEnds() public {
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NotYet.selector, at));
        source.priceAt(BASE, QUOTE, at);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NotYet.selector, at));
        source.record(BASE, QUOTE, at);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NotYet.selector, at));
        source.attempt(BASE, QUOTE, at, 0);
        vm.warp(at);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NotYet.selector, at + S));
        source.attempt(BASE, QUOTE, at, 1);
    }

    // ------------------------------------------------------------------ a push at expiry

    /// @notice A push through the settle window (+20 % for the five minutes before expiry), released at expiry: the
    ///         first window is refused, settlement waits one window (`NotYet`), and settles at the honest price.
    function test_APushAtExpiryDefersSettlementToTheNextWindow() public {
        vm.warp(at - S);
        oracle.moveTo(tick0 + PUSH);
        vm.warp(at);
        oracle.moveTo(tick0); // released

        HookTwapExpiryPrice.Attempt memory a0 = source.attempt(BASE, QUOTE, at, 0);
        assertFalse(a0.accepted, "the pushed window is outside the band");
        assertEq(a0.settleTick, tick0 + PUSH);
        assertEq(a0.centerTick, tick0, "the band was drawn before the push");
        assertApproxEqRel(a0.priceWad * 1e18 / a0.centerWad, 1.2e18, 0.0001e18, "+20 %");
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NotYet.selector, at + S));
        source.priceAt(BASE, QUOTE, at);

        vm.warp(at + S);
        HookTwapExpiryPrice.Attempt memory a1 = source.attempt(BASE, QUOTE, at, 1);
        assertTrue(a1.accepted);
        assertEq(a1.windowEnd, at + S);
        assertEq(a1.settleTick, tick0);
        assertEq(a1.centerTick, tick0, "held to the band drawn before expiry");
        assertEq(source.priceAt(BASE, QUOTE, at), _price(tick0), "the next window, at the honest price");
        vm.expectEmit(address(source));
        emit HookTwapExpiryPrice.Recorded(BASE, QUOTE, at, _price(tick0), 1);
        source.record(BASE, QUOTE, at);
        console2.log("pushed window: settle tick - center tick", int256(a0.settleTick) - int256(a0.centerTick));
        console2.log("  settle / center (1e-4)", a0.priceWad * 1e4 / a0.centerWad);
    }

    /// @notice Through an `OptionBook`: a call series on MEME, which has no price feed. While the pushed window is the
    ///         only one that has ended, the book's `settle` reverts and its grace waits; one window later it settles
    ///         at the honest price. No order is needed to create and settle a series.
    function test_AnOptionBookSettlesThroughIt() public {
        OptionBook tight = new OptionBook(source, 600, uint64(ATTEMPTS) * S);
        vm.expectRevert(
            abi.encodeWithSelector(OptionBook.GraceShorterThanSource.selector, BASE, QUOTE, uint64(1800), uint64(1800))
        );
        tight.createSeries(BASE, QUOTE, 0.05e18, at, true);

        OptionBook book = new OptionBook(source, 600, 3600);
        uint256 seriesId = book.createSeries(BASE, QUOTE, 0.05e18, at, true);
        vm.warp(at - S);
        oracle.moveTo(tick0 + PUSH);
        vm.warp(at);
        oracle.moveTo(tick0);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NotYet.selector, at + S));
        book.settle(seriesId);
        vm.warp(at + S - 1);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NotYet.selector, at + S));
        book.settle(seriesId);

        vm.warp(at + S);
        assertEq(book.settle(seriesId), _price(tick0));
        (bool settled, uint64 settledAt, uint256 price,,,,,) = book.settlements(seriesId);
        assertTrue(settled);
        assertEq(settledAt, at + S);
        assertEq(price, _price(tick0), "the honest price, not the push");
    }

    /// @notice The push held for every attempt. With the band fixed before expiry (the default) nothing is accepted:
    ///         the series is not settled here, and after the book's grace it unwinds (escrow back to the makers,
    ///         premiums back to the holders).
    function test_APushHeldThroughEveryWindowIsNeverThePrice() public {
        OptionBook book = new OptionBook(source, 600, 3600);
        uint256 seriesId = book.createSeries(BASE, QUOTE, 0.05e18, at, true);
        vm.warp(at - S);
        oracle.moveTo(tick0 + PUSH);

        uint64 last = at + uint64(ATTEMPTS - 1) * S;
        vm.warp(last - 1);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NotYet.selector, last));
        source.priceAt(BASE, QUOTE, at);
        vm.warp(last);
        for (uint16 i = 0; i < ATTEMPTS; i++) {
            HookTwapExpiryPrice.Attempt memory a = source.attempt(BASE, QUOTE, at, i);
            assertFalse(a.accepted);
            assertEq(a.centerTick, tick0, "every attempt is held to the band drawn before expiry");
            assertEq(a.settleTick, tick0 + PUSH);
        }
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NoWindowInBand.selector, at, ATTEMPTS));
        source.priceAt(BASE, QUOTE, at);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NoWindowInBand.selector, at, ATTEMPTS));
        source.record(BASE, QUOTE, at);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NoWindowInBand.selector, at, ATTEMPTS));
        book.settle(seriesId);

        vm.warp(at + 3600 + 1);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.SettleTooLate.selector, seriesId, at + 3600));
        book.settle(seriesId);
    }

    /// @notice The limit of the other mode, and the reason `bandFromExpiry = true` is the default: with a band per
    ///         attempt, each attempt's center is the TWAP just before its own window, so a push that is held drags the
    ///         center along. Held from five minutes before expiry, the +20 % push is inside its own band by the sixth
    ///         attempt (its center has been pushed for 25 of its 30 minutes) and becomes the price. Over the same
    ///         ticks, the default source refuses every window.
    function test_WithABandPerAttemptAHeldPushBecomesThePrice() public {
        HookTwapExpiryPrice perAttempt = new HookTwapExpiryPrice(owner);
        vm.prank(owner);
        perAttempt.setSource(IPoolManager(address(manager)), key, BASE, QUOTE, _params(false));
        vm.warp(at - S);
        oracle.moveTo(tick0 + PUSH);
        vm.warp(at + uint64(ATTEMPTS - 1) * S);

        int24[6] memory centers = [int24(0), 303, 607, 911, 1215, 1519]; // 1823 x i / 6, rounded down
        for (uint16 i = 0; i < ATTEMPTS; i++) {
            HookTwapExpiryPrice.Attempt memory a = perAttempt.attempt(BASE, QUOTE, at, i);
            assertEq(a.centerTick, tick0 + centers[i], "the push drags the center");
            assertEq(a.settleTick, tick0 + PUSH);
            assertEq(a.accepted, i == ATTEMPTS - 1, "only the last center is within 5 % of the push");
            console2.log(
                "band per attempt: attempt, center ticks behind the push",
                uint256(i),
                uint256(int256(PUSH - centers[i]))
            );
        }
        assertEq(perAttempt.priceAt(BASE, QUOTE, at), _price(tick0 + PUSH), "the pushed price settles");
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NoWindowInBand.selector, at, ATTEMPTS));
        source.priceAt(BASE, QUOTE, at);
    }

    // ------------------------------------------------------------------ the band's edge

    /// @notice `attempt` exposes each window: its end, the center and settle ticks and prices, and whether it was
    ///         accepted. The 5 % edge falls at +487 / +488 ticks above the center and −512 / −513 below it: the band is
    ///         in price, a fixed share of the center, so it is not symmetric in ticks.
    function test_AttemptExposesTheCenterThePriceAndAcceptance() public {
        vm.warp(at - S);
        oracle.moveTo(tick0 + 488); // +5.0008 %
        vm.warp(at);
        oracle.moveTo(tick0 + 487); // +4.9903 %
        vm.warp(at + S);
        oracle.moveTo(tick0);

        HookTwapExpiryPrice.Attempt memory a0 = source.attempt(BASE, QUOTE, at, 0);
        assertEq(a0.windowEnd, at);
        assertEq(a0.centerTick, tick0);
        assertEq(a0.settleTick, tick0 + 488);
        assertEq(a0.centerWad, _price(tick0));
        assertEq(a0.priceWad, _price(tick0 + 488));
        assertEq(a0.halfWidthBps, 500);
        assertFalse(a0.accepted, "+488 ticks is past 5 %");
        HookTwapExpiryPrice.Attempt memory a1 = source.attempt(BASE, QUOTE, at, 1);
        assertEq(a1.windowEnd, at + S);
        assertEq(a1.priceWad, _price(tick0 + 487));
        assertTrue(a1.accepted, "+487 ticks is inside");
        assertEq(source.priceAt(BASE, QUOTE, at), _price(tick0 + 487));
        console2.log("+488 ticks: settle / center (1e-6)", a0.priceWad * 1e6 / a0.centerWad);
        console2.log("+487 ticks: settle / center (1e-6)", a1.priceWad * 1e6 / a1.centerWad);

        uint64 at2 = at + 2 hours; // the pool has been back at tick0 for well over a band window
        vm.warp(at2 - S);
        oracle.moveTo(tick0 - 513); // -5.0004 %
        vm.warp(at2);
        oracle.moveTo(tick0 - 512); // -4.9909 %
        vm.warp(at2 + S);
        oracle.moveTo(tick0);
        HookTwapExpiryPrice.Attempt memory b0 = source.attempt(BASE, QUOTE, at2, 0);
        HookTwapExpiryPrice.Attempt memory b1 = source.attempt(BASE, QUOTE, at2, 1);
        assertEq(b0.centerTick, tick0);
        assertFalse(b0.accepted, "-513 ticks is past 5 %");
        assertTrue(b1.accepted, "-512 ticks is inside");
        assertEq(source.priceAt(BASE, QUOTE, at2), _price(tick0 - 512));
        console2.log("-513 ticks: settle / center (1e-6)", b0.priceWad * 1e6 / b0.centerWad);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NotYet.selector, at2 + 2 * S));
        source.attempt(BASE, QUOTE, at2, 2);
    }

    // ------------------------------------------------------------------ record

    /// @notice Once recorded, the answer no longer depends on the hook's ring: the oracle can revert (its ring has
    ///         wrapped past the window) and `priceAt` still answers. Anyone may record; a second record changes
    ///         nothing.
    function test_RecordKeepsTheAnswerWhenTheRingIsGone() public {
        vm.warp(at);
        address keeper = makeAddr("keeper");
        vm.expectEmit(address(source));
        emit HookTwapExpiryPrice.Recorded(BASE, QUOTE, at, _price(tick0), 0);
        vm.prank(keeper);
        uint256 p = source.record(BASE, QUOTE, at);
        assertEq(p, _price(tick0));
        assertEq(source.recorded(BASE, QUOTE, at), p);

        oracle.setBroken(true);
        assertEq(source.priceAt(BASE, QUOTE, at), p, "answered from the record");
        vm.recordLogs();
        vm.prank(makeAddr("anyone"));
        assertEq(source.record(BASE, QUOTE, at), p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0, "a second record stores and emits nothing");
        vm.expectRevert("oracle broken");
        source.attempt(BASE, QUOTE, at, 0); // attempt always reads the oracle
        vm.expectRevert("oracle broken");
        source.priceAt(BASE, QUOTE, at - 60); // an expiry nobody recorded
    }

    // ------------------------------------------------------------------ the source

    function test_MaxDelayIsAttemptsTimesTheSettleWindow() public view {
        assertEq(source.maxDelay(BASE, QUOTE), uint64(ATTEMPTS) * S);
        assertEq(source.maxDelay(BASE, QUOTE), 1800);
        assertEq(source.maxDelay(QUOTE, BASE), 0, "a pair with no source");
        assertFalse(source.covers(QUOTE, BASE));
        HookTwapExpiryPrice.Source memory src = source.source(BASE, QUOTE);
        assertEq(address(src.oracle), address(oracle), "the key's hook is the oracle");
        assertEq(PoolId.unwrap(src.poolId), PoolId.unwrap(key.toId()));
        assertTrue(src.baseIs0);
        assertEq(src.scale, 1e30);
        assertEq(abi.encode(src.params), abi.encode(_params(true)));
    }

    function test_SetSourceOnceAndOwnerOnly() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        source.setSource(IPoolManager(address(manager)), key, QUOTE, BASE, _params(true));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.SourceAlreadySet.selector, BASE, QUOTE));
        source.setSource(IPoolManager(address(manager)), key, BASE, QUOTE, _params(false));

        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NoSource.selector, QUOTE, BASE));
        source.priceAt(QUOTE, BASE, at);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NoSource.selector, QUOTE, BASE));
        source.attempt(QUOTE, BASE, at, 0);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NoSource.selector, QUOTE, BASE));
        source.record(QUOTE, BASE, at);

        // The same pool read the other way round is another pair, set once too.
        vm.expectEmit(address(source));
        emit HookTwapExpiryPrice.SourceSet(QUOTE, BASE, address(oracle), key.toId(), _params(true));
        vm.prank(owner);
        source.setSource(IPoolManager(address(manager)), key, QUOTE, BASE, _params(true));
        assertTrue(source.covers(QUOTE, BASE));
        assertFalse(source.source(QUOTE, BASE).baseIs0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.SourceAlreadySet.selector, QUOTE, BASE));
        source.setSource(IPoolManager(address(manager)), key, QUOTE, BASE, _params(true));
    }

    function test_SetSourceParamGuards() public {
        HookTwapExpiryPrice fresh = new HookTwapExpiryPrice(owner);
        HookTwapExpiryPrice.Params[] memory bad = new HookTwapExpiryPrice.Params[](5);
        for (uint256 i = 0; i < bad.length; i++) {
            bad[i] = _params(true);
        }
        bad[0].settleWindow = 0;
        bad[1].bandWindow = 0;
        bad[2].attempts = 0;
        bad[3].halfWidthBps = 0;
        bad[4].halfWidthBps = 5001; // wider than 50 %
        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(owner);
            vm.expectRevert(HookTwapExpiryPrice.BadParams.selector);
            fresh.setSource(IPoolManager(address(manager)), key, BASE, QUOTE, bad[i]);
        }

        PoolKey memory noHook = PoolKey(Currency.wrap(BASE), Currency.wrap(QUOTE), 3000, 60, IHooks(address(0)));
        vm.prank(owner);
        vm.expectRevert(HookTwapExpiryPrice.BadParams.selector);
        fresh.setSource(IPoolManager(address(manager)), noHook, BASE, QUOTE, _params(true));

        address other = address(0x3000);
        PoolKey memory mismatched = PoolKey(Currency.wrap(BASE), Currency.wrap(other), 3000, 60, key.hooks);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.PairMismatch.selector, BASE, QUOTE));
        fresh.setSource(IPoolManager(address(manager)), mismatched, BASE, QUOTE, _params(true));

        PoolKey memory uninit = PoolKey(Currency.wrap(BASE), Currency.wrap(QUOTE), 500, 10, key.hooks);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.PoolNotInitialized.selector, uninit.toId()));
        fresh.setSource(IPoolManager(address(manager)), uninit, BASE, QUOTE, _params(true));

        // More than 18 decimals, on an initialized pool.
        address wide = address(0x4000);
        deployCodeTo("BandMocks.sol:BandToken", abi.encode("Wide", "WIDE", uint8(19)), wide);
        MockBandOracle wideOracle = new MockBandOracle(manager);
        PoolKey memory wideKey =
            PoolKey(Currency.wrap(BASE), Currency.wrap(wide), 3000, 60, IHooks(address(wideOracle)));
        wideOracle.init(wideKey.toId(), 0);
        vm.prank(owner);
        vm.expectRevert(HookTwapExpiryPrice.BadParams.selector);
        fresh.setSource(IPoolManager(address(manager)), wideKey, BASE, wide, _params(true));

        // The widest band is accepted.
        HookTwapExpiryPrice.Params memory p = _params(true);
        p.halfWidthBps = 5000;
        vm.prank(owner);
        fresh.setSource(IPoolManager(address(manager)), key, BASE, QUOTE, p);
        assertEq(fresh.source(BASE, QUOTE).params.halfWidthBps, 5000);
        assertEq(fresh.MAX_HALF_WIDTH_BPS(), 5000);
    }
}
