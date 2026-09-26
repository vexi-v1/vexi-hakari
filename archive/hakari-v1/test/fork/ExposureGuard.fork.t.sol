// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ExposureGuard} from "../../src/ExposureGuard.sol";
import {PushCostLens} from "../../src/PushCostLens.sol";
import {CostModel} from "../../src/CostModel.sol";
import {IVexiVenue, IVexiSpotLeaf} from "../../src/interfaces/IVexi.sol";
import {VexiSeries} from "../../script/VexiSeries.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";

interface IDecimals {
    function decimals() external view returns (uint8);
}

/// @notice ExposureGuard against the live venue on a fork of Robinhood Chain testnet 46630: the deployed lens (not
///         redeployed), Vexi's venue and spot registry (not ours, called by ABI) and the six hookless pools on the
///         official PoolManager the venue fixes from. Read-only: a fork, no broadcast.
/// @dev The public testnet RPC serves state for the last few thousand blocks only, so this forks head − 60 and reads
///      everything at that block. The series settling at the next fix are found from the venue's SeriesOpened logs
///      at run time (a saved list is stale within 15 minutes). Run alone, never through script/record-fork-tests.sh,
///      which is for 4663 and rewrites the records under web/decisions:
///      RH_TESTNET_RPC= forge test --match-path 'test/fork/ExposureGuard*' -vv
contract ExposureGuardForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    /// @dev deployments/46630.json
    PushCostLens constant LENS = PushCostLens(0xE1AA7dD1Bd65bC9a88fbE62CE03aa4cBb7BfDCa2);
    /// @dev Vexi's public deployment on 46630, as gauge/data/vexi-markets.json lists it
    IVexiVenue constant VENUE = IVexiVenue(0xF91B7277217AC8E5Ff3E6144C1c5A66BbE1B06fA);
    IVexiSpotLeaf constant LEAF = IVexiSpotLeaf(0xCEde7e1Eb7e67338BCA489C3d3e9697ae19Faa04);
    address constant USDG = 0x09Bb68Fe50F37E02e6bbA45BFe4D204Ad479581a;
    uint32 constant FIX_WINDOW = 300;
    /// @dev The topic the live logs carry (gauge/test/vexi-abi.test.ts)
    bytes32 constant SERIES_OPENED_LIVE = 0xee88bb48af1a7c8ed2b5fff2cf908f31d4c92c793f09435ed41d82ef3ebdac04;

    struct Market {
        string symbol;
        address base;
        bytes32 pricingPoolId;
    }

    Market[] markets;
    ExposureGuard guard;

    function setUp() public {
        string memory rpc = vm.envOr("RH_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) rpc = "https://rpc.testnet.chain.robinhood.com/rpc";
        vm.createSelectFork(rpc);
        if (block.chainid != 46630) {
            // RH_TESTNET_RPC pointed somewhere else (a mainnet URL, say): use the public testnet RPC instead
            rpc = "https://rpc.testnet.chain.robinhood.com/rpc";
            vm.createSelectFork(rpc);
        }
        // fork a little behind the head: the load-balanced public RPC sometimes has no state yet for `latest`
        vm.createSelectFork(rpc, block.number - 60);
        assertEq(block.chainid, 46630, "Robinhood Chain testnet");

        // the six markets and their pricing pools, gauge/data/vexi-markets.json
        _market("AI", 0x7eC15F39D9c307EDbd07c730E87fB914E178b7B9, 0xee57cbac0517ef7e227e28633eb7982c89fcf59353074ce70d2835d996664de7);
        _market("PONS", 0x9edA6980d539bcAAf03c4C953265894cEdDC07e7, 0x6c538477cc7c98ab21d317000924599f4ed02422daa6510e1373c9458ac1d9a3);
        _market("MEME", 0x4A1FAD07D52d0743274b6ADc5E5A1b3578530232, 0x6b6610c1e919d70a0835760822f981bbed6cf801d0e56f3bcaad498d4c5a5bfa);
        _market("NVDA", 0x2F168C5EF394B84aFf8fF8814cb637Dac8bbdF12, 0x1f65201c2406510eeaced1ae93c0e4be5d602f17de3d5f9f625753a2b6aa6beb);
        _market("MU", 0x0650fB2e4A28e170F58f8AEa4997c1e55197de6C, 0xdc290821c86075a90f5da5ae36fd0bfbd6dad4cb0db84119f39acc34ef9c62ea);
        _market("TSLA", 0x58B728202FE175F1f2fe20e22205358E6D3Da0a4, 0x837bf9ccc605da1f5c9e95670b717854fd9ebf5063a542e8891fa2d7eb2c301e);

        require(address(LENS).code.length > 0, "the recorded lens is not at its address");
        guard = new ExposureGuard(LENS, MANAGER, VENUE, LEAF);
        (uint160 sqrtP,,,) = MANAGER.getSlot0(PoolId.wrap(markets[1].pricingPoolId));
        // the public RPC sometimes answers a fresh fork with empty state; say so instead of failing later
        require(sqrtP != 0, "RPC returned no state for PONS/USDG: retry");
    }

    function _market(string memory symbol, address base, bytes32 pricingPoolId) internal {
        markets.push(Market({symbol: symbol, base: base, pricingPoolId: pricingPoolId}));
    }

    /// @dev The pool the venue registered for a market, and which side of it USDG is (currency1 only on MU).
    function _pool(Market memory m) internal view returns (PoolKey memory key, bool quoteIsCurrency0) {
        bool set;
        (key, set) = LEAF.poolOf(m.base, USDG);
        assertTrue(set, string.concat(m.symbol, ": the venue registers no pool"));
        assertEq(PoolId.unwrap(key.toId()), m.pricingPoolId, string.concat(m.symbol, ": key hashes to the pricing pool"));
        quoteIsCurrency0 = Currency.unwrap(key.currency0) == USDG;
        assertTrue(quoteIsCurrency0 || Currency.unwrap(key.currency1) == USDG, "USDG is one side of the pool");
    }

    /// @dev The quote side of one full-range position, in USDG (6 dec): L / sqrtP or L * sqrtP.
    function _quoteReserve(PoolId id, bool quoteIsCurrency0) internal view returns (uint256) {
        (uint160 sqrtP,,,) = MANAGER.getSlot0(id);
        uint256 liquidity = MANAGER.getLiquidity(id);
        return quoteIsCurrency0
            ? FullMath.mulDiv(liquidity, FixedPoint96.Q96, sqrtP)
            : FullMath.mulDiv(liquidity, sqrtP, FixedPoint96.Q96);
    }

    /// Six live pool keys from the venue's registry, each hashing to its pricing pool, and the bound on every one:
    /// hookless pools, where SafeSettle would revert WrongHook.
    function test_sixMarkets_poolOfHashesToThePricingPool_andTheBoundIsComplete() public {
        console2.log("block / timestamp", block.number, block.timestamp);
        assertEq(IDecimals(USDG).decimals(), 6, "USDG has 6 decimals");
        for (uint256 i; i < markets.length; i++) {
            Market memory m = markets[i];
            (PoolKey memory key, bool quoteIsCurrency0) = _pool(m);
            assertEq(address(key.hooks), address(0), "hookless");
            assertEq(key.fee, 3000);
            assertEq(key.tickSpacing, 60);
            assertEq(IDecimals(m.base).decimals(), 18, string.concat(m.symbol, " has 18 decimals"));
            assertEq(quoteIsCurrency0, keccak256(bytes(m.symbol)) != keccak256("MU"), "USDG is currency0 except on MU");

            (, int24 tick,,) = MANAGER.getSlot0(key.toId());
            uint256 reserve = _quoteReserve(key.toId(), quoteIsCurrency0);
            CostModel.Bound memory b = guard.bound(key, quoteIsCurrency0, FIX_WINDOW, 0);
            assertTrue(b.complete, string.concat(m.symbol, ": the binding walk completed"));
            assertGt(b.maxSafeExposure, 0, string.concat(m.symbol, ": a positive bound"));
            assertLt(b.maxSafeExposure, reserve, string.concat(m.symbol, ": the bound is below the quote reserve"));

            console2.log(string.concat(m.symbol, ": tick"), int256(tick));
            console2.log(
                string.concat(m.symbol, ": liquidity / quote reserve / max safe exposure (USDG, 6 dec)"),
                MANAGER.getLiquidity(key.toId()),
                reserve,
                b.maxSafeExposure
            );
            console2.log(
                string.concat(m.symbol, ": binding move (ticks) / up? / cost to fake it (USDG, 6 dec)"),
                uint256(int256(b.ticks)),
                b.up,
                b.cost
            );
        }
    }

    /// The venue path: for each market, every series settling at the next fix (from the SeriesOpened logs), summed
    /// from the venue's ERC-6909 supply and priced at the pool, against the same bound the key path gives.
    function test_venueVerdict_onTheNextExpiry_sumsTheOpenSeriesAndPricesThemAtThePool() public {
        assertEq(VexiSeries.SERIES_OPENED_TOPIC, SERIES_OPENED_LIVE, "the re-declared event hashes to the live topic");
        (,,, uint64 fixWindow) = VENUE.terms();
        assertEq(uint256(fixWindow), uint256(FIX_WINDOW), "the venue's fix window");

        VexiSeries.Opened[] memory all = VexiSeries.opened(address(VENUE), block.number);
        console2.log("series opened in the last blocks scanned / at block", all.length, block.number);
        uint256 read;
        for (uint256 i; i < markets.length; i++) {
            Market memory m = markets[i];
            // the next fix at least a minute away, so every id is unexpired at this block whatever the grid does
            (uint256[] memory ids, uint64 expiry) = VexiSeries.nextExpiry(all, m.base, USDG, block.timestamp + 60);
            if (ids.length == 0) {
                console2.log(string.concat(m.symbol, ": no series open for a coming fix in the blocks scanned; skipped"));
                continue;
            }
            uint256 gasBefore = gasleft();
            (ExposureGuard.Verdict memory v, address base, address quote, uint64 e, uint256 contracts, uint256 spotWad) =
                guard.venueVerdict(ids, 0);
            uint256 gasUsed = gasBefore - gasleft();

            assertEq(base, m.base, "the series' base");
            assertEq(quote, USDG, "the series' quote");
            assertEq(uint256(e), uint256(expiry), "the expiry the log named");
            assertGt(uint256(e), block.timestamp, "unexpired at this block");
            assertEq(v.poolId, m.pricingPoolId, "the verdict is on the pricing pool");
            assertEq(uint256(v.source), 1, "source 1: read from the venue");
            assertEq(v.nIds, ids.length);
            uint256 supply;
            for (uint256 j; j < ids.length; j++) {
                supply += VENUE.totalSupply(ids[j] & ~uint256(1));
            }
            assertEq(contracts, supply, "contracts = the option supply of the ids, summed");
            assertEq(
                v.exposure,
                FullMath.mulDiv(FullMath.mulDiv(contracts, spotWad, 1e18), 1e6, 1e18),
                "exposure = contracts x spot, 18 dec into 6"
            );
            (PoolKey memory key, bool quoteIsCurrency0) = _pool(m);
            CostModel.Bound memory b = guard.bound(key, quoteIsCurrency0, FIX_WINDOW, 0);
            assertEq(v.maxSafeExposure, b.maxSafeExposure, "the venue path and the key path give one bound");
            assertEq(v.trusted, v.exposure < v.maxSafeExposure);
            assertTrue(v.complete);

            console2.log(
                string.concat(m.symbol, ": next expiry / series / contracts (base, 18 dec)"),
                uint256(expiry),
                ids.length,
                contracts
            );
            console2.log(
                string.concat(m.symbol, ": spot (USDG per base, 18 dec) / exposure / max safe exposure (USDG, 6 dec)"),
                spotWad,
                v.exposure,
                v.maxSafeExposure
            );
            console2.log(string.concat(m.symbol, ": trusted? / gas of the venue read and the walk"), v.trusted, gasUsed);
            read++;
        }
        assertGt(read, 0, "at least one market had series open for a coming fix");
    }
}
