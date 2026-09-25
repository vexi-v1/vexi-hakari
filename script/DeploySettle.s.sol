// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {HakariOracleHook} from "../src/HakariOracleHook.sol";
import {PushCostLens} from "../src/PushCostLens.sol";
import {SafeSettle} from "../src/SafeSettle.sol";

/// @notice Redeploys only SafeSettle against the recorded hook and lens (neither changed), and updates the record.
/// @dev Testnet 46630 only; key from the environment only.
///      forge script script/DeploySettle.s.sol --rpc-url robinhood_testnet --broadcast --slow
contract DeploySettle is Script {
    function run() external {
        require(block.chainid == 46630, "testnet 46630 only");
        string memory path = "deployments/46630.json";
        string memory rec = vm.readFile(path);
        HakariOracleHook hook = HakariOracleHook(vm.parseJsonAddress(rec, ".hakariOracleHook"));
        PushCostLens lens = PushCostLens(vm.parseJsonAddress(rec, ".pushCostLens"));
        require(address(hook).code.length > 0 && address(lens).code.length > 0, "recorded hook or lens missing");

        vm.startBroadcast(vm.envUint("HAKARI_DEPLOYER_KEY"));
        SafeSettle settle = new SafeSettle(hook, lens);
        vm.stopBroadcast();
        console2.log("SafeSettle", address(settle));

        vm.writeJson(vm.toString(address(settle)), path, ".safeSettle");
    }
}
