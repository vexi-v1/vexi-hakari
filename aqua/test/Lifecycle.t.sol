// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { OptionBook } from "../src/book/OptionBook.sol";
import { AquaWriter } from "../src/aqua/AquaWriter.sol";
import { FixedExpiryPrice } from "../src/price/FixedExpiryPrice.sol";

import { ForkFixture } from "./helpers/ForkFixture.sol";
import { DelayedExpiryPrice } from "./helpers/BookMocks.sol";

/// @notice OptionBook + AquaWriter on the pinned 4663 fork, against canonical Aqua and the real TSLA and USDG. The
///         five Aqua invariants: (1) shipping and posting move no tokens; (2) a fill pulls exactly the collateral,
///         inside `buy`; (3) `available` never overstates what `provide` can deliver; (4) unexercised collateral
///         returns to the wallet and is promised again; (5) premiums are credited to the maker's strategy. Then the
///         exercise paths, pro-rata returns across makers, releases, settlement liveness and the guards on series and
///         bind.
contract LifecycleTest is ForkFixture {
    // ------------------------------------------------------------------ invariant 1

    function test_Invariant1_ShippingMovesNoTokens() public {
        _approveAqua();
        uint256 tslaBefore = _wallet(TSLA);
        uint256 usdgBefore = _wallet(USDG);

        bytes32 hash = _ship();

        assertEq(_wallet(TSLA), tslaBefore, "wallet TSLA unchanged by ship");
        assertEq(_wallet(USDG), usdgBefore, "wallet USDG unchanged by ship");
        assertEq(_virtual(TSLA), SHIP_TSLA, "virtual TSLA = shipped");
        assertEq(_virtual(USDG), SHIP_USDG, "virtual USDG = shipped");
        assertEq(hash, keccak256(abi.encode(strategy)), "strategy hash is keccak of the encoded strategy");

        _bind();
        uint256 seriesId = _series(true);
        _post(seriesId, 10);
        assertEq(_wallet(TSLA), tslaBefore, "wallet TSLA unchanged by post");
        assertEq(IERC20(TSLA).balanceOf(address(book)), 0, "book holds nothing after post");
        assertEq(writer.promised(TSLA), 10e18, "post only records a promise");
    }

    // ------------------------------------------------------------------ invariant 2

    function test_Invariant2_FillPullsExactlyTheCollateralInTheBuyTransaction() public {
        _shipAndBind();
        uint256 callSeries = _series(true);
        uint256 putSeries = _series(false);
        uint256 callOrder = _post(callSeries, 10);
        uint256 putOrder = _post(putSeries, 10);
        uint256 tslaBefore = _wallet(TSLA);
        uint256 usdgBefore = _wallet(USDG);

        // 5 covered calls: exactly 5 TSLA leaves the wallet, inside buy().
        _buyExpectPulled(buyer, callOrder, 5, TSLA, 5e18);
        assertEq(tslaBefore - _wallet(TSLA), 5e18, "wallet TSLA fell by exactly 5");
        assertEq(IERC20(TSLA).balanceOf(address(book)), 5e18, "book escrows exactly 5 TSLA");
        assertEq(_virtual(TSLA), SHIP_TSLA - 5e18, "virtual TSLA fell by exactly 5");
        assertEq(book.balanceOf(buyer, callSeries), 5, "buyer holds 5 calls");

        // 3 cash-secured puts at 400: exactly 1200 USDG leaves the wallet.
        _buyExpectPulled(buyer2, putOrder, 3, USDG, 1200e6);
        assertEq(usdgBefore - _wallet(USDG), 1200e6, "wallet USDG fell by exactly 3 x 400");
        assertEq(
            IERC20(USDG).balanceOf(address(book)), 1200e6 + 8 * PREMIUM, "book holds put escrow plus both premiums"
        );
        assertEq(_virtual(USDG), SHIP_USDG - 1200e6, "virtual USDG fell by exactly the escrow");
        assertEq(book.balanceOf(buyer2, putSeries), 3, "buyer2 holds 3 puts");

        assertEq(writer.promised(TSLA), 5e18, "5 unfilled calls still promised");
        assertEq(writer.promised(USDG), 7 * 400e6, "7 unfilled puts still promised");
    }

    // ------------------------------------------------------------------ invariant 3

    function test_Invariant3_AvailableNeverOverstatesProvide_WalletLimited() public {
        _shipAndBind();
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10);

        // Wallet drops to 3 TSLA while the virtual balance still says 50.
        uint256 spare = _wallet(TSLA) - 3e18;
        _giveTslaFromMaker(makeAddr("elsewhere"), spare);
        assertEq(_virtual(TSLA), SHIP_TSLA);
        assertEq(writer.available(seriesId, TSLA, TSLA), 3e18, "available = wallet");

        _addUsdg(buyer, 4 * PREMIUM);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(book), 4 * PREMIUM);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.SourceShort.selector, orderId, 3e18, 4e18));
        book.buy(orderId, 4, 4 * PREMIUM);
        book.buy(orderId, 3, 3 * PREMIUM);
        vm.stopPrank();
        assertEq(_wallet(TSLA), 0, "the last 3 TSLA were delivered");
        assertEq(writer.available(seriesId, TSLA, TSLA), 0, "nothing left to promise");
    }

    function test_Invariant3_AvailableNeverOverstatesProvide_AllowanceLimited() public {
        _shipAndBind();
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10);

        vm.prank(maker);
        IERC20(TSLA).approve(AQUA, 2e18);
        assertEq(writer.available(seriesId, TSLA, TSLA), 2e18, "available = allowance");

        _addUsdg(buyer, 3 * PREMIUM);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(book), 3 * PREMIUM);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.SourceShort.selector, orderId, 2e18, 3e18));
        book.buy(orderId, 3, 3 * PREMIUM);
        book.buy(orderId, 2, 2 * PREMIUM);
        vm.stopPrank();
        assertEq(IERC20(TSLA).allowance(maker, AQUA), 0, "allowance fully consumed");
        assertEq(writer.available(seriesId, TSLA, TSLA), 0);
    }

    function test_Invariant3_AvailableNeverOverstatesProvide_VirtualLimited() public {
        _shipAndBind();
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 60);
        assertEq(writer.available(seriesId, TSLA, TSLA), SHIP_TSLA, "available = virtual balance");

        _buy(buyer, orderId, 50);
        assertEq(_virtual(TSLA), 0);
        assertGt(_wallet(TSLA), 0, "the wallet still has TSLA, but none is promised to this strategy");
        assertEq(writer.available(seriesId, TSLA, TSLA), 0, "available = 0 once the virtual balance is spent");

        _addUsdg(buyer, PREMIUM);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(book), PREMIUM);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.SourceShort.selector, orderId, 0, 1e18));
        book.buy(orderId, 1, PREMIUM);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ invariant 4

    function test_Invariant4_UnexercisedCollateralReturnsToWalletAndIsPromisedAgain() public {
        _shipAndBind();
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10);
        uint256 tslaBefore = _wallet(TSLA);

        _buy(buyer, orderId, 5);
        assertEq(tslaBefore - _wallet(TSLA), 5e18);

        // Expire out of the money: 350 < 400 strike.
        vm.warp(expiry);
        price.setPrice(TSLA, USDG, 350e18);
        assertEq(book.settle(seriesId), 350e18);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.OutOfTheMoney.selector, seriesId, 350e18, STRIKE));
        book.exercise(seriesId, 5);

        vm.warp(expiry + WINDOW + 1);
        vm.expectEmit(AQUA);
        emit IAqua.Pushed(maker, address(writer), strategyHash, TSLA, 5e18);
        (uint256 collateralReturned, uint256 proceedsReturned) = book.close(orderId);
        assertEq(collateralReturned, 5e18, "all 5 TSLA come back");
        assertEq(proceedsReturned, 0, "nothing was exercised");
        assertEq(_wallet(TSLA), tslaBefore, "wallet TSLA is whole again");
        assertEq(_virtual(TSLA), SHIP_TSLA, "virtual TSLA is whole again: the 5 TSLA are promised again");
        assertEq(IERC20(TSLA).balanceOf(address(book)), 0, "book escrow emptied");
        assertEq(IERC20(TSLA).balanceOf(address(writer)), 0, "writer keeps nothing");
    }

    // ------------------------------------------------------------------ invariant 5

    function test_Invariant5_PremiumsAreCreditedToTheMakersStrategy() public {
        _shipAndBind();
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10);
        uint256 usdgBefore = _wallet(USDG);

        _buy(buyer, orderId, 5);
        assertEq(IERC20(USDG).balanceOf(address(book)), 5 * PREMIUM, "book holds the premium");
        vm.expectRevert(abi.encodeWithSelector(OptionBook.NotSettled.selector, seriesId));
        writer.claimPremium(orderId); // premium is earned at settlement, not before

        vm.warp(expiry);
        price.setPrice(TSLA, USDG, 350e18);
        book.settle(seriesId);
        vm.expectEmit(AQUA);
        emit IAqua.Pushed(maker, address(writer), strategyHash, USDG, 5 * PREMIUM);
        assertEq(writer.claimPremium(orderId), 5 * PREMIUM);
        assertEq(_wallet(USDG) - usdgBefore, 5 * PREMIUM, "premium landed in the wallet");
        assertEq(_virtual(USDG), SHIP_USDG + 5 * PREMIUM, "premium credited to the strategy's USDG");
        assertEq(IERC20(USDG).balanceOf(address(writer)), 0, "writer keeps nothing");
        assertEq(writer.claimPremium(orderId), 0, "nothing left to claim");
    }

    // ------------------------------------------------------------------ exercise paths

    function test_CallExercisedInTheMoney_ProceedsReturnToStrategy() public {
        _shipAndBind();
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10);
        _buy(buyer, orderId, 5);
        uint256 tslaAfterFill = _wallet(TSLA);
        uint256 usdgAfterFill = _wallet(USDG);

        vm.warp(expiry);
        price.setPrice(TSLA, USDG, 450e18);
        book.settle(seriesId);

        // Holder exercises 5 calls: pays 5 x 400 USDG, receives 5 TSLA.
        _addUsdg(buyer, 2000e6);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(book), 2000e6);
        book.exercise(seriesId, 5);
        vm.stopPrank();
        assertEq(IERC20(TSLA).balanceOf(buyer), 5e18, "holder received 5 TSLA");
        assertEq(book.balanceOf(buyer, seriesId), 0, "contracts burned");
        assertEq(IERC20(TSLA).balanceOf(address(book)), 0, "escrow delivered");

        vm.warp(expiry + WINDOW + 1);
        vm.expectEmit(AQUA);
        emit IAqua.Pushed(maker, address(writer), strategyHash, USDG, 2000e6);
        (uint256 collateralReturned, uint256 proceedsReturned) = book.close(orderId);
        assertEq(collateralReturned, 0, "no TSLA comes back: it was delivered");
        assertEq(proceedsReturned, 2000e6, "the strike proceeds come back");
        assertEq(_wallet(TSLA), tslaAfterFill, "wallet TSLA stays 5 lower");
        assertEq(_wallet(USDG) - usdgAfterFill, 2000e6, "wallet USDG rose by the strike proceeds");
        assertEq(_virtual(USDG), SHIP_USDG + 2000e6, "strategy USDG credited with the proceeds");
        assertEq(_virtual(TSLA), SHIP_TSLA - 5e18, "strategy TSLA stays 5 lower");
    }

    function test_PutExercisedInTheMoney_DeliveredTslaReturnsToStrategy() public {
        _shipAndBind();
        _giveTslaFromMaker(buyer, 3e18); // the holder needs TSLA to deliver
        uint256 seriesId = _series(false);
        uint256 orderId = _post(seriesId, 10);
        uint256 tslaBefore = _wallet(TSLA);
        uint256 usdgBefore = _wallet(USDG);

        _buyExpectPulled(buyer, orderId, 3, USDG, 1200e6);
        assertEq(usdgBefore - _wallet(USDG), 1200e6, "3 x 400 USDG escrowed");

        vm.warp(expiry);
        price.setPrice(TSLA, USDG, 350e18);
        book.settle(seriesId);

        vm.startPrank(buyer);
        IERC20(TSLA).approve(address(book), 3e18);
        book.exercise(seriesId, 3);
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(buyer), 1200e6, "holder received the strike in USDG");
        assertEq(IERC20(TSLA).balanceOf(buyer), 0, "holder delivered 3 TSLA");

        vm.warp(expiry + WINDOW + 1);
        vm.expectEmit(AQUA);
        emit IAqua.Pushed(maker, address(writer), strategyHash, TSLA, 3e18);
        (uint256 collateralReturned, uint256 proceedsReturned) = book.close(orderId);
        assertEq(collateralReturned, 0);
        assertEq(proceedsReturned, 3e18, "the delivered TSLA comes back to the maker");
        assertEq(_wallet(TSLA) - tslaBefore, 3e18, "wallet TSLA rose by 3");
        assertEq(_wallet(USDG), usdgBefore - 1200e6, "wallet USDG stays 1200 lower");
        assertEq(_virtual(TSLA), SHIP_TSLA + 3e18, "strategy TSLA credited with the delivered shares");
        assertEq(_virtual(USDG), SHIP_USDG - 1200e6);
    }

    function test_ExerciseRefusedAfterWindow() public {
        _shipAndBind();
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10);
        _buy(buyer, orderId, 1);
        vm.warp(expiry);
        price.setPrice(TSLA, USDG, 450e18);
        book.settle(seriesId);
        vm.warp(expiry + WINDOW + 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.ExerciseWindowClosed.selector, seriesId, expiry + WINDOW));
        book.exercise(seriesId, 1);
    }

    function test_PartialExercise_ProRataReturn() public {
        _shipAndBind();
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10);
        _buy(buyer, orderId, 4);
        vm.warp(expiry);
        price.setPrice(TSLA, USDG, 450e18);
        book.settle(seriesId);
        _addUsdg(buyer, 400e6);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(book), 400e6);
        book.exercise(seriesId, 1);
        vm.stopPrank();
        vm.warp(expiry + WINDOW + 1);
        (uint256 collateralReturned, uint256 proceedsReturned) = book.close(orderId);
        assertEq(collateralReturned, 3e18, "3 of 4 TSLA unexercised");
        assertEq(proceedsReturned, 400e6, "1 x strike in proceeds");
        assertEq(_virtual(TSLA), SHIP_TSLA - 1e18);
        assertEq(_virtual(USDG), SHIP_USDG + 400e6);
    }

    // ------------------------------------------------------------------ promises

    function test_ReleaseDropsUnfilledPromise() public {
        _shipAndBind();
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10);
        _buy(buyer, orderId, 4);
        assertEq(writer.promised(TSLA), 6e18);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("OwnableUnauthorizedAccount(address)")), buyer));
        writer.release(orderId);

        vm.prank(maker);
        writer.release(orderId);
        assertEq(writer.promised(TSLA), 0, "promise dropped");
        (,,, uint256 maxContracts, uint256 filled,,,,) = book.orders(orderId);
        assertEq(maxContracts, filled, "order closed to new fills");

        uint256 orderId2 = _post(seriesId, 3);
        assertEq(writer.promised(TSLA), 3e18);
        vm.warp(expiry);
        vm.prank(buyer); // anyone, once expired
        writer.release(orderId2);
        assertEq(writer.promised(TSLA), 0);
    }

    // ------------------------------------------------------------------ guards on posting and series

    function test_PostRefusesASeriesOnOtherTokens() public {
        _shipAndBind();
        address other = makeAddr("other-token");
        vm.mockCall(other, abi.encodeWithSignature("decimals()"), abi.encode(uint8(18)));
        price.setPrice(other, USDG, 1);
        uint256 seriesId = book.createSeries(other, USDG, STRIKE, expiry, true);
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(AquaWriter.SeriesTokensMismatch.selector, seriesId, other, USDG));
        writer.post(seriesId, premium, 1);
    }

    function test_CreateSeriesRefusesPairsWithoutAPriceSource() public {
        address other = makeAddr("uncovered-token");
        vm.mockCall(other, abi.encodeWithSignature("decimals()"), abi.encode(uint8(18)));
        vm.expectRevert(abi.encodeWithSelector(OptionBook.NoPriceSource.selector, other, USDG));
        book.createSeries(other, USDG, STRIKE, expiry, true);
    }

    function test_CreateSeriesRefusesDustStrikesAndSameToken() public {
        vm.expectRevert(abi.encodeWithSelector(OptionBook.StrikeTooSmall.selector, uint256(1e11), uint8(6)));
        book.createSeries(TSLA, USDG, 1e11, expiry, false); // 1e11 * 1e6 < 1e18
        book.createSeries(TSLA, USDG, 1e12, expiry, false); // exactly one quote unit per contract is allowed
        vm.expectRevert(abi.encodeWithSelector(OptionBook.SameToken.selector, TSLA));
        book.createSeries(TSLA, TSLA, STRIKE, expiry, true);
    }

    function test_BindRefusesStrategiesNotShippedOrNotOurs() public {
        _approveAqua();
        vm.startPrank(maker);
        bytes32 hash = keccak256(abi.encode(strategy));
        vm.expectRevert(abi.encodeWithSelector(AquaWriter.StrategyNotShipped.selector, hash, TSLA));
        writer.bind(strategy);
        AquaWriter.Strategy memory wrongApp = strategy;
        wrongApp.app = address(0xBAD);
        vm.expectRevert(
            abi.encodeWithSelector(
                AquaWriter.InvalidAquaStrategy.selector,
                maker,
                keccak256(abi.encode(wrongApp)),
                address(0xBAD),
                maker,
                address(writer)
            )
        );
        writer.bind(wrongApp);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ settlement liveness

    function test_UnsettledSeriesClosesAfterGraceAndOptionsExpireWorthless() public {
        FixedExpiryPrice silent = new FixedExpiryPrice(address(this));
        silent.setPrice(TSLA, USDG, 1); // covered, but the price is cleared before expiry
        book = new OptionBook(silent, WINDOW, GRACE);
        writer = new AquaWriter(aqua, book, maker);
        strategy.app = address(writer);
        _shipAndBind();
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10);
        _buy(buyer, orderId, 5);
        uint256 tslaAfterFill = _wallet(TSLA);
        silent.setPrice(TSLA, USDG, 0); // the source goes dark

        vm.warp(expiry + 1);
        vm.expectRevert(abi.encodeWithSelector(FixedExpiryPrice.NoPrice.selector, TSLA, USDG));
        book.settle(seriesId);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.SettleGraceRunning.selector, seriesId, expiry + GRACE));
        book.close(orderId);

        vm.warp(expiry + GRACE + 1);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.SettleTooLate.selector, seriesId, expiry + GRACE));
        book.settle(seriesId);
        vm.expectEmit(AQUA);
        emit IAqua.Pushed(maker, address(writer), strategyHash, TSLA, 5e18);
        (uint256 back, uint256 proceeds) = book.close(orderId);
        assertEq(back, 5e18, "the whole escrow comes back");
        assertEq(proceeds, 0);
        assertEq(_wallet(TSLA), tslaAfterFill + 5e18);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.NotSettled.selector, seriesId));
        book.exercise(seriesId, 5);

        // The maker never earned the premium: the holder gets it back, pro rata by contract, and the contracts burn.
        vm.expectRevert(abi.encodeWithSelector(OptionBook.NotSettled.selector, seriesId));
        writer.claimPremium(orderId);
        uint256 usdgBefore = IERC20(USDG).balanceOf(buyer);
        vm.prank(buyer);
        assertEq(book.refund(seriesId, 2), 2 * PREMIUM, "2 of 5 contracts refunded at the premium paid");
        vm.prank(buyer);
        assertEq(book.refund(seriesId, 3), 3 * PREMIUM);
        assertEq(IERC20(USDG).balanceOf(buyer) - usdgBefore, 5 * PREMIUM);
        assertEq(book.balanceOf(buyer, seriesId), 0);
        assertEq(IERC20(USDG).balanceOf(address(book)), 0, "nothing left in the book");
    }

    function test_GraceMustCoverTheSourcesDelay() public {
        DelayedExpiryPrice late = new DelayedExpiryPrice(90_000); // publishes up to 25 hours after the instant
        late.setCovered(TSLA, USDG, true);
        OptionBook shortGrace = new OptionBook(late, WINDOW, 1 hours);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptionBook.GraceShorterThanSource.selector, TSLA, USDG, uint64(90_000), uint64(1 hours)
            )
        );
        shortGrace.createSeries(TSLA, USDG, STRIKE, expiry, true);
        OptionBook longGrace = new OptionBook(late, WINDOW, GRACE);
        longGrace.createSeries(TSLA, USDG, STRIKE, expiry, true); // 3 days > 25 hours
        vm.expectRevert(abi.encodeWithSelector(OptionBook.BadGrace.selector, uint64(0)));
        new OptionBook(late, WINDOW, 0);
        vm.expectRevert(abi.encodeWithSelector(OptionBook.BadWindow.selector, uint64(366 days)));
        new OptionBook(late, 366 days, WINDOW);
    }

    function test_ExerciseWindowCountsFromSettlementNotExpiry() public {
        _shipAndBind();
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10);
        _buy(buyer, orderId, 2);
        price.setPrice(TSLA, USDG, 450e18);
        vm.warp(expiry + 2 days); // settled late, still inside the grace
        book.settle(seriesId);
        vm.warp(expiry + 2 days + WINDOW); // the window is still open: it counts from settlement
        _addUsdg(buyer, 800e6);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(book), 800e6);
        book.exercise(seriesId, 2);
        vm.stopPrank();
        vm.expectRevert(
            abi.encodeWithSelector(OptionBook.ExerciseWindowOpen.selector, seriesId, uint64(expiry + 2 days + WINDOW))
        );
        book.close(orderId);
        vm.warp(expiry + 2 days + WINDOW + 1);
        (, uint256 proceeds) = book.close(orderId);
        assertEq(proceeds, 800e6);
    }

    function test_DockedStrategyBlocksCloseUntilTheMakerRebinds() public {
        _shipAndBind();
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10);
        _buy(buyer, orderId, 5);
        vm.prank(maker);
        aqua.dock(address(writer), strategyHash, _addrs(TSLA, USDG));
        assertEq(writer.available(seriesId, TSLA, TSLA), 0, "a docked strategy backs nothing");

        vm.warp(expiry);
        price.setPrice(TSLA, USDG, 350e18);
        book.settle(seriesId);
        vm.warp(expiry + WINDOW + 1);
        vm.expectRevert( // Aqua refuses to push into a docked strategy, so the return cannot land
            abi.encodeWithSelector(
                IAqua.PushToNonActiveStrategyPrevented.selector, maker, address(writer), strategyHash, TSLA
            )
        );
        book.close(orderId);

        // The maker ships a fresh strategy and rebinds; the return then lands there.
        strategy.salt = bytes32(uint256(99));
        vm.startPrank(maker);
        bytes32 fresh = aqua.ship(address(writer), abi.encode(strategy), _addrs(TSLA, USDG), _amts(1e18, 1e6));
        writer.bind(strategy);
        vm.stopPrank();
        book.close(orderId);
        (uint248 v,) = aqua.rawBalances(maker, address(writer), fresh, TSLA);
        assertEq(v, 1e18 + 5e18, "the 5 TSLA were pushed into the new strategy");
    }

    // ------------------------------------------------------------------ several makers in one series

    function test_TwoOrdersShareExerciseProRata() public {
        _shipAndBind();
        // A second writer for the same maker wallet, with its own strategy, posts in the same series.
        AquaWriter writer2 = new AquaWriter(aqua, book, maker);
        AquaWriter.Strategy memory strategy2 = AquaWriter.Strategy({
            maker: maker,
            app: address(writer2),
            base: TSLA,
            quote: USDG,
            salt: bytes32(uint256(8))
        });
        vm.startPrank(maker);
        bytes32 hash2 = aqua.ship(address(writer2), abi.encode(strategy2), _addrs(TSLA, USDG), _amts(20e18, 1e6));
        writer2.bind(strategy2);
        vm.stopPrank();

        uint256 seriesId = _series(true);
        uint256 orderA = _post(seriesId, 10);
        vm.prank(maker);
        uint256 orderB = writer2.post(seriesId, premium, 10);
        _buy(buyer, orderA, 6);
        _buy(buyer2, orderB, 4); // 10 sold in total, 6 from A and 4 from B

        vm.warp(expiry);
        price.setPrice(TSLA, USDG, 450e18);
        book.settle(seriesId);
        _addUsdg(buyer, 5 * 400e6);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(book), 5 * 400e6);
        book.exercise(seriesId, 5); // 5 of 10 exercised
        vm.stopPrank();

        vm.warp(expiry + WINDOW + 1);
        (uint256 backA, uint256 proceedsA) = book.close(orderA);
        (uint256 backB, uint256 proceedsB) = book.close(orderB);
        assertEq(backA, 6e18 * 5 / 10, "A gets back 6 x 5/10 = 3 TSLA");
        assertEq(backB, 4e18 * 5 / 10, "B gets back 4 x 5/10 = 2 TSLA");
        assertEq(proceedsA, 2000e6 * 6 / 10, "A gets 6/10 of the 2000 USDG strike proceeds");
        assertEq(proceedsB, 2000e6 * 4 / 10, "B gets 4/10");
        assertEq(backA + backB, 5e18, "the 5 unexercised TSLA are fully returned");
        assertEq(proceedsA + proceedsB, 2000e6, "the proceeds are fully returned");
        assertEq(IERC20(TSLA).balanceOf(address(book)), 0);
        assertEq(IERC20(USDG).balanceOf(address(book)), 10 * PREMIUM, "only unclaimed premiums stay");
        (uint248 v2,) = aqua.rawBalances(maker, address(writer2), hash2, TSLA);
        assertEq(v2, 20e18 - 4e18 + backB, "writer2's strategy got its share back");
    }
}
