// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IExpiryPrice } from "./IExpiryPrice.sol";

/// @title FixedExpiryPrice
/// @notice Test double: the owner sets the price per pair, so in- and out-of-the-money paths are deterministic.
contract FixedExpiryPrice is IExpiryPrice, Ownable {
    error NoPrice(address base, address quote);

    event PriceSet(address indexed base, address indexed quote, uint256 priceWad);

    mapping(address base => mapping(address quote => uint256)) public prices;

    constructor(address owner_) Ownable(owner_) { }

    function setPrice(address base, address quote, uint256 priceWad) external onlyOwner {
        prices[base][quote] = priceWad;
        emit PriceSet(base, quote, priceWad);
    }

    /// @inheritdoc IExpiryPrice
    function covers(address base, address quote) external view returns (bool) {
        return prices[base][quote] != 0;
    }

    /// @inheritdoc IExpiryPrice
    function maxDelay(address, address) external pure returns (uint64) {
        return 0;
    }

    /// @inheritdoc IExpiryPrice
    function priceAt(address base, address quote, uint64) external view returns (uint256 price) {
        price = prices[base][quote];
        require(price != 0, NoPrice(base, quote));
    }
}
