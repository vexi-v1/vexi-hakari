// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { FullMath } from "@uniswap/v4-core/src/libraries/FullMath.sol";
import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice The oracle a HAKARI pool's hook keeps: OpenZeppelin's `BaseOracleHook` (Panoptic's truncated oracle).
/// @dev Cumulative ticks (raw and truncated) as of each `secondsAgos`; reverts
///      `TargetPredatesOldestObservation` for a time older than the oldest stored observation.
interface ITruncatedOracle {
    function observe(uint32[] calldata secondsAgos, PoolId underlyingPoolId)
        external
        view
        returns (int56[] memory tickCumulatives, int56[] memory truncatedTickCumulatives);
}

/// @title BandMath
/// @notice The arithmetic the stability band and the TWAP settlement share: an average tick from two cumulative
///         ticks, a pool price as WAD quote per base, and whether a price sits inside a fixed band.
library BandMath {
    /// @dev Uniswap's convention: round toward negative infinity.
    function avgTick(int56 delta, uint32 window) internal pure returns (int24 tick) {
        tick = int24(delta / int56(uint56(window)));
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) tick--;
    }

    /// @notice A pool `sqrtPriceX96` as WAD quote per base (whole tokens), whichever currency the base is; `scale` is
    ///         10^(18 + baseDecimals − quoteDecimals).
    /// @dev The square goes through X128 above 2^128, so no product overflows 256 bits.
    function priceOf(uint160 sqrtPriceX96, bool baseIs0, uint256 scale) internal pure returns (uint256) {
        if (sqrtPriceX96 == 0) return 0;
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            return baseIs0 ? FullMath.mulDiv(ratioX192, scale, 1 << 192) : FullMath.mulDiv(1 << 192, scale, ratioX192);
        }
        uint256 ratioX128 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
        return baseIs0 ? FullMath.mulDiv(ratioX128, scale, 1 << 128) : FullMath.mulDiv(1 << 128, scale, ratioX128);
    }

    /// @notice |a − b|.
    function dist(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    /// @notice Whether `price` lies within `halfWidthBps` of `center` (edges included).
    /// @dev dist ≤ ⌊center × bps / 10⁴⌋ is the same test as dist × 10⁴ ≤ center × bps for integers, without overflow.
    function within(uint256 price, uint256 center, uint256 halfWidthBps) internal pure returns (bool) {
        return dist(price, center) <= FullMath.mulDiv(center, halfWidthBps, 10_000);
    }
}
