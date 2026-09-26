// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPremium
/// @notice What a buyer pays for option contracts, in quote units, computed at the moment of the trade.
/// @dev The book calls `ask` at every buy, so a pricer can be swapped or wrapped (the stability band wraps one)
///      without touching an order.
interface IPremium {
    /// @notice What a buyer pays for `n` more contracts of a series right now. Reverts when the pricer does not
    ///         quote.
    function ask(uint256 seriesId, uint256 n) external view returns (uint256 quoteUnits);
}
