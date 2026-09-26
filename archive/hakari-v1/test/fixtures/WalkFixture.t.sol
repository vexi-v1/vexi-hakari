// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {HakariDeployers} from "../utils/HakariDeployers.sol";
import {PushCostLens} from "../../src/PushCostLens.sol";
import {CostModel} from "../../src/CostModel.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// @dev Calls CostModel.maxSafeExposure (a library) from outside.
contract MaxSafeHarness {
    function bound(PushCostLens lens, PoolKey calldata key, bool quoteIsCurrency0) external view returns (CostModel.Bound memory) {
        return CostModel.maxSafeExposure(lens, key, CostModel.Query(0, 60, 0, quoteIsCurrency0, 64));
    }
}

/// @dev Writes test/fixtures/walk.json: a pool built from known positions, its slot0, and the lens's
///      depthToMove answers for a ladder of pushes, so the TypeScript port in gauge/src/v4math.ts can be
///      checked against the Solidity walk. Run: forge test --match-contract WalkFixture
contract WalkFixtureTest is HakariDeployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function test_writeFixture() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        PushCostLens lens = new PushCostLens(manager);
        // start away from 1:1 so the port cannot pass by accident
        (PoolKey memory k, PoolId id) = initPool(currency0, currency1, IHooks(address(0)), 3000, TickMath.getSqrtPriceAtTick(-1234));
        int24[3] memory lowers = [int24(-6000), -1800, -600];
        int24[3] memory uppers = [int24(6000), 1200, 300];
        int256[3] memory liqs = [int256(1e18), 5e18, 20e18];
        for (uint256 i; i < 3; i++) {
            addLiquidity(k, lowers[i], uppers[i], liqs[i]);
        }
        string memory json = "fixture";
        vm.serializeInt(json, "tickSpacing", int256(k.tickSpacing));
        vm.serializeUint(json, "fee", uint256(k.fee));
        (uint160 sqrtP, int24 tick,,) = manager.getSlot0(id);
        vm.serializeString(json, "sqrtPriceX96", vm.toString(uint256(sqrtP)));
        vm.serializeInt(json, "tick", int256(tick));
        vm.serializeString(json, "liquidity", vm.toString(uint256(manager.getLiquidity(id))));
        string memory positions = "positions";
        string memory posOut;
        for (uint256 i; i < 3; i++) {
            string memory p = string(abi.encodePacked("p", vm.toString(i)));
            vm.serializeInt(p, "tickLower", int256(lowers[i]));
            vm.serializeInt(p, "tickUpper", int256(uppers[i]));
            string memory pOut = vm.serializeString(p, "liquidity", vm.toString(liqs[i]));
            posOut = vm.serializeString(positions, vm.toString(i), pOut);
        }
        vm.serializeString(json, "positions", posOut);
        int24[6] memory ladder = [int24(50), 400, 1500, 3000, 5000, 9000];
        string memory pushes = "pushes";
        string memory pushOut;
        for (uint256 i; i < ladder.length; i++) {
            for (uint256 dir; dir < 2; dir++) {
                bool up = dir == 0;
                (uint256 amountIn, uint256 amountOut, uint256 feePaid, bool complete) =
                    lens.depthToMove(k, ladder[i], up, 64);
                string memory q = string(abi.encodePacked("q", vm.toString(i * 2 + dir)));
                vm.serializeInt(q, "ticks", int256(ladder[i]));
                vm.serializeBool(q, "up", up);
                vm.serializeString(q, "amountIn", vm.toString(amountIn));
                vm.serializeString(q, "amountOut", vm.toString(amountOut));
                vm.serializeString(q, "feePaid", vm.toString(feePaid));
                string memory qOut = vm.serializeBool(q, "complete", complete);
                pushOut = vm.serializeString(pushes, vm.toString(i * 2 + dir), qOut);
            }
        }
        // a few sqrt prices for the TickMath port
        int24[5] memory ticks = [int24(-887272), -216886, -1234, 0, 242527];
        string memory sq = "sqrt";
        string memory sqOut;
        for (uint256 i; i < ticks.length; i++) {
            sqOut = vm.serializeString(sq, vm.toString(ticks[i]), vm.toString(uint256(TickMath.getSqrtPriceAtTick(ticks[i]))));
        }
        vm.serializeString(json, "sqrtPrices", sqOut);
        // the contract's bound with nobody pushing back, both quote sides, for the gauge's mirror to match
        MaxSafeHarness harness = new MaxSafeHarness();
        string memory ms = "maxSafe";
        string memory msOut;
        for (uint256 q; q < 2; q++) {
            bool quote0 = q == 0;
            CostModel.Bound memory b = harness.bound(lens, k, quote0);
            string memory side = quote0 ? "quote0" : "quote1";
            vm.serializeString(side, "exposure", vm.toString(b.maxSafeExposure));
            vm.serializeInt(side, "ticks", int256(b.ticks));
            vm.serializeString(side, "cost", vm.toString(b.cost));
            string memory sideOut = vm.serializeBool(side, "up", b.up);
            msOut = vm.serializeString(ms, side, sideOut);
        }
        vm.serializeString(json, "maxSafe", msOut);
        string memory out = vm.serializeString(json, "pushes", pushOut);
        vm.writeJson(out, "test/fixtures/walk.json");
    }
}
