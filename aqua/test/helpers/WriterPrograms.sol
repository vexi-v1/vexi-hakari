// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @dev Test helper that derives from the WriterOpcodes table to build programs. Powered by SwapVM — © Degensoft Ltd 2025.

import { XYCSwap } from "@1inch/swap-vm/src/instructions/XYCSwap.sol";
import { Controls, ControlsArgsBuilder } from "@1inch/swap-vm/src/instructions/Controls.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { Program, ProgramBuilder } from "@1inch/swap-vm/test/utils/ProgramBuilder.sol";

import { WriterOpcodes } from "../../src/swapvm/WriterSwapVMRouter.sol";
import { ExposureGuard, ExposureGuardArgsBuilder } from "../../src/swapvm/ExposureGuard.sol";

import { OrderBuilders } from "./OrderBuilders.sol";

/// @notice Builds programs against the WriterOpcodes table (AquaOpcodes + ExposureGuard).
contract WriterPrograms is WriterOpcodes {
    using ProgramBuilder for Program;

    constructor(address aqua) WriterOpcodes(aqua) { }

    /// @notice The stock constant-product strategy: `xycSwap`, salt.
    function xycProgram(uint64 salt) public pure returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        return bytes.concat(p.build(XYCSwap._xycSwapXD), p.build(Controls._salt, ControlsArgsBuilder.buildSalt(salt)));
    }

    /// @notice The guarded strategy: `exposureGuard(writer)`, `xycSwap`, salt.
    function guardedXycProgram(address writer, uint64 salt) public pure returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        return bytes.concat(
            p.build(ExposureGuard._exposureGuardXD, ExposureGuardArgsBuilder.build(writer)),
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, ControlsArgsBuilder.buildSalt(salt))
        );
    }

    function opcodeOfExposureGuard() public pure returns (uint8) {
        return ProgramBuilder.findOpcode(ProgramBuilder.init(_opcodes()), ExposureGuard._exposureGuardXD);
    }

    function opcodeOfXycSwap() public pure returns (uint8) {
        return ProgramBuilder.findOpcode(ProgramBuilder.init(_opcodes()), XYCSwap._xycSwapXD);
    }

    function opcodeOfSalt() public pure returns (uint8) {
        return ProgramBuilder.findOpcode(ProgramBuilder.init(_opcodes()), Controls._salt);
    }

    function aquaOrder(address maker, bytes memory program) public pure returns (ISwapVM.Order memory) {
        return OrderBuilders.aquaOrder(maker, program);
    }

    function takerData(address taker, bool isExactIn) public pure returns (bytes memory) {
        return OrderBuilders.takerData(taker, isExactIn);
    }
}
