// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { ICollateralSource } from "../book/ICollateralSource.sol";
import { IPremium } from "../book/IPremium.sol";
import { OptionBook } from "../book/OptionBook.sol";

/// @title AquaWriter
/// @notice The Aqua app that writes options: collateral stays in the maker's wallet and is pulled only at a fill.
/// @dev One AquaWriter per maker, owned by that maker. It is the `app` of the maker's Aqua strategy and the
///      `ICollateralSource` maker of every order it posts on the `OptionBook`.
///
///      Flow: the maker approves Aqua once per token, ships a strategy whose app is this contract, binds the
///      strategy here, then posts orders. `buy` on the book calls `provide`, which is `Aqua.pull` straight from the
///      maker's wallet to the book. Unexercised escrow, exercise proceeds and premiums come back through
///      `Aqua.push`, so they land in the wallet and are credited to the same strategy again.
///
///      `promised(token)` is what open, unfilled orders still promise. The SwapVM `ExposureGuard` reads it, so the
///      same wallet can also quote spot through SwapVM without ever selling a token an option buyer was promised.
contract AquaWriter is ICollateralSource, Ownable {
    using SafeERC20 for IERC20;

    /// @notice What the maker ships to Aqua with this contract as `app` (`abi.encode(Strategy)`).
    struct Strategy {
        address maker;
        address app;
        address base;
        address quote;
        bytes32 salt;
    }

    error NotBook(address caller);
    error NotBound();
    error InvalidAquaStrategy(
        address maker, bytes32 strategyHash, address app, address expectedMaker, address expectedApp
    );
    error SeriesTokensMismatch(uint256 seriesId, address seriesBase, address seriesQuote);
    error StrategyNotShipped(bytes32 strategyHash, address token);
    error OrderNotMine(uint256 orderId);

    event Bound(bytes32 indexed strategyHash, address base, address quote);
    event Promised(uint256 indexed orderId, address indexed token, uint256 amount);
    event Unpromised(uint256 indexed orderId, address indexed token, uint256 amount);
    event Provided(uint256 indexed seriesId, address indexed token, uint256 amount);
    event Returned(uint256 indexed seriesId, address indexed token, uint256 amount);
    event PremiumPushed(uint256 indexed orderId, address indexed token, uint256 amount);

    /// @notice Canonical Aqua. This contract only calls its published ABI (ship happens from the maker's wallet).
    IAqua public immutable AQUA;
    OptionBook public immutable BOOK;
    /// @notice The wallet whose tokens back every promise.
    address public immutable MAKER;

    bytes32 public strategyHash;
    address public base;
    address public quote;

    /// @notice Collateral that open, unfilled orders still promise, per token. Read by ExposureGuard.
    /// @dev Grows at `post`, shrinks at `provide` (the promise became escrow) and at `release`.
    mapping(address token => uint256) public promised;
    mapping(uint256 orderId => bool) public isMine;
    /// @notice Every order this writer posted, in order.
    uint256[] public orderIds;

    modifier onlyBook() {
        require(msg.sender == address(BOOK), NotBook(msg.sender));
        _;
    }

    constructor(IAqua aqua, OptionBook book, address maker) Ownable(maker) {
        AQUA = aqua;
        BOOK = book;
        MAKER = maker;
    }

    // ---------------------------------------------------------------- strategy

    /// @notice Records the strategy the maker shipped with this contract as app.
    /// @dev Reverts unless Aqua already holds an active strategy with this hash for both tokens.
    function bind(Strategy calldata strategy) external onlyOwner returns (bytes32 hash) {
        bytes memory encoded = abi.encode(strategy);
        hash = keccak256(encoded);
        require(
            strategy.maker == MAKER && strategy.app == address(this),
            InvalidAquaStrategy(strategy.maker, hash, strategy.app, MAKER, address(this))
        );
        _requireShipped(hash, strategy.base);
        _requireShipped(hash, strategy.quote);
        strategyHash = hash;
        base = strategy.base;
        quote = strategy.quote;
        emit Bound(hash, strategy.base, strategy.quote);
    }

    // ---------------------------------------------------------------- orders

    /// @notice Posts a sourced order priced by `pricer` at every buy and records the promise. No tokens move.
    function post(uint256 seriesId, IPremium pricer, uint256 maxContracts) external onlyOwner returns (uint256 orderId) {
        require(strategyHash != bytes32(0), NotBound());
        (address seriesBase, address seriesQuote,,,,,) = BOOK.series(seriesId);
        require(seriesBase == base && seriesQuote == quote, SeriesTokensMismatch(seriesId, seriesBase, seriesQuote));
        orderId = BOOK.post(seriesId, pricer, maxContracts);
        (address token, uint256 amount) = BOOK.collateralFor(seriesId, maxContracts);
        isMine[orderId] = true;
        orderIds.push(orderId);
        promised[token] += amount;
        emit Promised(orderId, token, amount);
    }

    function orderCount() external view returns (uint256) {
        return orderIds.length;
    }

    function allOrders() external view returns (uint256[] memory) {
        return orderIds;
    }

    /// @notice Cancels the unfilled part of an order and drops its promise.
    /// @dev The owner may do this at any time; anyone may once the series has expired, so stale promises
    ///      stop capping the spot strategy.
    function release(uint256 orderId) external {
        require(isMine[orderId], OrderNotMine(orderId));
        (, uint256 seriesId,,,,,,,) = BOOK.orders(orderId);
        if (msg.sender != owner()) {
            (,,, uint64 expiry,,,) = BOOK.series(seriesId);
            require(block.timestamp >= expiry, OwnableUnauthorizedAccount(msg.sender));
        }
        uint256 unfilled = BOOK.cancel(orderId);
        (address token, uint256 amount) = BOOK.collateralFor(seriesId, unfilled);
        if (amount == 0) return;
        uint256 open = promised[token];
        amount = amount > open ? open : amount;
        promised[token] = open - amount;
        emit Unpromised(orderId, token, amount);
    }

    /// @notice Sends the order's premium from the book into the maker's strategy (quote balance).
    function claimPremium(uint256 orderId) external returns (uint256 amount) {
        require(isMine[orderId], OrderNotMine(orderId));
        amount = BOOK.claimPremium(orderId);
        if (amount > 0) {
            _push(quote, amount);
            emit PremiumPushed(orderId, quote, amount);
        }
    }

    // ---------------------------------------------------------------- ICollateralSource

    /// @inheritdoc ICollateralSource
    /// @dev The smallest of the Aqua virtual balance, the wallet balance and the wallet's allowance to Aqua.
    function available(uint256, address, address collateral) external view returns (uint256 amount) {
        if (strategyHash == bytes32(0)) return 0;
        (uint248 virtualBalance, uint8 tokensCount) = AQUA.rawBalances(MAKER, address(this), strategyHash, collateral);
        if (tokensCount == 0 || tokensCount == 0xff) return 0;
        amount = virtualBalance;
        uint256 wallet = IERC20(collateral).balanceOf(MAKER);
        if (wallet < amount) amount = wallet;
        uint256 allowance = IERC20(collateral).allowance(MAKER, address(AQUA));
        if (allowance < amount) amount = allowance;
    }

    /// @inheritdoc ICollateralSource
    /// @dev Tokens go straight from the maker's wallet to the book. The promise turns into escrow.
    function provide(uint256 seriesId, address, address collateral, uint256 amount) external onlyBook {
        AQUA.pull(MAKER, strategyHash, collateral, amount, address(BOOK));
        uint256 open = promised[collateral];
        promised[collateral] = open > amount ? open - amount : 0;
        emit Provided(seriesId, collateral, amount);
    }

    /// @inheritdoc ICollateralSource
    /// @dev The book has sent tokens here; push them back into the strategy so they are promised again.
    function onReturned(uint256 seriesId, address, address token, uint256 amount) external onlyBook {
        _push(token, amount);
        emit Returned(seriesId, token, amount);
    }

    // ---------------------------------------------------------------- internals

    function _push(address token, uint256 amount) internal {
        IERC20(token).forceApprove(address(AQUA), amount);
        AQUA.push(MAKER, address(this), strategyHash, token, amount);
    }

    function _requireShipped(bytes32 hash, address token) internal view {
        (, uint8 tokensCount) = AQUA.rawBalances(MAKER, address(this), hash, token);
        require(tokensCount > 0 && tokensCount != 0xff, StrategyNotShipped(hash, token));
    }
}
