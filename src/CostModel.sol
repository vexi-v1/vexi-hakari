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
///      - arbReversionSeconds > 0: the attacker re-pushes after every pull-back, so wider, shorter pushes are tried
///        too, up to each move's one-interval width ⌈x·W / R⌉, the narrowest push that moves the TWAP within one
///        reversion interval; no wider push can be cheaper. Past the last LP range a wider push costs no more fees,
///        so the cheapest hold is often exactly that: a push beyond the book, held for seconds. This term is only as
///        good as the reversion time the caller asserts: pass a slow bound.
///      - One view walk per direction prices every width (`PushCostLens.roundTripCosts`).
///      - Liquidity is read at settlement. A wall added in an earlier transaction inflates the bound (README).
library CostModel {
    uint256 internal constant WAD = 1e18;

    struct Bound {
        uint256 maxSafeExposure; // quote units
        int24 ticks; // the move that sets it
        bool up; // its tick direction
        uint256 cost; // what faking that move costs, quote units
        int24 width; // the push width that costs it (wider than `ticks` when a wider, shorter push is cheaper)
        bool complete; // false: the binding walk hit its cap, so the cost (and the bound) is "at least this"
    }

    /// @dev What to price: one more move (e.g. the gap between the two TWAPs; 0 for none), the TWAP window in seconds,
    ///      the arbitrage reversion time (0: nobody pulls back), which side is the quote, and the walk's step cap.
    struct Query {
        int24 extraTicks;
        uint32 window;
        uint32 arbReversionSeconds;
        bool quoteIsCurrency0;
        uint256 maxSteps;
    }

    /// @dev The cheapest way to hold one move: its cost, the push width that costs it, and whether that walk finished.
    struct Hold {
        uint256 cost;
        int24 width;
        bool complete;
    }

    /// @dev ≈ 0.5 %, 1 %, 2 %, 5 %, 10 %, 20 %.
    function ladder() internal pure returns (int24[6] memory) {
        return [int24(50), 100, 200, 488, 953, 1823];
    }

    function maxSafeExposure(PushCostLens lens, PoolKey calldata key, Query memory q) internal view returns (Bound memory b) {
        int24[] memory xs = moves(q.extraTicks);
        int24[] memory ds = widths(xs, q.window, q.arbReversionSeconds);
        b.maxSafeExposure = type(uint256).max;
        b.complete = true;
        for (uint256 dir; dir < 2; dir++) {
            bool up = dir == 0;
            (uint256[] memory in0, uint256[] memory in1, bool[] memory ok) = lens.roundTripCosts(key, ds, up, q.maxSteps);
            _cheapestOneWay(b, xs, ds, q.quoteIsCurrency0 ? in0 : in1, ok, up, q);
        }
    }

    /// @dev Lowers `b` to any move in this direction whose cheapest hold costs less per unit of gain.
    function _cheapestOneWay(
        Bound memory b,
        int24[] memory xs,
        int24[] memory ds,
        uint256[] memory roundTrips,
        bool[] memory ok,
        bool up,
        Query memory q
    ) private pure {
        for (uint256 i; i < xs.length; i++) {
            // the payout follows the asset; with the quote as currency0 the asset moves against the tick
            uint256 gain = gainIfFaked(WAD, xs[i], q.quoteIsCurrency0 ? !up : up);
            if (gain == 0) continue;
            Hold memory h = cheapestHold(xs[i], ds, roundTrips, ok, q.window, q.arbReversionSeconds);
            uint256 n = FullMath.mulDiv(h.cost, WAD, gain);
            if (n < b.maxSafeExposure) {
                (b.maxSafeExposure, b.ticks, b.up, b.cost, b.width, b.complete) = (n, xs[i], up, h.cost, h.width, h.complete);
            }
        }
    }

    /// @notice The moves priced: the ladder, and `extraTicks` when it is positive (capped at MAX_TICK).
    function moves(int24 extraTicks) internal pure returns (int24[] memory xs) {
        int24[6] memory l = ladder();
        xs = new int24[](extraTicks > 0 ? 7 : 6);
        for (uint256 i; i < 6; i++) {
            xs[i] = l[i];
        }
        if (extraTicks > 0) xs[6] = extraTicks > TickMath.MAX_TICK ? TickMath.MAX_TICK : extraTicks;
    }

    /// @notice The push widths to price, ascending and distinct. Every move; and while arbitrage is open, each move's
    ///         one-interval width ⌈x·W / R⌉ (the narrowest push that moves the TWAP by x within one reversion interval,
    ///         where the hold drops to one re-push and a wider push only costs more), plus the smallest move doubled
    ///         up to the largest of those, for holds that pay several re-pushes.
    function widths(int24[] memory xs, uint32 window, uint32 arbReversionSeconds)
        internal
        pure
        returns (int24[] memory ds)
    {
        int24[] memory all = new int24[](2 * xs.length + 24);
        for (uint256 i; i < xs.length; i++) {
            all[i] = xs[i];
        }
        uint256 n = arbReversionSeconds == 0 ? xs.length : _appendHoldWidths(all, xs, window, arbReversionSeconds);
        ds = _sortedDistinct(all, n);
    }

    /// @dev After the moves in `all`: each move's one-interval width, and the smallest move doubled below the largest.
    function _appendHoldWidths(int24[] memory all, int24[] memory xs, uint32 window, uint32 arbReversionSeconds)
        private
        pure
        returns (uint256 n)
    {
        n = xs.length;
        int24 d = xs[0];
        int24 widest;
        for (uint256 i; i < xs.length; i++) {
            if (xs[i] < d) d = xs[i];
            uint256 w = _ceilDiv(uint256(uint24(xs[i])) * window, arbReversionSeconds);
            int24 oneInterval = w >= uint256(uint24(TickMath.MAX_TICK)) ? TickMath.MAX_TICK : int24(uint24(w));
            if (oneInterval > xs[i]) all[n++] = oneInterval;
            if (oneInterval > widest) widest = oneInterval;
        }
        while (d < widest && d < TickMath.MAX_TICK / 2) {
            d *= 2;
            if (d < widest) all[n++] = d;
        }
    }

    /// @notice The cheapest way to hold a move of x ticks, over the widths `ds` priced by `roundTrips`.
    /// @dev A wider push never has a smaller round trip and still pays at least one re-push, so once the best is at
    ///      most two of the current round trip no wider push can beat it.
    function cheapestHold(
        int24 x,
        int24[] memory ds,
        uint256[] memory roundTrips,
        bool[] memory ok,
        uint32 window,
        uint32 arbReversionSeconds
    ) internal pure returns (Hold memory best) {
        bool found;
        for (uint256 j; j < ds.length; j++) {
            if (ds[j] < x) continue;
            uint256 cost = roundTrips[j] * (1 + _repushes(x, ds[j], window, arbReversionSeconds));
            if (!found || cost < best.cost) {
                best = Hold(cost, ds[j], ok[j]);
                found = true;
            }
            if (arbReversionSeconds == 0 || best.cost <= 2 * roundTrips[j]) break;
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

    /// @dev Holding d ticks off moves a W-second TWAP by x in ⌈x·W / d⌉ seconds; arbitrage undoes the push every
    ///      `arbReversionSeconds` of them.
    function _repushes(int24 x, int24 d, uint32 window, uint32 arbReversionSeconds) private pure returns (uint256) {
        if (arbReversionSeconds == 0) return 0;
        return _ceilDiv(_ceilDiv(uint256(uint24(x)) * window, uint256(uint24(d))), arbReversionSeconds);
    }

    /// @dev The first `n` entries of `a`, sorted ascending, duplicates dropped (insertion sort: n is small).
    function _sortedDistinct(int24[] memory a, uint256 n) private pure returns (int24[] memory out) {
        for (uint256 i = 1; i < n; i++) {
            int24 v = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > v) {
                a[j] = a[j - 1];
                j--;
            }
            a[j] = v;
        }
        uint256 m;
        for (uint256 i; i < n; i++) {
            if (m == 0 || a[i] != a[m - 1]) a[m++] = a[i];
        }
        out = new int24[](m);
        for (uint256 i; i < m; i++) {
            out[i] = a[i];
        }
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
