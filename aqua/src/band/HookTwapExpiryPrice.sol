// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";

import { IExpiryPrice } from "../price/IExpiryPrice.sol";
import { BandMath, ITruncatedOracle } from "./BandMath.sol";

/// @title HookTwapExpiryPrice
/// @notice Settles a series on a Uniswap v4 pool's TWAP, read from the pool's HAKARI oracle hook, but only when that
///         TWAP lies inside a fixed band around the TWAP the pool drew just before it. For a token with no price feed,
///         or a stock token over a weekend, when its market is closed and the pool is the only price.
///
///         For expiry `at`, attempt i = 0, 1, …, attempts − 1 reads the window that ends at e = at + i × settleWindow:
///           settle  = TWAP over [e − settleWindow, e]                       (e.g. 300 s)
///           center  = TWAP over the band window: [at − settleWindow − bandWindow, at − settleWindow] when
///                     `bandFromExpiry` (every attempt is held to the band drawn before expiry), else the
///                     bandWindow just before this attempt's settle window
///           accept  if |settle − center| ≤ halfWidthBps × center
///         The price is the first accepted attempt's settle TWAP. An attempt whose window has not ended yet reverts
///         `NotYet`, so the book's `settle` reverts and its grace waits: a push at expiry defers settlement to the
///         next window rather than setting the price. If no attempt is accepted, `NoWindowInBand`: the series cannot
///         be settled here and, after the book's grace, holders get their premiums back (`OptionBook.refund`).
///
/// @dev The answer is a pure function of the hook's observations, so anyone computes the same one. The hook keeps a
///      ring of observations (one per second with a swap); once the ring wraps past the band window the reads revert.
///      `record` stores the answer on chain the first time it can be computed, so a settlement no longer depends on
///      the ring afterwards: call it soon after the accepted window ends (a keeper or the settler).
///
///      A source is set once per pair and can never be changed, so no party can move the settlement source after
///      options have been sold.
contract HookTwapExpiryPrice is IExpiryPrice, Ownable {
    using StateLibrary for IPoolManager;

    struct Params {
        uint32 settleWindow; // seconds of TWAP that settle (and the step between attempts)
        uint32 bandWindow; // seconds before the settle window that draw the band's center
        uint16 attempts; // settle windows tried, one after another from expiry
        uint16 halfWidthBps; // the band's half-width, fixed, in bps of the center
        bool bandFromExpiry; // true: every attempt uses the band drawn before expiry; false: a band per attempt
    }

    struct Source {
        ITruncatedOracle oracle;
        PoolId poolId;
        bool baseIs0;
        uint256 scale;
        Params params;
    }

    /// @notice One attempt, for a UI or a settler: the windows it read and whether it was accepted.
    struct Attempt {
        uint64 windowEnd;
        int24 settleTick;
        int24 centerTick;
        uint256 centerWad;
        uint256 priceWad;
        uint256 halfWidthBps;
        bool accepted;
    }

    error NoSource(address base, address quote);
    error SourceAlreadySet(address base, address quote);
    error BadParams();
    error PairMismatch(address base, address quote);
    error PoolNotInitialized(PoolId poolId);
    error NotYet(uint64 windowEnd);
    error NoWindowInBand(uint64 at, uint16 attempts);

    event SourceSet(address indexed base, address indexed quote, address oracle, PoolId poolId, Params params);
    event Recorded(address indexed base, address indexed quote, uint64 indexed at, uint256 priceWad, uint16 attempt);

    /// @notice The widest half-width an owner may set: 50 %.
    uint16 public constant MAX_HALF_WIDTH_BPS = 5000;

    mapping(address base => mapping(address quote => Source)) internal _sources;
    mapping(address base => mapping(address quote => mapping(uint64 at => uint256 priceWad))) public recorded;

    constructor(address owner_) Ownable(owner_) { }

    /// @notice Binds a pair to a HAKARI-hooked v4 pool (its key's `hooks` is the oracle), once.
    function setSource(IPoolManager manager, PoolKey calldata key, address base, address quote, Params calldata p)
        external
        onlyOwner
    {
        require(address(_sources[base][quote].oracle) == address(0), SourceAlreadySet(base, quote));
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        bool baseIs0 = c0 == base && c1 == quote;
        require(baseIs0 || (c0 == quote && c1 == base), PairMismatch(base, quote));
        require(address(key.hooks) != address(0), BadParams());
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(key.toId());
        require(sqrtPriceX96 != 0, PoolNotInitialized(key.toId()));
        require(
            p.settleWindow > 0 && p.bandWindow > 0 && p.attempts > 0 && p.halfWidthBps > 0
                && p.halfWidthBps <= MAX_HALF_WIDTH_BPS,
            BadParams()
        );
        uint8 bd = IERC20Metadata(base).decimals();
        uint8 qd = IERC20Metadata(quote).decimals();
        require(bd <= 18 && qd <= 18, BadParams());
        _sources[base][quote] = Source({
            oracle: ITruncatedOracle(address(key.hooks)),
            poolId: key.toId(),
            baseIs0: baseIs0,
            scale: 10 ** (18 + uint256(bd) - uint256(qd)),
            params: p
        });
        emit SourceSet(base, quote, address(key.hooks), key.toId(), p);
    }

    function source(address base, address quote) external view returns (Source memory) {
        return _sources[base][quote];
    }

    // ---------------------------------------------------------------- IExpiryPrice

    /// @inheritdoc IExpiryPrice
    function covers(address base, address quote) external view returns (bool) {
        return address(_sources[base][quote].oracle) != address(0);
    }

    /// @inheritdoc IExpiryPrice
    /// @dev The last attempt's window ends (attempts − 1) × settleWindow after expiry; a book's grace must be longer.
    function maxDelay(address base, address quote) external view returns (uint64) {
        Params memory p = _sources[base][quote].params;
        return uint64(p.attempts) * p.settleWindow;
    }

    /// @inheritdoc IExpiryPrice
    function priceAt(address base, address quote, uint64 at) external view returns (uint256 priceWad) {
        (priceWad,) = _price(base, quote, at);
    }

    /// @notice Stores the settlement price for `at` once it can be computed, so it no longer depends on the hook's
    ///         ring of observations. Anyone may call it; it stores only what `priceAt` computes.
    function record(address base, address quote, uint64 at) external returns (uint256 priceWad) {
        uint16 used;
        (priceWad, used) = _price(base, quote, at);
        if (recorded[base][quote][at] == 0) {
            recorded[base][quote][at] = priceWad;
            emit Recorded(base, quote, at, priceWad, used);
        }
    }

    function _price(address base, address quote, uint64 at) internal view returns (uint256 priceWad, uint16 i) {
        uint256 stored = recorded[base][quote][at];
        if (stored != 0) return (stored, type(uint16).max);
        Source memory src = _sources[base][quote];
        require(address(src.oracle) != address(0), NoSource(base, quote));
        for (i = 0; i < src.params.attempts; i++) {
            uint64 end = at + uint64(i) * src.params.settleWindow;
            require(end <= block.timestamp, NotYet(end));
            Attempt memory a = _attempt(src, at, end);
            if (a.accepted) return (a.priceWad, i);
        }
        revert NoWindowInBand(at, src.params.attempts);
    }

    /// @notice Reads attempt `i` for expiry `at`: its settle window and its band, accepted or not.
    function attempt(address base, address quote, uint64 at, uint16 i) external view returns (Attempt memory) {
        Source memory src = _sources[base][quote];
        require(address(src.oracle) != address(0), NoSource(base, quote));
        uint64 end = at + uint64(i) * src.params.settleWindow;
        require(end <= block.timestamp, NotYet(end));
        return _attempt(src, at, end);
    }

    function _attempt(Source memory src, uint64 at, uint64 end) internal view returns (Attempt memory a) {
        Params memory p = src.params;
        uint32 endAgo = uint32(block.timestamp - end);
        uint32 settleStartAgo = endAgo + p.settleWindow;
        // The band ends where the expiry's own settle window starts, or where this attempt's does.
        uint32 bandEndAgo = p.bandFromExpiry ? uint32(block.timestamp - at) + p.settleWindow : settleStartAgo;
        uint32[] memory ago = new uint32[](4);
        ago[0] = bandEndAgo + p.bandWindow;
        ago[1] = bandEndAgo;
        ago[2] = settleStartAgo;
        ago[3] = endAgo;
        (int56[] memory c,) = src.oracle.observe(ago, src.poolId);

        a.windowEnd = end;
        a.centerTick = BandMath.avgTick(c[1] - c[0], p.bandWindow);
        a.settleTick = BandMath.avgTick(c[3] - c[2], p.settleWindow);
        a.centerWad = BandMath.priceOf(TickMath.getSqrtPriceAtTick(a.centerTick), src.baseIs0, src.scale);
        a.priceWad = BandMath.priceOf(TickMath.getSqrtPriceAtTick(a.settleTick), src.baseIs0, src.scale);
        a.halfWidthBps = p.halfWidthBps;
        a.accepted = BandMath.within(a.priceWad, a.centerWad, p.halfWidthBps);
    }
}
