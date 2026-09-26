// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, console2 } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC1155Holder } from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import { AquaWriter } from "../src/aqua/AquaWriter.sol";
import { BandMath } from "../src/band/BandMath.sol";
import { HookTwapExpiryPrice } from "../src/band/HookTwapExpiryPrice.sol";
import { StabilityBandPricer } from "../src/band/StabilityBandPricer.sol";
import { FixedPremium } from "../src/book/FixedPremium.sol";
import { OptionBook } from "../src/book/OptionBook.sol";
import { FixedExpiryPrice } from "../src/price/FixedExpiryPrice.sol";

import { RobinhoodChain } from "./helpers/RobinhoodChain.sol";
import { UniswapV4Robinhood } from "./helpers/UniswapV4Robinhood.sol";
import { HakariOracleHookCode } from "./helpers/HakariOracleHookCode.sol";

/// @notice What the tests call on HAKARI's hook: OpenZeppelin's `BaseOracleHook` plus `twaps`.
interface IHakariOracleHook {
    function increaseObservationCardinalityNext(uint16 next, PoolId id) external;
    function twaps(PoolId id, uint32 window) external view returns (int24 rawTick, int24 truncTick);
    function observe(uint32[] calldata secondsAgos, PoolId id)
        external
        view
        returns (int56[] memory tickCumulatives, int56[] memory truncatedTickCumulatives);
    function MAX_ABS_TICK_DELTA() external view returns (int24);
}

