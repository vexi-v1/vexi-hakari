// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @title IVexiVenue
/// @notice The three read-only calls ExposureGuard makes on Vexi's venue, re-declared here in our own words from the
///         deployed contract's signatures (`cast call` against 0xF91B7277… on testnet 46630). None of Vexi's code is
///         in this repo; the ABI encoding of these calls is all that is shared.
/// @dev Vexi is a fully collateralised ERC-6909 options venue. A series is one (base, quote, kind, strike, expiry)
///      with two token ids: the option token (an even id) and the deposit token (the option id + 1). `series` and
///      `totalSupply` are keyed by the option id. The field names below are ours; the types and their order are the
///      contract's.
interface IVexiVenue {
    /// @dev One series as the venue stores it: 13 static fields, decoded straight from the return words.
    struct SeriesView {
        address base; // the asset the option is on
        address quote; // the asset it settles in (USDG on 46630)
        uint8 kind; // call or put; the guard sums both
        uint256 strikeWad; // quote per base, 18 decimals
        uint64 expiry; // settlement time; the fix reads the pool's TWAP ending here
        uint64 fixBy; // expiry + the venue's window: a fix taken after this counts as late
        uint64 openedAt;
        address opener;
        uint256 baseHeld; // collateral escrowed in base
        uint256 quoteHeld; // collateral escrowed in quote
        uint256 baseUnit; // 10 ** base decimals
        uint256 quoteUnit; // 10 ** quote decimals
        uint256 fixedPriceWad; // the settlement price once fixed, else 0
    }

    function series(uint256 id) external view returns (SeriesView memory);

    /// @notice ERC-6909 supply of one token id. For an option id: the open interest of that series, in base units.
    function totalSupply(uint256 id) external view returns (uint256);

    /// @notice The venue's clock: the expiry step, its quote window, the longest tenor, and the TWAP window a fix reads.
    function terms() external view returns (uint64 step, uint64 window, uint64 maxTenor, uint64 fixWindow);
}

/// @title IVexiSpotLeaf
/// @notice The venue's spot registry (0xCEde7e1E… on 46630): which v4 pool prices a (base, quote) pair.
interface IVexiSpotLeaf {
    /// @return key the pool the venue fixes from
    /// @return set false when the pair has no pool (the key is then all zeros)
    function poolOf(address base, address quote) external view returns (PoolKey memory key, bool set);
}
