// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IPremium } from "./IPremium.sol";

/// @title FixedPremium
/// @notice The simplest pricer: the owner sets one premium per series, in quote units per contract, and a buyer pays
///         `n` times it. It does not move with the price of the underlying, which is exactly why a writer that uses
///         it wants a band in front of it (`StabilityBandPricer`): a fixed premium goes stale as the price moves.
contract FixedPremium is IPremium, Ownable {
    error NoPremium(uint256 seriesId);

    event PremiumSet(uint256 indexed seriesId, uint256 premiumPerContract);

    mapping(uint256 seriesId => uint256 quoteUnitsPerContract) public premiumOf;

    constructor(address owner_) Ownable(owner_) { }

    /// @notice Sets the premium of a series; 0 stops quoting it.
    function setPremium(uint256 seriesId, uint256 premiumPerContract) external onlyOwner {
        premiumOf[seriesId] = premiumPerContract;
        emit PremiumSet(seriesId, premiumPerContract);
    }

    /// @inheritdoc IPremium
    function ask(uint256 seriesId, uint256 n) external view returns (uint256) {
        uint256 p = premiumOf[seriesId];
        require(p != 0, NoPremium(seriesId));
        return n * p;
    }
}
