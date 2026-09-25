// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityMath} from "@uniswap/v4-core/src/libraries/LiquidityMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {BitMath} from "@uniswap/v4-core/src/libraries/BitMath.sol";
import {ProtocolFeeLibrary} from "@uniswap/v4-core/src/libraries/ProtocolFeeLibrary.sol";

/// @title PushCostLens
/// @notice What it costs to push a Uniswap v4 pool's price by `ticks` and sell straight back.
/// @dev Two modes:
///      - `quotePush` is an exact simulation: it unlocks the PoolManager, swaps to the target price with a huge
///        exact-input amount, sells back exactly what it received, and reverts with the result (the V4Quoter
///        pattern). Every hook and fee on the pool runs for real; every state change is undone. Call it with
///        `eth_call` — on a chain you cannot deploy to, inject this bytecode with an `eth_call` state override.
///      - `depthToMove` / `roundTripCost` are views that walk the tick bitmap through `StateLibrary` (extsload),
///        so a contract that is itself inside an unlock can still ask. They use the pool's stored LP fee and
///        protocol fee; a hook that overrides the fee per swap is not seen here (it is in `quotePush`).
contract PushCostLens is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using ProtocolFeeLibrary for uint24;
    using ProtocolFeeLibrary for uint16;

    struct PushQuote {
        uint160 sqrtPriceStart;
        int24 tickStart;
        uint160 sqrtPriceTarget;
        uint160 sqrtPriceReached; // == target unless the pool ran out of the huge input (never, in practice)
        int24 tickReached;
        bool zeroForOne; // false: price pushed up, paid in currency1; true: pushed down, paid in currency0
        uint256 amountIn; // input token spent on the push leg, fees included
        uint256 amountOut; // output token received on the push leg
        uint256 amountBackOut; // input token recovered by selling `amountOut` straight back
        uint256 cost; // amountIn - amountBackOut, in the input token
        uint256 costInCurrency0; // `cost` valued at the start price
        uint256 costInCurrency1;
    }

    error ZeroTicks();
    error NotPoolManager();
    error UnexpectedSuccess();
    /// @dev Carries the result out of `unlockCallback`; never surfaces to a caller.
    error QuoteResult(PushQuote quote);

    IPoolManager public immutable poolManager;

    /// @dev Large enough to reach any price limit on any real pool, small enough for v4's int128 deltas.
    int256 private constant HUGE_EXACT_INPUT = -int256(uint256(type(uint120).max));

    constructor(IPoolManager manager) {
        poolManager = manager;
    }

    // ───────────────────────── exact simulation ─────────────────────────

    /// @notice Push the price by `ticks` (up if `up`, else down), sell back what came out, report the round trip.
    /// @dev Reverts internally and decodes its own revert; the pool is left exactly as it was.
    function quotePush(PoolKey calldata key, int24 ticks, bool up) external returns (PushQuote memory) {
        if (ticks <= 0) revert ZeroTicks();
        try poolManager.unlock(abi.encode(key, ticks, up)) {}
        catch (bytes memory reason) {
            return _parse(reason);
        }
        revert UnexpectedSuccess();
    }

    /// @notice `quotePush` for several distances, each its own unlock.
    function quotePushLadder(PoolKey calldata key, int24[] calldata ticks, bool up)
        external
        returns (PushQuote[] memory quotes)
    {
        quotes = new PushQuote[](ticks.length);
        for (uint256 i; i < ticks.length; i++) {
            quotes[i] = this.quotePush(key, ticks[i], up);
        }
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, int24 ticks, bool up) = abi.decode(data, (PoolKey, int24, bool));
        PoolId id = key.toId();
        PushQuote memory q;
        (q.sqrtPriceStart, q.tickStart,,) = poolManager.getSlot0(id);
        q.zeroForOne = !up;
        q.sqrtPriceTarget = TickMath.getSqrtPriceAtTick(_targetTick(q.tickStart, ticks, up));

        // push leg: exact input, stop at the target price
        BalanceDelta pushDelta = poolManager.swap(
            key, SwapParams({zeroForOne: q.zeroForOne, amountSpecified: HUGE_EXACT_INPUT, sqrtPriceLimitX96: q.sqrtPriceTarget}), ""
        );
        (q.sqrtPriceReached, q.tickReached,,) = poolManager.getSlot0(id);
        (int128 paid, int128 received) =
            q.zeroForOne ? (pushDelta.amount0(), pushDelta.amount1()) : (pushDelta.amount1(), pushDelta.amount0());
        q.amountIn = paid < 0 ? uint256(uint128(-paid)) : 0;
        q.amountOut = received > 0 ? uint256(uint128(received)) : 0;

        // return leg: sell exactly what came out, no price limit
        if (q.amountOut > 0) {
            BalanceDelta backDelta = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: !q.zeroForOne,
                    amountSpecified: -int256(q.amountOut),
                    sqrtPriceLimitX96: q.zeroForOne ? TickMath.MAX_SQRT_PRICE - 1 : TickMath.MIN_SQRT_PRICE + 1
                }),
                ""
            );
            int128 back = q.zeroForOne ? backDelta.amount0() : backDelta.amount1();
            q.amountBackOut = back > 0 ? uint256(uint128(back)) : 0;
        }
        q.cost = q.amountIn > q.amountBackOut ? q.amountIn - q.amountBackOut : 0;
        (q.costInCurrency0, q.costInCurrency1) = _valueAt(q.cost, q.zeroForOne, q.sqrtPriceStart);

        bytes memory result = abi.encodeWithSelector(QuoteResult.selector, q);
        assembly ("memory-safe") {
            revert(add(result, 0x20), mload(result))
        }
    }

    function _parse(bytes memory reason) private pure returns (PushQuote memory q) {
        if (reason.length >= 4 && bytes4(reason) == QuoteResult.selector) {
            assembly ("memory-safe") {
                // drop the 4-byte selector in place
                let len := sub(mload(reason), 4)
                reason := add(reason, 4)
                mstore(reason, len)
            }
            return abi.decode(reason, (PushQuote));
        }
        // anything else (a hook revert, a bad pool) is the caller's problem: bubble it up unchanged
        assembly ("memory-safe") {
            revert(add(reason, 0x20), mload(reason))
        }
    }

    // ───────────────────────── view tick walk ─────────────────────────

    /// @notice Input needed (fees included) to move the price by `ticks`, walking at most `maxSteps` bitmap segments.
    /// @return amountIn   input token, gross of the swap fee
    /// @return amountOut  output token that would come out
    /// @return feePaid    the fee part of `amountIn` (LP + protocol, as `Pool.swap` charges it)
    /// @return complete   false when the walk hit `maxSteps` before the target: "deeper than we bothered to count"
    function depthToMove(PoolKey calldata key, int24 ticks, bool up, uint256 maxSteps)
        external
        view
        returns (uint256 amountIn, uint256 amountOut, uint256 feePaid, bool complete)
    {
        if (ticks <= 0) revert ZeroTicks();
        PoolId id = key.toId();
        (uint160 sqrtP, int24 tick, uint24 protocolFee, uint24 lpFee) = poolManager.getSlot0(id);
        bool zeroForOne = !up;
        uint24 swapFee = _swapFee(protocolFee, lpFee, zeroForOne);
        uint160 target = TickMath.getSqrtPriceAtTick(_targetTick(tick, ticks, up));
        uint128 liquidity = poolManager.getLiquidity(id);
        uint256 netIn;

        for (uint256 step; step < maxSteps && sqrtP != target; step++) {
            (int24 next, bool initialized) = _nextInitializedTick(id, tick, key.tickSpacing, zeroForOne);
            if (next < TickMath.MIN_TICK) next = TickMath.MIN_TICK;
            if (next > TickMath.MAX_TICK) next = TickMath.MAX_TICK;
            uint160 sqrtNext = TickMath.getSqrtPriceAtTick(next);
            uint160 sqrtStep = zeroForOne ? (sqrtNext < target ? target : sqrtNext) : (sqrtNext > target ? target : sqrtNext);
            if (liquidity > 0) {
                if (zeroForOne) {
                    netIn += SqrtPriceMath.getAmount0Delta(sqrtStep, sqrtP, liquidity, true);
                    amountOut += SqrtPriceMath.getAmount1Delta(sqrtStep, sqrtP, liquidity, false);
                } else {
                    netIn += SqrtPriceMath.getAmount1Delta(sqrtP, sqrtStep, liquidity, true);
                    amountOut += SqrtPriceMath.getAmount0Delta(sqrtP, sqrtStep, liquidity, false);
                }
            }
            sqrtP = sqrtStep;
            if (sqrtStep == sqrtNext) {
                if (initialized) {
                    (, int128 liquidityNet) = poolManager.getTickLiquidity(id, next);
                    liquidity = LiquidityMath.addDelta(liquidity, zeroForOne ? -liquidityNet : liquidityNet);
                }
                tick = zeroForOne ? next - 1 : next;
            } else {
                tick = TickMath.getTickAtSqrtPrice(sqrtP);
            }
        }
        complete = sqrtP == target;
        amountIn = netIn == 0 ? 0 : FullMath.mulDivRoundingUp(netIn, 1e6, 1e6 - swapFee);
        feePaid = amountIn - netIn;
    }

    /// @notice Cost of pushing by `ticks` and selling back, in the input token, from the view walk.
    /// @dev = fee on the push leg + the sell-back's fee valued at the start price. The sell-back's fee is
    ///      the slice of the curve nearest the start price that the returned amount can no longer retrace.
    function roundTripCost(PoolKey calldata key, int24 ticks, bool up, uint256 maxSteps)
        external
        view
        returns (uint256 cost, bool complete)
    {
        uint256 amountOut;
        uint256 feePaid;
        (, amountOut, feePaid, complete) = this.depthToMove(key, ticks, up, maxSteps);
        (uint160 sqrtStart,, uint24 protocolFee, uint24 lpFee) = poolManager.getSlot0(key.toId());
        bool zeroForOne = !up;
        uint24 backFee = _swapFee(protocolFee, lpFee, !zeroForOne);
        uint256 backFeeInOutputToken = FullMath.mulDivRoundingUp(amountOut, backFee, 1e6);
        // value the output-token fee in the input token at the start price
        uint256 backFeeInInputToken = zeroForOne
            ? _mulSqrtPriceSquared(backFeeInOutputToken, sqrtStart, false) // input is currency0: currency1 → currency0
            : _mulSqrtPriceSquared(backFeeInOutputToken, sqrtStart, true); // input is currency1: currency0 → currency1
        cost = feePaid + backFeeInInputToken;
    }

    // ───────────────────────── helpers ─────────────────────────

    function _targetTick(int24 tick, int24 ticks, bool up) private pure returns (int24 target) {
        target = up ? tick + ticks : tick - ticks;
        // a swap's price limit must be strictly inside (MIN_SQRT_PRICE, MAX_SQRT_PRICE)
        if (target <= TickMath.MIN_TICK) target = TickMath.MIN_TICK + 1;
        if (target >= TickMath.MAX_TICK) target = TickMath.MAX_TICK - 1;
    }

    /// @dev Same combination `Pool.swap` uses: the protocol fee for this direction folded into the LP fee.
    function _swapFee(uint24 protocolFee, uint24 lpFee, bool zeroForOne) private pure returns (uint24) {
        uint16 directional = zeroForOne ? protocolFee.getZeroForOneFee() : protocolFee.getOneForZeroFee();
        return directional == 0 ? lpFee : directional.calculateSwapFee(lpFee);
    }

    /// @dev `cost` is in the input token; value it in both currencies at `sqrtStart`.
    function _valueAt(uint256 cost, bool zeroForOne, uint160 sqrtStart) private pure returns (uint256 in0, uint256 in1) {
        if (zeroForOne) {
            in0 = cost;
            in1 = _mulSqrtPriceSquared(cost, sqrtStart, true);
        } else {
            in1 = cost;
            in0 = _mulSqrtPriceSquared(cost, sqrtStart, false);
        }
    }

    /// @dev amount × price or amount ÷ price, where price = sqrtP² / 2^192 (currency1 per currency0).
    function _mulSqrtPriceSquared(uint256 amount, uint160 sqrtP, bool multiply) private pure returns (uint256) {
        if (multiply) {
            return FullMath.mulDiv(FullMath.mulDiv(amount, sqrtP, FixedPoint96.Q96), sqrtP, FixedPoint96.Q96);
        }
        return FullMath.mulDiv(FullMath.mulDiv(amount, FixedPoint96.Q96, sqrtP), FixedPoint96.Q96, sqrtP);
    }

    /// @dev `TickBitmap.nextInitializedTickWithinOneWord`, reading the word through extsload.
    function _nextInitializedTick(PoolId id, int24 tick, int24 tickSpacing, bool lte)
        private
        view
        returns (int24 next, bool initialized)
    {
        unchecked {
            int24 compressed = tick / tickSpacing;
            if (tick < 0 && tick % tickSpacing != 0) compressed--;
            if (lte) {
                int16 wordPos = int16(compressed >> 8);
                uint8 bitPos = uint8(uint24(compressed));
                uint256 mask = type(uint256).max >> (uint256(type(uint8).max) - bitPos);
                uint256 masked = poolManager.getTickBitmap(id, wordPos) & mask;
                initialized = masked != 0;
                next = initialized
                    ? (compressed - int24(uint24(bitPos - BitMath.mostSignificantBit(masked)))) * tickSpacing
                    : (compressed - int24(uint24(bitPos))) * tickSpacing;
            } else {
                compressed++;
                int16 wordPos = int16(compressed >> 8);
                uint8 bitPos = uint8(uint24(compressed));
                // forge-lint: disable-next-line(incorrect-shift)
                uint256 mask = ~((1 << bitPos) - 1);
                uint256 masked = poolManager.getTickBitmap(id, wordPos) & mask;
                initialized = masked != 0;
                next = initialized
                    ? (compressed + int24(uint24(BitMath.leastSignificantBit(masked) - bitPos))) * tickSpacing
                    : (compressed + int24(uint24(type(uint8).max - bitPos))) * tickSpacing;
            }
        }
    }
}
