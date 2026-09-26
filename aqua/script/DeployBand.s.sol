// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console2 } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";

import { FixedPremium } from "../src/book/FixedPremium.sol";
import { StabilityBandPricer } from "../src/band/StabilityBandPricer.sol";
import { HookTwapExpiryPrice } from "../src/band/HookTwapExpiryPrice.sol";
import { UniswapV4Robinhood } from "../test/helpers/UniswapV4Robinhood.sol";

/// @notice Robinhood Chain **testnet 46630**: the band and the settlement source over the AAPL/USDG v4 pool whose hook
///         is HAKARI's oracle hook (`deployments/46630-hooked-pool.json`; `script/HookedPool.s.sol` makes one).
///         Deploys a `FixedPremium` for the band to guard, a `StabilityBandPricer` with the default 5 % band, and a
///         `HookTwapExpiryPrice` bound to the same pool, all owned by the deployer.
///
///         Run without `--broadcast` to simulate:
///           forge script script/DeployBand.s.sol --rpc-url robinhood_testnet
///         and with `--broadcast --slow` to deploy. The key is read from the environment (`BAND_DEPLOYER_KEY`, loaded
///         by forge from .env), never from argv. With `--broadcast` it writes deployments/46630-band.json; a
///         simulation writes nothing.
contract DeployBand is Script, UniswapV4Robinhood {
    using StateLibrary for IPoolManager;

    address internal constant AAPL = 0xEC654A00FBf55334f70B867bbbB2502406deba6B; // testnet, 18 decimals
    address internal constant USDG = 0xf46f82B1d1c341e6680798fE0a52285004112351; // testnet, 6 decimals
    address internal constant HOOK = 0x3b58D774cE351227B24A91103b20bA4fc068D080; // HakariOracleHook
    bytes32 internal constant POOL_ID = 0x3e8b60d6f58a9f894f1b76f3a8239814f0186b78e2990801773a55fd34e43fbe;
    string internal constant EXPLORER = "https://explorer.testnet.chain.robinhood.com";
    string internal constant OUT = "deployments/46630-band.json";

    function run() external {
        require(block.chainid == 46_630, "Robinhood Chain testnet 46630 only");
        IPoolManager manager = IPoolManager(V4_POOL_MANAGER);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(AAPL), currency1: Currency.wrap(USDG), fee: 3000, tickSpacing: 60, hooks: IHooks(HOOK)
        });
        require(PoolId.unwrap(key.toId()) == POOL_ID, "not the hooked AAPL/USDG pool");
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(key.toId());
        require(sqrtPriceX96 != 0, "the hooked pool is not initialised");

        uint256 deployerKey = vm.envUint("BAND_DEPLOYER_KEY");
        address owner = vm.addr(deployerKey);
        vm.startBroadcast(deployerKey);
        FixedPremium premium = new FixedPremium(owner);
        StabilityBandPricer band =
            new StabilityBandPricer(premium, manager, key, AAPL, USDG, _defaultBand(), owner);
        HookTwapExpiryPrice settle = new HookTwapExpiryPrice(owner);
        settle.setSource(
            manager,
            key,
            AAPL,
            USDG,
            HookTwapExpiryPrice.Params({
                settleWindow: 300, bandWindow: 1800, attempts: 6, halfWidthBps: 500, bandFromExpiry: true
            })
        );
        vm.stopBroadcast();

        StabilityBandPricer.Status memory s = band.status();
        console2.log("owner", owner);
        console2.log("FixedPremium", string.concat(EXPLORER, "/address/", vm.toString(address(premium))));
        console2.log("StabilityBandPricer", string.concat(EXPLORER, "/address/", vm.toString(address(band))));
        console2.log("HookTwapExpiryPrice", string.concat(EXPLORER, "/address/", vm.toString(address(settle))));
        console2.log("band quoting", s.quoting, "reason", uint256(s.reason));
        console2.log("  center (WAD USDG per AAPL)", s.centerWad);
        console2.log("  current (WAD USDG per AAPL)", s.currentWad);
        console2.log("  half-width bps", s.halfWidthBps);
        console2.log("  u (WAD)", s.uWad);
        console2.log("  contracts per call", s.sizeCap);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory j = "band";
            vm.serializeUint(j, "chainId", block.chainid);
            vm.serializeAddress(j, "owner", owner);
            vm.serializeBytes32(j, "poolId", POOL_ID);
            vm.serializeAddress(j, "hakariOracleHook", HOOK);
            vm.serializeAddress(j, "fixedPremium", address(premium));
            vm.serializeAddress(j, "hookTwapExpiryPrice", address(settle));
            vm.serializeUint(j, "deployedAt", block.timestamp);
            vm.writeJson(vm.serializeAddress(j, "stabilityBandPricer", address(band)), OUT);
        }
    }

    function _defaultBand() internal pure returns (StabilityBandPricer.Params memory) {
        return StabilityBandPricer.Params({
            bandWindow: 3600, nowWindow: 0, halfWidthBps: 500, maxExtraBps: 2000, maxContracts: 50, minLiquidity: 0
        });
    }
}
