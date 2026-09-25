// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// @title NaiveSpotConsumer
/// @notice The protocol we are warning about, reduced to one function: it settles on `slot0`, the live price.
///         Anyone can push the pool, call `settle`, and push it back in the same transaction (SPEC.md § 1, case A).
///         Demo only.
contract NaiveSpotConsumer {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    event NaiveSettled(PoolId indexed id, int24 tick);

    IPoolManager public immutable poolManager;
    mapping(PoolId => int24) public settledTick;

    constructor(IPoolManager manager) {
        poolManager = manager;
    }

    function settle(PoolKey calldata key) external returns (int24 tick) {
        PoolId id = key.toId();
        (, tick,,) = poolManager.getSlot0(id);
        settledTick[id] = tick;
        emit NaiveSettled(id, tick);
    }
}