/// @notice Moves the hooked reference pool to an exact price, and trades the book in the same transaction.
contract ReferencePusher is ERC1155Holder {
    using StateLibrary for IPoolManager;

    IPoolManager public immutable MANAGER;
    PoolSwapTest public immutable SWAPPER;
    PoolKey internal _key;

    constructor(IPoolManager manager, PoolSwapTest swapper, PoolKey memory key) {
        MANAGER = manager;
        SWAPPER = swapper;
        _key = key;
        IERC20(Currency.unwrap(key.currency0)).approve(address(swapper), type(uint256).max);
        IERC20(Currency.unwrap(key.currency1)).approve(address(swapper), type(uint256).max);
    }

    /// @notice Swaps the pool to exactly `sqrtTarget` (exact input of the whole balance, stopped by the price limit)
    ///         and returns what it paid in the token that went in.
    function pushTo(uint160 sqrtTarget) public returns (uint256 paid) {
        PoolKey memory key = _key;
        (uint160 sqrtNow,,,) = MANAGER.getSlot0(key.toId());
        bool up = sqrtTarget > sqrtNow; // up: quote (currency1) in, base out
        IERC20 tokenIn = IERC20(Currency.unwrap(up ? key.currency1 : key.currency0));
        uint256 before = tokenIn.balanceOf(address(this));
        SWAPPER.swap(
            key,
            IPoolManager.SwapParams({ zeroForOne: !up, amountSpecified: -int256(before), sqrtPriceLimitX96: sqrtTarget }),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        (uint160 sqrtAfter,,,) = MANAGER.getSlot0(key.toId());
        require(sqrtAfter == sqrtTarget, "pusher short of the target");
        paid = before - tokenIn.balanceOf(address(this));
    }

    /// @notice Push, then buy: one transaction.
    function pushAndBuy(uint160 sqrtTarget, OptionBook book, uint256 orderId, uint256 n) external {
        pushTo(sqrtTarget);
        IERC20(Currency.unwrap(_key.currency1)).approve(address(book), type(uint256).max);
        book.buy(orderId, n, type(uint256).max);
    }

    /// @notice One transaction: push to `sqrtTarget`, read the band, try to buy (the refusal is returned), push back
    ///         to where the pool was, buy again.
    function pushTryBackBuy(uint160 sqrtTarget, StabilityBandPricer band, OptionBook book, uint256 orderId, uint256 n)
        external
        returns (
            uint256 quoteIn,
            uint256 baseBack,
            StabilityBandPricer.Status memory pushed,
            bytes memory refusal,
            uint256 premium
        )
    {
        (uint160 sqrt0,,,) = MANAGER.getSlot0(_key.toId());
        IERC20 quote = IERC20(Currency.unwrap(_key.currency1));
        quote.approve(address(book), type(uint256).max);

        quoteIn = pushTo(sqrtTarget);
        pushed = band.status();
        try book.buy(orderId, n, type(uint256).max) {
            revert("bought outside the band");
        } catch (bytes memory reason) {
            refusal = reason;
        }

        baseBack = pushTo(sqrt0);
        uint256 before = quote.balanceOf(address(this));
        book.buy(orderId, n, type(uint256).max);
        premium = before - quote.balanceOf(address(this));
    }
}

/// @title StabilityBandForkTest
/// @notice On a fork of Robinhood Chain mainnet (4663), pinned: HAKARI's oracle hook, byte for byte as deployed on
///         testnet 46630, runs on the real Uniswap v4 PoolManager (the same address on both chains) as the hook of a
///         new TSLA/USDG pool, opened at the real TSLA/USDG pool's price and as deep near that price as the real pool
///         is (its in-range liquidity, spread over the full range). Two hours of small two-way swaps every 30 s fill
///         the hook's observation ring. A plain maker address writes covered calls through `AquaWriter`: the TSLA
///         stays in its wallet and Aqua pulls it at a fill. The order is priced by a `FixedPremium` behind a
///         `StabilityBandPricer` with its default parameters (a fixed 5 % band around the one-hour TWAP).
///
///         What it proves, on the real contracts:
///         - the band's center is the hook's own TWAP (raw and truncated), read through `observe`;
///         - a buy inside the band pays the fixed premium widened by maxExtra × u², and Aqua pulls the collateral
///           from the maker's wallet inside `buy`;
///         - a push of the reference past 5 % in the same transaction as a buy pauses the book (`OutsideBand`), and
///           a push back reopens it; halfway to the edge the book tapers (about half the contracts, +5 % premium);
///         - the limitation: a push nobody pulls back becomes the center within the hour;
///         - `HookTwapExpiryPrice` settles on the hook's own five-minute TWAP, and a push through the five minutes
///           before expiry defers settlement (`NotYet`) to the next window, which settles at the honest price.
contract StabilityBandForkTest is Test, RobinhoodChain, UniswapV4Robinhood {
    using StateLibrary for IPoolManager;

    IPoolManager internal constant manager = IPoolManager(V4_POOL_MANAGER);
    IAqua internal constant aqua = IAqua(AQUA);
    IHakariOracleHook internal constant hook = IHakariOracleHook(HakariOracleHookCode.ADDRESS);

    uint256 internal constant SCALE = 1e30; // 10^(18 + 18 − 6): TSLA 18 decimals, USDG 6
    uint256 internal constant SHIP_TSLA = 100e18;
    uint256 internal constant SHIP_USDG = 20_000e6;
    uint256 internal constant PREMIUM = 8e6; // the fixed premium: 8 USDG per contract
    uint256 internal constant N = 50; // contracts the order offers
    uint256 internal constant HISTORY_TSLA_LEG = 5e18; // each TSLA-in swap of the history

    PoolKey internal key;
    PoolId internal id;
    PoolSwapTest internal v4;
    PoolModifyLiquidityTest internal lp;
    ReferencePusher internal pusher;
    uint128 internal realLiquidity;
    uint256 internal lpTsla;
    uint256 internal lpUsdg;

    FixedExpiryPrice internal fixedPrice;
    OptionBook internal book;
    AquaWriter internal writer;
    AquaWriter.Strategy internal strategy;
    bytes32 internal strategyHash;
    FixedPremium internal fixedPremium;
    StabilityBandPricer internal band;

    address internal maker = makeAddr("maker");
    address internal buyer = makeAddr("buyer");
    uint256 internal strike;
    uint256 internal seriesId;
    uint256 internal orderId;

    function setUp() public {
        vm.createSelectFork(vm.envString("RH_MAINNET_RPC"), vm.envUint("RH_MAINNET_FORK_BLOCK"));
        vm.label(AQUA, "Aqua");
        vm.label(TSLA, "TSLA");
        vm.label(USDG, "USDG");
        vm.label(V4_POOL_MANAGER, "PoolManager");

        // HAKARI's hook, as deployed on 46630, at its own (flag-mined) address.
        vm.etch(HakariOracleHookCode.ADDRESS, HakariOracleHookCode.runtime());
        assertEq(HakariOracleHookCode.ADDRESS.codehash, HakariOracleHookCode.CODEHASH, "the 46630 bytecode");
        vm.label(HakariOracleHookCode.ADDRESS, "HakariOracleHook");

        // A TSLA/USDG pool with the hook, at the real (hookless) pool's price, with its in-range liquidity.
        PoolId realId = PoolId.wrap(TSLA_USDG_POOL_ID);
        (uint160 realSqrt,,,) = manager.getSlot0(realId);
        realLiquidity = manager.getLiquidity(realId);
        key = PoolKey(
            Currency.wrap(TSLA), Currency.wrap(USDG), TSLA_USDG_FEE, TSLA_USDG_TICK_SPACING, IHooks(address(hook))
        );
        id = key.toId();
        manager.initialize(key, realSqrt);
        lp = new PoolModifyLiquidityTest(manager);
        v4 = new PoolSwapTest(manager);
        deal(TSLA, address(this), 200_000e18);
        deal(USDG, address(this), 100_000_000e6);
        IERC20(TSLA).approve(address(lp), type(uint256).max);
        IERC20(USDG).approve(address(lp), type(uint256).max);
        IERC20(TSLA).approve(address(v4), type(uint256).max);
        IERC20(USDG).approve(address(v4), type(uint256).max);
        (uint256 t0, uint256 u0) = (IERC20(TSLA).balanceOf(address(this)), IERC20(USDG).balanceOf(address(this)));
        lp.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(TSLA_USDG_TICK_SPACING),
                tickUpper: TickMath.maxUsableTick(TSLA_USDG_TICK_SPACING),
                liquidityDelta: int256(uint256(realLiquidity)),
                salt: 0
            }),
            ""
        );
        lpTsla = t0 - IERC20(TSLA).balanceOf(address(this));
        lpUsdg = u0 - IERC20(USDG).balanceOf(address(this));

        // Two hours of small two-way flow: a swap every 30 s, 240 observations, alternating direction, legs of
        // equal value at the opening price.
        hook.increaseObservationCardinalityNext(300, id);
        uint256 usdgLeg = HISTORY_TSLA_LEG * BandMath.priceOf(realSqrt, true, SCALE) / SCALE;
        uint256 t = vm.getBlockTimestamp();
        for (uint256 i = 0; i < 240; i++) {
            vm.warp(t + (i + 1) * 30);
            _swap(i % 2 == 0, i % 2 == 0 ? HISTORY_TSLA_LEG : usdgLeg);
        }
        vm.warp(vm.getBlockTimestamp() + 5);

        pusher = new ReferencePusher(manager, v4, key);
        vm.label(address(pusher), "ReferencePusher");
        deal(USDG, address(pusher), 10_000_000e6);
        deal(TSLA, address(pusher), 20_000e18);

        // The maker: a plain funded address, an OptionBook (settling through FixedExpiryPrice), an AquaWriter.
        fixedPrice = new FixedExpiryPrice(address(this));
        fixedPrice.setPrice(TSLA, USDG, 1); // covered; these tests never settle this book
        book = new OptionBook(fixedPrice, 1 days, 3 days);
        writer = new AquaWriter(aqua, book, maker);
        fixedPremium = new FixedPremium(maker);
        vm.label(address(book), "OptionBook");
        vm.label(address(writer), "AquaWriter");
        vm.label(address(fixedPremium), "FixedPremium");
        vm.label(maker, "maker");
        vm.label(buyer, "buyer");
        deal(TSLA, maker, 650e18);
        deal(USDG, maker, SHIP_USDG);

        strategy = AquaWriter.Strategy({
            maker: maker,
            app: address(writer),
            base: TSLA,
            quote: USDG,
            salt: bytes32(uint256(7))
        });
        vm.startPrank(maker);
        IERC20(TSLA).approve(AQUA, type(uint256).max);
        IERC20(USDG).approve(AQUA, type(uint256).max);
        strategyHash = aqua.ship(address(writer), abi.encode(strategy), _addrs(TSLA, USDG), _amts(SHIP_TSLA, SHIP_USDG));
        writer.bind(strategy);
        vm.stopPrank();

        // A call near the money, a week out, its fixed premium, and the band over it with the defaults.
        (uint160 sqrtNow,,,) = manager.getSlot0(id);
        strike = (BandMath.priceOf(sqrtNow, true, SCALE) + 5e18) / 10e18 * 10e18;
        seriesId = book.createSeries(TSLA, USDG, strike, uint64(vm.getBlockTimestamp() + 7 days), true);
        vm.prank(maker);
        fixedPremium.setPremium(seriesId, PREMIUM);
        band = new StabilityBandPricer(fixedPremium, manager, key, TSLA, USDG, _defaults(), maker);
        vm.label(address(band), "StabilityBandPricer");
        assertTrue(band.BASE_IS_CURRENCY0());
        vm.prank(maker);
        orderId = writer.post(seriesId, band, N);
    }

    // ------------------------------------------------------------------ the real hook

    /// @notice The band's center is HAKARI's own one-hour TWAP, raw and truncated, on the real PoolManager; with
    ///         nothing pushed, the book quotes the fixed premium, barely widened, and nearly its full size.
    function test_TheBandReadsHakarisHookOnTheRealPoolManager() public view {
        assertEq(hook.MAX_ABS_TICK_DELTA(), HakariOracleHookCode.MAX_ABS_TICK_DELTA);
        assertEq(keccak256(abi.encode(band.params())), keccak256(abi.encode(band.defaultParams())), "defaults");

        StabilityBandPricer.Status memory s = band.status();
        (int24 rawTwap, int24 truncTwap) = hook.twaps(id, 3600);
        (uint160 sqrtNow, int24 tickNow,,) = manager.getSlot0(id);
        assertTrue(s.quoting, "quoting");
        assertEq(uint8(s.reason), uint8(StabilityBandPricer.Reason.None));
        assertEq(s.centerTick, rawTwap, "the center is the hook's own one-hour TWAP");
        assertEq(s.truncatedCenterTick, truncTwap, "and its truncated twin");
        assertEq(s.centerWad, band.priceOf(TickMath.getSqrtPriceAtTick(rawTwap)));
        assertEq(s.currentTick, tickNow, "current = slot0");
        assertEq(s.currentWad, band.priceOf(sqrtNow));
        assertEq(s.halfWidthBps, 500, "a fixed 5 %");
        assertEq(s.liquidity, realLiquidity);
        assertLt(s.uWad, 0.05e18, "u is small");
        assertGe(s.sizeCap, 48, "the cap is near 50");
        assertEq(s.sizeCap, band.sizeCapAt(s.uWad, 50));
        assertEq(s.extraBps, band.extraBpsAt(s.uWad, 2000));
        assertEq(book.quotePremium(orderId, 1), Math.mulDiv(PREMIUM, 10_000 + s.extraBps, 10_000, Math.Rounding.Ceil));

        console2.log("pool: in-range liquidity of the real TSLA/USDG pool", uint256(realLiquidity));
        console2.log("pool: full-range position, TSLA / USDG", _fmt(lpTsla, 18), _fmt(lpUsdg, 6));
        console2.log("center tick (hook twaps 3600, raw / truncated)", _ticks(rawTwap, truncTwap));
        console2.log("current tick (slot0)", int256(s.currentTick));
        console2.log("center / current, USDG per TSLA", _fmt(s.centerWad, 18), _fmt(s.currentWad, 18));
        console2.log("u (1e-4), extra bps, size cap", s.uWad / 1e14, s.extraBps, s.sizeCap);
        console2.log("strike, premium of 1 contract (USDG)", _fmt(strike, 18), _fmt(book.quotePremium(orderId, 1), 6));
    }

    // ------------------------------------------------------------------ a fill through Aqua

    /// @notice A buy inside the band pays the fixed premium widened by the band, and the collateral leaves the
    ///         maker's wallet only now: Aqua emits `Pulled` from the maker inside `buy`.
    function test_ABuyThroughTheBandPullsFromTheMakerThroughAqua() public {
        uint256 n = 10;
        StabilityBandPricer.Status memory s = band.status();
        vm.cool(address(band));
        vm.cool(address(fixedPremium));
        vm.cool(address(hook));
        vm.cool(V4_POOL_MANAGER);
        vm.cool(address(book));
        uint256 g = gasleft();
        uint256 premium = book.quotePremium(orderId, n);
        uint256 gasQuote = g - gasleft();
        assertEq(premium, Math.mulDiv(n * PREMIUM, 10_000 + s.extraBps, 10_000, Math.Rounding.Ceil), "widened");

        uint256 walletBefore = IERC20(TSLA).balanceOf(maker);
        uint256 virtualBefore = _virtual(TSLA);
        uint256 promisedBefore = writer.promised(TSLA);
        assertEq(promisedBefore, N * 1e18, "the order promises 50 TSLA, none moved");
        assertEq(IERC20(TSLA).balanceOf(address(book)), 0);

        deal(USDG, buyer, premium);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(book), premium);
        vm.expectEmit(AQUA);
        emit IAqua.Pulled(maker, address(writer), strategyHash, TSLA, n * 1e18);
        g = gasleft();
        book.buy(orderId, n, premium);
        uint256 gasBuy = g - gasleft();
        vm.stopPrank();

        assertEq(book.balanceOf(buyer, seriesId), n, "the buyer holds the calls");
        assertEq(IERC20(USDG).balanceOf(buyer), 0, "and paid the widened premium");
        assertEq(IERC20(USDG).balanceOf(address(book)), premium);
        assertEq(IERC20(TSLA).balanceOf(maker), walletBefore - n * 1e18, "from the maker's wallet");
        assertEq(IERC20(TSLA).balanceOf(address(book)), n * 1e18, "into the book's escrow");
        assertEq(_virtual(TSLA), virtualBefore - n * 1e18, "Aqua's balance of the strategy follows");
        assertEq(writer.promised(TSLA), promisedBefore - n * 1e18, "the promise became escrow");

        console2.log("10 calls: fixed premium / paid through the band (USDG)", _fmt(n * PREMIUM, 6), _fmt(premium, 6));
        console2.log("u (1e-4), extra bps", s.uWad / 1e14, s.extraBps);
        console2.log("gas, book.quotePremium through the band (cold)", gasQuote);
        console2.log("gas, book.buy of 10 calls through the band and Aqua", gasBuy);
    }

    // ------------------------------------------------------------------ pushing the reference

    /// @notice Push the hooked pool just past the band's edge (+5.1 % over the center) and buy, in one transaction:
    ///         refused `Paused(OutsideBand)`. Pushed back to where it was, in the same transaction, the book fills at
    ///         the same premium as before: the push never moved the center.
    function test_APushOfTheReferencePastTheBandPausesTheBook() public {
        StabilityBandPricer.Status memory s0 = band.status();
        uint160 target = _sqrtAtPrice(s0.centerWad * 10_510 / 10_000);
        bytes memory paused =
            abi.encodeWithSelector(StabilityBandPricer.Paused.selector, StabilityBandPricer.Reason.OutsideBand);

        vm.expectRevert(paused);
        pusher.pushAndBuy(target, book, orderId, 10);
        assertTrue(band.status().quoting, "the reverted push left nothing behind");

        (
            uint256 usdgIn,
            uint256 tslaBack,
            StabilityBandPricer.Status memory pushed,
            bytes memory refusal,
            uint256 premium
        ) = pusher.pushTryBackBuy(target, band, book, orderId, 10);
        assertEq(refusal, paused, "past the edge: Paused(OutsideBand)");
        assertFalse(pushed.quoting);
        assertGt(pushed.uWad, 1e18);
        assertEq(pushed.sizeCap, 0);
        assertEq(pushed.centerTick, s0.centerTick, "the push does not move the one-hour center");
        assertEq(premium, Math.mulDiv(10 * PREMIUM, 10_000 + s0.extraBps, 10_000, Math.Rounding.Ceil), "back: quoting");
        assertEq(book.balanceOf(address(pusher), seriesId), 10);
        assertTrue(band.status().quoting);

        console2.log("push to +5.1 % over the center took USDG", _fmt(usdgIn, 6));
        console2.log("push back took TSLA", _fmt(tslaBack, 18));
        console2.log("center / pushed price", _fmt(pushed.centerWad, 18), _fmt(pushed.currentWad, 18));
        console2.log("pushed u (1e-4)", pushed.uWad / 1e14);
        console2.log("pushed back: 10 calls filled for USDG", _fmt(premium, 6));
    }

    /// @notice Push halfway to the edge (+2.5 %): the book still quotes, but about half the contracts per call and
    ///         about +5 % on the fixed premium (maxExtra × u² = 20 % × 0.25).
    function test_InsideTheBandTheBookTapers() public {
        StabilityBandPricer.Status memory s0 = band.status();
        uint256 usdgIn = pusher.pushTo(_sqrtAtPrice(s0.centerWad * 10_250 / 10_000));

        StabilityBandPricer.Status memory s = band.status();
        assertTrue(s.quoting);
        assertEq(s.centerTick, s0.centerTick, "the center did not move");
        assertApproxEqAbs(s.uWad, 0.5e18, 0.01e18, "u = 0.5");
        assertApproxEqAbs(s.sizeCap, 25, 1, "cap = 50 x (1 - u)");
        assertApproxEqAbs(s.extraBps, 500, 20, "extra = 2000 bps x u^2");
        assertEq(s.sizeCap, band.sizeCapAt(s.uWad, 50));
        assertEq(s.extraBps, band.extraBpsAt(s.uWad, 2000));

        vm.expectRevert(abi.encodeWithSelector(StabilityBandPricer.SizeCapped.selector, s.sizeCap + 1, s.sizeCap));
        book.quotePremium(orderId, s.sizeCap + 1);

        uint256 n = 10;
        uint256 expected = Math.mulDiv(n * PREMIUM, 10_000 + s.extraBps, 10_000, Math.Rounding.Ceil);
        deal(USDG, buyer, expected);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(book), expected);
        book.buy(orderId, n, expected);
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(buyer), 0, "paid the fixed premium widened by extra(u)");
        assertEq(book.balanceOf(buyer, seriesId), n);

        console2.log("push to +2.5 % over the center took USDG", _fmt(usdgIn, 6));
        console2.log("u (1e-4), extra bps, size cap", s.uWad / 1e14, s.extraBps, s.sizeCap);
        console2.log("10 calls: fixed / paid (USDG)", _fmt(n * PREMIUM, 6), _fmt(expected, 6));
    }

    /// @notice The documented limitation, on the real hook: the band's center is a TWAP, so a push of the reference
    ///         that nobody trades back becomes the center. Pushed +6 % and held with no trading, the book is paused
    ///         at first, reopens (tapered) once the one-hour center has moved within 5 % of the pushed price, and an
    ///         hour later the pushed price is the center exactly. The hook's truncated series has moved only
    ///         MAX_ABS_TICK_DELTA ticks (one observation), but that is still inside a half-width of the raw center,
    ///         so `SeriesDisagree` does not fire either. What limits the maker then is its own premium, which a fixed
    ///         pricer does not move: the band only buys the maker the time to reprice.
    function test_APushOfTheReferenceThatStandsBecomesTheCenter() public {
        StabilityBandPricer.Status memory s0 = band.status();
        (, int24 tickBefore,,) = manager.getSlot0(id);
        uint256 usdgIn = pusher.pushTo(_sqrtAtPrice(s0.centerWad * 10_600 / 10_000));
        StabilityBandPricer.Status memory s = band.status();
        assertFalse(s.quoting, "at first the pushed price is outside the band");
        assertEq(uint8(s.reason), uint8(StabilityBandPricer.Reason.OutsideBand));
        (, int24 tickPushed,,) = manager.getSlot0(id);

        // Nobody trades. Minute by minute, the one-hour center walks toward the pushed price.
        uint256 t = vm.getBlockTimestamp();
        uint256 reopenedAfter;
        for (uint256 dt = 60; dt <= 3600; dt += 60) {
            vm.warp(t + dt);
            s = band.status();
            if (s.quoting) {
                reopenedAfter = dt;
                break;
            }
        }
        assertGt(reopenedAfter, 0, "the book reopens within the hour");
        assertLt(s.sizeCap, 5, "tapered near the edge");
        console2.log("+6 % push, held: book reopens after seconds", reopenedAfter);
        console2.log("  then u (1e-4), extra bps, size cap", s.uWad / 1e14, s.extraBps, s.sizeCap);

        vm.warp(t + 3600);
        s = band.status();
        assertTrue(s.quoting, "an hour later the book quotes around the pushed price");
        assertEq(s.centerTick, tickPushed, "the pushed price is the center");
        assertEq(s.currentTick, tickPushed);
        assertEq(
            s.truncatedCenterTick,
            tickBefore + HakariOracleHookCode.MAX_ABS_TICK_DELTA,
            "the truncated series moved one step of MAX_ABS_TICK_DELTA"
        );
        assertTrue(BandMath.within(s.truncatedCenterWad, s.centerWad, 500), "inside a half-width: no SeriesDisagree");

        console2.log("push to +6 % over the center took USDG", _fmt(usdgIn, 6));
        console2.log("tick before / pushed", _ticks(tickBefore, tickPushed));
        console2.log("an hour later: center tick raw / truncated", _ticks(s.centerTick, s.truncatedCenterTick));
        console2.log("an hour later: u (1e-4), extra bps, size cap", s.uWad / 1e14, s.extraBps, s.sizeCap);
    }

    // ------------------------------------------------------------------ settlement on the hook

    /// @notice `HookTwapExpiryPrice` bound to the hooked pool: a series expiring after the swap history settles, on
    ///         the book, at the hook's own five-minute TWAP, inside the band drawn from the half hour before it.
    function test_HookTwapSettlesOnTheRealHook() public {
        (HookTwapExpiryPrice src, OptionBook twapBook) = _twapBook();
        uint64 at = uint64(vm.getBlockTimestamp() + 60);
        uint256 sid = twapBook.createSeries(TSLA, USDG, strike, at, true);
        vm.warp(at);

        (int24 raw5,) = hook.twaps(id, 300);
        uint256 hookPrice = band.priceOf(TickMath.getSqrtPriceAtTick(raw5));
        HookTwapExpiryPrice.Attempt memory a = src.attempt(TSLA, USDG, at, 0);
        assertTrue(a.accepted, "the first window is inside the band");
        assertEq(a.settleTick, raw5, "the hook's own five-minute TWAP");
        assertEq(a.centerTick, _hookAvgTick(2100, 300), "the band: the hook's TWAP over the 30 min before");

        uint256 gasPriceAt = _gasOfPriceAt(src, at);
        uint256 settled = twapBook.settle(sid);
        assertEq(settled, hookPrice, "settled at the hook's TWAP");
        assertEq(src.priceAt(TSLA, USDG, at), hookPrice);

        console2.log("settle price / hook twaps(300), USDG per TSLA", _fmt(settled, 18), _fmt(hookPrice, 18));
        console2.log("settle tick / band center tick", _ticks(a.settleTick, a.centerTick));
        console2.log("gas, HookTwapExpiryPrice.priceAt, 1 attempt (cold)", gasPriceAt);
    }

    /// @notice A push through the five minutes before expiry (+6 %, held from expiry − 300 s to expiry): the first
    ///         window is outside the band, and the next one has not ended, so the book's `settle` reverts `NotYet`.
    ///         The pusher lets go at expiry; five minutes later the book settles on the next window, at the honest
    ///         price.
    function test_APushAtExpiryDefersSettlementOnTheRealHook() public {
        (HookTwapExpiryPrice src, OptionBook twapBook) = _twapBook();
        uint64 at = uint64(vm.getBlockTimestamp() + 600);
        uint256 sid = twapBook.createSeries(TSLA, USDG, strike, at, true);
        (uint160 sqrt0,,,) = manager.getSlot0(id);
        uint256 honest = band.priceOf(sqrt0);

        vm.warp(at - 300);
        uint256 usdgIn = pusher.pushTo(_sqrtAtPrice(honest * 10_600 / 10_000));

        vm.warp(at);
        HookTwapExpiryPrice.Attempt memory a0 = src.attempt(TSLA, USDG, at, 0);
        assertFalse(a0.accepted, "the pushed window is outside the band");
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NotYet.selector, at + 300));
        twapBook.settle(sid);

        // The pusher lets go at expiry.
        uint256 tslaBack = pusher.pushTo(sqrt0);
        vm.warp(at + 300);

        (int24 raw5,) = hook.twaps(id, 300);
        uint256 hookPrice = band.priceOf(TickMath.getSqrtPriceAtTick(raw5));
        HookTwapExpiryPrice.Attempt memory a1 = src.attempt(TSLA, USDG, at, 1);
        assertTrue(a1.accepted, "the next window is inside the band");
        assertEq(a1.settleTick, raw5, "the hook's own five-minute TWAP");
        assertEq(a1.centerTick, a0.centerTick, "held to the band drawn before expiry");

        uint256 gasPriceAt = _gasOfPriceAt(src, at);
        uint256 settled = twapBook.settle(sid);
        assertEq(settled, hookPrice, "settled on the next window");
        assertApproxEqRel(settled, honest, 1e14, "at the honest price, within a tick");

        console2.log("push through the last 5 min took USDG / back took TSLA", _fmt(usdgIn, 6), _fmt(tslaBack, 18));
        console2.log("window 0: settle / center price", _fmt(a0.priceWad, 18), _fmt(a0.centerWad, 18));
        console2.log("window 0: off the center, bps", BandMath.dist(a0.priceWad, a0.centerWad) * 10_000 / a0.centerWad);
        console2.log("window 1: settled / honest spot", _fmt(settled, 18), _fmt(honest, 18));
        console2.log("gas, HookTwapExpiryPrice.priceAt, 2 attempts (cold)", gasPriceAt);
    }

    // ------------------------------------------------------------------ helpers

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

    function _twapBook() internal returns (HookTwapExpiryPrice src, OptionBook twapBook) {
        src = new HookTwapExpiryPrice(address(this));
        src.setSource(
            manager,
            key,
            TSLA,
            USDG,
            HookTwapExpiryPrice.Params({
                settleWindow: 300,
                bandWindow: 1800,
                attempts: 6,
                halfWidthBps: 500,
                bandFromExpiry: true
            })
        );
        twapBook = new OptionBook(src, 1 days, 3 days);
        vm.label(address(src), "HookTwapExpiryPrice");
        vm.label(address(twapBook), "OptionBook (TWAP)");
    }

    function _gasOfPriceAt(HookTwapExpiryPrice src, uint64 at) internal returns (uint256 used) {
        vm.cool(address(src));
        vm.cool(address(hook));
        vm.cool(V4_POOL_MANAGER);
        uint256 g = gasleft();
        src.priceAt(TSLA, USDG, at);
        used = g - gasleft();
    }

    /// @dev The hook's raw TWAP tick over [now − fromAgo, now − toAgo].
    function _hookAvgTick(uint32 fromAgo, uint32 toAgo) internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = fromAgo;
        ago[1] = toAgo;
        (int56[] memory c,) = hook.observe(ago, id);
        return BandMath.avgTick(c[1] - c[0], fromAgo - toAgo);
    }

    function _swap(bool tslaIn, uint256 amountIn) internal {
        v4.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: tslaIn,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: tslaIn ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    /// @dev The pool's sqrtPriceX96 at a WAD USDG-per-TSLA price (TSLA is currency0).
    function _sqrtAtPrice(uint256 priceWad) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(priceWad, 1 << 192, SCALE)));
    }

    function _virtual(address token) internal view returns (uint256) {
        (uint248 balance,) = aqua.rawBalances(maker, address(writer), strategyHash, token);
        return balance;
    }

    function _ticks(int24 a, int24 b) internal pure returns (string memory) {
        return string.concat(vm.toString(int256(a)), " / ", vm.toString(int256(b)));
    }

    function _fmt(uint256 v, uint8 d) internal pure returns (string memory) {
        uint256 frac = (v % 10 ** d) * 10_000 / 10 ** d; // four decimals
        string memory pad = frac < 10 ? "000" : frac < 100 ? "00" : frac < 1000 ? "0" : "";
        return string.concat(vm.toString(v / 10 ** d), ".", pad, vm.toString(frac));
    }

    function _addrs(address a, address b) internal pure returns (address[] memory arr) {
        arr = new address[](2);
        arr[0] = a;
        arr[1] = b;
    }

    function _amts(uint256 a, uint256 b) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](2);
        arr[0] = a;
        arr[1] = b;
    }
}
