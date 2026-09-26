// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IExpiryPrice
/// @notice Where a book reads the settlement price of a series.
interface IExpiryPrice {
    /// @notice Whether this source can ever price `base` in `quote`. A book refuses to create a series on a pair the
    ///         source does not cover, so no option is sold before its settlement source exists.
    function covers(address base, address quote) external view returns (bool);

    /// @notice How long after `at` the price for `at` may still become available, in seconds. A book must keep a
    ///         series settleable for at least this long after expiry.
    function maxDelay(address base, address quote) external view returns (uint64);

    /// @notice WAD quote per base (1e18 = one whole quote token per one whole base token) at `at`.
    /// @dev Reverts if no price covers `at` yet, or none ever will.
    function priceAt(address base, address quote, uint64 at) external view returns (uint256);
}
