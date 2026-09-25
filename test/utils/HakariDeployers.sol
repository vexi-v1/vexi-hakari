// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HakariOracleHook} from "../../src/HakariOracleHook.sol";

/// @dev Shared setup: a fresh PoolManager, two mock tokens, and a hook etched at an address
///      whose low bits carry the afterInitialize + beforeSwap flags (0x1080).
abstract contract HakariDeployers is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 constant HOOK_FLAGS = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);

    function deployHook(int24 maxAbsTickDelta, uint160 seed) internal returns (HakariOracleHook hook) {
        address where = address(HOOK_FLAGS ^ (seed << 20));
        deployCodeTo("HakariOracleHook.sol:HakariOracleHook", abi.encode(manager, maxAbsTickDelta), where);
        hook = HakariOracleHook(where);
    }

    /// @dev Exact-input swap that stops at a price limit; returns the caller's delta.
    function swapToPrice(PoolKey memory _key, bool zeroForOne, uint160 sqrtPriceLimitX96)
        internal
        returns (BalanceDelta)
    {
        return swapRouter.swap(
            _key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(uint256(type(uint112).max)),
                sqrtPriceLimitX96: sqrtPriceLimitX96
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @dev A dust swap that only serves to write an oracle observation at the current timestamp.
    function poke(PoolKey memory _key) internal {
        swap(_key, true, -1, ZERO_BYTES);
    }

    function addLiquidity(PoolKey memory _key, int24 lower, int24 upper, int256 liquidity) internal {
        modifyLiquidityRouter.modifyLiquidity(
            _key, ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: liquidity, salt: 0}), ZERO_BYTES
        );
    }

    function currentTick(PoolId id) internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(id);
    }
}
