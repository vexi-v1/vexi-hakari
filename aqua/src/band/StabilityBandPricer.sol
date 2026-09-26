// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";

import { IPremium } from "../book/IPremium.sol";
import { BandMath, ITruncatedOracle } from "./BandMath.sol";

/// @title StabilityBandPricer
/// @notice An `IPremium` that quotes what the writer's own pricer quotes, but only inside a fixed band around a
///         Uniswap v4 reference pool's TWAP, and quotes less the nearer the price is to the band's edge:
///
///           center     = the reference pool's TWAP over `bandWindow` (default one hour), from its HAKARI hook
///           halfWidth  = `halfWidthBps` of the center (default 5 %)
///           current    = the reference pool's slot0 price (default), or its TWAP over `nowWindow` seconds
///           u          = |current − center| / halfWidth                  (0 at the center, 1 at the edge)
///           ask        = inner ask × (1 + maxExtra × u²)
///           contracts  ≤ maxContracts × (1 − u) per call
///
///         It stops quoting (reverts `Paused`) when u > 1 or not one contract is left, when the reference cannot be
///         read over the window, when its in-range liquidity is below `minLiquidity`, and when the hook's raw and
///         truncated TWAPs over the window are more than a half-width apart (a jump larger than the truncation
///         absorbs).
///
/// @dev Why a fixed 5 %: it is the band the US equity market itself uses for these names. Under the Limit Up-Limit
///      Down plan, a Tier 1 stock (S&P 500, Russell 1000) priced above $3 may not trade more than 5 % away from its
///      average price over the preceding five minutes, and trading pauses if it stays at that limit. The tokenized
///      stocks this was built for (TSLA, AAPL on Robinhood Chain) are Tier 1, so the book stops selling at a fixed
///      premium about where the stock's own market would stop trading it; on a weekend, when that market is closed
///      and the pool is the only price, the band is the only brake left. The owner may set any half-width up to 50 %.
///
///      Nothing is stored per trade: `ask` is a view, so the taper is a function of prices at this block, not of
///      what traded before. `status` never reverts, so a board keeps rendering while the book refuses.
///
///      `current` is the slot0 price by default, so option liquidity reacts to a push of the reference at once. A
///      TWAP (`nowWindow` > 0) hides a push made in this transaction, because the hook writes its observation before
///      the swap, once per block timestamp, but it lags a genuine move by its window.
contract StabilityBandPricer is IPremium, Ownable {
    using StateLibrary for IPoolManager;

    enum Reason {
        None,
        ReferenceTooThin, // the reference pool's in-range liquidity is below minLiquidity
        ReferenceUnavailable, // the hook cannot answer over bandWindow (pool younger than it, or its ring wrapped)
        SeriesDisagree, // raw and truncated TWAPs over bandWindow are more than a half-width apart
        OutsideBand // u > 1, or so near 1 that not one contract is left
    }

    struct Params {
        uint32 bandWindow; // seconds of TWAP for the band's center
        uint32 nowWindow; // seconds of TWAP for `current`; 0 = the reference pool's slot0 price
        uint16 halfWidthBps; // the band's half-width, fixed, in bps of the center
        uint16 maxExtraBps; // the spread added to the ask at u = 1 (quadratic in u)
        uint32 maxContracts; // contracts per call at u = 0
        uint128 minLiquidity; // least in-range liquidity of the reference pool
    }

    /// @notice Everything the band reads and decides, for a UI. Fields after a failed read are zero.
    struct Status {
        bool quoting;
        Reason reason;
        uint256 centerWad; // reference TWAP over bandWindow (raw)
        uint256 truncatedCenterWad; // the same window on the hook's truncated series
        uint256 currentWad; // reference slot0 price, or its TWAP over nowWindow
        int24 centerTick;
        int24 truncatedCenterTick;
        int24 currentTick;
        uint128 liquidity; // reference pool in-range liquidity
        uint256 halfWidthBps;
        uint256 uWad; // position in the band, 1e18 = the edge
        uint256 extraBps; // added to the ask
        uint256 sizeCap; // contracts per call
    }

    error Paused(Reason reason);
    error SizeCapped(uint256 n, uint256 cap);
    error BadParams();
    error NoOracleHook();
    error PoolNotInitialized(PoolId poolId);
    error PairMismatch(address base, address quote, Currency currency0, Currency currency1);
    error BadDecimals(uint8 baseDecimals, uint8 quoteDecimals);

    event ParamsSet(Params params);

    uint256 internal constant WAD = 1e18;
    /// @notice The widest half-width an owner may set: 50 %.
    uint16 public constant MAX_HALF_WIDTH_BPS = 5000;
    /// @notice The half-width the band ships with: 5 %, the Limit Up-Limit Down band of a Tier 1 US stock.
    uint16 public constant DEFAULT_HALF_WIDTH_BPS = 500;

    IPremium public immutable INNER;
    IPoolManager public immutable POOL_MANAGER;
    /// @notice The reference pool's hook, which keeps its oracle.
    ITruncatedOracle public immutable ORACLE;
    PoolId public immutable POOL_ID;
    address public immutable BASE;
    address public immutable QUOTE;
    bool public immutable BASE_IS_CURRENCY0;
    Currency internal immutable CURRENCY0;
    Currency internal immutable CURRENCY1;
    uint24 internal immutable FEE;
    int24 internal immutable TICK_SPACING;
    /// @dev 10^(18 + baseDecimals - quoteDecimals): raw quote-per-base units to WAD per whole token.
    uint256 internal immutable SCALE;

    Params internal _params;

    constructor(
        IPremium inner,
        IPoolManager poolManager,
        PoolKey memory key,
        address base,
        address quote,
        Params memory p,
        address owner_
    ) Ownable(owner_) {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        bool baseIs0 = c0 == base && c1 == quote;
        require(baseIs0 || (c0 == quote && c1 == base), PairMismatch(base, quote, key.currency0, key.currency1));
        require(address(key.hooks) != address(0), NoOracleHook());
        uint8 baseDecimals = IERC20Metadata(base).decimals();
        uint8 quoteDecimals = IERC20Metadata(quote).decimals();
        require(baseDecimals <= 18 && quoteDecimals <= 18, BadDecimals(baseDecimals, quoteDecimals));

        INNER = inner;
        POOL_MANAGER = poolManager;
        ORACLE = ITruncatedOracle(address(key.hooks));
        POOL_ID = key.toId();
        BASE = base;
        QUOTE = quote;
        BASE_IS_CURRENCY0 = baseIs0;
        CURRENCY0 = key.currency0;
        CURRENCY1 = key.currency1;
        FEE = key.fee;
        TICK_SPACING = key.tickSpacing;
        SCALE = 10 ** (18 + uint256(baseDecimals) - uint256(quoteDecimals));

        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        require(sqrtPriceX96 != 0, PoolNotInitialized(key.toId()));
        _setParams(p);
    }

    /// @notice The defaults: a 5 % band around the one-hour TWAP, `current` = the slot0 price, up to +20 % spread at
    ///         the edge, 50 contracts per call at the center.
    function defaultParams() public pure returns (Params memory) {
        return Params({
            bandWindow: 3600,
            nowWindow: 0,
            halfWidthBps: DEFAULT_HALF_WIDTH_BPS,
            maxExtraBps: 2000,
            maxContracts: 50,
            minLiquidity: 0
        });
    }

    // ---------------------------------------------------------------- owner

    function setParams(Params calldata p) external onlyOwner {
        _setParams(p);
    }

    function params() external view returns (Params memory) {
        return _params;
    }

    function _setParams(Params memory p) internal {
        require(
            p.bandWindow > 0 && p.nowWindow < p.bandWindow && p.halfWidthBps > 0
                && p.halfWidthBps <= MAX_HALF_WIDTH_BPS && p.maxExtraBps < 10_000 && p.maxContracts > 0,
            BadParams()
        );
        _params = p;
        emit ParamsSet(p);
    }

    // ---------------------------------------------------------------- the band

    /// @notice The reference pool's key.
    function poolKey() external view returns (PoolKey memory) {
        return PoolKey({
            currency0: CURRENCY0, currency1: CURRENCY1, fee: FEE, tickSpacing: TICK_SPACING, hooks: IHooks(address(ORACLE))
        });
    }

    /// @notice Everything the band reads and decides, without reverting.
    function status() public view returns (Status memory s) {
        Params memory p = _params;
        s.halfWidthBps = p.halfWidthBps;
        (uint160 sqrtPriceX96, int24 slot0Tick,,) = POOL_MANAGER.getSlot0(POOL_ID);
        s.liquidity = POOL_MANAGER.getLiquidity(POOL_ID);
        if (s.liquidity < p.minLiquidity) return _pause(s, Reason.ReferenceTooThin);

        uint32[] memory ago = new uint32[](p.nowWindow > 0 ? 3 : 2);
        ago[0] = p.bandWindow; // ago[1] = 0: now
        if (p.nowWindow > 0) ago[2] = p.nowWindow;
        int56[] memory raw;
        int56[] memory trunc;
        try ORACLE.observe(ago, POOL_ID) returns (int56[] memory r, int56[] memory t) {
            (raw, trunc) = (r, t);
        } catch {
            return _pause(s, Reason.ReferenceUnavailable);
        }

        s.centerTick = BandMath.avgTick(raw[1] - raw[0], p.bandWindow);
        s.truncatedCenterTick = BandMath.avgTick(trunc[1] - trunc[0], p.bandWindow);
        s.centerWad = priceOf(TickMath.getSqrtPriceAtTick(s.centerTick));
        s.truncatedCenterWad = priceOf(TickMath.getSqrtPriceAtTick(s.truncatedCenterTick));
        if (p.nowWindow == 0) {
            s.currentTick = slot0Tick;
            s.currentWad = priceOf(sqrtPriceX96);
        } else {
            s.currentTick = BandMath.avgTick(raw[1] - raw[2], p.nowWindow);
            s.currentWad = priceOf(TickMath.getSqrtPriceAtTick(s.currentTick));
        }

        uint256 halfWidthWad = Math.mulDiv(s.centerWad, p.halfWidthBps, 10_000);
        uint256 far = BandMath.dist(s.currentWad, s.centerWad);
        // u saturates instead of overflowing when the price is absurdly far from a tiny center, so status never reverts.
        s.uWad = halfWidthWad == 0 || far / halfWidthWad >= type(uint256).max / WAD / 2
            ? type(uint256).max
            : Math.mulDiv(far, WAD, halfWidthWad, Math.Rounding.Ceil);

        if (!BandMath.within(s.truncatedCenterWad, s.centerWad, p.halfWidthBps)) {
            return _pause(s, Reason.SeriesDisagree);
        }
        if (s.uWad > WAD) return _pause(s, Reason.OutsideBand);
        s.sizeCap = sizeCapAt(s.uWad, p.maxContracts);
        if (s.sizeCap == 0) return _pause(s, Reason.OutsideBand); // at the edge: not one contract left
        s.extraBps = extraBpsAt(s.uWad, p.maxExtraBps);
        s.quoting = true;
    }

    /// @notice The spread added at position `uWad` in the band: maxExtra × u², rounded up.
    function extraBpsAt(uint256 uWad, uint16 maxExtraBps) public pure returns (uint256) {
        if (uWad >= WAD) return maxExtraBps;
        return Math.mulDiv(uint256(maxExtraBps) * uWad, uWad, WAD * WAD, Math.Rounding.Ceil);
    }

    /// @notice Contracts per call at position `uWad` in the band: maxContracts × (1 − u), rounded down.
    function sizeCapAt(uint256 uWad, uint32 maxContracts) public pure returns (uint256) {
        if (uWad >= WAD) return 0;
        return uint256(maxContracts) * (WAD - uWad) / WAD;
    }

    /// @notice A pool `sqrtPriceX96` as WAD quote per base (whole tokens), whichever currency the base is.
    function priceOf(uint160 sqrtPriceX96) public view returns (uint256) {
        return BandMath.priceOf(sqrtPriceX96, BASE_IS_CURRENCY0, SCALE);
    }

    function _pause(Status memory s, Reason reason) internal pure returns (Status memory) {
        s.reason = reason;
        s.quoting = false;
        s.extraBps = 0;
        s.sizeCap = 0;
        return s;
    }

    // ---------------------------------------------------------------- quotes

    /// @inheritdoc IPremium
    function ask(uint256 seriesId, uint256 n) external view returns (uint256) {
        Status memory s = status();
        require(s.quoting, Paused(s.reason));
        require(n <= s.sizeCap, SizeCapped(n, s.sizeCap));
        return Math.mulDiv(INNER.ask(seriesId, n), 10_000 + s.extraBps, 10_000, Math.Rounding.Ceil);
    }
}
