// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HakariOracleHook} from "../src/HakariOracleHook.sol";
import {SafeSettle} from "../src/SafeSettle.sol";

/// @notice A public, on-chain run of the whole loop on testnet 46630: a pool with HakariOracleHook on the official
///         PoolManager, liquidity, a push held across blocks, and a SafeSettle.settle() that emits its reason.
/// @dev Reads deployments/46630.json. Key from the environment only.
///      forge script script/DemoPool.s.sol --rpc-url robinhood_testnet --broadcast --slow
contract DemoPool is Script {
    using PoolIdLibrary for PoolKey;

    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function run() external {
        require(block.chainid == 46630, "testnet 46630 only");
        string memory rec = vm.readFile("deployments/46630.json");
        HakariOracleHook hook = HakariOracleHook(vm.parseJsonAddress(rec, ".hakariOracleHook"));
        SafeSettle settle = SafeSettle(vm.parseJsonAddress(rec, ".safeSettle"));
        IPoolManager manager = IPoolManager(POOL_MANAGER);

        uint256 key = vm.envUint("HAKARI_DEPLOYER_KEY");
        address me = vm.addr(key);
        vm.startBroadcast(key);

        PoolSwapTest swapRouter = new PoolSwapTest(manager);
        PoolModifyLiquidityTest lpRouter = new PoolModifyLiquidityTest(manager);
        MockERC20 a = new MockERC20("HAKARI demo base", "hBASE", 18);
        MockERC20 b = new MockERC20("HAKARI demo quote", "hQUOTE", 18);
        (MockERC20 c0, MockERC20 c1) = address(a) < address(b) ? (a, b) : (b, a);
        c0.mint(me, 1e30);
        c1.mint(me, 1e30);
        c0.approve(address(swapRouter), type(uint256).max);
        c1.approve(address(swapRouter), type(uint256).max);
        c0.approve(address(lpRouter), type(uint256).max);
        c1.approve(address(lpRouter), type(uint256).max);

        PoolKey memory pool = PoolKey({
            currency0: Currency.wrap(address(c0)),
            currency1: Currency.wrap(address(c1)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        PoolId id = pool.toId();
        manager.initialize(pool, TickMath.getSqrtPriceAtTick(0));
        hook.increaseObservationCardinalityNext(64, id);
        // a thin book: the weekend case
        lpRouter.modifyLiquidity(pool, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e15, salt: 0}), "");

        // push the price up ~3000 ticks (+35 %) and keep the pushed tick in the record with small swaps;
        // --slow lands each tx in its own block, so the observations are seconds apart
        swapRouter.swap(pool, SwapParams({zeroForOne: false, amountSpecified: -int256(uint256(type(uint112).max)), sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(3000)}), PoolSwapTest.TestSettings(false, false), "");
        for (uint256 i; i < 4; i++) {
            swapRouter.swap(pool, SwapParams({zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}), PoolSwapTest.TestSettings(false, false), "");
        }
        // 1,000,000 quote units riding on a 60-second TWAP; weekend (arbitrage closed)
        SafeSettle.Decision memory d = settle.settle(pool, 60, 1_000_000e18, false, false);
        vm.stopBroadcast();

        console2.log("demo pool id");
        console2.logBytes32(PoolId.unwrap(id));
        console2.log("raw TWAP tick", d.rawTick);
        console2.log("truncated TWAP tick", d.truncTick);
        console2.log("cost to fake", d.costToFake);
        console2.log("gain if faked", d.gainIfFaked);
        console2.log("used raw?", d.usedRaw);

        string memory json = "demo";
        vm.serializeAddress(json, "currency0", address(c0));
        vm.serializeAddress(json, "currency1", address(c1));
        vm.serializeAddress(json, "swapRouter", address(swapRouter));
        vm.serializeAddress(json, "lpRouter", address(lpRouter));
        string memory out = vm.serializeBytes32(json, "poolId", PoolId.unwrap(id));
        vm.writeJson(out, "deployments/46630-demo-pool.json");
    }
}
