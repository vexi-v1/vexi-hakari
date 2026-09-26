// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { OptionBook } from "../src/book/OptionBook.sol";
import { FixedPremium } from "../src/book/FixedPremium.sol";
import { AquaWriter } from "../src/aqua/AquaWriter.sol";
import { FixedExpiryPrice } from "../src/price/FixedExpiryPrice.sol";

import { RobinhoodChain } from "./helpers/RobinhoodChain.sol";
import { AquaPrograms } from "./helpers/AquaPrograms.sol";

/// @notice The canonical contracts on a pinned fork of Robinhood Chain 4663, unmodified:
///         (a) a stock SwapVM strategy ships through canonical Aqua and fills through the deployed v1.0.2 router;
///         (b) an `OptionBook` buy pulls TSLA straight from a plain wallet through the `AquaWriter` app.
contract CanonicalAquaTest is Test, RobinhoodChain {
    IAqua internal constant aqua = IAqua(AQUA);
    ISwapVM internal constant router = ISwapVM(ROUTER);

    AquaPrograms internal programs;
    address internal maker = makeAddr("maker"); // a plain EOA, funded with real TSLA on the fork
    address internal taker = makeAddr("taker");
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        vm.createSelectFork(vm.envString("RH_MAINNET_RPC"), vm.envUint("RH_MAINNET_FORK_BLOCK"));
        programs = new AquaPrograms(AQUA);
        deal(TSLA, maker, 650e18);
        vm.label(AQUA, "Aqua");
        vm.label(ROUTER, "SwapVMRouter");
        vm.label(TSLA, "TSLA");
        vm.label(USDG, "USDG");
        vm.label(maker, "maker");
    }

    function _fund(address token, address to, uint256 amount) internal {
        deal(token, to, amount);
        assertEq(IERC20(token).balanceOf(to), amount, "deal failed");
    }

    function _two(address a, address b) internal pure returns (address[] memory arr) {
        arr = new address[](2);
        arr[0] = a;
        arr[1] = b;
    }

    function _two(uint256 a, uint256 b) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](2);
        arr[0] = a;
        arr[1] = b;
    }

    // ------------------------------------------------------------------ (a)

    function test_ShipStockStrategyAndFillThroughCanonicalRouter() public {
        uint256 shippedTsla = 100e18;
        uint256 shippedUsdg = 38_000e6;

        ISwapVM.Order memory order = programs.aquaOrder(maker, programs.xycProgram(1));
        bytes32 orderHash = router.hash(order);

        uint256 makerTslaBefore = IERC20(TSLA).balanceOf(maker);
        uint256 makerUsdgBefore = IERC20(USDG).balanceOf(maker);
        assertEq(makerTslaBefore, 650e18, "the maker EOA holds real TSLA on the fork");

        vm.startPrank(maker);
        IERC20(TSLA).approve(AQUA, type(uint256).max);
        IERC20(USDG).approve(AQUA, type(uint256).max);
        vm.expectEmit(AQUA);
        emit IAqua.Shipped(maker, ROUTER, orderHash, abi.encode(order));
        bytes32 strategyHash = aqua.ship(ROUTER, abi.encode(order), _two(TSLA, USDG), _two(shippedTsla, shippedUsdg));
        vm.stopPrank();

        assertEq(strategyHash, orderHash, "Aqua strategy hash == router order hash");
        assertEq(IERC20(TSLA).balanceOf(maker), makerTslaBefore, "ship moved no TSLA");
        assertEq(IERC20(USDG).balanceOf(maker), makerUsdgBefore, "ship moved no USDG");
        (uint256 vTsla, uint256 vUsdg) = aqua.safeBalances(maker, ROUTER, strategyHash, TSLA, USDG);
        assertEq(vTsla, shippedTsla);
        assertEq(vUsdg, shippedUsdg);

        // Taker sells 380 USDG for TSLA against the constant-product curve.
        uint256 amountIn = 380e6;
        uint256 expectedOut = amountIn * shippedTsla / (shippedUsdg + amountIn);
        _fund(USDG, taker, amountIn);
        bytes memory takerData = programs.takerData(taker, true);

        vm.startPrank(taker);
        IERC20(USDG).approve(ROUTER, amountIn);
        (uint256 quotedIn, uint256 quotedOut,) = router.quote(order, USDG, TSLA, amountIn, takerData);
        assertEq(quotedIn, amountIn);
        assertEq(quotedOut, expectedOut, "quote matches x*y=k");

        vm.expectEmit(AQUA);
        emit IAqua.Pulled(maker, ROUTER, strategyHash, TSLA, expectedOut);
        vm.expectEmit(AQUA);
        emit IAqua.Pushed(maker, ROUTER, strategyHash, USDG, amountIn);
        (uint256 amountInActual, uint256 amountOut,) = router.swap(order, USDG, TSLA, amountIn, takerData);
        vm.stopPrank();

        assertEq(amountInActual, amountIn);
        assertEq(amountOut, expectedOut, "swap matches x*y=k");
        assertEq(makerTslaBefore - IERC20(TSLA).balanceOf(maker), expectedOut, "maker wallet TSLA fell by amountOut");
        assertEq(IERC20(USDG).balanceOf(maker) - makerUsdgBefore, amountIn, "maker wallet USDG rose by amountIn");
        assertEq(IERC20(TSLA).balanceOf(taker), expectedOut, "taker holds amountOut TSLA");
        assertEq(IERC20(USDG).balanceOf(taker), 0, "taker spent all USDG");
        (vTsla, vUsdg) = aqua.safeBalances(maker, ROUTER, strategyHash, TSLA, USDG);
        assertEq(vTsla, shippedTsla - expectedOut, "virtual TSLA fell by amountOut");
        assertEq(vUsdg, shippedUsdg + amountIn, "virtual USDG rose by amountIn");
    }

    // ------------------------------------------------------------------ (b)

    function test_BuyPullsTslaFromMakerWalletThroughAquaWriter() public {
        FixedExpiryPrice price = new FixedExpiryPrice(address(this));
        price.setPrice(TSLA, USDG, 1); // the book refuses a series its price source does not cover
        OptionBook book = new OptionBook(price, 1 days, 3 days);
        FixedPremium premium = new FixedPremium(maker);
        AquaWriter writer = new AquaWriter(aqua, book, maker);
        vm.label(address(book), "OptionBook");
        vm.label(address(premium), "FixedPremium");
        vm.label(address(writer), "AquaWriter");

        AquaWriter.Strategy memory strategy = AquaWriter.Strategy({
            maker: maker,
            app: address(writer),
            base: TSLA,
            quote: USDG,
            salt: bytes32(uint256(1))
        });
        uint256 shippedTsla = 50e18;
        uint256 shippedUsdg = 20_000e6;
        uint256 makerTslaBefore = IERC20(TSLA).balanceOf(maker);

        vm.startPrank(maker);
        IERC20(TSLA).approve(AQUA, type(uint256).max);
        IERC20(USDG).approve(AQUA, type(uint256).max);
        bytes32 strategyHash =
            aqua.ship(address(writer), abi.encode(strategy), _two(TSLA, USDG), _two(shippedTsla, shippedUsdg));
        assertEq(writer.bind(strategy), strategyHash);
        uint64 expiry = uint64(block.timestamp + 1 days);
        uint256 seriesId = book.createSeries(TSLA, USDG, 400e18, expiry, true);
        premium.setPremium(seriesId, 5e6); // 5 USDG per contract
        uint256 orderId = writer.post(seriesId, premium, 10);
        vm.stopPrank();

        assertEq(IERC20(TSLA).balanceOf(maker), makerTslaBefore, "post moved no TSLA");
        assertEq(writer.promised(TSLA), 10e18, "10 calls promise 10 TSLA");
        assertEq(
            writer.available(seriesId, TSLA, TSLA),
            shippedTsla,
            "available = virtual balance (wallet and allowance are larger)"
        );
        assertEq(book.quotePremium(orderId, 5), 25e6, "the pricer asks 5 x 5 USDG");

        _fund(USDG, buyer, 25e6);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(book), 25e6);
        vm.expectEmit(AQUA);
        emit IAqua.Pulled(maker, address(writer), strategyHash, TSLA, 5e18);
        book.buy(orderId, 5, 25e6);
        vm.stopPrank();

        assertEq(makerTslaBefore - IERC20(TSLA).balanceOf(maker), 5e18, "exactly 5 TSLA left the maker's wallet");
        assertEq(IERC20(TSLA).balanceOf(address(book)), 5e18, "the book escrows 5 TSLA");
        assertEq(IERC20(USDG).balanceOf(address(book)), 25e6, "the book holds the premium");
        assertEq(book.balanceOf(buyer, seriesId), 5, "buyer holds 5 contracts");
        (uint248 vTsla,) = aqua.rawBalances(maker, address(writer), strategyHash, TSLA);
        assertEq(vTsla, shippedTsla - 5e18, "virtual TSLA fell by the escrow");
        assertEq(writer.promised(TSLA), 5e18, "5 unfilled calls still promise 5 TSLA");
    }
}
