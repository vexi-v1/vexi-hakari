// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {PushCostLens} from "./PushCostLens.sol";

/// @title CostModel v1
/// @notice The largest exposure a v4 pool's price can safely carry: for every move x on a ladder, both ways, what faking
///         it would cost against what it would earn per unit of exposure; the smallest ratio is the bound.
/// @dev For a move of x ticks held over a W-second TWAP window, the attacker holds the pool d ticks off for s seconds
///      with d·s ≥ x·W. cost(d, s) = roundTrip(d) × (1 + re-pushes), re-pushes = ⌈s / arbReversionSeconds⌉.
///      - The walk starts at the pool's price now, both directions. A pool held at a fake price is cheap to move back
///        through the gap it was pushed across, so a held push shows up as a low bound whatever the two TWAPs say.
///      - arbReversionSeconds = 0: nobody pulls the price back (a fenced weekend stock); holding is free, d = x, and the
///        cost is fees on an exact retrace: a lower bound for the liquidity the pool has now.
///      - arbReversionSeconds > 0: the attacker re-pushes after every pull-back; wider, shorter pushes (d = 2x, 4x)
///        are tried too. This term is only as good as the reversion time the caller asserts: pass a slow bound.
///      - Liquidity is read at settlement. A wall added in an earlier transaction inflates the bound (README).
library CostModel {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant HOLD_RUNGS = 3; // d = x, 2x, 4x while arbitrage is open

    struct Bound {
        uint256 maxSafeExposure; // quote units
        int24 ticks; // the move that sets it
        bool up; // its tick direction
        uint256 cost; // what faking that move costs, quote units
        bool complete; // false: the binding walk hit its cap, so the cost (and the bound) is "at least this"
    }

    /// @dev ≈ 0.5 %, 1 %, 2 %, 5 %, 10 %, 20 %.
    function ladder() internal pure returns (int24[6] memory) {
        return [int24(50), 100, 200, 488, 953, 1823];
    }

    /// @param extraTicks one more move to price, e.g. the observed gap between the two TWAPs (0 for none)
    function maxSafeExposure(
        PushCostLens lens,
        PoolKey calldata key,
        int24 extraTicks,
        uint32 window,
        uint32 arbReversionSeconds,
        bool quoteIsCurrency0,
        uint256 maxSteps
    ) internal view returns (Bound memory b) {
        int24[6] memory xs = ladder();
        b.maxSafeExposure = type(uint256).max;
        b.complete = true;
        for (uint256 i; i <= xs.length; i++) {
            int24 x = i < xs.length ? xs[i] : extraTicks;
            if (x <= 0) continue;
            for (uint256 dir; dir < 2; dir++) {
                bool up = dir == 0;
                (uint256 cost, bool ok) = costToHold(lens, key, x, up, window, arbReversionSeconds, quoteIsCurrency0, maxSteps);
                // the payout follows the asset; with the quote as currency0 the asset moves against the tick
                uint256 gain = gainIfFaked(WAD, x, quoteIsCurrency0 ? !up : up);
                if (gain == 0) continue;
                uint256 n = FullMath.mulDiv(cost, WAD, gain);
                if (n < b.maxSafeExposure) b = Bound(n, x, up, cost, ok);
            }
        }
    }

    /// @notice What it costs, in the quote, to hold the price x ticks off (from where it is now) over a W-second TWAP.
    function costToHold(
        PushCostLens lens,
        PoolKey calldata key,
        int24 x,
        bool up,
        uint32 window,
        uint32 arbReversionSeconds,
        bool quoteIsCurrency0,
        uint256 maxSteps
    ) internal view returns (uint256 best, bool complete) {
        int24 d = x;
        uint256 rungs = arbReversionSeconds == 0 ? 1 : HOLD_RUNGS;
        for (uint256 k; k < rungs; k++) {
            (, uint256 in0, uint256 in1, bool ok) = lens.roundTripCost(key, d, up, maxSteps);
            uint256 roundTrip = quoteIsCurrency0 ? in0 : in1;
            uint256 repushes;
            if (arbReversionSeconds != 0) {
                uint256 holdSeconds = _ceilDiv(uint256(uint24(x)) * window, uint256(uint24(d)));
                repushes = _ceilDiv(holdSeconds, arbReversionSeconds);
            }
            uint256 cost = roundTrip * (1 + repushes);
            if (k == 0 || cost < best) {
                best = cost;
                complete = ok;
            }
            if (d > TickMath.MAX_TICK / 4) break;
            d *= 2;
        }
    }

    /// @notice How much a payout on `exposure` (quote units) moves when the asset's price is off by x ticks.
    /// @dev assetUp: exposure × (1.0001^x − 1); down: exposure × (1 − 1.0001^−x). Delta ≈ 1, as for a deep ITM option.
    ///      The caller turns the tick direction into the asset's direction (they are opposite when the quote is
    ///      currency0).
    function gainIfFaked(uint256 exposure, int24 x, bool assetUp) internal pure returns (uint256) {
        if (x > TickMath.MAX_TICK) x = TickMath.MAX_TICK;
        uint160 r = TickMath.getSqrtPriceAtTick(x); // sqrt(1.0001^x) in Q96
        if (assetUp) {
            uint256 moved = FullMath.mulDiv(FullMath.mulDiv(exposure, r, FixedPoint96.Q96), r, FixedPoint96.Q96);
            return moved > exposure ? moved - exposure : 0;
        }
        uint256 kept = FullMath.mulDiv(FullMath.mulDiv(exposure, FixedPoint96.Q96, r), FixedPoint96.Q96, r);
        return exposure > kept ? exposure - kept : 0;
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
