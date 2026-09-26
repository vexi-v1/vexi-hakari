// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IVexiVenue, IVexiSpotLeaf} from "../../src/interfaces/IVexi.sol";

/// @dev Test-only. A venue with settable series and supplies, keyed by option id, answering the three calls
///      ExposureGuard makes and nothing else.
contract MockVexiVenue is IVexiVenue {
    mapping(uint256 => SeriesView) internal _series;
    mapping(uint256 => uint256) internal _supply;
    uint64 public fixWindow = 300;

    function setSeries(uint256 id, uint8 kind, address base, address quote, uint64 expiry, uint256 baseUnit, uint256 quoteUnit)
        external
    {
        SeriesView storage s = _series[id];
        (s.kind, s.base, s.quote, s.expiry, s.baseUnit, s.quoteUnit) = (kind, base, quote, expiry, baseUnit, quoteUnit);
    }

    function setSupply(uint256 id, uint256 n) external {
        _supply[id] = n;
    }

    function setFixWindow(uint64 w) external {
        fixWindow = w;
    }

    function series(uint256 id) external view returns (SeriesView memory) {
        return _series[id];
    }

    function totalSupply(uint256 id) external view returns (uint256) {
        return _supply[id];
    }

    function terms() external view returns (uint64, uint64, uint64, uint64) {
        return (900, 900, 2592000, fixWindow);
    }
}

/// @dev Test-only. A spot registry with settable pool keys.
contract MockVexiSpotLeaf is IVexiSpotLeaf {
    mapping(address => mapping(address => PoolKey)) internal _pools;
    mapping(address => mapping(address => bool)) internal _set;

    function setPool(address base, address quote, PoolKey calldata key) external {
        _pools[base][quote] = key;
        _set[base][quote] = true;
    }

    function poolOf(address base, address quote) external view returns (PoolKey memory, bool) {
        return (_pools[base][quote], _set[base][quote]);
    }
}
