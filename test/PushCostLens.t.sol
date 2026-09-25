// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {HakariDeployers} from "./utils/HakariDeployers.sol";
import {PushCostLens} from "../src/PushCostLens.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

contract PushCostLensTest is HakariDeployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    PushCostLens lens;
    PoolId id;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        lens = new PushCostLens(manager);
        (key, id) = initPool(currency0, currency1, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        // a concentrated core and thinner wings, like a real book
        addLiquidity(key, -600, 600, 5e18);
        addLiquidity(key, -6000, 6000, 1e18);
    }

    function test_quotePush_reachesTheTargetAndLeavesThePoolUntouched() public {
        (uint160 sqrtBefore, int24 tickBefore,,) = manager.getSlot0(id);
        PushCostLens.PushQuote memory q = lens.quotePush(key, 300, true);
        assertEq(q.sqrtPriceStart, sqrtBefore);
        assertEq(q.sqrtPriceTarget, TickMath.getSqrtPriceAtTick(tickBefore + 300));
        assertEq(q.sqrtPriceReached, q.sqrtPriceTarget, "push leg reached the target price");
        assertFalse(q.zeroForOne, "pushing the price up means buying currency0 with currency1");
        assertGt(q.amountIn, 0);
        assertGt(q.amountOut, 0);
        assertGt(q.cost, 0, "a round trip costs something");
        assertLt(q.cost, q.amountIn, "but less than the push itself");
        (uint160 sqrtAfter,,,) = manager.getSlot0(id);
        assertEq(sqrtAfter, sqrtBefore, "the quote reverted every state change");
    }

    function test_quotePush_costIsTheFeesOnBothLegs() public {
        // 0.3 % fee, no protocol fee: cost = fee on the push leg + fee on the sell-back, in the input token
        PushCostLens.PushQuote memory q = lens.quotePush(key, 100, true);
        uint256 feePush = q.amountIn * 3000 / 1e6;
        uint256 feeBackInInputTerms = q.amountBackOut * 3000 / (1e6 - 3000);
        assertApproxEqRel(q.cost, feePush + feeBackInInputTerms, 0.02e18, "cost ~ two fees");
    }

    function test_quotePush_downIsPaidInCurrency0AndValuedInBoth() public {
        PushCostLens.PushQuote memory q = lens.quotePush(key, 100, false);
        assertTrue(q.zeroForOne);
        assertEq(q.costInCurrency0, q.cost, "input token is currency0");
        // at a 1:1 start price both valuations agree to rounding
        assertApproxEqRel(q.costInCurrency1, q.cost, 0.01e18);
    }

    function test_quotePush_crossingIntoTheThinWingCostsMorePerTick() public {
        PushCostLens.PushQuote memory core = lens.quotePush(key, 500, true);
        PushCostLens.PushQuote memory wing = lens.quotePush(key, 1000, true);
        // per-tick capital falls once the 5e18 core is behind us (thin wing)
        assertLt(wing.amountIn - core.amountIn, core.amountIn, "the second 500 ticks needed less capital");
    }

    function test_quotePushLadder_isMonotone() public {
        int24[] memory ticks = new int24[](3);
        ticks[0] = 100;
        ticks[1] = 500;
        ticks[2] = 2000;
        PushCostLens.PushQuote[] memory qs = lens.quotePushLadder(key, ticks, true);
        assertEq(qs.length, 3);
        assertLt(qs[0].cost, qs[1].cost);
        assertLt(qs[1].cost, qs[2].cost);
    }

    function test_quotePushToPrice_stopsExactlyAtAMidTickPrice() public {
        (uint160 sqrtBefore, int24 tickBefore,,) = manager.getSlot0(id);
        // a price strictly between two tick boundaries
        uint160 target = (TickMath.getSqrtPriceAtTick(tickBefore + 37) + TickMath.getSqrtPriceAtTick(tickBefore + 38)) / 2;
        PushCostLens.PushQuote memory q = lens.quotePushToPrice(key, target);
        assertEq(q.sqrtPriceTarget, target);
        assertEq(q.sqrtPriceReached, target, "reached the exact price, not a tick boundary");
        assertFalse(q.zeroForOne);
        PushCostLens.PushQuote memory byTicks = lens.quotePush(key, 37, true);
        assertGt(q.amountIn, byTicks.amountIn, "half a tick further costs more than the tick boundary");
        (uint160 sqrtAfter,,,) = manager.getSlot0(id);
        assertEq(sqrtAfter, sqrtBefore, "state reverted");
    }

    function test_quotePushToPrice_atTheCurrentPrice_reverts() public {
        (uint160 sqrtNow,,,) = manager.getSlot0(id);
        vm.expectRevert(PushCostLens.ZeroTicks.selector);
        lens.quotePushToPrice(key, sqrtNow);
    }

    function test_quotePush_zeroTicks_reverts() public {
        vm.expectRevert(PushCostLens.ZeroTicks.selector);
        lens.quotePush(key, 0, true);
    }

    function test_depthToMove_matchesTheExactSimulation() public {
        int24[3] memory ladder = [int24(100), 700, 3000];
        for (uint256 i; i < ladder.length; i++) {
            for (uint256 dir; dir < 2; dir++) {
                bool up = dir == 0;
                PushCostLens.PushQuote memory q = lens.quotePush(key, ladder[i], up);
                (uint256 amountIn, uint256 amountOut, uint256 feePaid, bool complete) =
                    lens.depthToMove(key, ladder[i], up, 64);
                assertTrue(complete);
                assertApproxEqRel(amountIn, q.amountIn, 0.001e18, "amountIn within 0.1 %");
                assertApproxEqRel(amountOut, q.amountOut, 0.001e18, "amountOut within 0.1 %");
                assertApproxEqRel(feePaid, q.amountIn * 3000 / 1e6, 0.001e18, "fee within 0.1 %");
            }
        }
    }

    function test_depthToMove_stepCapReportsIncomplete() public {
        (,, , bool complete) = lens.depthToMove(key, 3000, true, 1);
        assertFalse(complete, "one step cannot cross the core boundary and reach 3000 ticks");
    }

    function test_roundTripCost_isWithinAPercentOfTheExactSimulation() public {
        PushCostLens.PushQuote memory q = lens.quotePush(key, 700, true);
        (uint256 cost, uint256 in0, uint256 in1, bool complete) = lens.roundTripCost(key, 700, true, 64);
        assertTrue(complete);
        assertApproxEqRel(cost, q.cost, 0.01e18);
        assertEq(in1, cost, "pushing up is paid in currency1");
        assertApproxEqRel(in0, q.costInCurrency0, 0.01e18);
    }
}
