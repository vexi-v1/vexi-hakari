// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { OptionBook } from "../../src/book/OptionBook.sol";
import { FixedPremium } from "../../src/book/FixedPremium.sol";
import { AquaWriter } from "../../src/aqua/AquaWriter.sol";
import { FixedExpiryPrice } from "../../src/price/FixedExpiryPrice.sol";

import { RobinhoodChain } from "./RobinhoodChain.sol";

/// @notice Pinned fork of 4663 with an OptionBook, a FixedPremium pricer and an AquaWriter both owned by a funded
///         plain address, and a strategy ready to ship and bind.
abstract contract ForkFixture is Test, RobinhoodChain {
    IAqua internal constant aqua = IAqua(AQUA);

    uint256 internal constant SHIP_TSLA = 50e18;
    uint256 internal constant SHIP_USDG = 20_000e6;
    uint256 internal constant STRIKE = 400e18; // 400 USDG per TSLA
    uint256 internal constant PREMIUM = 5e6; // 5 USDG per contract
    uint64 internal constant WINDOW = 1 days;
    uint64 internal constant GRACE = 3 days;

    FixedExpiryPrice internal price;
    OptionBook internal book;
    FixedPremium internal premium;
    AquaWriter internal writer;
    AquaWriter.Strategy internal strategy;
    bytes32 internal strategyHash;

    /// @dev A plain address funded on the fork. Real TSLA and USDG (proxies), no impersonation of anyone.
    address internal maker = makeAddr("maker");
    address internal buyer = makeAddr("buyer");
    address internal buyer2 = makeAddr("buyer2");
    uint64 internal expiry;

    function setUp() public virtual {
        vm.createSelectFork(vm.envString("RH_MAINNET_RPC"), vm.envUint("RH_MAINNET_FORK_BLOCK"));
        vm.label(AQUA, "Aqua");
        vm.label(TSLA, "TSLA");
        vm.label(USDG, "USDG");
        vm.label(maker, "maker");

        price = new FixedExpiryPrice(address(this));
        price.setPrice(TSLA, USDG, 1); // covered; each test sets the price it settles at
        book = new OptionBook(price, WINDOW, GRACE);
        premium = new FixedPremium(maker);
        writer = new AquaWriter(aqua, book, maker);
        vm.label(address(book), "OptionBook");
        vm.label(address(premium), "FixedPremium");
        vm.label(address(writer), "AquaWriter");

        // The maker's wallet: 650 TSLA and 20,000 USDG, written into the real token contracts' storage.
        deal(TSLA, maker, 650e18);
        deal(USDG, maker, SHIP_USDG);
        assertEq(IERC20(TSLA).balanceOf(maker), 650e18, "deal TSLA to maker");
        assertEq(IERC20(USDG).balanceOf(maker), SHIP_USDG, "deal USDG to maker");

        strategy = AquaWriter.Strategy({
            maker: maker,
            app: address(writer),
            base: TSLA,
            quote: USDG,
            salt: bytes32(uint256(7))
        });
        expiry = uint64(block.timestamp + 7 days);
    }

    // ------------------------------------------------------------------ maker actions

    function _approveAqua() internal {
        vm.startPrank(maker);
        IERC20(TSLA).approve(AQUA, type(uint256).max);
        IERC20(USDG).approve(AQUA, type(uint256).max);
        vm.stopPrank();
    }

    function _ship() internal returns (bytes32 hash) {
        vm.prank(maker);
        hash = aqua.ship(address(writer), abi.encode(strategy), _addrs(TSLA, USDG), _amts(SHIP_TSLA, SHIP_USDG));
        strategyHash = hash;
    }

    function _bind() internal {
        vm.prank(maker);
        writer.bind(strategy);
    }

    function _shipAndBind() internal {
        _approveAqua();
        _ship();
        _bind();
    }

    /// @dev Creates the series on the book and, as the maker, prices it at `PREMIUM` per contract.
    function _series(bool isCall) internal returns (uint256 seriesId) {
        seriesId = book.createSeries(TSLA, USDG, STRIKE, expiry, isCall);
        vm.prank(maker);
        premium.setPremium(seriesId, PREMIUM);
    }

    function _post(uint256 seriesId, uint256 maxContracts) internal returns (uint256 orderId) {
        vm.prank(maker);
        orderId = writer.post(seriesId, premium, maxContracts);
    }

    // ------------------------------------------------------------------ buyer actions

    function _buy(address who, uint256 orderId, uint256 n) internal {
        uint256 cost = n * PREMIUM;
        _addUsdg(who, cost);
        vm.startPrank(who);
        IERC20(USDG).approve(address(book), cost);
        book.buy(orderId, n, cost);
        vm.stopPrank();
    }

    /// @dev Same as `_buy`, but asserts the `Pulled` event of `token`/`amount` is emitted by Aqua inside `buy`.
    function _buyExpectPulled(address who, uint256 orderId, uint256 n, address token, uint256 amount) internal {
        uint256 cost = n * PREMIUM;
        _addUsdg(who, cost);
        vm.startPrank(who);
        IERC20(USDG).approve(address(book), cost);
        vm.expectEmit(AQUA);
        emit IAqua.Pulled(maker, address(writer), strategyHash, token, amount);
        book.buy(orderId, n, cost);
        vm.stopPrank();
    }

    function _addUsdg(address who, uint256 amount) internal {
        deal(USDG, who, IERC20(USDG).balanceOf(who) + amount);
    }

    /// @dev TSLA moves out of the maker's wallet by a plain transfer; call it before recording maker baselines.
    function _giveTslaFromMaker(address who, uint256 amount) internal {
        vm.prank(maker);
        assertTrue(IERC20(TSLA).transfer(who, amount), "transfer from the maker");
    }

    // ------------------------------------------------------------------ views

    function _virtual(address token) internal view returns (uint256) {
        (uint248 balance,) = aqua.rawBalances(maker, address(writer), strategyHash, token);
        return balance;
    }

    function _wallet(address token) internal view returns (uint256) {
        return IERC20(token).balanceOf(maker);
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
