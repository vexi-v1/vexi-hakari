// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {PushCostLens} from "../../src/PushCostLens.sol";
import {RoundTripProbe} from "../utils/RoundTripProbe.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice G1 of SPEC.md § 7: the lens against the real TSLA/USDG pool on a fork of Robinhood Chain 4663.
/// @dev Read-only: a fork, no broadcast. The public RPC only serves recent state, so this forks `latest`
///      and compares the lens with a manual round trip *at the same block* instead of against the
///      pre-hackathon figure (−26.560259 USDG for 10 TSLA at block 71,937,777, which is logged for scale).
///      Run: forge test --match-contract Fork -vv
contract PushCostLensForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    bytes32 constant TSLA_USDG = 0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e;

    PushCostLens lens;
    RoundTripProbe probe;
    PoolKey key;

    function setUp() public {
        string memory rpc = vm.envOr("RH_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) rpc = "https://rpc.mainnet.chain.robinhood.com";
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 4663, "Robinhood Chain mainnet");
        lens = new PushCostLens(MANAGER);
        probe = new RoundTripProbe(MANAGER);
        key = PoolKey({
            currency0: Currency.wrap(TSLA),
            currency1: Currency.wrap(USDG),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        assertEq(PoolId.unwrap(key.toId()), TSLA_USDG, "pool key hashes to the TSLA/USDG pool id");
    }

    /// @dev Buy 10 TSLA and sell 10 back (the pre-hackathon measurement) vs the lens pushed to the same price.
    function test_G1_tenTslaRoundTrip_matchesTheLensAtTheSameBlock() public {
        (uint160 sqrtStart, int24 tickStart,,) = MANAGER.getSlot0(key.toId());
        RoundTripProbe.Result memory manual = probe.roundTrip(key, true, 10e18);
        assertEq(manual.netDelta0, 0, "manual attacker ends flat in TSLA");
        assertLt(manual.netDelta1, 0, "and down in USDG");

        int24 ticksMoved = manual.tickAfterBuy - tickStart;
        assertGt(ticksMoved, 0, "buying TSLA pushed the price up");
        PushCostLens.PushQuote memory q = lens.quotePush(key, ticksMoved, true);

        console2.log("block", block.number);
        console2.log("start tick", tickStart);
        console2.log("ticks moved by 10 TSLA", ticksMoved);
        console2.log("manual net USDG (6 dec)", manual.netDelta1);
        console2.log("lens amountOut TSLA (18 dec)", q.amountOut);
        console2.log("lens cost USDG (6 dec)", q.cost);
        console2.log("pre-hackathon figure at block 71,937,777: -26.560259 USDG");

        // the lens pushes to the tick's price, not exactly to 10 TSLA, so allow the tick-granularity gap
        assertApproxEqRel(q.amountOut, 10e18, 0.02e18, "lens push bought ~10 TSLA");
        assertApproxEqRel(q.cost, uint256(-manual.netDelta1), 0.02e18, "lens cost ~ manual round trip");
        assertEq(q.sqrtPriceStart, sqrtStart);
    }

    function test_depthToMove_agreesWithQuotePush_onTheRealPool() public {
        int24[3] memory ladder = [int24(50), 200, 1000];
        for (uint256 i; i < ladder.length; i++) {
            PushCostLens.PushQuote memory q = lens.quotePush(key, ladder[i], true);
            (uint256 amountIn,,, bool complete) = lens.depthToMove(key, ladder[i], true, 256);
            assertTrue(complete);
            assertApproxEqRel(amountIn, q.amountIn, 0.002e18);
            console2.log("push up ticks / USDG needed / round-trip cost", uint256(int256(ladder[i])), q.amountIn, q.cost);
        }
    }
}
