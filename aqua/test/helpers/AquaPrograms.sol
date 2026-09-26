// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @dev Test helper that derives from SwapVM's opcode table to build programs and orders. Powered by SwapVM — © Degensoft Ltd 2025.

import { AquaOpcodes } from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";
import { XYCSwap } from "@1inch/swap-vm/src/instructions/XYCSwap.sol";
import { Controls, ControlsArgsBuilder } from "@1inch/swap-vm/src/instructions/Controls.sol";
import { Extruction } from "@1inch/swap-vm/src/instructions/Extruction.sol";
import { Fee, FeeArgsBuilder } from "@1inch/swap-vm/src/instructions/Fee.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { Program, ProgramBuilder } from "@1inch/swap-vm/test/utils/ProgramBuilder.sol";

import { OrderBuilders } from "./OrderBuilders.sol";

/// @notice Builds programs against the AquaOpcodes table, which is what the router deployed on 4663 runs.
contract AquaPrograms is AquaOpcodes {
    using ProgramBuilder for Program;

    constructor(address aqua) AquaOpcodes(aqua) { }

    /// @notice `xycSwap` followed by a salt: the stock constant-product strategy.
    function xycProgram(uint64 salt) public pure returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        return bytes.concat(p.build(XYCSwap._xycSwapXD), p.build(Controls._salt, ControlsArgsBuilder.buildSalt(salt)));
    }

    /// @notice The guarded strategy for the canonical router: `extruction(guard, writer)`, `xycSwap`, salt.
    function extructionGuardedXycProgram(address guard, address writer, uint64 salt)
        public
        pure
        returns (bytes memory)
    {
        Program memory p = ProgramBuilder.init(_opcodes());
        return bytes.concat(
            p.build(Extruction._extruction, abi.encodePacked(guard, writer)),
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, ControlsArgsBuilder.buildSalt(salt))
        );
    }

    /// @notice The canonical-router variant with a flat fee: `extruction(guard, writer)`, `flatFee`, `xycSwap`, salt.
    function extructionGuardedFeeXycProgram(address guard, address writer, uint32 feeBps, uint64 salt)
        public
        pure
        returns (bytes memory)
    {
        Program memory p = ProgramBuilder.init(_opcodes());
        return bytes.concat(
            p.build(Extruction._extruction, abi.encodePacked(guard, writer)),
            p.build(Fee._flatFeeAmountInXD, FeeArgsBuilder.buildFlatFee(feeBps * 100_000)), // SwapVM's BPS is 1e9
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, ControlsArgsBuilder.buildSalt(salt))
        );
    }

    function opcodeOfExtruction() public pure returns (uint8) {
        return ProgramBuilder.findOpcode(ProgramBuilder.init(_opcodes()), Extruction._extruction);
    }

    /// @notice The opcode of an instruction in this table, for documentation and assertions.
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
