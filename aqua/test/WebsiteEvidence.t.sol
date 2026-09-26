// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import {AquaWriter} from "../src/aqua/AquaWriter.sol";
import {BandMath} from "../src/band/BandMath.sol";
import {HookTwapExpiryPrice} from "../src/band/HookTwapExpiryPrice.sol";
import {StabilityBandPricer} from "../src/band/StabilityBandPricer.sol";
import {FixedPremium} from "../src/book/FixedPremium.sol";
import {OptionBook} from "../src/book/OptionBook.sol";
import {Vm} from "forge-std/Vm.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {ExposureGuardExtruction} from "../src/swapvm/ExposureGuardExtruction.sol";
import {AquaPrograms} from "./helpers/AquaPrograms.sol";
import {IHakariOracleHook, ReferencePusher} from "./StabilityBandFork.t.sol";

import {RobinhoodChain} from "./helpers/RobinhoodChain.sol";
import {UniswapV4Robinhood} from "./helpers/UniswapV4Robinhood.sol";
import {HakariOracleHookCode} from "./helpers/HakariOracleHookCode.sol";

/// @notice One continuous public demonstration, plus independent adverse scenarios. All calls execute in a local
/// fork EVM. No transaction is broadcast. Synthetic accounts and reference history are explicit fixture inputs.
/// Aqua — © Degensoft Ltd 2025. Powered by SwapVM — © Degensoft Ltd 2025.
contract WebsiteEvidenceTest is Test, RobinhoodChain, UniswapV4Robinhood {
    using StateLibrary for IPoolManager;

    IPoolManager internal constant manager = IPoolManager(V4_POOL_MANAGER);
    IAqua internal constant aqua = IAqua(AQUA);
    ISwapVM internal constant router = ISwapVM(ROUTER);
    IHakariOracleHook internal constant hook = IHakariOracleHook(HakariOracleHookCode.ADDRESS);
    uint256 internal constant SCALE = 1e30;
    uint256 internal constant HISTORY_TSLA_LEG = 5e18;
    PoolKey internal key;
    PoolId internal id;
    PoolSwapTest internal v4;
    PoolModifyLiquidityTest internal lp;
    ReferencePusher internal pusher;
    uint128 internal realLiquidity;
    HookTwapExpiryPrice internal expiryPrice;
    OptionBook internal book;
    AquaWriter internal writer;
    FixedPremium internal fixedPremium;
    StabilityBandPricer internal band;
    AquaPrograms internal programs;
    ISwapVM.Order internal spotOrder;
    bytes32 internal strategyHash;
    bytes32 internal spotHash;
    address internal maker = makeAddr("website-maker");
    address internal buyer = makeAddr("website-buyer");
    address internal taker = makeAddr("website-spot-taker");
    uint256 internal callId;
    uint256 internal putId;
    uint256 internal callOrder;
    uint256 internal putOrder;
    uint64 internal expiry;
    uint64 internal deadline;
    string[] internal steps;
    bool internal exporting;

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

        exporting = vm.envOr("EXPORT_WEBSITE", false);
        expiryPrice = new HookTwapExpiryPrice(address(this));
        expiryPrice.setSource(manager, key, TSLA, USDG, HookTwapExpiryPrice.Params(300, 1800, 6, 500, true));
        book = new OptionBook(expiryPrice, 600, 3600);
        writer = new AquaWriter(aqua, book, maker);
        fixedPremium = new FixedPremium(maker);
        band = new StabilityBandPricer(
            fixedPremium, manager, key, TSLA, USDG, StabilityBandPricer.Params(3600, 0, 500, 2000, 50, 0), maker
        );
        programs = new AquaPrograms(AQUA);
        ExposureGuardExtruction guard = new ExposureGuardExtruction();
        spotOrder = programs.aquaOrder(maker, programs.extructionGuardedXycProgram(address(guard), address(writer), 1));
        vm.label(address(book), "OptionBook");
        vm.label(address(writer), "AquaWriter");
        vm.label(address(band), "StabilityBandPricer");
        vm.label(address(fixedPremium), "FixedPremium");
        vm.label(address(expiryPrice), "HookTwapExpiryPrice");
        vm.label(ROUTER, "CanonicalSwapVMRouter");
        vm.label(maker, "Maker");
        vm.label(buyer, "OptionBuyer");
        vm.label(taker, "SpotTaker");
        deal(TSLA, maker, 30e18);
        deal(USDG, maker, 20_000e6);
        deal(TSLA, buyer, 10e18);
        deal(USDG, buyer, 10_000e6);
        deal(USDG, taker, 400e6);
        expiry = uint64(vm.getBlockTimestamp() + 7200);
        deadline = uint64(vm.getBlockTimestamp() + 600);
        callId = book.createSeries(TSLA, USDG, 400e18, expiry, true);
        putId = book.createSeries(TSLA, USDG, 400e18, expiry, false);
        vm.startPrank(buyer);
        IERC20(TSLA).approve(address(book), type(uint256).max);
        IERC20(USDG).approve(address(book), type(uint256).max);
        vm.stopPrank();
        vm.recordLogs();
    }

    function _shipAndPost() internal {
        AquaWriter.Strategy memory strategy =
            AquaWriter.Strategy(maker, address(writer), TSLA, USDG, bytes32(uint256(7)));
        vm.startPrank(maker);
        IERC20(TSLA).approve(AQUA, type(uint256).max);
        IERC20(USDG).approve(AQUA, type(uint256).max);
        strategyHash = aqua.ship(address(writer), abi.encode(strategy), _addrs(TSLA, USDG), _amts(30e18, 20_000e6));
        writer.bind(strategy);
        spotHash = aqua.ship(ROUTER, abi.encode(spotOrder), _addrs(TSLA, USDG), _amts(40e18, 16_000e6));
        vm.stopPrank();
        assertEq(spotHash, router.hash(spotOrder));
        assertEq(IERC20(TSLA).balanceOf(maker), 30e18);
        assertEq(IERC20(USDG).balanceOf(maker), 20_000e6);
        _step("ship", "Two virtual strategies; no token transfer");
        vm.startPrank(maker);
        fixedPremium.setAnchoredPremium(callId, 8e6, deadline, band, 500);
        fixedPremium.setAnchoredPremium(putId, 8e6, deadline, band, 500);
        callOrder = writer.post(callId, band, 10);
        putOrder = writer.post(putId, band, 10);
        vm.stopPrank();
        assertEq(writer.promised(TSLA), 10e18);
        assertEq(writer.promised(USDG), 4000e6);
        assertEq(IERC20(TSLA).balanceOf(address(book)), 0);
        assertEq(IERC20(USDG).balanceOf(address(book)), 0);
        _step("post", "10 covered calls and 10 cash-secured puts promised");
    }

    function _buy() internal {
        uint256 t = IERC20(TSLA).balanceOf(maker);
        uint256 q = IERC20(USDG).balanceOf(maker);
        vm.startPrank(buyer);
        book.buy(callOrder, 5, type(uint256).max);
        book.buy(putOrder, 3, type(uint256).max);
        vm.stopPrank();
        assertEq(t - IERC20(TSLA).balanceOf(maker), 5e18);
        assertEq(q - IERC20(USDG).balanceOf(maker), 1200e6);
        assertEq(book.balanceOf(buyer, callId), 5);
        assertEq(book.balanceOf(buyer, putId), 3);
        _step("buy", "5 calls + 3 puts: Aqua pulls 5 TSLA and 1,200 USDG");
    }

    function test_WebsiteLifecycle() public {
        _step("initial", "One maker wallet, before shipping");
        _shipAndPost();
        uint256 t = IERC20(TSLA).balanceOf(maker);
        vm.startPrank(taker);
        IERC20(USDG).approve(ROUTER, 400e6);
        (, uint256 out,) = router.swap(spotOrder, USDG, TSLA, 400e6, programs.takerData(taker, true));
        vm.stopPrank();
        assertEq(out, uint256(400e6) * 20e18 / (8000e6 + 400e6));
        assertEq(t - IERC20(TSLA).balanceOf(maker), out);
        assertGe(IERC20(TSLA).balanceOf(maker), writer.promised(TSLA));
        _step("spot", "Guarded canonical SwapVM swap uses only unpromised inventory");
        _buy();
        (uint160 original,,,) = manager.getSlot0(id);
        uint256 center = band.status().centerWad;
        pusher.pushTo(_sqrtAtPrice(center * 10_250 / 10_000));
        assertTrue(band.status().quoting);
        assertLe(band.status().sizeCap, 26);
        assertGe(band.status().sizeCap, 24);
        assertGt(book.quotePremium(callOrder, 1), 8e6);
        _step("taper", "+2.5%: less size and a wider premium");
        pusher.pushTo(_sqrtAtPrice(center * 10_510 / 10_000));
        uint256 buyerBefore = IERC20(USDG).balanceOf(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(StabilityBandPricer.Paused.selector, StabilityBandPricer.Reason.OutsideBand)
        );
        vm.prank(buyer);
        book.buy(callOrder, 1, type(uint256).max);
        assertEq(IERC20(USDG).balanceOf(buyer), buyerBefore);
        assertEq(book.balanceOf(buyer, callId), 5);
        _step("pause", "+5.1%: a real buy is refused; funds unchanged");
        pusher.pushTo(original);
        assertGt(book.quotePremium(callOrder, 1), 0);
        _step("recover", "Reference returns; a fresh quote is available");
        vm.warp(deadline);
        assertTrue(band.status().quoting);
        vm.expectRevert(abi.encodeWithSelector(FixedPremium.QuoteExpired.selector, callId, deadline));
        vm.prank(buyer);
        book.buy(callOrder, 1, type(uint256).max);
        assertEq(IERC20(USDG).balanceOf(buyer), buyerBefore);
        _step("expired", "Band recovered, but the original quote has expired");
        vm.startPrank(maker);
        fixedPremium.setAnchoredPremium(callId, 8e6, expiry, band, 500);
        fixedPremium.setAnchoredPremium(putId, 8e6, expiry, band, 500);
        vm.stopPrank();
        assertGt(book.quotePremium(callOrder, 1), 0);
        _step("renew", "Only an explicit maker update renews the quote");
        vm.warp(expiry);
        assertTrue(expiryPrice.attempt(TSLA, USDG, expiry, 0).accepted);
        expiryPrice.record(TSLA, USDG, expiry);
        uint256 price = book.settle(callId);
        assertEq(book.settle(putId), price);
        assertLt(price, 400e18, "fixture: put ITM, call OTM");
        _step("settle", "First five-minute window accepted and recorded");
        vm.prank(buyer);
        book.exercise(putId, 3);
        assertEq(book.balanceOf(buyer, putId), 0);
        assertEq(IERC20(TSLA).balanceOf(buyer), 7e18);
        _step("exercise", "Physical put exercise: deliver 3 TSLA, receive 1,200 USDG");
        vm.warp(expiry + 601);
        (uint256 collateral, uint256 proceeds) = book.close(callOrder);
        assertEq(collateral, 5e18);
        assertEq(proceeds, 0);
        (collateral, proceeds) = book.close(putOrder);
        assertEq(collateral, 0);
        assertEq(proceeds, 3e18);
        _step("close", "Aqua pushes 5 unused TSLA + 3 exercise TSLA to the maker");
        uint256 q = IERC20(USDG).balanceOf(maker);
        uint256 premiums = writer.claimPremium(callOrder) + writer.claimPremium(putOrder);
        assertEq(IERC20(USDG).balanceOf(maker) - q, premiums);
        assertEq(IERC20(TSLA).balanceOf(address(book)), 0);
        assertEq(IERC20(USDG).balanceOf(address(book)), 0);
        _step("premium", "Premiums are claimed separately through Aqua");
        writer.release(callOrder);
        writer.release(putOrder);
        assertEq(writer.promised(TSLA), 0);
        assertEq(writer.promised(USDG), 0);
        _step("release", "Expired unfilled promises released; the wallet is reusable");
        _export("lifecycle");
    }

    function test_WebsiteUnguarded() public {
        _shipAndPost();
        ISwapVM.Order memory unguarded = programs.aquaOrder(maker, programs.xycProgram(2));
        vm.prank(maker);
        aqua.ship(ROUTER, abi.encode(unguarded), _addrs(TSLA, USDG), _amts(40e18, 16_000e6));
        // This independent adverse scenario funds its taker for an exact-output 21 TSLA swap.
        deal(USDG, taker, 50_000e6);
        vm.startPrank(taker);
        IERC20(USDG).approve(ROUTER, type(uint256).max);
        router.swap(unguarded, USDG, TSLA, 21e18, programs.takerData(taker, false));
        vm.stopPrank();
        assertEq(IERC20(TSLA).balanceOf(maker), 9e18);
        uint256 before = IERC20(USDG).balanceOf(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(OptionBook.SourceShort.selector, callOrder, uint256(9e18), uint256(10e18))
        );
        vm.prank(buyer);
        book.buy(callOrder, 10, type(uint256).max);
        assertEq(IERC20(USDG).balanceOf(buyer), before);
        assertEq(book.balanceOf(buyer, callId), 0);
        _step("unguarded", "An unguarded spot swap takes 21 TSLA; a 10-call fill now refuses");
        _export("unguarded");
    }

    function test_WebsiteAnchor() public {
        _shipAndPost();
        vm.prank(maker);
        fixedPremium.setAnchoredPremium(callId, 8e6, expiry, band, 500);
        uint256 before = IERC20(USDG).balanceOf(buyer);
        uint256 original = band.referencePriceWad();
        pusher.pushTo(_sqrtAtPrice(original * 10_600 / 10_000));
        _step("anchor-push", "A sustained 6% reference move");
        vm.warp(vm.getBlockTimestamp() + 3601);
        assertTrue(band.status().quoting, "rolling band recovers");
        vm.expectRevert(
            abi.encodeWithSelector(FixedPremium.QuoteOffAnchor.selector, callId, band.referencePriceWad(), original)
        );
        vm.prank(buyer);
        book.buy(callOrder, 1, type(uint256).max);
        assertEq(IERC20(USDG).balanceOf(buyer), before);
        assertEq(book.balanceOf(buyer, callId), 0);
        _step("anchor-refused", "Rolling TWAP catches up; the original anchor still refuses");
        _export("anchor");
    }

    function test_WebsiteDelayedSettlement() public {
        _shipAndPost();
        _buy();
        (uint160 original,,,) = manager.getSlot0(id);
        vm.warp(expiry - 300);
        pusher.pushTo(_sqrtAtPrice(band.referencePriceWad() * 10_600 / 10_000));
        vm.warp(expiry);
        assertFalse(expiryPrice.attempt(TSLA, USDG, expiry, 0).accepted);
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NotYet.selector, expiry + 300));
        book.settle(callId);
        _step("deferred", "Window 0 refused; window 1 is not complete");
        pusher.pushTo(original);
        vm.warp(expiry + 300);
        assertTrue(expiryPrice.attempt(TSLA, USDG, expiry, 1).accepted);
        expiryPrice.record(TSLA, USDG, expiry);
        book.settle(callId);
        book.settle(putId);
        _step("later-window", "Window 1 accepted at a later price; this changes expiry economics");
        _export("delayed");
    }

    function test_WebsiteNoWindowRefund() public {
        _shipAndPost();
        _buy();
        vm.warp(expiry - 300);
        pusher.pushTo(_sqrtAtPrice(band.referencePriceWad() * 11_000 / 10_000));
        vm.warp(expiry + 1500);
        for (uint16 i = 0; i < 6; i++) {
            assertFalse(expiryPrice.attempt(TSLA, USDG, expiry, i).accepted);
        }
        vm.expectRevert(abi.encodeWithSelector(HookTwapExpiryPrice.NoWindowInBand.selector, expiry, uint16(6)));
        book.settle(callId);
        _step("no-window", "All six windows refused; collateral waits for the grace deadline");
        vm.warp(expiry + 3601);
        book.close(callOrder);
        book.close(putOrder);
        vm.startPrank(buyer);
        book.refund(callId, 5);
        book.refund(putId, 3);
        vm.stopPrank();
        writer.release(callOrder);
        writer.release(putOrder);
        assertEq(IERC20(TSLA).balanceOf(maker), 30e18);
        assertEq(IERC20(USDG).balanceOf(maker), 20_000e6);
        assertEq(IERC20(USDG).balanceOf(buyer), 10_000e6);
        assertEq(IERC20(USDG).balanceOf(address(book)), 0);
        assertEq(book.balanceOf(buyer, callId), 0);
        assertEq(book.balanceOf(buyer, putId), 0);
        _step("refund", "Collateral returned; holders receive pooled premium refunds");
        _export("refund");
    }

    // Integers are strings: the browser must never round token balances or series ids through IEEE-754.
    function _num(string memory k, string memory field, uint256 value) internal {
        vm.serializeString(k, field, vm.toString(value));
    }

    function _step(string memory name, string memory title) internal {
        if (!exporting) return;
        string memory k = string.concat("step-", vm.toString(steps.length));
        vm.serializeString(k, "id", name);
        vm.serializeString(k, "title", title);
        _num(k, "timestamp", vm.getBlockTimestamp());
        _num(k, "makerTsla", IERC20(TSLA).balanceOf(maker));
        _num(k, "makerUsdg", IERC20(USDG).balanceOf(maker));
        _num(k, "buyerTsla", IERC20(TSLA).balanceOf(buyer));
        _num(k, "buyerUsdg", IERC20(USDG).balanceOf(buyer));
        _num(k, "takerTsla", IERC20(TSLA).balanceOf(taker));
        _num(k, "takerUsdg", IERC20(USDG).balanceOf(taker));
        _num(k, "bookTsla", IERC20(TSLA).balanceOf(address(book)));
        _num(k, "bookUsdg", IERC20(USDG).balanceOf(address(book)));
        _num(k, "promisedTsla", writer.promised(TSLA));
        _num(k, "promisedUsdg", writer.promised(USDG));
        (uint248 vt,) = aqua.rawBalances(maker, address(writer), strategyHash, TSLA);
        (uint248 vq,) = aqua.rawBalances(maker, address(writer), strategyHash, USDG);
        _num(k, "optionVirtualTsla", vt);
        _num(k, "optionVirtualUsdg", vq);
        (vt,) = aqua.rawBalances(maker, ROUTER, spotHash, TSLA);
        (vq,) = aqua.rawBalances(maker, ROUTER, spotHash, USDG);
        _num(k, "spotVirtualTsla", vt);
        _num(k, "spotVirtualUsdg", vq);
        _num(k, "callLong", book.balanceOf(buyer, callId));
        _num(k, "putLong", book.balanceOf(buyer, putId));
        (bool settled,, uint256 price,,,,,) = book.settlements(callId);
        vm.serializeBool(k, "settled", settled);
        _num(k, "settlementPrice", price);
        _num(k, "recordedPrice", expiryPrice.recorded(TSLA, USDG, expiry));
        StabilityBandPricer.Status memory s = band.status();
        vm.serializeBool(k, "bandQuoting", s.quoting);
        _num(k, "bandReason", uint256(s.reason));
        _num(k, "center", s.centerWad);
        _num(k, "current", s.currentWad);
        _num(k, "truncatedCenter", s.truncatedCenterWad);
        _num(k, "u", s.uWad);
        _num(k, "extraBps", s.extraBps);
        _num(k, "cap", s.sizeCap);
        bool quoteAvailable;
        uint256 quoted;
        bytes memory refusal;
        if (callOrder != 0 && vm.getBlockTimestamp() < expiry) {
            try book.quotePremium(callOrder, 1) returns (uint256 value) {
                quoteAvailable = true;
                quoted = value;
            } catch (bytes memory reason) {
                refusal = reason;
            }
        }
        vm.serializeBool(k, "quoteAvailable", quoteAvailable);
        _num(k, "quoteOne", quoted);
        vm.serializeBytes(k, "quoteRefusal", refusal);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        string memory rawLogs = "[";
        for (uint256 i = 0; i < logs.length; i++) {
            string memory ek = string.concat(k, "-log-", vm.toString(i));
            vm.serializeAddress(ek, "emitter", logs[i].emitter);
            vm.serializeBytes32(ek, "topics", logs[i].topics);
            string memory eventJson = vm.serializeBytes(ek, "data", logs[i].data);
            rawLogs = string.concat(rawLogs, i == 0 ? "" : ",", eventJson);
        }
        string memory json = vm.serializeString(k, "logs", string.concat(rawLogs, "]"));
        steps.push(json);
        vm.recordLogs();
    }

    function _export(string memory scenario) internal {
        if (!exporting) return;
        string memory k = "evidence";
        vm.serializeString(k, "scenario", scenario);
        vm.serializeAddress(k, "maker", maker);
        vm.serializeAddress(k, "buyer", buyer);
        vm.serializeAddress(k, "taker", taker);
        vm.serializeAddress(k, "book", address(book));
        vm.serializeAddress(k, "writer", address(writer));
        vm.serializeAddress(k, "band", address(band));
        vm.serializeAddress(k, "aqua", AQUA);
        vm.serializeAddress(k, "router", ROUTER);
        vm.serializeAddress(k, "poolManager", V4_POOL_MANAGER);
        vm.serializeAddress(k, "hook", address(hook));
        vm.serializeAddress(k, "tsla", TSLA);
        vm.serializeAddress(k, "usdg", USDG);
        vm.serializeBytes32(k, "poolId", PoolId.unwrap(id));
        vm.serializeBytes32(k, "hookCodeHash", address(hook).codehash);
        _num(k, "expiry", expiry);
        _num(k, "strike", 400e18);
        _num(k, "callSeries", callId);
        _num(k, "putSeries", putId);
        string memory arr = "[";
        for (uint256 i = 0; i < steps.length; i++) {
            arr = string.concat(arr, i == 0 ? "" : ",", steps[i]);
        }
        string memory json = vm.serializeString(k, "steps", string.concat(arr, "]"));
        vm.writeJson(json, string.concat("deployments/website-", scenario, ".json"));
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
