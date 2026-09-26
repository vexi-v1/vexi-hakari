// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { stdError } from "forge-std/StdError.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { XYCSwap } from "@1inch/swap-vm/src/instructions/XYCSwap.sol";

import { OptionBook } from "../src/book/OptionBook.sol";
import { WriterSwapVMRouter } from "../src/swapvm/WriterSwapVMRouter.sol";
import { ExposureGuardExtruction } from "../src/swapvm/ExposureGuardExtruction.sol";

import { ForkFixture } from "./helpers/ForkFixture.sol";
import { WriterPrograms } from "./helpers/WriterPrograms.sol";
import { AquaPrograms } from "./helpers/AquaPrograms.sol";

/// @notice A subclassed router with the `ExposureGuard` instruction shrinks the spot strategy to the unpromised
///         balance without moving its price, so a spot fill can never take what an open option order has promised.
///         The same policy run as an `Extruction` on the canonical router quotes exactly the same numbers.
contract ExposureGuardTest is ForkFixture {
    uint256 internal constant SPOT_TSLA = 40e18;
    uint256 internal constant SPOT_USDG = 16_000e6; // 400 USDG per TSLA
    uint256 internal constant WALLET_TSLA = 30e18; // the wallet is made smaller than the virtual balance

    WriterSwapVMRouter internal router;
    WriterPrograms internal programs;
    address internal taker = makeAddr("taker");

    function setUp() public override {
        super.setUp();
        router = new WriterSwapVMRouter(AQUA, address(0), address(this), "Writer SwapVM", "1.0.2");
        programs = new WriterPrograms(AQUA);
        vm.label(address(router), "WriterSwapVMRouter");
        _shipAndBind();
        // Leave exactly 30 TSLA in the wallet so the guard has something to bind on.
        _giveTslaFromMaker(makeAddr("elsewhere"), _wallet(TSLA) - WALLET_TSLA);
        assertEq(_wallet(TSLA), WALLET_TSLA);
    }

    function _shipSpot(bool guarded, uint64 salt) internal returns (ISwapVM.Order memory order, bytes32 hash) {
        bytes memory program = guarded ? programs.guardedXycProgram(address(writer), salt) : programs.xycProgram(salt);
        order = programs.aquaOrder(maker, program);
        vm.prank(maker);
        hash = aqua.ship(address(router), abi.encode(order), _addrs(TSLA, USDG), _amts(SPOT_TSLA, SPOT_USDG));
        assertEq(hash, router.hash(order));
    }

    function _quote(ISwapVM.Order memory order, address tokenIn, address tokenOut, uint256 amount, bool isExactIn)
        internal
        view
        returns (uint256 amountIn, uint256 amountOut)
    {
        (amountIn, amountOut,) =
            ISwapVM(address(router)).quote(order, tokenIn, tokenOut, amount, programs.takerData(taker, isExactIn));
    }

    function _quoteOut(ISwapVM.Order memory order, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (uint256 out)
    {
        (, out) = _quote(order, tokenIn, tokenOut, amountIn, true);
    }

    function _xyc(uint256 amountIn, uint256 balanceIn, uint256 balanceOut) internal pure returns (uint256) {
        return amountIn * balanceOut / (balanceIn + amountIn);
    }

    /// @dev The pool the guard leaves behind when only `free` of `SPOT_TSLA` may be sold: same price, less depth.
    function _cappedIn(uint256 free) internal pure returns (uint256) {
        return Math.ceilDiv(SPOT_USDG * free, SPOT_TSLA);
    }

    // ------------------------------------------------------------------ table

    function test_OpcodeIsAppendedAfterTheAquaTable() public view {
        assertEq(router.exposureGuardOpcode(), 34, "AquaOpcodes has 34 opcodes (0..33); the guard is 34");
        assertEq(programs.opcodeOfExposureGuard(), 34);
        assertEq(programs.opcodeOfXycSwap(), 17, "xycSwap keeps its number from the deployed router");
    }

    function test_CapToFreeKeepsThePrice() public view {
        (uint256 bIn, uint256 bOut) = router.capToFree(SPOT_USDG, SPOT_TSLA, 20e18);
        assertEq(bOut, 20e18);
        assertEq(bIn, 8000e6, "16000 USDG / 40 TSLA becomes 8000 / 20: still 400 per TSLA");
        (bIn, bOut) = router.capToFree(SPOT_USDG, SPOT_TSLA, 50e18);
        assertEq(bIn, SPOT_USDG, "nothing to cap when free exceeds the pool");
        assertEq(bOut, SPOT_TSLA);
        (bIn, bOut) = router.capToFree(SPOT_USDG, SPOT_TSLA, 0);
        assertEq(bIn + bOut, 0, "nothing free: an empty pool");
    }

    // ------------------------------------------------------------------ depth, not price

    function test_GuardShrinksDepthToTheUnpromisedBalanceAtTheSamePrice() public {
        (ISwapVM.Order memory guarded, bytes32 guardedHash) = _shipSpot(true, 1);
        (ISwapVM.Order memory unguarded,) = _shipSpot(false, 2);

        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10); // 10 calls promise 10 TSLA; 20 of the 30 in the wallet are free
        assertEq(writer.promised(TSLA), 10e18);
        assertEq(router.unpromised(maker, TSLA, address(writer)), 20e18);

        // Same marginal price: a tiny trade gets the same rate on both, to within the pools' own slippage.
        uint256 tiny = 1e6;
        assertApproxEqRel(
            _quoteOut(guarded, USDG, TSLA, tiny), _quoteOut(unguarded, USDG, TSLA, tiny), 1e14, "same price for 1 USDG"
        );

        // Exactly the scaled pool for a real trade.
        uint256 amountIn = 400e6;
        uint256 unguardedOut = _xyc(amountIn, SPOT_USDG, SPOT_TSLA);
        uint256 guardedOut = _xyc(amountIn, _cappedIn(20e18), 20e18);
        assertEq(_quoteOut(unguarded, USDG, TSLA, amountIn), unguardedOut, "unguarded quotes the full virtual balance");
        assertEq(_quoteOut(guarded, USDG, TSLA, amountIn), guardedOut, "guarded quotes the pool shrunk to 20 TSLA");
        assertLt(guardedOut, unguardedOut, "less depth means more slippage");

        // Less depth: the guarded pool can hand out at most `free`, the unguarded one can take promised tokens.
        (uint256 inFor19,) = _quote(guarded, USDG, TSLA, 20e18 - 1, false);
        assertGt(inFor19, 0, "just under 20 TSLA is still quotable");
        bytes memory takerData = programs.takerData(taker, false);
        vm.expectRevert(stdError.divisionError); // the curve has exactly 20 TSLA: there is no price for all of them
        ISwapVM(address(router)).quote(guarded, USDG, TSLA, 20e18, takerData);
        (uint256 inFor25,) = _quote(unguarded, USDG, TSLA, 25e18, false);
        assertGt(inFor25, 0, "the unguarded twin would sell 25 TSLA, 5 of them promised to option buyers");

        // The taker fills the guarded strategy; the wallet loses exactly the quote.
        deal(USDG, taker, amountIn);
        uint256 walletBefore = _wallet(TSLA);
        vm.startPrank(taker);
        IERC20(USDG).approve(address(router), amountIn);
        vm.expectEmit(AQUA);
        emit IAqua.Pulled(maker, address(router), guardedHash, TSLA, guardedOut);
        (uint256 amountInActual, uint256 amountOut,) =
            router.swap(guarded, USDG, TSLA, amountIn, programs.takerData(taker, true));
        vm.stopPrank();
        assertEq(amountInActual, amountIn);
        assertEq(amountOut, guardedOut);
        assertEq(walletBefore - _wallet(TSLA), guardedOut);
        assertEq(IERC20(TSLA).balanceOf(taker), guardedOut);

        // And the option depth the buyer saw is still real: all 10 calls fill from the same wallet.
        _buyExpectPulled(buyer, orderId, 10, TSLA, 10e18);
        assertEq(_wallet(TSLA), WALLET_TSLA - guardedOut - 10e18);
    }

    function test_WithoutTheGuardASpotFillTakesWhatTheOptionsPromised() public {
        (ISwapVM.Order memory unguarded,) = _shipSpot(false, 2);
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10); // 10 TSLA promised out of 30

        // A taker buys 21 TSLA from the unguarded strategy: allowed, because nothing looks at the promise.
        (uint256 amountIn,) = _quote(unguarded, USDG, TSLA, 21e18, false);
        deal(USDG, taker, amountIn);
        vm.startPrank(taker);
        IERC20(USDG).approve(address(router), amountIn);
        router.swap(unguarded, USDG, TSLA, 21e18, programs.takerData(taker, false));
        vm.stopPrank();
        assertEq(_wallet(TSLA), 9e18, "only 9 TSLA are left for 10 promised calls");

        // The option buyer who saw 10 contracts of depth now gets refused.
        assertEq(writer.available(seriesId, TSLA, TSLA), 9e18);
        _addUsdg(buyer, 10 * PREMIUM);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(book), 10 * PREMIUM);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.SourceShort.selector, orderId, 9e18, 10e18));
        book.buy(orderId, 10, 10 * PREMIUM);
        vm.stopPrank();
    }

    function test_GuardQuotesNothingWhenEverythingIsPromised() public {
        (ISwapVM.Order memory guarded,) = _shipSpot(true, 1);
        (ISwapVM.Order memory unguarded,) = _shipSpot(false, 2);
        uint256 seriesId = _series(true);
        _post(seriesId, 30); // promise the whole wallet
        assertEq(router.unpromised(maker, TSLA, address(writer)), 0);

        uint256 amountIn = 400e6;
        assertEq(
            _quoteOut(unguarded, USDG, TSLA, amountIn), _xyc(amountIn, SPOT_USDG, SPOT_TSLA), "unguarded still quotes"
        );
        bytes memory takerData = programs.takerData(taker, true);
        vm.expectRevert(abi.encodeWithSelector(XYCSwap.XYCSwapRequiresBothBalancesNonZero.selector, 0, 0));
        ISwapVM(address(router)).quote(guarded, USDG, TSLA, amountIn, takerData);

        // The other side is untouched: buying TSLA from the taker only needs USDG, which nothing has promised.
        assertEq(_quoteOut(guarded, TSLA, USDG, 1e18), _xyc(1e18, SPOT_TSLA, SPOT_USDG), "TSLA -> USDG is not capped");
    }

    function test_GuardFollowsFillsAndReleases() public {
        (ISwapVM.Order memory guarded,) = _shipSpot(true, 1);
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10);
        uint256 amountIn = 400e6;
        assertEq(
            _quoteOut(guarded, USDG, TSLA, amountIn), _xyc(amountIn, _cappedIn(20e18), 20e18), "30 wallet - 10 promised"
        );

        _buy(buyer, orderId, 5); // 5 became escrow: wallet 25, promised 5, free still 20
        assertEq(_wallet(TSLA), 25e18);
        assertEq(writer.promised(TSLA), 5e18);
        assertEq(
            _quoteOut(guarded, USDG, TSLA, amountIn),
            _xyc(amountIn, _cappedIn(20e18), 20e18),
            "a fill moves promise to escrow, free is unchanged"
        );

        vm.prank(maker);
        writer.release(orderId); // promise dropped: free = wallet = 25
        assertEq(writer.promised(TSLA), 0);
        assertEq(
            _quoteOut(guarded, USDG, TSLA, amountIn),
            _xyc(amountIn, _cappedIn(25e18), 25e18),
            "free = wallet once nothing is promised"
        );
    }

    function test_GuardCapsTheQuoteSideForPuts() public {
        (ISwapVM.Order memory guarded,) = _shipSpot(true, 1);
        uint256 seriesId = _series(false);
        _post(seriesId, 20); // 20 puts at 400 promise 8000 USDG of the 20000 in the wallet
        assertEq(writer.promised(USDG), 8000e6);
        assertEq(router.unpromised(maker, USDG, address(writer)), 12_000e6);

        uint256 amountIn = 1e18; // taker sells 1 TSLA for USDG
        uint256 cappedTsla = Math.ceilDiv(SPOT_TSLA * 12_000e6, SPOT_USDG);
        assertEq(
            _quoteOut(guarded, TSLA, USDG, amountIn),
            _xyc(amountIn, cappedTsla, 12_000e6),
            "USDG side shrunk to wallet - promised at the same price"
        );
    }

    // ------------------------------------------------------------------ instruction == extruction

    function test_InstructionAndExtructionAgreeOnTheSameState() public {
        ExposureGuardExtruction guard = new ExposureGuardExtruction();
        AquaPrograms canonicalPrograms = new AquaPrograms(AQUA);
        (ISwapVM.Order memory native,) = _shipSpot(true, 1);
        ISwapVM.Order memory viaExtruction = canonicalPrograms.aquaOrder(
            maker, canonicalPrograms.extructionGuardedXycProgram(address(guard), address(writer), 3)
        );
        vm.prank(maker);
        aqua.ship(ROUTER, abi.encode(viaExtruction), _addrs(TSLA, USDG), _amts(SPOT_TSLA, SPOT_USDG));
        _post(_series(true), 10);

        uint256[4] memory amounts = [uint256(1e6), 400e6, 5000e6, 40_000e6];
        for (uint256 i = 0; i < amounts.length; i++) {
            (, uint256 nativeOut,) =
                ISwapVM(address(router)).quote(native, USDG, TSLA, amounts[i], programs.takerData(taker, true));
            (, uint256 extructionOut,) =
                ISwapVM(ROUTER).quote(viaExtruction, USDG, TSLA, amounts[i], canonicalPrograms.takerData(taker, true));
            assertEq(nativeOut, extructionOut, "same registers, same quote, on two routers");
            assertEq(nativeOut, _xyc(amounts[i], _cappedIn(20e18), 20e18));
        }
        (, uint256 nativeBid,) =
            ISwapVM(address(router)).quote(native, TSLA, USDG, 1e18, programs.takerData(taker, true));
        (, uint256 extructionBid,) =
            ISwapVM(ROUTER).quote(viaExtruction, TSLA, USDG, 1e18, canonicalPrograms.takerData(taker, true));
        assertEq(nativeBid, extructionBid, "and on the uncapped side");

        // Exact-out too: the same USDG is asked for 7 TSLA on both routers, and the swap on ours pays exactly it.
        (uint256 nativeIn,,) =
            ISwapVM(address(router)).quote(native, USDG, TSLA, 7e18, programs.takerData(taker, false));
        (uint256 extructionIn,,) =
            ISwapVM(ROUTER).quote(viaExtruction, USDG, TSLA, 7e18, canonicalPrograms.takerData(taker, false));
        assertEq(nativeIn, extructionIn, "exact-out agrees too");
        assertEq(nativeIn, Math.ceilDiv(7e18 * _cappedIn(20e18), 20e18 - 7e18), "and equals the shrunk curve");
        deal(USDG, taker, nativeIn);
        vm.startPrank(taker);
        IERC20(USDG).approve(address(router), nativeIn);
        (uint256 paid, uint256 got,) = router.swap(native, USDG, TSLA, 7e18, programs.takerData(taker, false));
        vm.stopPrank();
        assertEq(paid, nativeIn, "the exact-out swap pays the quoted USDG");
        assertEq(got, 7e18);
    }
}
