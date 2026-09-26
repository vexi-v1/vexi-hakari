// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/v1.0.2/LICENSES/SwapVM-1.1.txt (copy: LICENSES/SwapVM-1.1.txt)
/// @notice Written for the Vexi × HAKARI entry at ETHGlobal Tokyo 2026. Powered by SwapVM — © Degensoft Ltd 2025.
/// @dev An `IExtruction` target for the canonical SwapVM router, written 2026-09-25 JST; last changed 2026-09-25 JST.

import { IExtruction, IStaticExtruction } from "@1inch/swap-vm/src/instructions/Extruction.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

import { ExposureGuard } from "./ExposureGuard.sol";

/// @title ExposureGuardExtruction
/// @notice The same policy as the `ExposureGuard` instruction, packaged as an `Extruction` target so it runs on the
///         **canonical** SwapVM router already deployed on Robinhood Chain 4663, without redeploying a router.
/// @dev Program: `extruction(target = this, args = writer) ; xycSwap ; salt`. The router hands over the registers,
///      this contract applies `ExposureGuard.capToFree` and hands them back. It is a view in both the quote and
///      the swap path, so quote/swap consistency holds by construction, and it has no owner and no state.
contract ExposureGuardExtruction is IExtruction, IStaticExtruction, ExposureGuard {
    error ExposureGuardExtructionMissingWriterArg();

    /// @param nextPC Where the router continues; returned unchanged.
    /// @param query The swap being quoted or executed (maker, tokenOut).
    /// @param swap The registers before the curve runs.
    /// @param args `abi.encodePacked(writer)`.
    function extruction(
        bool, /* isStaticContext */
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata args,
        bytes calldata /* takerData */
    )
        external
        view
        override(IExtruction, IStaticExtruction)
        returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap)
    {
        require(args.length >= 20, ExposureGuardExtructionMissingWriterArg());
        address writer = address(bytes20(args[0:20]));
        updatedSwap = swap;
        uint256 free = unpromised(query.maker, query.tokenOut, writer);
        (updatedSwap.balanceIn, updatedSwap.balanceOut) = capToFree(swap.balanceIn, swap.balanceOut, free);
        return (nextPC, 0, updatedSwap);
    }
}
