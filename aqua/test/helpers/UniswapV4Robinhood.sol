// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Uniswap v4 on Robinhood Chain. The addresses are the ones Uniswap's v4 deployments page lists for mainnet
///         4663 (read 2026-09-27); the same contracts carry code at the same addresses on testnet 46630, which the
///         docs do not list (checked with `cast codesize` and `poolManager()` on 2026-09-27).
abstract contract UniswapV4Robinhood {
    address internal constant V4_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant V4_POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant V4_STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// @dev keccak256(abi.encode(TSLA, USDG, 3000, 60, address(0))) on 4663: the real TSLA/USDG pool, initialised at
    ///      block 2,670,479, before the fork pin.
    bytes32 internal constant TSLA_USDG_POOL_ID = 0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e;
    uint24 internal constant TSLA_USDG_FEE = 3000;
    int24 internal constant TSLA_USDG_TICK_SPACING = 60;
}
