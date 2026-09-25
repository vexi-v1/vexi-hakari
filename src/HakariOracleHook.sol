// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {BaseOracleHook} from "@openzeppelin/uniswap-hooks/oracles/panoptic/BaseOracleHook.sol";

/// @title HakariOracleHook
/// @notice OpenZeppelin's truncated oracle hook with one addition: `twaps` returns the raw and the
///         truncated time-weighted average tick side by side, so a consumer can see when they disagree.
/// @dev Permissions are inherited from BaseOracleHook: afterInitialize + beforeSwap (address bits 0x1080).
///      The observation is written *before* the swap, once per block timestamp, so a push undone within
///      the same second is never recorded (layer 1). Each observation moves the truncated series by at
///      most `MAX_ABS_TICK_DELTA` (layer 2). One contract has one Δ; deploy another for another Δ.
contract HakariOracleHook is BaseOracleHook {
    error WindowZero();

    constructor(IPoolManager manager, int24 maxAbsTickDelta) BaseHook(manager) BaseOracleHook(maxAbsTickDelta) {}

    /// @notice Geometric TWAP ticks over [now - window, now], raw and truncated.
    /// @dev Reverts (from Oracle) if the window predates the oldest stored observation; grow the
    ///      cardinality with `increaseObservationCardinalityNext` for long windows on busy pools.
    function twaps(PoolId id, uint32 window) external view returns (int24 rawTick, int24 truncTick) {
        if (window == 0) revert WindowZero();
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;
        (int56[] memory raw, int56[] memory trunc) = this.observe(secondsAgos, id);
        rawTick = _avg(raw[1] - raw[0], window);
        truncTick = _avg(trunc[1] - trunc[0], window);
    }

    /// @dev Uniswap's convention: round toward negative infinity when the delta is negative.
    function _avg(int56 delta, uint32 window) private pure returns (int24 tick) {
        tick = int24(delta / int56(uint56(window)));
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) tick--;
    }
}
