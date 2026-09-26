// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { FixedPremium } from "../src/book/FixedPremium.sol";
import { IQuoteReference } from "../src/book/IQuoteReference.sol";
import { OptionBook } from "../src/book/OptionBook.sol";
import { FixedExpiryPrice } from "../src/price/FixedExpiryPrice.sol";
import { MockToken, WalletSource } from "./helpers/BookMocks.sol";

contract QuoteReferenceMock is IQuoteReference {
    uint256 public value = 100e18;
    bool public broken;

    function set(uint256 v) external {
        value = v;
    }

    function setBroken(bool v) external {
        broken = v;
    }

    function referencePriceWad() external view returns (uint256) {
        require(!broken, "priceSource unavailable");
        return value;
    }
}

contract FixedPremiumTest is Test {
    FixedPremium internal premium;
    QuoteReferenceMock internal priceSource;
    uint64 internal constant UNTIL = 2000;
    uint256 internal constant SERIES = 1;

    function setUp() public {
        vm.warp(1000);
        premium = new FixedPremium(address(this));
        priceSource = new QuoteReferenceMock();
    }

    function test_DeadlineIsExclusiveAndOnlyExplicitRenewalReopensQuote() public {
        premium.setPremium(SERIES, 2e6, UNTIL);
        vm.warp(UNTIL - 1);
        assertEq(premium.ask(SERIES, 3), 6e6);
        vm.warp(UNTIL);
        vm.expectRevert(abi.encodeWithSelector(FixedPremium.QuoteExpired.selector, SERIES, UNTIL));
        premium.ask(SERIES, 1);
        premium.setPremium(SERIES, 3e6, UNTIL + 100);
        assertEq(premium.ask(SERIES, 3), 9e6);
    }

    function test_ExpiredTermsCannotBeInstalledAndQuoteCanBeDisabled() public {
        vm.expectRevert(FixedPremium.BadQuoteTerms.selector);
        premium.setPremium(SERIES, 2e6, 1000);
        premium.setAnchoredPremium(SERIES, 2e6, UNTIL, priceSource, 500);
        premium.setPremium(SERIES, 0, 0);
        (uint64 until, uint16 deviation, IQuoteReference source, uint256 anchor) = premium.termsOf(SERIES);
        assertEq(until, 0);
        assertEq(deviation, 0);
        assertEq(address(source), address(0));
        assertEq(anchor, 0);
        vm.expectRevert(abi.encodeWithSelector(FixedPremium.NoPremium.selector, SERIES));
        premium.ask(SERIES, 1);
    }

    function test_AnchorChecksBothInclusiveEdgesAndOneWeiOutside() public {
        premium.setAnchoredPremium(SERIES, 2e6, UNTIL, priceSource, 500);
        priceSource.set(105e18);
        assertEq(premium.ask(SERIES, 1), 2e6);
        priceSource.set(105e18 + 1);
        vm.expectRevert(abi.encodeWithSelector(FixedPremium.QuoteOffAnchor.selector, SERIES, 105e18 + 1, 100e18));
        premium.ask(SERIES, 1);
        priceSource.set(95e18);
        assertEq(premium.ask(SERIES, 1), 2e6);
        priceSource.set(95e18 - 1);
        vm.expectRevert(abi.encodeWithSelector(FixedPremium.QuoteOffAnchor.selector, SERIES, 95e18 - 1, 100e18));
        premium.ask(SERIES, 1);
    }

    function test_BrokenOrZeroReferenceFailsClosedAndRenewalCapturesNewAnchor() public {
        premium.setAnchoredPremium(SERIES, 2e6, UNTIL, priceSource, 500);
        priceSource.setBroken(true);
        vm.expectRevert("priceSource unavailable");
        premium.ask(SERIES, 1);
        priceSource.setBroken(false);
        priceSource.set(0);
        vm.expectRevert(FixedPremium.InvalidReferencePrice.selector);
        premium.ask(SERIES, 1);
        vm.expectRevert(FixedPremium.InvalidReferencePrice.selector);
        premium.setAnchoredPremium(SERIES, 2e6, UNTIL, priceSource, 500);
        priceSource.set(110e18);
        premium.setAnchoredPremium(SERIES, 3e6, UNTIL, priceSource, 500);
        (,,, uint256 anchor) = premium.termsOf(SERIES);
        assertEq(anchor, 110e18);
        assertEq(premium.ask(SERIES, 1), 3e6);
    }

    function test_OnlyOwnerCanSetOrRenewEitherKindOfQuote() public {
        address stranger = makeAddr("stranger");
        bytes memory err = abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger);
        vm.prank(stranger);
        vm.expectRevert(err);
        premium.setPremium(SERIES, 2e6, UNTIL);
        vm.prank(stranger);
        vm.expectRevert(err);
        premium.setAnchoredPremium(SERIES, 2e6, UNTIL, priceSource, 500);
    }

    function test_InvalidAnchorTermsAreRefused() public {
        vm.expectRevert(FixedPremium.BadQuoteTerms.selector);
        premium.setAnchoredPremium(SERIES, 2e6, UNTIL, IQuoteReference(address(0)), 500);
        vm.expectRevert(FixedPremium.BadQuoteTerms.selector);
        premium.setAnchoredPremium(SERIES, 2e6, UNTIL, priceSource, 0);
        vm.expectRevert(FixedPremium.BadQuoteTerms.selector);
        premium.setAnchoredPremium(SERIES, 2e6, UNTIL, priceSource, 5001);
    }

    function test_ExpiredQuoteBlocksBookBuyWithoutMovingFundsAndDoesNotBlockSettlement() public {
        MockToken base = new MockToken("BASE", 18);
        MockToken quote = new MockToken("QUOTE", 6);
        FixedExpiryPrice price = new FixedExpiryPrice(address(this));
        price.setPrice(address(base), address(quote), 110e18);
        OptionBook book = new OptionBook(price, 1 hours, 1 days);
        WalletSource maker = new WalletSource(book);
        base.mint(address(maker), 10e18);
        quote.mint(address(this), 1000e6);
        quote.approve(address(book), type(uint256).max);
        uint256 id = book.createSeries(address(base), address(quote), 100e18, 3000, true);
        premium.setPremium(id, 2e6, UNTIL);
        uint256 order = maker.post(id, premium, 10);
        book.buy(order, 1, 2e6);
        vm.warp(UNTIL);
        uint256 quoteBefore = quote.balanceOf(address(this));
        vm.expectRevert(abi.encodeWithSelector(FixedPremium.QuoteExpired.selector, id, UNTIL));
        book.buy(order, 1, 2e6);
        assertEq(quote.balanceOf(address(this)), quoteBefore);
        assertEq(base.balanceOf(address(maker)), 9e18);
        assertEq(book.balanceOf(address(this), id), 1);
        vm.warp(3000);
        book.settle(id);
        book.exercise(id, 1);
        assertEq(base.balanceOf(address(this)), 1e18);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }
}
