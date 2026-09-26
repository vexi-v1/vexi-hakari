// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A configured pair's current price, WAD quote per whole base token.
/// @dev The quote owner must choose a trusted source for the series' pair. This interface does not attest to it.
interface IQuoteReference {
    function referencePriceWad() external view returns (uint256);
}
