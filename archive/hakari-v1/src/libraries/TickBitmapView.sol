// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {BitMath} from "@uniswap/v4-core/src/libraries/BitMath.sol";

/// @notice `TickBitmap.nextInitializedTickWithinOneWord` for a pool you do not own: the word is read
///         through `StateLibrary` (extsload) instead of a storage mapping.
library TickBitmapView {
    using StateLibrary for IPoolManager;

    function nextInitializedTickWithinOneWord(IPoolManager manager, PoolId id, int24 tick, int24 tickSpacing, bool lte)
        internal
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
                uint256 masked = manager.getTickBitmap(id, wordPos) & mask;
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
                uint256 masked = manager.getTickBitmap(id, wordPos) & mask;
                initialized = masked != 0;
                next = initialized
                    ? (compressed + int24(uint24(BitMath.leastSignificantBit(masked) - bitPos))) * tickSpacing
                    : (compressed + int24(uint24(type(uint8).max - bitPos))) * tickSpacing;
            }
        }
    }
}
