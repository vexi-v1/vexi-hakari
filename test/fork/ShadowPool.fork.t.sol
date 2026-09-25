// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HakariOracleHook} from "../../src/HakariOracleHook.sol";
import {PushCostLens} from "../../src/PushCostLens.sol";
import {SafeSettle} from "../../src/SafeSettle.sol";
import {TickBitmapView} from "../../src/libraries/TickBitmapView.sol";
import {DecisionLog} from "../utils/DecisionLog.sol";

/// @notice SPEC.md § 3.2's shadow pool: on a fork of Robinhood Chain 4663, a new pool on the *official*
///         PoolManager with HakariOracleHook attached, seeded with the exact liquidity profile of the real
///         TSLA/USDG pool (read tick by tick through the bitmap). Then the sustained-push attack and
///         SafeSettle's decision, in USDG, on a TSLA-shaped book. Run: forge test --match-contract ShadowPool -vv
contract ShadowPoolForkTest is DecisionLog {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    int24 constant SPACING = 60;
    uint256 constant SEGMENTS_EACH_WAY = 40;
    /// @dev gauge/data/delta.json: p99 tick move per swap block on TSLA/USDG over the last 300k blocks
    int24 constant TSLA_DELTA = 3;
    uint32 constant WINDOW = 10;
    uint32 constant LONG_WINDOW = 1800;

    PoolKey real;
    PoolKey shadow;
    PoolId shadowId;
    HakariOracleHook hook;
    PushCostLens lens;
    SafeSettle settle;
    PoolSwapTest swapRouter;
    PoolModifyLiquidityTest lpRouter;
    uint256 t0;

    function setUp() public {
        string memory rpc = vm.envOr("RH_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) rpc = "https://rpc.mainnet.chain.robinhood.com";
        vm.createSelectFork(rpc);
        if (block.chainid != 4663) {
            // RH_MAINNET_RPC pointed somewhere else (a testnet URL, say): use the public mainnet RPC instead
            rpc = "https://rpc.mainnet.chain.robinhood.com";
            vm.createSelectFork(rpc);
        }
        // fork a little behind the head: the load-balanced public RPC sometimes has no state yet for `latest`
        vm.createSelectFork(rpc, block.number - 60);
        real = PoolKey({currency0: Currency.wrap(TSLA), currency1: Currency.wrap(USDG), fee: 3000, tickSpacing: SPACING, hooks: IHooks(address(0))});

        swapRouter = new PoolSwapTest(MANAGER);
        lpRouter = new PoolModifyLiquidityTest(MANAGER);
        lens = new PushCostLens(MANAGER);
        address hookAddr = address(uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG) ^ (0x7777 << 20));
        deployCodeTo("HakariOracleHook.sol:HakariOracleHook", abi.encode(MANAGER, TSLA_DELTA), hookAddr);
        hook = HakariOracleHook(hookAddr);
        settle = new SafeSettle(hook, lens);

        // two fresh tokens standing in for TSLA (currency0, 18 dec) and USDG (currency1, 6 dec)
        MockERC20 a = new MockERC20("shadow TSLA", "sTSLA", 18);
        MockERC20 b = new MockERC20("shadow USDG", "sUSDG", 6);
        (MockERC20 c0, MockERC20 c1) = address(a) < address(b) ? (a, b) : (b, a);
        for (uint256 i; i < 2; i++) {
            MockERC20 t = i == 0 ? c0 : c1;
            t.mint(address(this), type(uint160).max);
            t.approve(address(swapRouter), type(uint256).max);
            t.approve(address(lpRouter), type(uint256).max);
        }
        shadow = PoolKey({currency0: Currency.wrap(address(c0)), currency1: Currency.wrap(address(c1)), fee: 3000, tickSpacing: SPACING, hooks: IHooks(hookAddr)});
        shadowId = shadow.toId();

        (uint160 sqrtP,,,) = MANAGER.getSlot0(real.toId());
        // the public RPC sometimes answers a fresh fork with empty state; say so instead of failing later
        require(sqrtP != 0, "RPC returned no state for TSLA/USDG: retry");
        MANAGER.initialize(shadow, sqrtP);
        hook.increaseObservationCardinalityNext(64, shadowId);
        _mirrorLiquidity();
        t0 = block.timestamp;
    }

    /// @dev Copy the real pool's liquidity profile: one position per segment between initialized ticks.
    function _mirrorLiquidity() internal {
        PoolId realId = real.toId();
        (, int24 tick,,) = MANAGER.getSlot0(realId);
        uint128 liquidity = MANAGER.getLiquidity(realId);

        // boundaries of the segment holding the current tick
        (int24 lower,) = _boundary(realId, tick, true);
        (int24 upper,) = _boundary(realId, tick, false);
        _seed(lower, upper, liquidity);

        // upward segments
        uint128 l = liquidity;
        int24 from = upper;
        for (uint256 i; i < SEGMENTS_EACH_WAY; i++) {
            (, int128 net) = MANAGER.getTickLiquidity(realId, from);
            l = uint128(int128(l) + net);
            (int24 to, bool found) = _boundary(realId, from, false);
            if (!found) break;
            _seed(from, to, l);
            from = to;
        }
        // downward segments
        l = liquidity;
        int24 hi = lower;
        for (uint256 i; i < SEGMENTS_EACH_WAY; i++) {
            (, int128 net) = MANAGER.getTickLiquidity(realId, hi);
            l = uint128(int128(l) - net);
            (int24 lo, bool found) = _boundary(realId, hi - 1, true);
            if (!found) break;
            _seed(lo, hi, l);
            hi = lo;
        }
    }

    /// @dev Next initialized tick strictly above `tick` (lte=false) or at/below it (lte=true), searching word by word.
    function _boundary(PoolId id, int24 tick, bool lte) internal view returns (int24 next, bool found) {
        int24 t = tick;
        for (uint256 w; w < 64; w++) {
            bool initialized;
            (next, initialized) = TickBitmapView.nextInitializedTickWithinOneWord(MANAGER, id, t, SPACING, lte);
            if (initialized) return (next, true);
            if (next <= TickMath.MIN_TICK || next >= TickMath.MAX_TICK) return (next, false);
            t = lte ? next - 1 : next;
        }
        return (next, false);
    }

    function _seed(int24 lower, int24 upper, uint128 liquidity) internal {
        if (liquidity == 0 || lower >= upper) return;
        lpRouter.modifyLiquidity(shadow, ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: 0}), "");
    }

    function _swapTo(bool zeroForOne, uint160 limit) internal {
        swapRouter.swap(shadow, SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(uint256(type(uint112).max)), sqrtPriceLimitX96: limit}), PoolSwapTest.TestSettings(false, false), "");
    }

    function _poke() internal {
        swapRouter.swap(shadow, SwapParams({zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}), PoolSwapTest.TestSettings(false, false), "");
    }

    function test_shadowPool_hasTheRealPoolsDepth() public {
        int24[3] memory ladder = [int24(100), 488, 953];
        for (uint256 i; i < ladder.length; i++) {
            for (uint256 d; d < 2; d++) {
                bool up = d == 0;
                (uint256 inR, uint256 outR, uint256 feeR,) = lens.depthToMove(real, ladder[i], up, 256);
                (uint256 inS, uint256 outS, uint256 feeS,) = lens.depthToMove(shadow, ladder[i], up, 256);
                // the real pool carries a 500-pip protocol fee the shadow does not; compare the curve amounts
                assertApproxEqRel(inS - feeS, inR - feeR, 0.0005e18, "same net input");
                assertApproxEqRel(outS, outR, 0.0005e18, "same output");
            }
        }
        console2.log("shadow pool mirrors TSLA/USDG at block", block.number);
    }

    function _log(string memory label, SafeSettle.Decision memory d) internal pure {
        console2.log(label);
        console2.log("  max safe exposure, USDG (6 dec)", d.maxSafeExposure);
        console2.log("  binding move (ticks)", d.bindingTicks);
        console2.log("  cost to fake it, USDG (6 dec)", d.bindingCost);
        console2.log("  trusted for 100,000 USDG?", d.trusted);
    }

    /// How much settlement can a TSLA-shaped book carry on a 30-minute TWAP? Nobody pushing back (a fenced weekend)
    /// versus arbitrage that pulls the price back every 12 s or every 60 s.
    function test_tslaShapedBook_maxSafeExposure_weekendVsWeekday() public {
        vm.warp(t0 + LONG_WINDOW + 1);
        _poke();
        uint256 exposure = 100_000e6;
        SafeSettle.Decision memory weekend = settle.settlePrice(shadow, LONG_WINDOW, exposure, false, 0);
        SafeSettle.Decision memory weekday12 = settle.settlePrice(shadow, LONG_WINDOW, exposure, false, 12);
        SafeSettle.Decision memory weekday60 = settle.settlePrice(shadow, LONG_WINDOW, exposure, false, 60);
        console2.log("TSLA/USDG book at block", block.number);
        _log("weekend (nobody pushes back)", weekend);
        _log("weekday, arbitrage every 12 s", weekday12);
        _log("weekday, arbitrage every 60 s", weekday60);
        string memory pool = string(abi.encodePacked("TSLA/USDG book at block ", vm.toString(block.number), ", 30-min TWAP"));
        _record("tsla-shaped-weekend", pool, 0, LONG_WINDOW, exposure, 6, "USDG", weekend);
        _record("tsla-shaped-weekday-12s", pool, 12, LONG_WINDOW, exposure, 6, "USDG", weekday12);
        _record("tsla-shaped-weekday-60s", pool, 60, LONG_WINDOW, exposure, 6, "USDG", weekday60);
        // Gas of one settlement on a real book, storage cold as it would be on-chain (settle() adds an event).
        uint256 gasWeekend = _coldGas(0, exposure);
        uint256 gasWeekday = _coldGas(12, exposure);
        console2.log("gas, settlePrice, weekend (1 rung per move)", gasWeekend);
        console2.log("gas, settlePrice, weekday (3 rungs per move)", gasWeekday);
        assertLt(gasWeekday, 30_000_000, "fits a block");
        // Which side of 100,000 each lands on depends on the live book, so the decisions are logged. The ratios are
        // derivable: a push held 1,800 s at d = x, 2x, 4x (hold 1,800 / 900 / 450 s) pays 1 + ⌈hold / R⌉ round trips,
        // and a longer push never costs less than a shorter one. R = 60 s: at least 9 round trips (the 4x rung),
        // so ≥ 9 × the weekend bound. R = 12 s against 60 s: 39/9, 76/16, 151/31 per rung, so ≥ 4.3×.
        assertGe(weekday60.maxSafeExposure, weekend.maxSafeExposure * 9, "a 30-minute hold against arbitrage pays at least 9 round trips");
        assertGe(weekday12.maxSafeExposure * 9, weekday60.maxSafeExposure * 39, "faster arbitrage: at least 39/9 as many");
    }

    function _coldGas(uint32 reversion, uint256 exposure) internal returns (uint256 used) {
        vm.cool(address(MANAGER));
        vm.cool(address(hook));
        uint256 before = gasleft();
        settle.settlePrice(shadow, LONG_WINDOW, exposure, false, reversion);
        used = before - gasleft();
    }

    /// The weekend attack on the same book: hold +5 % with a dust swap a second. With nobody pushing back the pool is
    /// cheap to move, so 100,000 USDG of settlement is refused.
    function test_heldPushOnTslaShapedBook_weekend_isRefused() public {
        (, int24 honest,,) = MANAGER.getSlot0(shadowId);
        _swapTo(false, TickMath.getSqrtPriceAtTick(honest + 488));
        for (uint256 s = 1; s <= WINDOW; s++) {
            vm.warp(t0 + s);
            _poke();
        }
        vm.warp(t0 + WINDOW + 1);
        SafeSettle.Decision memory d = settle.settlePrice(shadow, WINDOW, 100_000e6, false, 0);
        console2.log("held +5 % for 10 s on a weekend, raw TWAP", d.rawTick);
        console2.log("truncated TWAP", d.truncTick);
        _log("decision", d);
        assertFalse(d.trusted);
        _record("tsla-shaped-weekend-held-push", "TSLA/USDG book, +5 % held 10 s", 0, WINDOW, 100_000e6, 6, "USDG", d);
    }
}
