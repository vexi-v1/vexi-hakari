// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { OptionBook } from "../src/book/OptionBook.sol";
import { FixedPremium } from "../src/book/FixedPremium.sol";
import { FixedExpiryPrice } from "../src/price/FixedExpiryPrice.sol";

import { MockToken, DelayedExpiryPrice, WalletSource } from "./helpers/BookMocks.sol";

/// @notice OptionBook's way out when a series cannot be settled, on mocks, no fork: once the grace has passed without
///         a settlement, holders get the premiums back pro rata by contract, and nothing a maker does (or refuses to
///         do) can delay that; a refund is refused before the grace and on a settled series; and a book refuses a
///         series whose price source may publish later than its grace allows.
contract BookRefundTest is Test {
    MockToken internal base;
    MockToken internal quote;
    FixedExpiryPrice internal price;
    OptionBook internal book;
    FixedPremium internal premiumA;
    FixedPremium internal premiumB;
    WalletSource internal makerA;
    WalletSource internal makerB;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint64 internal constant WINDOW = 1 hours;
    uint64 internal constant GRACE = 2 days;
    uint64 internal constant SOURCE_DELAY = 1 days;
    uint256 internal constant STRIKE = 100e18;

    function setUp() public {
        base = new MockToken("BASE", 18);
        quote = new MockToken("QUOTE", 6);
        price = new FixedExpiryPrice(address(this));
        price.setPrice(address(base), address(quote), 90e18);
        book = new OptionBook(price, WINDOW, GRACE);
        premiumA = new FixedPremium(address(this));
        premiumB = new FixedPremium(address(this));
        makerA = new WalletSource(book);
        makerB = new WalletSource(book);
        base.mint(address(makerA), 100e18);
        base.mint(address(makerB), 100e18);
        quote.mint(alice, 10_000e6);
        quote.mint(bob, 10_000e6);
        vm.warp(2500);
    }

    function _buy(address who, uint256 orderId, uint256 n, uint256 maxPremium) internal {
        vm.startPrank(who);
        quote.approve(address(book), maxPremium);
        book.buy(orderId, n, maxPremium);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ refunds nobody can block

    function test_RefundDoesNotDependOnAnyMakerClosing() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        uint256 seriesId = book.createSeries(address(base), address(quote), STRIKE, expiry, true);
        premiumA.setPremium(seriesId, 2e6, uint64(vm.getBlockTimestamp() + 7 days));
        premiumB.setPremium(seriesId, 1e6, uint64(vm.getBlockTimestamp() + 7 days));
        uint256 orderA = makerA.post(seriesId, premiumA, 10);
        uint256 orderB = makerB.post(seriesId, premiumB, 10);
        _buy(alice, orderA, 3, 6e6); // alice paid 6
        _buy(bob, orderB, 3, 3e6); // bob paid 3
        makerB.setRefuse(true); // B will revert on every return

        // Nobody settles: the source goes dark. After the grace, refunds open regardless of the makers.
        price.setPrice(address(base), address(quote), 0);
        vm.warp(expiry + 1);
        vm.expectRevert(abi.encodeWithSelector(FixedExpiryPrice.NoPrice.selector, address(base), address(quote)));
        book.settle(seriesId);
        vm.warp(expiry + GRACE + 1);
        vm.expectRevert("maker refuses");
        book.close(orderB);
        vm.prank(alice);
        assertEq(book.refund(seriesId, 3), 4_500_000, "3 of 6 contracts get half of the 9 QUOTE pool");
        vm.prank(bob);
        assertEq(book.refund(seriesId, 3), 4_500_000, "pro rata by contract, not by what each paid");
        assertEq(book.balanceOf(alice, seriesId), 0);
        assertEq(book.balanceOf(bob, seriesId), 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.NothingToRefund.selector, seriesId));
        book.refund(seriesId, 1);

        // A closes and gets its escrow; B stays blocked by its own refusal and blocks nobody else.
        (uint256 back, uint256 proceeds) = book.close(orderA);
        assertEq(back, 3e18, "the whole escrow of A comes back");
        assertEq(proceeds, 0);
        assertEq(base.balanceOf(address(makerA)), 100e18, "A is whole again");
        assertEq(quote.balanceOf(address(book)), 0, "every premium went back to a holder");
        assertEq(base.balanceOf(address(book)), 3e18, "only B's escrow is left, waiting for B to accept it");
    }

    function test_RefundOnlyAfterTheGraceAndOnlyWhenUnsettled() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        uint256 seriesId = book.createSeries(address(base), address(quote), STRIKE, expiry, true);
        premiumA.setPremium(seriesId, 1e6, uint64(vm.getBlockTimestamp() + 7 days));
        uint256 orderId = makerA.post(seriesId, premiumA, 10);
        _buy(alice, orderId, 2, 2e6);

        // Before expiry and inside the grace, a series can still be settled: no refund.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.NotUnsettled.selector, seriesId));
        book.refund(seriesId, 1);
        vm.warp(expiry + GRACE); // the last second of the grace still belongs to settlement
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.NotUnsettled.selector, seriesId));
        book.refund(seriesId, 1);

        // The series settles at the last second of the grace; from then on it never refunds.
        assertEq(book.settle(seriesId), 90e18);
        vm.warp(expiry + GRACE + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.NotUnsettled.selector, seriesId));
        book.refund(seriesId, 1);

        // Settled, so the premium is the maker's.
        vm.prank(address(makerA));
        assertEq(book.claimPremium(orderId), 2e6, "the maker earned the premium");
    }

    function test_RefundOpensOneSecondAfterTheGrace() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        uint256 seriesId = book.createSeries(address(base), address(quote), STRIKE, expiry, false);
        premiumA.setPremium(seriesId, 1e6, uint64(vm.getBlockTimestamp() + 7 days));
        quote.mint(address(makerA), 1000e6); // puts are secured by quote
        uint256 orderId = makerA.post(seriesId, premiumA, 10);
        _buy(alice, orderId, 4, 4e6);
        assertEq(quote.balanceOf(address(book)), 4e6 + 400e6, "premium plus 4 x 100 QUOTE of put escrow");

        vm.warp(expiry + GRACE + 1);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.SettleTooLate.selector, seriesId, expiry + GRACE));
        book.settle(seriesId);
        vm.prank(alice);
        assertEq(book.refund(seriesId, 4), 4e6, "the whole premium goes back");
        vm.prank(address(makerA));
        vm.expectRevert(abi.encodeWithSelector(OptionBook.NotSettled.selector, seriesId));
        book.claimPremium(orderId);
        (uint256 back,) = book.close(orderId);
        assertEq(back, 400e6, "the put escrow goes back to the maker");
        assertEq(quote.balanceOf(address(book)), 0, "the book holds nothing");
    }

    // ------------------------------------------------------------------ the grace margin

    function test_GraceMustExceedTheSourcesDelay() public {
        DelayedExpiryPrice late = new DelayedExpiryPrice(SOURCE_DELAY);
        late.setCovered(address(base), address(quote), true);
        OptionBook tight = new OptionBook(late, WINDOW, SOURCE_DELAY);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptionBook.GraceShorterThanSource.selector, address(base), address(quote), SOURCE_DELAY, SOURCE_DELAY
            )
        );
        tight.createSeries(address(base), address(quote), STRIKE, uint64(block.timestamp + 1 days), true);
        OptionBook ok = new OptionBook(late, WINDOW, SOURCE_DELAY + 1);
        ok.createSeries(address(base), address(quote), STRIKE, uint64(block.timestamp + 1 days), true);
    }
}
