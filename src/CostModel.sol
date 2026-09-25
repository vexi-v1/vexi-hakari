// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {PushCostLens} from "./PushCostLens.sol";

/// @title CostModel v0
/// @notice What it costs to move a W-second raw TWAP by x ticks away from the truncated (honest) price, and what that
///         move is worth to an attacker.
/// @dev To move the TWAP by x the attacker holds the pool d ticks off the honest price for s seconds with d·s ≥ x·W.
///      cost(d, s) = roundTrip(honest → honest ± d) × (1 + re-pushes), re-pushes = ⌈s / arbReversionSeconds⌉.
///      - The walk is over the stretch the attacker had to cross — from the truncated price to where it held the
///        pool — through the liquidity in the pool now. It is not measured from wherever the pool sits at settlement.
///      - arbReversionSeconds = 0: nobody pulls the price back (a fenced weekend stock); holding is free and d = x.
///        Then the cost is fees only on an exact retrace: a lower bound for the liquidity the pool has right now.
///      - arbReversionSeconds > 0: arbitrageurs pull the price back once per that many seconds and the attacker
///        re-pushes each time; a wider, shorter push (d = 2x, 4x, 8x) is tried too. This term is only as good as the
///        reversion time the caller asserts. Asserting a faster reversion than the market delivers overstates the
///        cost and makes the raw price look safer than it is, so callers should pass a slow, measured bound.
///      - The walk is capped at `maxSteps` segments; `complete = false` means "at least this".
library CostModel {
    uint256 internal constant LADDER = 4; // d = x, 2x, 4x, 8x

    function costToFake(
        PushCostLens lens,
        PoolKey calldata key,
        int24 truncTick,
        int24 x,
        bool up,
        uint32 window,
        uint32 arbReversionSeconds,
        bool quoteIsCurrency0,
        uint256 maxSteps
    ) internal view returns (uint256 best, bool complete) {
        int24 d = x;
        uint256 rungs = arbReversionSeconds == 0 ? 1 : LADDER;
        for (uint256 i; i < rungs; i++) {
            int24 heldAt = up ? truncTick + d : truncTick - d;
            (, uint256 in0, uint256 in1, bool ok) = lens.roundTripCostBetween(key, truncTick, heldAt, maxSteps);
            uint256 roundTrip = quoteIsCurrency0 ? in0 : in1;
            uint256 holdSeconds = _ceilDiv(uint256(uint24(x)) * window, uint256(uint24(d)));
            uint256 repushes = arbReversionSeconds == 0 ? 0 : _ceilDiv(holdSeconds, arbReversionSeconds);
            uint256 cost = roundTrip * (1 + repushes);
            if (i == 0 || cost < best) {
                best = cost;
                complete = ok;
            }
            if (d > TickMath.MAX_TICK / 4) break;
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
