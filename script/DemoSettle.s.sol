// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SafeSettle} from "../src/SafeSettle.sol";
import {HakariOracleHook} from "../src/HakariOracleHook.sol";

/// @notice Step 2 of the 46630 demo: settle the pool DemoPool.s.sol created, on-chain, with the reason in the log.
/// @dev Run at least a minute after DemoPool. Window = min(60 s, age of the pool − 1).
///      forge script script/DemoSettle.s.sol --rpc-url robinhood_testnet --broadcast --slow
contract DemoSettle is Script {
    using PoolIdLibrary for PoolKey;

    function run() external {
        require(block.chainid == 46630, "testnet 46630 only");
        string memory rec = vm.readFile("deployments/46630.json");
        SafeSettle settle = SafeSettle(vm.parseJsonAddress(rec, ".safeSettle"));
        string memory demo = vm.readFile("deployments/46630-demo-pool.json");
        PoolKey memory pool = PoolKey({
            currency0: Currency.wrap(vm.parseJsonAddress(demo, ".currency0")),
            currency1: Currency.wrap(vm.parseJsonAddress(demo, ".currency1")),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(vm.parseJsonAddress(demo, ".hooks"))
        });
        // the pool's first observation carries the on-chain initialize time (the JSON's createdAt is the
        // simulation's clock, which runs ahead of a --slow broadcast)
        (uint32 initializedAt,,,,) = HakariOracleHook(address(pool.hooks)).observationsById(pool.toId(), 0);
        uint256 age = block.timestamp - initializedAt;
        require(age >= 10, "wait a little: the pool has almost no history yet");
        uint32 window = uint32(age > 60 ? 60 : age - 1);

        uint256 key = vm.envUint("HAKARI_DEPLOYER_KEY");
        vm.startBroadcast(key);
        // 1,000,000 quote tokens settling on this price; weekend (nobody pushes back)
        SafeSettle.Decision memory d = settle.settle(pool, window, 1_000_000e18, false, 0);
        vm.stopBroadcast();

        console2.log("window (s)", window);
        console2.log("raw TWAP tick", d.rawTick);
        console2.log("truncated TWAP tick", d.truncTick);
        console2.log("max safe exposure", d.maxSafeExposure);
        console2.log("binding move (ticks)", d.bindingTicks);
        console2.log("trusted?", d.trusted);
    }
}
