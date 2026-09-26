// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { ICollateralSource } from "./ICollateralSource.sol";
import { IPremium } from "./IPremium.sol";
import { IExpiryPrice } from "../price/IExpiryPrice.sol";

/// @title OptionBook
/// @notice A deliberately small, physically settled book of covered calls and cash-secured puts whose makers hold a
///         promise, not tokens. It exists to show the Aqua seam end to end: collateral is taken from the maker's
///         `ICollateralSource` only at a fill, inside `buy`, and handed back through the same source.
/// @dev One contract = one whole base token. `strike` is WAD quote per base. Every order is priced by an `IPremium`
///      at every buy. Holders are ERC-1155 balances with id = seriesId. Settlement is pro rata across the makers of a
///      series. If no price can be read within `SETTLE_GRACE` of expiry, makers take their escrow back and holders
///      their premiums: the book never holds collateral hostage to a silent price source.
contract OptionBook is ERC1155, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Series {
        address base;
        address quote;
        uint256 strike; // WAD quote per base
        uint64 expiry; // block.timestamp at which the series stops trading
        bool isCall;
        uint8 baseDecimals;
        uint8 quoteDecimals;
    }

    struct Order {
        address maker; // an ICollateralSource
        uint256 seriesId;
        address pricer; // an IPremium, asked at every buy
        uint256 maxContracts;
        uint256 filled;
        uint256 collateral; // escrow taken so far (base for calls, quote for puts)
        uint256 premiumAccrued;
        uint256 premiumClaimed;
        bool closed;
    }

    struct Settlement {
        bool settled;
        uint64 settledAt; // when `settle` ran; the exercise window counts from here
        uint256 price; // WAD quote per base at expiry
        uint256 sold; // contracts sold across all orders of the series
        uint256 exercised;
        uint256 proceeds; // what exercisers paid in (quote for calls, base for puts)
        uint256 premiums; // premium paid on the series, held here until settlement
        uint256 refunded; // contracts refunded after a settlement failed
    }

    error SeriesUnknown(uint256 seriesId);
    error NoPriceSource(address base, address quote);
    error GraceShorterThanSource(address base, address quote, uint64 sourceDelay, uint64 grace);
    error BadWindow(uint64 exerciseWindow);
    error BadGrace(uint64 settleGrace);
    error SameToken(address token);
    error StrikeTooSmall(uint256 strike, uint8 quoteDecimals);
    error ExpiryInPast(uint64 expiry);
    error SeriesExpired(uint256 seriesId, uint64 expiry);
    error SeriesNotExpired(uint256 seriesId, uint64 expiry);
    error MakerHasNoCode(address maker);
    error PricerHasNoCode(address pricer);
    error ZeroContracts();
    error OrderUnknown(uint256 orderId);
    error OrderExhausted(uint256 orderId, uint256 remaining, uint256 requested);
    error PremiumTooHigh(uint256 premium, uint256 maxPremium);
    error SourceShort(uint256 orderId, uint256 available, uint256 needed);
    error CollateralNotReceived(uint256 orderId, uint256 received, uint256 needed);
    error AlreadySettled(uint256 seriesId);
    error NotSettled(uint256 seriesId);
    error SettleTooLate(uint256 seriesId, uint64 graceEndsAt);
    error ExerciseWindowClosed(uint256 seriesId, uint64 closesAt);
    error ExerciseWindowOpen(uint256 seriesId, uint64 closesAt);
    error SettleGraceRunning(uint256 seriesId, uint64 graceEndsAt);
    error OutOfTheMoney(uint256 seriesId, uint256 price, uint256 strike);
    error NotMaker(uint256 orderId, address caller);
    error OrderClosed(uint256 orderId);
    error NotUnsettled(uint256 seriesId);
    error NothingToRefund(uint256 seriesId);

    event SeriesCreated(
        uint256 indexed seriesId, address base, address quote, uint256 strike, uint64 expiry, bool isCall
    );
    event Posted(
        uint256 indexed orderId, uint256 indexed seriesId, address indexed maker, address pricer, uint256 maxContracts
    );
    event Cancelled(uint256 indexed orderId, uint256 unfilled);
    event Bought(
        uint256 indexed orderId,
        uint256 indexed seriesId,
        address indexed buyer,
        uint256 contracts,
        uint256 premium,
        uint256 collateral
    );
    event Settled(uint256 indexed seriesId, uint256 price);
    event Exercised(
        uint256 indexed seriesId, address indexed holder, uint256 contracts, uint256 paid, uint256 received
    );
    event Closed(uint256 indexed orderId, uint256 collateralReturned, uint256 proceedsReturned);
    event ClosedUnsettled(uint256 indexed orderId, uint256 indexed seriesId, uint256 collateralReturned);
    event PremiumClaimed(uint256 indexed orderId, address indexed maker, uint256 amount);
    event Refunded(uint256 indexed seriesId, address indexed holder, uint256 contracts, uint256 amount);

    IExpiryPrice public immutable PRICE;
    /// @notice How long holders have to exercise, counted from the moment the series is settled.
    uint64 public immutable EXERCISE_WINDOW;
    /// @notice How long after expiry a series may still be settled. Past it, an unsettled series unwinds: escrow to
    ///         the makers, premiums to the holders.
    uint64 public immutable SETTLE_GRACE;

    mapping(uint256 seriesId => Series) public series;
    mapping(uint256 seriesId => Settlement) public settlements;
    mapping(uint256 orderId => Order) public orders;
    uint256 public nextOrderId = 1;

    constructor(IExpiryPrice price, uint64 exerciseWindow, uint64 settleGrace) ERC1155("") {
        require(exerciseWindow > 0 && exerciseWindow <= 365 days, BadWindow(exerciseWindow));
        require(settleGrace > 0 && settleGrace <= 365 days, BadGrace(settleGrace));
        PRICE = price;
        EXERCISE_WINDOW = exerciseWindow;
        SETTLE_GRACE = settleGrace;
    }

    // ---------------------------------------------------------------- series

    function seriesIdOf(address base, address quote, uint256 strike, uint64 expiry, bool isCall)
        public
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encode(base, quote, strike, expiry, isCall)));
    }

    /// @notice Registers a series. Idempotent. Refuses a pair its price source does not cover, or covers too late.
    function createSeries(address base, address quote, uint256 strike, uint64 expiry, bool isCall)
        external
        returns (uint256 seriesId)
    {
        require(expiry > block.timestamp, ExpiryInPast(expiry));
        require(base != quote, SameToken(base));
        require(PRICE.covers(base, quote), NoPriceSource(base, quote));
        uint64 sourceDelay = PRICE.maxDelay(base, quote);
        require(SETTLE_GRACE > sourceDelay, GraceShorterThanSource(base, quote, sourceDelay, SETTLE_GRACE));
        seriesId = seriesIdOf(base, quote, strike, expiry, isCall);
        if (series[seriesId].base == address(0)) {
            uint8 quoteDecimals = IERC20Metadata(quote).decimals();
            // One contract must be worth at least one quote unit, or put collateral rounds to nothing.
            require(strike * 10 ** quoteDecimals >= 1e18, StrikeTooSmall(strike, quoteDecimals));
            series[seriesId] = Series({
                base: base,
                quote: quote,
                strike: strike,
                expiry: expiry,
                isCall: isCall,
                baseDecimals: IERC20Metadata(base).decimals(),
                quoteDecimals: quoteDecimals
            });
            emit SeriesCreated(seriesId, base, quote, strike, expiry, isCall);
        }
    }

    /// @notice Collateral token of a series and the escrow `n` contracts need.
    function collateralFor(uint256 seriesId, uint256 n) public view returns (address token, uint256 amount) {
        Series memory s = series[seriesId];
        require(s.base != address(0), SeriesUnknown(seriesId));
        return s.isCall ? (s.base, _baseAmount(s, n)) : (s.quote, _quoteAmount(s, n));
    }

    // ---------------------------------------------------------------- orders

    /// @notice Posts a sourced order: the caller must be an `ICollateralSource`, and no tokens move.
    function post(uint256 seriesId, IPremium pricer, uint256 maxContracts) external returns (uint256 orderId) {
        Series memory s = series[seriesId];
        require(s.base != address(0), SeriesUnknown(seriesId));
        require(block.timestamp < s.expiry, SeriesExpired(seriesId, s.expiry));
        require(msg.sender.code.length > 0, MakerHasNoCode(msg.sender));
        require(address(pricer).code.length > 0, PricerHasNoCode(address(pricer)));
        require(maxContracts > 0, ZeroContracts());

        orderId = nextOrderId++;
        orders[orderId] = Order({
            maker: msg.sender,
            seriesId: seriesId,
            pricer: address(pricer),
            maxContracts: maxContracts,
            filled: 0,
            collateral: 0,
            premiumAccrued: 0,
            premiumClaimed: 0,
            closed: false
        });
        emit Posted(orderId, seriesId, msg.sender, address(pricer), maxContracts);
    }

    /// @notice What `n` contracts of an order cost a buyer right now.
    function quotePremium(uint256 orderId, uint256 n) public view returns (uint256) {
        Order storage o = orders[orderId];
        require(o.maker != address(0), OrderUnknown(orderId));
        return IPremium(o.pricer).ask(o.seriesId, n);
    }

    /// @notice Stops further fills. Escrow already taken stays until close.
    function cancel(uint256 orderId) external returns (uint256 unfilled) {
        Order storage o = orders[orderId];
        require(o.maker != address(0), OrderUnknown(orderId));
        require(msg.sender == o.maker, NotMaker(orderId, msg.sender));
        unfilled = o.maxContracts - o.filled;
        o.maxContracts = o.filled;
        emit Cancelled(orderId, unfilled);
    }

    /// @notice Buys `n` contracts: pays the pricer's ask, then takes exactly the collateral from the maker's source.
    function buy(uint256 orderId, uint256 n, uint256 maxPremium) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.maker != address(0), OrderUnknown(orderId));
        Series memory s = series[o.seriesId];
        require(block.timestamp < s.expiry, SeriesExpired(o.seriesId, s.expiry));
        require(n > 0, ZeroContracts());
        uint256 remaining = o.maxContracts - o.filled;
        require(n <= remaining, OrderExhausted(orderId, remaining, n));

        // 1. The buyer pays the premium the order's pricer asks right now.
        uint256 premium = quotePremium(orderId, n);
        require(premium <= maxPremium, PremiumTooHigh(premium, maxPremium));
        IERC20(s.quote).safeTransferFrom(msg.sender, address(this), premium);
        o.premiumAccrued += premium;
        settlements[o.seriesId].premiums += premium;

        // 2. The source must be able to deliver.
        (address token, uint256 needed) = collateralFor(o.seriesId, n);
        uint256 avail = ICollateralSource(o.maker).available(o.seriesId, s.base, token);
        require(avail >= needed, SourceShort(orderId, avail, needed));

        // 3. Take exactly the collateral, checked by balance delta.
        uint256 before = IERC20(token).balanceOf(address(this));
        ICollateralSource(o.maker).provide(o.seriesId, s.base, token, needed);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        require(received == needed, CollateralNotReceived(orderId, received, needed));

        // 4. Credit the buyer.
        o.filled += n;
        o.collateral += needed;
        settlements[o.seriesId].sold += n;
        _mint(msg.sender, o.seriesId, n, "");
        emit Bought(orderId, o.seriesId, msg.sender, n, premium, needed);
    }

    // ---------------------------------------------------------------- settlement

    /// @notice Reads the expiry price once the series has expired, within the grace.
    function settle(uint256 seriesId) external returns (uint256 price) {
        Series memory s = series[seriesId];
        require(s.base != address(0), SeriesUnknown(seriesId));
        require(block.timestamp >= s.expiry, SeriesNotExpired(seriesId, s.expiry));
        Settlement storage st = settlements[seriesId];
        require(!st.settled, AlreadySettled(seriesId));
        uint64 graceEndsAt = s.expiry + SETTLE_GRACE;
        require(block.timestamp <= graceEndsAt, SettleTooLate(seriesId, graceEndsAt));
        price = PRICE.priceAt(s.base, s.quote, s.expiry);
        st.settled = true;
        st.settledAt = uint64(block.timestamp);
        st.price = price;
        emit Settled(seriesId, price);
    }

    /// @notice Physical exercise inside the window. Calls pay strike in quote and take base; puts deliver base and
    ///         take strike.
    function exercise(uint256 seriesId, uint256 n) external nonReentrant {
        Series memory s = series[seriesId];
        Settlement storage st = settlements[seriesId];
        require(st.settled, NotSettled(seriesId));
        uint64 closesAt = st.settledAt + EXERCISE_WINDOW;
        require(block.timestamp <= closesAt, ExerciseWindowClosed(seriesId, closesAt));
        require(n > 0, ZeroContracts());
        bool inTheMoney = s.isCall ? st.price > s.strike : st.price < s.strike;
        require(inTheMoney, OutOfTheMoney(seriesId, st.price, s.strike));

        _burn(msg.sender, seriesId, n);
        st.exercised += n;

        uint256 baseAmount = _baseAmount(s, n);
        uint256 quoteAmount = _quoteAmount(s, n);
        if (s.isCall) {
            IERC20(s.quote).safeTransferFrom(msg.sender, address(this), quoteAmount);
            st.proceeds += quoteAmount;
            IERC20(s.base).safeTransfer(msg.sender, baseAmount);
            emit Exercised(seriesId, msg.sender, n, quoteAmount, baseAmount);
        } else {
            IERC20(s.base).safeTransferFrom(msg.sender, address(this), baseAmount);
            st.proceeds += baseAmount;
            IERC20(s.quote).safeTransfer(msg.sender, quoteAmount);
            emit Exercised(seriesId, msg.sender, n, baseAmount, quoteAmount);
        }
    }

    /// @notice After the exercise window: unexercised escrow and this order's share of exercise proceeds go back to
    ///         the maker through its source. If the series could not be settled within `SETTLE_GRACE`, the whole
    ///         escrow goes back and the options expire worthless.
    /// @dev Pro rata by contracts filled. Each token is handed over with `onReturned` so the source can re-promise it.
    function close(uint256 orderId)
        external
        nonReentrant
        returns (uint256 collateralReturned, uint256 proceedsReturned)
    {
        Order storage o = orders[orderId];
        require(o.maker != address(0), OrderUnknown(orderId));
        require(!o.closed, OrderClosed(orderId));
        Series memory s = series[o.seriesId];
        Settlement storage st = settlements[o.seriesId];
        (address collateralToken,) = collateralFor(o.seriesId, 1);
        address proceedsToken = s.isCall ? s.quote : s.base;

        if (st.settled) {
            uint64 closesAt = st.settledAt + EXERCISE_WINDOW;
            require(block.timestamp > closesAt, ExerciseWindowOpen(o.seriesId, closesAt));
            if (st.sold > 0) {
                collateralReturned = o.collateral * (st.sold - st.exercised) / st.sold;
                proceedsReturned = st.proceeds * o.filled / st.sold;
            }
        } else {
            uint64 graceEndsAt = s.expiry + SETTLE_GRACE;
            require(block.timestamp > graceEndsAt, SettleGraceRunning(o.seriesId, graceEndsAt));
            collateralReturned = o.collateral;
            // The premium was never earned: it stays in the book for the holders (`refund`), never for the maker.
            emit ClosedUnsettled(orderId, o.seriesId, collateralReturned);
        }
        o.closed = true;

        if (collateralReturned > 0) {
            IERC20(collateralToken).safeTransfer(o.maker, collateralReturned);
            ICollateralSource(o.maker).onReturned(o.seriesId, s.base, collateralToken, collateralReturned);
        }
        if (proceedsReturned > 0) {
            IERC20(proceedsToken).safeTransfer(o.maker, proceedsReturned);
            ICollateralSource(o.maker).onReturned(o.seriesId, s.base, proceedsToken, proceedsReturned);
        }
        emit Closed(orderId, collateralReturned, proceedsReturned);
    }

    /// @notice Sends the premium collected on an order to its maker, once the series is settled. Until then it stays
    ///         in the book, so holders of a series nobody could settle can get it back.
    function claimPremium(uint256 orderId) external nonReentrant returns (uint256 amount) {
        Order storage o = orders[orderId];
        require(o.maker != address(0), OrderUnknown(orderId));
        require(msg.sender == o.maker, NotMaker(orderId, msg.sender));
        require(settlements[o.seriesId].settled, NotSettled(o.seriesId));
        amount = o.premiumAccrued - o.premiumClaimed;
        o.premiumClaimed = o.premiumAccrued;
        if (amount > 0) IERC20(series[o.seriesId].quote).safeTransfer(o.maker, amount);
        emit PremiumClaimed(orderId, o.maker, amount);
    }

    /// @notice Once a series can no longer be settled (the grace has passed without a settlement), holders get the
    ///         premiums paid on it back, pro rata by contract, and their contracts are burned. It depends on time
    ///         alone: nothing a maker does can delay it.
    function refund(uint256 seriesId, uint256 n) external nonReentrant returns (uint256 amount) {
        Series memory s = series[seriesId];
        require(s.base != address(0), SeriesUnknown(seriesId));
        Settlement storage st = settlements[seriesId];
        uint64 graceEndsAt = s.expiry + SETTLE_GRACE;
        require(!st.settled && block.timestamp > graceEndsAt, NotUnsettled(seriesId));
        require(n > 0, ZeroContracts());
        require(st.sold > st.refunded, NothingToRefund(seriesId));
        amount = st.premiums * n / st.sold;
        st.refunded += n;
        _burn(msg.sender, seriesId, n);
        IERC20(s.quote).safeTransfer(msg.sender, amount);
        emit Refunded(seriesId, msg.sender, n, amount);
    }

    // ---------------------------------------------------------------- amounts

    function _baseAmount(Series memory s, uint256 n) internal pure returns (uint256) {
        return n * 10 ** s.baseDecimals;
    }

    function _quoteAmount(Series memory s, uint256 n) internal pure returns (uint256) {
        return n * s.strike * 10 ** s.quoteDecimals / 1e18;
    }
}
