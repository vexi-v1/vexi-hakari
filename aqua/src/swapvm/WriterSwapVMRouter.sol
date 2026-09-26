// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/v1.0.2/LICENSES/SwapVM-1.1.txt (copy: LICENSES/SwapVM-1.1.txt)
/// @custom:copyright © 2025 Degensoft Ltd (AquaSwapVMRouter, which WriterSwapVMRouter adapts)
/// @notice A SwapVM router subclass written for the Vexi × HAKARI entry at ETHGlobal Tokyo 2026.
///         Powered by SwapVM — © Degensoft Ltd 2025.
/// @dev Adapted from `src/routers/AquaSwapVMRouter.sol` of 1inch swap-vm v1.0.2: the same bases, constructor and
///      `_instructions`. Changes, 2026-09-25 JST: `AquaOpcodes` replaced by `WriterOpcodes`, the AquaOpcodes table with
///      `ExposureGuard` appended in the first free slot; `exposureGuardOpcode()` added. Last changed 2026-09-27 JST.

import { Simulator } from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";

import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { Context } from "@1inch/swap-vm/src/libs/VM.sol";
import { AquaOpcodes } from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";

import { ExposureGuard } from "./ExposureGuard.sol";

/// @title WriterOpcodes
/// @notice The AquaOpcodes table of the router deployed on Robinhood Chain 4663, plus `ExposureGuard` appended in the
///         first free slot, so every existing opcode keeps its number.
contract WriterOpcodes is AquaOpcodes, ExposureGuard {
    constructor(address aqua) AquaOpcodes(aqua) { }

    function _opcodes()
        internal
        pure
        virtual
        override
        returns (function(Context memory, bytes calldata) internal[] memory result)
    {
        function(Context memory, bytes calldata) internal[] memory base = AquaOpcodes._opcodes();
        result = new function(Context memory, bytes calldata) internal[](base.length + 1);
        for (uint256 i = 0; i < base.length; i++) {
            result[i] = base[i];
        }
        result[base.length] = ExposureGuard._exposureGuardXD;
    }

    /// @notice The opcode `ExposureGuard` occupies in this router.
    function exposureGuardOpcode() public pure returns (uint8) {
        return uint8(AquaOpcodes._opcodes().length);
    }
}

/// @title WriterSwapVMRouter
/// @notice SwapVM router with Aqua settlement and the `ExposureGuard` instruction. Deployed on the 4663 fork for the
///         tests; canonical Aqua is used unmodified. On the canonical router the same guard runs through
///         `ExposureGuardExtruction` instead.
contract WriterSwapVMRouter is Simulator, SwapVM, WriterOpcodes {
    constructor(address aqua, address weth, address owner, string memory name, string memory version)
        SwapVM(aqua, weth, owner, name, version)
        WriterOpcodes(aqua)
    { }

    function _instructions()
        internal
        pure
        override
        returns (function(Context memory, bytes calldata) internal[] memory)
    {
        return _opcodes();
    }
}
