// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HakariOracleHook} from "../src/HakariOracleHook.sol";
import {PushCostLens} from "../src/PushCostLens.sol";
import {SafeSettle} from "../src/SafeSettle.sol";

/// @notice Deploys the lens, one hook (with a mined salt) and the demo settler against the official PoolManager.
/// @dev Testnet 46630 only. The key comes from the environment (`HAKARI_DEPLOYER_KEY`, loaded by forge from .env),
///      never from argv. Refuses to run on 4663.
///      forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast --slow
contract Deploy is Script {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    /// @dev The canonical CREATE2 proxy (Arachnid), present on Robinhood Chain.
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 constant FLAGS = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
    uint160 constant FLAG_MASK = Hooks.ALL_HOOK_MASK;

    function run() external {
        // an RPC variable can be mislabelled; the chain id cannot. Testnet only, whatever the URL said.
        require(block.chainid == 46630, "testnet 46630 only");
        int24 delta = int24(int256(vm.envOr("HAKARI_DELTA", uint256(250))));
        require(POOL_MANAGER.code.length > 0, "no PoolManager here");

        bytes memory creation = abi.encodePacked(type(HakariOracleHook).creationCode, abi.encode(IPoolManager(POOL_MANAGER), delta));
        (address hookAddress, bytes32 salt) = _mine(creation);
        console2.log("hook salt found; address", hookAddress);

        uint256 key = vm.envUint("HAKARI_DEPLOYER_KEY");
        vm.startBroadcast(key);
        PushCostLens lens = new PushCostLens(IPoolManager(POOL_MANAGER));
        HakariOracleHook hook = new HakariOracleHook{salt: salt}(IPoolManager(POOL_MANAGER), delta);
        require(address(hook) == hookAddress, "hook landed elsewhere");
        SafeSettle settle = new SafeSettle(hook, lens);
        vm.stopBroadcast();

        console2.log("PushCostLens", address(lens));
        console2.log("HakariOracleHook", address(hook));
        console2.log("SafeSettle", address(settle));

        string memory json = "deploy";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "poolManager", POOL_MANAGER);
        vm.serializeAddress(json, "pushCostLens", address(lens));
        vm.serializeAddress(json, "hakariOracleHook", address(hook));
        vm.serializeInt(json, "maxAbsTickDelta", int256(delta));
        vm.serializeBytes32(json, "hookSalt", salt);
        string memory out = vm.serializeAddress(json, "safeSettle", address(settle));
        vm.writeJson(out, string(abi.encodePacked("deployments/", vm.toString(block.chainid), ".json")));
    }

    /// @dev forge broadcasts `new X{salt}` through the CREATE2 proxy, so mine against that deployer.
    function _mine(bytes memory creationWithArgs) internal view returns (address, bytes32) {
        bytes32 initHash = keccak256(creationWithArgs);
        for (uint256 salt; salt < 200_000; salt++) {
            address a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xFF), CREATE2_DEPLOYER, salt, initHash)))));
            if (uint160(a) & FLAG_MASK == FLAGS && a.code.length == 0) return (a, bytes32(salt));
        }
        revert("no salt");
    }
}
