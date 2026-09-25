// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {PushCostLens} from "./PushCostLens.sol";

/// @title CostModel v0
/// @notice What it costs to move a W-second raw TWAP by x ticks, and what that move is worth to an attacker.
/// @dev To move the TWAP by x the attacker holds the pool d ticks off-price for s seconds with d·s ≥ x·W, s ≤ W.
///      cost(d, s) = roundTrip(d) + (arbOpen ? s × roundTrip(d) : 0): one push, plus one re-push per second
///      while arbitrageurs keep pulling it back. With arbitrage closed (a fenced weekend stock) the holding cost
///      is ~0 and d = x is optimal. With arbitrage open a wider, shorter push may be cheaper when liquidity thins
///      away from the price, so a small ladder of d is tried. Everything is a conservative lower bound: the
///      round trip counts fees only (an exact retrace has no impact loss) and the walk is capped.
///      The walk starts from the pool's *current* price in the direction of the raw/truncated gap.
library CostModel {
    uint256 internal constant LADDER = 4; // d = x, 2x, 4x, 8x

    function costToFake(
        PushCostLens lens,
        PoolKey calldata key,
        int24 x,
        bool up,
        uint32 window,
        bool arbOpen,
        bool quoteIsCurrency0,
        uint256 maxSteps
    ) internal view returns (uint256 best, bool complete) {
        int24 d = x;
        uint256 rungs = arbOpen ? LADDER : 1;
        for (uint256 i; i < rungs; i++) {
            (, uint256 in0, uint256 in1, bool ok) = lens.roundTripCost(key, d, up, maxSteps);
            uint256 roundTrip = quoteIsCurrency0 ? in0 : in1;
            uint256 holdSeconds = arbOpen ? _ceilDiv(uint256(uint24(x)) * window, uint256(uint24(d))) : 0;
            uint256 cost = roundTrip * (1 + holdSeconds);
            if (i == 0 || cost < best) {
                best = cost;
                complete = ok;
            }
            if (d > TickMath.MAX_TICK / 2) break;
            d *= 2;
        }
    }

    /// @notice How much a payout on `notional` (quote units) moves when the settlement tick is off by x.
    /// @dev up: notional × (1.0001^x − 1); down: notional × (1 − 1.0001^−x). Delta ≈ 1, as for a deep ITM option.
    function gainIfFaked(uint256 notional, int24 x, bool up) internal pure returns (uint256) {
        if (x > TickMath.MAX_TICK) x = TickMath.MAX_TICK;
        uint160 r = TickMath.getSqrtPriceAtTick(x); // sqrt(1.0001^x) in Q96
        if (up) {
            uint256 moved = FullMath.mulDiv(FullMath.mulDiv(notional, r, FixedPoint96.Q96), r, FixedPoint96.Q96);
            return moved > notional ? moved - notional : 0;
        }
        uint256 kept = FullMath.mulDiv(FullMath.mulDiv(notional, FixedPoint96.Q96, r), FixedPoint96.Q96, r);
        return notional > kept ? notional - kept : 0;
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
