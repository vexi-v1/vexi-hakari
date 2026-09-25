// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Test.sol";
import {HakariDeployers} from "../utils/HakariDeployers.sol";
import {HakariOracleHook} from "../../src/HakariOracleHook.sol";
import {PushCostLens} from "../../src/PushCostLens.sol";
import {SafeSettle} from "../../src/SafeSettle.sol";
import {NaiveSpotConsumer} from "../../src/demo/NaiveSpotConsumer.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

/// @notice The demo script of SPEC.md § 5, as tests with logs. Run: forge test --match-contract ThreeLayers -vv
contract ThreeLayersTest is HakariDeployers {
    using PoolIdLibrary for PoolKey;

    int24 constant DELTA = 100;
    uint32 constant WINDOW = 10;
    HakariOracleHook hook;
    PushCostLens lens;
    SafeSettle settle;
    NaiveSpotConsumer naive;
    PoolId id;
    uint256 t0;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        hook = deployHook(DELTA, 0x4444);
        lens = new PushCostLens(manager);
        settle = new SafeSettle(hook, lens);
        naive = new NaiveSpotConsumer(manager);
        (key, id) = initPool(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
        hook.increaseObservationCardinalityNext(64, id);
        t0 = block.timestamp;
    }

    /// Layer 1. A protocol that settles on slot0 pays on a price that existed for zero seconds.
    function test_layer1_atomicPush_foolsSlot0_notTheHook() public {
        addLiquidity(key, -6000, 6000, 1e18);
        vm.warp(t0 + 1);
        poke(key);
        vm.warp(t0 + 20);
        int24 honest = currentTick(id);

        // one transaction: push up 500 ticks, settle, push back
        BalanceDelta pushDelta = swapToPrice(key, false, TickMath.getSqrtPriceAtTick(honest + 500));
        int24 seenByNaive = naive.settle(key);
        BalanceDelta backDelta = swapToPrice(key, true, SQRT_PRICE_1_1);

        assertGe(seenByNaive, honest + 499, "the naive protocol settled on the pushed price");
        // the attacker's cost: fees on both legs, in currency1 terms
        int256 net1 = int256(pushDelta.amount1()) + int256(backDelta.amount1());
        int256 net0 = int256(pushDelta.amount0()) + int256(backDelta.amount0());
        console2.log("naive settlement tick", seenByNaive);
        console2.log("honest tick", honest);
        console2.log("attacker net currency0", net0);
        console2.log("attacker net currency1", net1);

        // the hook: the next second's swap records the pre-push tick, the push was never in any record
        vm.warp(t0 + 21);
        poke(key);
        (int24 raw, int24 trunc) = hook.twaps(id, WINDOW);
        console2.log("hook raw TWAP", raw);
        console2.log("hook truncated TWAP", trunc);
        assertApproxEqAbs(raw, honest, 1, "raw TWAP never saw the push");
        assertApproxEqAbs(trunc, honest, 1, "truncated TWAP never saw the push");
    }

    /// Layers 2 + 3. A thin pool held off-price for the window: the truncated series lags, the cost model says
    /// the fake was cheap, SafeSettle refuses to pay on the raw price.
    function test_layer2and3_sustainedPushOnThinPool_settlesTruncated() public {
        addLiquidity(key, -6000, 6000, 1e15);
        int24 honest = currentTick(id);
        swapToPrice(key, false, TickMath.getSqrtPriceAtTick(honest + 3000));
        for (uint256 s = 1; s <= WINDOW; s++) {
            vm.warp(t0 + s);
            poke(key);
        }
        vm.warp(t0 + WINDOW + 1);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, false);
        console2.log("raw TWAP", d.rawTick);
        console2.log("truncated TWAP", d.truncTick);
        console2.log("cost to fake (quote units)", d.costToFake);
        console2.log("gain if faked (quote units)", d.gainIfFaked);
        console2.log("used raw?", d.usedRaw);
        assertFalse(d.usedRaw);
        assertLt(d.costToFake, d.gainIfFaked);
        _record("thin-pool-sustained-push", "local 18/18, L=1e15, fee 0.3%", false, 1e18, d);
    }

    /// Layer 3, the other way. A deep pool, arbitrage open, a real move: the raw series is trusted and the
    /// truncated lag is avoided.
    function test_layer3_genuineSurgeOnDeepPool_settlesRaw() public {
        addLiquidity(key, -6000, 6000, 1e21);
        int24 honest = currentTick(id);
        // a surge: independent buyers walk the price up over the window, nobody pushes back
        for (uint256 s = 1; s <= WINDOW; s++) {
            vm.warp(t0 + s);
            swapToPrice(key, false, TickMath.getSqrtPriceAtTick(honest + int24(int256(s)) * 300));
        }
        vm.warp(t0 + WINDOW + 1);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, true);
        console2.log("raw TWAP", d.rawTick);
        console2.log("truncated TWAP", d.truncTick);
        console2.log("cost to fake (quote units)", d.costToFake);
        console2.log("gain if faked (quote units)", d.gainIfFaked);
        console2.log("used raw?", d.usedRaw);
        assertGt(d.rawTick, d.truncTick + TOLERANCE(), "the series disagree: truncation is lagging");
        assertTrue(d.usedRaw, "but faking this would cost more than it pays, so the move is real");
        _record("deep-pool-genuine-surge", "local 18/18, L=1e21, fee 0.3%", true, 1e18, d);
    }

    function TOLERANCE() internal view returns (int24) {
        return settle.TOLERANCE_TICKS();
    }

    /// @dev The web page's decision log: one row per scenario, appended by each test that settles.
    function _record(string memory scenario, string memory pool, bool arbOpen, uint256 notional, SafeSettle.Decision memory d) internal {
        string memory row = scenario;
        vm.serializeString(row, "scenario", scenario);
        vm.serializeString(row, "pool", pool);
        vm.serializeBool(row, "arbOpen", arbOpen);
        vm.serializeString(row, "notional", vm.toString(notional));
        vm.serializeInt(row, "rawTick", int256(d.rawTick));
        vm.serializeInt(row, "truncTick", int256(d.truncTick));
        vm.serializeString(row, "costToFake", vm.toString(d.costToFake));
        vm.serializeString(row, "gainIfFaked", vm.toString(d.gainIfFaked));
        vm.serializeBool(row, "costComplete", d.costComplete);
        string memory out = vm.serializeBool(row, "usedRaw", d.usedRaw);
        string memory path = string(abi.encodePacked("web/decisions/", scenario, ".json"));
        vm.writeJson(out, path);
    }
}
