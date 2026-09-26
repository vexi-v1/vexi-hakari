// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Addresses on Robinhood Chain mainnet (4663), read on 2026-09-25.
abstract contract RobinhoodChain {
    address internal constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address internal constant ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De; // SwapVM v1.0.2 (AquaOpcodes)
    address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d; // 18 decimals
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // 6 decimals
    /// @dev An EOA holding about 650 TSLA at the pinned block. Recorded for reference; tests and the demo fund
    ///      their own plain addresses instead of impersonating anyone.
    address internal constant TSLA_HOLDER = 0x9f736F87E6293AC1Bd9142E257dbfAC8b7AcF1ae;
}
