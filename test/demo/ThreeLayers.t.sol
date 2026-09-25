// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Test.sol";
import {HakariDeployers} from "../utils/HakariDeployers.sol";
import {DecisionLog} from "../utils/DecisionLog.sol";
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
contract ThreeLayersTest is HakariDeployers, DecisionLog {
    using PoolIdLibrary for PoolKey;

    int24 constant DELTA = 100;
    uint32 constant WINDOW = 10;
    /// @dev Demo assumption for an open market: arbitrageurs pull the price back once every 5 s.
    uint32 constant ARB_REVERSION = 5;
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

    function _log(SafeSettle.Decision memory d) internal pure {
        console2.log("raw TWAP", d.rawTick);
        console2.log("truncated TWAP", d.truncTick);
        console2.log("max safe exposure (quote wei)", d.maxSafeExposure);
        console2.log("binding move (ticks)", d.bindingTicks);
        console2.log("cost to fake it (quote wei)", d.bindingCost);
        console2.log("trusted?", d.trusted);
    }

    function _heldPush(int24 ticks, uint256 secs) internal {
        swapToPrice(key, false, TickMath.getSqrtPriceAtTick(currentTick(id) + ticks));
        for (uint256 s = 1; s <= secs; s++) {
            vm.warp(t0 + s);
            poke(key);
        }
        vm.warp(t0 + secs + 1);
    }

    /// Layer 2. A thin pool held off-price with nobody to push back: the pool is cheap to move, so SafeSettle refuses
    /// to settle on it for this exposure, whether the two TWAPs still disagree (10 s) ...
    function test_layer2_heldPushOnThinPool_isRefused() public {
        addLiquidity(key, -6000, 6000, 1e15);
        _heldPush(3000, WINDOW);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, 0);
        _log(d);
        assertGt(d.rawTick, d.truncTick + 1000, "the series disagree");
        assertFalse(d.trusted);
        _record("thin-pool-held-push", "local, L = 1e15, fee 0.3 %", 0, WINDOW, 1e18, 18, "tokens", d);
    }

    /// ... or have been held long enough to agree on the fake (42 s at Δ = 100). The old rule settled this on raw with
    /// no check at all.
    function test_layer2_heldUntilTheSeriesAgree_isStillRefused() public {
        addLiquidity(key, -6000, 6000, 1e15);
        _heldPush(3000, 42);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, 0);
        _log(d);
        assertApproxEqAbs(d.rawTick, d.truncTick, uint256(uint24(TOLERANCE())), "the series agree on the fake");
        assertFalse(d.trusted);
        _record("thin-pool-held-until-converged", "local, L = 1e15, fee 0.3 %", 0, WINDOW, 1e18, 18, "tokens", d);
    }

    /// Layer 3. A deep pool, arbitrage open, a genuine surge: faking a move here would cost more than it earns, so the
    /// raw price is trusted and truncation's lag is avoided.
    function test_layer3_genuineSurgeOnDeepPool_isTrusted() public {
        addLiquidity(key, -6000, 6000, 1e21);
        int24 honest = currentTick(id);
        for (uint256 s = 1; s <= WINDOW; s++) {
            vm.warp(t0 + s);
            swapToPrice(key, false, TickMath.getSqrtPriceAtTick(honest + int24(int256(s)) * 300));
        }
        vm.warp(t0 + WINDOW + 1);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, ARB_REVERSION);
        _log(d);
        assertGt(d.rawTick, d.truncTick + TOLERANCE(), "truncation is lagging");
        assertTrue(d.trusted, "the pool is deep enough: this move is real");
        assertEq(d.tickUsed, d.rawTick);
        _record("deep-pool-genuine-surge", "local, L = 1e21, fee 0.3 %", ARB_REVERSION, WINDOW, 1e18, 18, "tokens", d);
    }

    /// The same surge on a thin pool is refused: where faking is cheap the rule cannot tell real from fake, and it says
    /// so instead of settling on a lagging price.
    function test_layer3_genuineSurgeOnThinPool_isRefused() public {
        addLiquidity(key, -6000, 6000, 1e15);
        int24 honest = currentTick(id);
        for (uint256 s = 1; s <= WINDOW; s++) {
            vm.warp(t0 + s);
            swapToPrice(key, false, TickMath.getSqrtPriceAtTick(honest + int24(int256(s)) * 300));
        }
        vm.warp(t0 + WINDOW + 1);
        SafeSettle.Decision memory d = settle.settlePrice(key, WINDOW, 1e18, false, ARB_REVERSION);
        _log(d);
        assertFalse(d.trusted);
        _record("thin-pool-genuine-surge", "local, L = 1e15, fee 0.3 %", ARB_REVERSION, WINDOW, 1e18, 18, "tokens", d);
    }

    function TOLERANCE() internal view returns (int24) {
        return settle.TOLERANCE_TICKS();
    }
}
