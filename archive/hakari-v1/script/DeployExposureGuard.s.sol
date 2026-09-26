// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ExposureGuard} from "../src/ExposureGuard.sol";
import {PushCostLens} from "../src/PushCostLens.sol";
import {IVexiVenue, IVexiSpotLeaf} from "../src/interfaces/IVexi.sol";

/// @notice Deploys ExposureGuard against the recorded lens, the official PoolManager and Vexi's public venue on
///         testnet 46630, and records it in deployments/46630-vexi.json (its own file: vm.writeJson into a key that
///         deployments/46630.json does not have is a silent no-op).
/// @dev Testnet 46630 only; the key comes from the environment (`HAKARI_DEPLOYER_KEY`), never from argv. A run
///      without --broadcast is a rehearsal: it simulates the deployment and writes no record.
///      forge script script/DeployExposureGuard.s.sol --rpc-url robinhood_testnet --broadcast --slow
contract DeployExposureGuard is Script {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    /// @dev Vexi's public deployment on 46630 (not ours, called by ABI): the venue and its spot registry,
    ///      as gauge/data/vexi-markets.json lists them.
    address constant VEXI_VENUE = 0xF91B7277217AC8E5Ff3E6144C1c5A66BbE1B06fA;
    address constant VEXI_SPOT_LEAF = 0xCEde7e1Eb7e67338BCA489C3d3e9697ae19Faa04;
    string constant RECORD = "deployments/46630-vexi.json";

    function run() external {
        // an RPC variable can be mislabelled; the chain id cannot. Testnet only, whatever the URL said.
        require(block.chainid == 46630, "testnet 46630 only");
        string memory rec = vm.readFile("deployments/46630.json");
        PushCostLens lens = PushCostLens(vm.parseJsonAddress(rec, ".pushCostLens"));
        require(address(lens).code.length > 0, "recorded lens missing");
        require(POOL_MANAGER.code.length > 0, "no PoolManager here");
        require(VEXI_VENUE.code.length > 0 && VEXI_SPOT_LEAF.code.length > 0, "venue or spot leaf missing");

        vm.startBroadcast(vm.envUint("HAKARI_DEPLOYER_KEY"));
        // the constructor reverts ManagerMismatch unless the lens was built on this PoolManager
        ExposureGuard guard =
            new ExposureGuard(lens, IPoolManager(POOL_MANAGER), IVexiVenue(VEXI_VENUE), IVexiSpotLeaf(VEXI_SPOT_LEAF));
        vm.stopBroadcast();
        console2.log("ExposureGuard", address(guard));

        if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) {
            console2.log("rehearsal (no --broadcast): nothing deployed, no record written");
            return;
        }
        string memory json = "vexi";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "exposureGuard", address(guard));
        vm.serializeAddress(json, "pushCostLens", address(lens));
        vm.serializeAddress(json, "poolManager", POOL_MANAGER);
        vm.serializeAddress(json, "vexiVenue", VEXI_VENUE);
        vm.serializeAddress(json, "vexiSpotLeaf", VEXI_SPOT_LEAF);
        // the block the simulation ran at; a --slow broadcast lands a few blocks later
        string memory out = vm.serializeUint(json, "deployBlock", block.number);
        vm.writeJson(out, RECORD);
        // read it back: a write that did not happen must fail here, not in the demo
        require(vm.parseJsonAddress(vm.readFile(RECORD), ".exposureGuard") == address(guard), "record not written");
    }
}
