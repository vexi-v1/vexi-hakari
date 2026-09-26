// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @title VexiSeries
/// @notice Which of the venue's series settle next, read from its `SeriesOpened` logs through the forked or scripted
///         RPC: ERC-6909 has no per-id enumeration and the ids are hashes, so a list has to come from the log. Shared
///         by the 46630 fork test and the demo script. The event is re-declared in our own words from the live topic
///         (gauge/test/vexi-abi.test.ts checks the hash against the chain); only the id, the pair and the expiry are
///         decoded from each log.
/// @dev The venue opens a batch of series for each 15-minute expiry roughly 60 to 105 minutes ahead, and every batch
///      expires with it, so a list of ids saved to a file is stale within a quarter of an hour: scan at run time.
library VexiSeries {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 internal constant SERIES_OPENED_TOPIC =
        keccak256("SeriesOpened(uint256,address,address,uint8,uint256,uint64,address)");
    /// @dev Blocks to look back: about 2.5 h at the testnet's ~6 blocks/s, a few thousand logs at most (the public
    ///      RPC caps one query at 10,000 logs and has no block-range cap).
    uint256 internal constant SCAN_BLOCKS = 60_000;

    struct Opened {
        uint256 id; // the option token's id; its deposit token is id + 1
        address base;
        address quote;
        uint64 expiry;
    }

    /// @notice Every series the venue opened in the `SCAN_BLOCKS` blocks up to `toBlock`.
    function opened(address venue, uint256 toBlock) internal view returns (Opened[] memory out) {
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = SERIES_OPENED_TOPIC;
        uint256 fromBlock = toBlock > SCAN_BLOCKS ? toBlock - SCAN_BLOCKS : 0;
        Vm.EthGetLogs[] memory logs = vm.eth_getLogs(fromBlock, toBlock, venue, topics);
        out = new Opened[](logs.length);
        for (uint256 i; i < logs.length; i++) {
            // data = (kind, strike, expiry, opener); only the expiry is kept
            (,, uint64 expiry,) = abi.decode(logs[i].data, (uint8, uint256, uint64, address));
            out[i] = Opened({
                id: uint256(logs[i].topics[1]),
                base: address(uint160(uint256(logs[i].topics[2]))),
                quote: address(uint160(uint256(logs[i].topics[3]))),
                expiry: expiry
            });
        }
    }

    /// @notice The ids of the `base`/`quote` series on the earliest expiry at or after `notBefore`; empty when none.
    function nextExpiry(Opened[] memory all, address base, address quote, uint256 notBefore)
        internal
        pure
        returns (uint256[] memory ids, uint64 expiry)
    {
        uint256 n;
        for (uint256 i; i < all.length; i++) {
            Opened memory o = all[i];
            if (o.base != base || o.quote != quote || o.expiry < notBefore) continue;
            if (expiry == 0 || o.expiry < expiry) {
                expiry = o.expiry;
                n = 1;
            } else if (o.expiry == expiry) {
                n++;
            }
        }
        ids = new uint256[](n);
        uint256 k;
        for (uint256 i; i < all.length && k < n; i++) {
            Opened memory o = all[i];
            if (o.base == base && o.quote == quote && o.expiry == expiry) ids[k++] = o.id;
        }
    }
}
