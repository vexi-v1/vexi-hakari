// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/// @title ICollateralSource
/// @notice The seam between a book and a writer whose collateral is a promise until a fill.
/// @dev A sourced order on the book holds no tokens. The book calls `available` to size a fill, `provide` to take
///      exactly the collateral for that fill inside the buy transaction, and `onReturned` after it has sent
///      unexercised escrow, exercise proceeds or premium back to the source.
interface ICollateralSource {
    /// @notice How much `collateral` the source can hand over right now for `seriesId`.
    /// @dev Must be cheap: a book may call it under a gas stipend.
    function available(uint256 seriesId, address base, address collateral) external view returns (uint256);

    /// @notice Transfer exactly `amount` of `collateral` to `msg.sender` (the book).
    function provide(uint256 seriesId, address base, address collateral, uint256 amount) external;

    /// @notice The book has just transferred `amount` of `token` back to the source.
    function onReturned(uint256 seriesId, address base, address token, uint256 amount) external;
}
