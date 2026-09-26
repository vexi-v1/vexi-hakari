// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/v1.0.2/LICENSES/SwapVM-1.1.txt (copy: LICENSES/SwapVM-1.1.txt)
/// @notice A custom SwapVM instruction written for the Vexi × HAKARI entry at ETHGlobal Tokyo 2026.
///         Powered by SwapVM — © Degensoft Ltd 2025.
/// @dev A new instruction for SwapVM's opcode table, written 2026-09-25 JST; code last changed 2026-09-26 JST.
///      As deployed on Robinhood Chain testnet 46630 inside the router at 0xfadDb8796f92C6aA00aF84a6B431E90859C7aeF3
///      (tx 0x9d872ac1a961c028d245596cc43385821ff8c3164425d1ccc1fc55d47ad0130a, 2026-09-26 20:53 JST). For publication
///      on 2026-09-27 JST only these header comments changed; the code is the deployed code.

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Calldata } from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import { Context } from "@1inch/swap-vm/src/libs/VM.sol";

/// @notice What the skew reads from the maker's AquaWriter.
interface IOptionDelta {
    /// @return The delta the open option book added to the wallet, in whole base tokens (WAD).
    ///         Negative = the options left the writer shorter of the base than before it wrote them.
    function optionDelta() external view returns (int256);
}

library DeltaSkewArgsBuilder {
    using Calldata for bytes;

    error DeltaSkewMissingWriterArg();
    error DeltaSkewMissingBaseArg();
    error DeltaSkewMissingMaxSkewArg();
    error DeltaSkewMissingFullSkewAtArg();

    /// @param writer The AquaWriter whose net delta drives the skew.
    /// @param base The base token of the options (the token the delta is measured in).
    /// @param maxSkewBps The largest price skew, in basis points of the curve's price.
    /// @param fullSkewAt The |delta|, in whole base tokens, at which the skew reaches `maxSkewBps`.
    function build(address writer, address base, uint16 maxSkewBps, uint32 fullSkewAt)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(writer, base, maxSkewBps, fullSkewAt);
    }

    function parse(bytes calldata args)
        internal
        pure
        returns (address writer, address base, uint16 maxSkewBps, uint32 fullSkewAt)
    {
        writer = address(bytes20(args.slice(0, 20, DeltaSkewMissingWriterArg.selector)));
        base = address(bytes20(args.slice(20, 40, DeltaSkewMissingBaseArg.selector)));
        maxSkewBps = uint16(bytes2(args.slice(40, 42, DeltaSkewMissingMaxSkewArg.selector)));
        fullSkewAt = uint32(bytes4(args.slice(42, 46, DeltaSkewMissingFullSkewAtArg.selector)));
    }
}

/// @title DeltaSkew
/// @notice Lean by quote, not by order: tilt the spot price against the delta the option book added. Short calls
///         (-0.5 each) make the strategy pay more when a taker sells it the base and give less when a taker buys
///         the base; short puts (+0.5 each) do the opposite. Place it after the curve instruction.
/// @dev The delta is the option legs alone (`IOptionDelta.optionDelta`); a wheel writer keeps its stock and cash
///      exposure on purpose and only leans against what the options changed. Why a writer that already holds the
///      base leans towards buying more of it after selling calls: the calls it sold are covered by escrow, the calls
///      it still has open for sale are covered by the wallet, and a spot fill that drains the wallet is exactly
///      what the guard forbids. Leaning the bid up refills the wallet from takers who want to sell, so the next
///      round of the wheel is covered too. skewBps = min(maxSkewBps,
///      maxSkewBps * |delta| / fullSkewAt). A favourable skew never lifts `amountOut` above `balanceOut`.
///      Pure function of on-chain state, so quote and swap agree. Anyone can move the delta by buying an option,
///      so the maker bounds the effect with `maxSkewBps` and the depth it ships. A favourable skew is capped at
///      `balanceOut`, which after ExposureGuard is the unpromised balance: one large fill can take all of it, never
///      more.
contract DeltaSkew {
    using Math for uint256;

    uint256 internal constant BPS = 10_000;

    error DeltaSkewShouldBeAppliedAfterSwap();
    error DeltaSkewMaxSkewTooHigh(uint16 maxSkewBps);
    error DeltaSkewFullSkewAtZero();

    /// @param args.writer     | 20 bytes
    /// @param args.base       | 20 bytes
    /// @param args.maxSkewBps | 2 bytes
    /// @param args.fullSkewAt | 4 bytes (whole base tokens)
    function _deltaSkewXD(Context memory ctx, bytes calldata args) internal view {
        require(ctx.swap.amountIn > 0 && ctx.swap.amountOut > 0, DeltaSkewShouldBeAppliedAfterSwap());
        (address writer, address base, uint16 maxSkewBps, uint32 fullSkewAt) = DeltaSkewArgsBuilder.parse(args);
        require(maxSkewBps < BPS, DeltaSkewMaxSkewTooHigh(maxSkewBps));
        require(fullSkewAt > 0, DeltaSkewFullSkewAtZero());

        bool takerSellsBase = ctx.query.tokenIn == base;
        if (!takerSellsBase && ctx.query.tokenOut != base) return; // not a base pair: no opinion

        int256 delta = IOptionDelta(writer).optionDelta();
        if (delta == 0) return;
        uint256 absDelta = uint256(delta < 0 ? -delta : delta);
        uint256 skewBps = Math.min(maxSkewBps, uint256(maxSkewBps) * absDelta / (uint256(fullSkewAt) * 1e18));
        if (skewBps == 0) return;

        // delta < 0: the options left the wallet shorter of the base; a taker selling base gets the better price.
        // delta > 0: the options left it longer; a taker buying base gets the better price.
        bool favourTaker = (delta < 0) == takerSellsBase;
        if (favourTaker) {
            if (ctx.query.isExactIn) {
                ctx.swap.amountOut = Math.min(ctx.swap.amountOut * (BPS + skewBps) / BPS, ctx.swap.balanceOut);
            } else {
                ctx.swap.amountIn = (ctx.swap.amountIn * BPS).ceilDiv(BPS + skewBps);
            }
        } else {
            if (ctx.query.isExactIn) {
                ctx.swap.amountOut = ctx.swap.amountOut * (BPS - skewBps) / BPS;
            } else {
                ctx.swap.amountIn = (ctx.swap.amountIn * BPS).ceilDiv(BPS - skewBps);
            }
        }
    }
}
