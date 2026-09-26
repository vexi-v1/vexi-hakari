// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ExposureGuard} from "../src/ExposureGuard.sol";
import {PushCostLens} from "../src/PushCostLens.sol";
import {IVexiVenue, IVexiSpotLeaf} from "../src/interfaces/IVexi.sol";
import {VexiSeries} from "./VexiSeries.sol";

/// @notice Two checks on-chain with the deployed ExposureGuard on testnet 46630, the reason in the log each time:
///         (a) `venueCheck` on every PONS series settling at the next fix (source 1: the exposure summed from the
///         venue's ERC-6909 supply and priced at the pool), then (b) `check` on the same pool with a stated exposure
///         (source 0: a what-if). Reads deployments/46630-vexi.json. Key from the environment only.
///         forge script script/DemoVexiCheck.s.sol --rpc-url robinhood_testnet --broadcast --slow
/// @dev The what-if is `HAKARI_WHATIF_EXPOSURE` in raw quote units (USDG, 6 decimals): the largest historical cell
///      from gauge/data/vexi-fixes.json, say. Unset, it is twice the pool's bound at that block, which the guard
///      refuses. The PONS ids come from the venue's SeriesOpened logs at run time (a saved list is stale within
///      15 minutes). `rehearse()` makes the same two calls on a guard built inside the simulation, so the flow can be
///      checked with nothing deployed and no key; it never broadcasts:
///      forge script script/DemoVexiCheck.s.sol --sig 'rehearse()' --rpc-url robinhood_testnet
contract DemoVexiCheck is Script {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    /// @dev Vexi's public deployment on 46630 (not ours, called by ABI), as gauge/data/vexi-markets.json lists it
    address constant VEXI_VENUE = 0xF91B7277217AC8E5Ff3E6144C1c5A66BbE1B06fA;
    address constant VEXI_SPOT_LEAF = 0xCEde7e1Eb7e67338BCA489C3d3e9697ae19Faa04;
    address constant USDG = 0x09Bb68Fe50F37E02e6bbA45BFe4D204Ad479581a;
    address constant PONS = 0x9edA6980d539bcAAf03c4C953265894cEdDC07e7;
    uint32 constant FIX_WINDOW = 300;

    function run() external {
        require(block.chainid == 46630, "testnet 46630 only");
        string memory rec = vm.readFile("deployments/46630-vexi.json");
        ExposureGuard guard = ExposureGuard(vm.parseJsonAddress(rec, ".exposureGuard"));
        require(address(guard).code.length > 0, "recorded ExposureGuard missing: run DeployExposureGuard.s.sol first");
        (uint256[] memory ids, uint64 expiry) = _nextPons();
        uint256 whatIf = _whatIf(guard);

        vm.startBroadcast(vm.envUint("HAKARI_DEPLOYER_KEY"));
        _demo(guard, ids, expiry, whatIf);
        vm.stopBroadcast();
        console2.log("two Checked events: copy the tx hashes from broadcast/DemoVexiCheck.s.sol/46630/run-latest.json");
    }

    /// @notice The same two calls on a guard that exists only in this simulation. Never broadcast.
    function rehearse() external {
        require(block.chainid == 46630, "testnet 46630 only");
        require(!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast), "a rehearsal never broadcasts");
        string memory rec = vm.readFile("deployments/46630.json");
        PushCostLens lens = PushCostLens(vm.parseJsonAddress(rec, ".pushCostLens"));
        ExposureGuard guard =
            new ExposureGuard(lens, IPoolManager(POOL_MANAGER), IVexiVenue(VEXI_VENUE), IVexiSpotLeaf(VEXI_SPOT_LEAF));
        console2.log("rehearsal: ExposureGuard built in the simulation at", address(guard));
        (uint256[] memory ids, uint64 expiry) = _nextPons();
        _demo(guard, ids, expiry, _whatIf(guard));
    }

    function _demo(ExposureGuard guard, uint256[] memory ids, uint64 expiry, uint256 whatIf) internal {
        require(ids.length > 0, "no PONS series open for a coming fix in the blocks scanned");
        console2.log("PONS series settling at / ids", uint256(expiry), ids.length);
        (ExposureGuard.Verdict memory v,,,, uint256 contracts, uint256 spotWad) = guard.venueCheck(ids, 0);
        console2.log("(a) venue read: contracts (18 dec) / spot (USDG per PONS, 18 dec)", contracts, spotWad);
        _log("(a) venue read, source 1", v);

        (PoolKey memory key, bool quoteIsCurrency0) = _ponsPool();
        ExposureGuard.Verdict memory w = guard.check(key, quoteIsCurrency0, whatIf, FIX_WINDOW, 0);
        _log("(b) what-if, source 0", w);
    }

    /// @dev Every PONS series on the earliest expiry at least a minute away, from the venue's logs.
    function _nextPons() internal view returns (uint256[] memory ids, uint64 expiry) {
        VexiSeries.Opened[] memory all = VexiSeries.opened(VEXI_VENUE, block.number);
        (ids, expiry) = VexiSeries.nextExpiry(all, PONS, USDG, block.timestamp + 60);
    }

    function _ponsPool() internal view returns (PoolKey memory key, bool quoteIsCurrency0) {
        bool set;
        (key, set) = IVexiSpotLeaf(VEXI_SPOT_LEAF).poolOf(PONS, USDG);
        require(set, "the venue registers no PONS/USDG pool");
        quoteIsCurrency0 = Currency.unwrap(key.currency0) == USDG;
    }

    function _whatIf(ExposureGuard guard) internal view returns (uint256 exposure) {
        exposure = vm.envOr("HAKARI_WHATIF_EXPOSURE", uint256(0));
        if (exposure == 0) {
            (PoolKey memory key, bool quoteIsCurrency0) = _ponsPool();
            exposure = 2 * guard.bound(key, quoteIsCurrency0, FIX_WINDOW, 0).maxSafeExposure;
            console2.log("HAKARI_WHATIF_EXPOSURE unset: the what-if is twice the bound", exposure);
        }
    }

    function _log(string memory label, ExposureGuard.Verdict memory v) internal pure {
        console2.log(label);
        console2.log("  exposure / max safe exposure (USDG, 6 dec)", v.exposure, v.maxSafeExposure);
        console2.log(
            "  binding move (ticks) / up? / cost to fake it (USDG, 6 dec)",
            uint256(int256(v.bindingTicks)),
            v.bindingUp,
            v.bindingCost
        );
        console2.log("  walk complete? / trusted?", v.complete, v.trusted);
    }
}
