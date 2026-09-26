// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/v1.0.2/LICENSES/SwapVM-1.1.txt (copy: LICENSES/SwapVM-1.1.txt)
/// @notice A custom SwapVM instruction written for the Vexi × HAKARI entry at ETHGlobal Tokyo 2026.
///         Powered by SwapVM — © Degensoft Ltd 2025.
/// @dev A new instruction for SwapVM's opcode table, written 2026-09-25 JST; code last changed 2026-09-26 JST. Its
///      code is the same as `aqua/src/swapvm/ExposureGuard.sol`.
///      As deployed on Robinhood Chain testnet 46630 inside the router at 0xfadDb8796f92C6aA00aF84a6B431E90859C7aeF3
///      (tx 0x9d872ac1a961c028d245596cc43385821ff8c3164425d1ccc1fc55d47ad0130a, 2026-09-26 20:53 JST). For publication
///      on 2026-09-27 JST only these header comments changed; the code is the deployed code.

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Calldata } from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import { Context } from "@1inch/swap-vm/src/libs/VM.sol";

/// @notice What the guard reads from the maker's AquaWriter.
interface IPromised {
    /// @return The collateral that open, unfilled option orders still promise for `token`.
    function promised(address token) external view returns (uint256);
}

library ExposureGuardArgsBuilder {
    /// @param writer The AquaWriter whose open option orders promise the maker's tokens.
    function build(address writer) internal pure returns (bytes memory) {
        return abi.encodePacked(writer);
    }
}

/// @title ExposureGuard
/// @notice Options first: the spot strategy may only sell the part of the maker's wallet that open option orders
///         have not promised. Place it before the curve instruction.
/// @dev When the curve's `balanceOut` exceeds `free = wallet(tokenOut) - promised(tokenOut)`, both reserves are
///      scaled down in the same ratio: `balanceOut = free`, `balanceIn = ceil(balanceIn * free / balanceOut)`.
///      The marginal price of the curve is unchanged; only its depth shrinks, so no fill can ever take more than
///      `free`. At `free == 0` both reserves are zero and the curve that follows refuses to quote
///      (`XYCSwapRequiresBothBalancesNonZero`). Works in both directions (XD): it only looks at the token that
///      would leave the maker.
contract ExposureGuard {
    using Calldata for bytes;

    error ExposureGuardMissingWriterArg();

    /// @param args.writer | 20 bytes
    function _exposureGuardXD(Context memory ctx, bytes calldata args) internal view {
        address writer = address(bytes20(args.slice(0, 20, ExposureGuardMissingWriterArg.selector)));
        uint256 free = unpromised(ctx.query.maker, ctx.query.tokenOut, writer);
        (ctx.swap.balanceIn, ctx.swap.balanceOut) = capToFree(ctx.swap.balanceIn, ctx.swap.balanceOut, free);
    }

    /// @notice The maker's wallet balance of `token` that no open option order has promised.
    function unpromised(address maker, address token, address writer) public view returns (uint256) {
        uint256 wallet = IERC20(token).balanceOf(maker);
        uint256 promised = IPromised(writer).promised(token);
        return wallet > promised ? wallet - promised : 0;
    }

    /// @notice Shrinks a constant-product pool to `free` on the out side without moving its price.
    /// @dev Shared by the instruction and by `ExposureGuardExtruction`, so both forms compute the same registers.
    function capToFree(uint256 balanceIn, uint256 balanceOut, uint256 free)
        public
        pure
        returns (uint256 cappedIn, uint256 cappedOut)
    {
        if (balanceOut <= free) return (balanceIn, balanceOut);
        if (free == 0) return (0, 0);
        return (Math.mulDiv(balanceIn, free, balanceOut, Math.Rounding.Ceil), free);
    }
}
