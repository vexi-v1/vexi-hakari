// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console2 } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { SqrtPriceMath } from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import { FullMath } from "@uniswap/v4-core/src/libraries/FullMath.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import { UniswapV4Robinhood } from "../test/helpers/UniswapV4Robinhood.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

interface IPermit2Approve {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IPositionManager {
    function initializePool(PoolKey calldata key, uint160 sqrtPriceX96) external payable returns (int24);
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
}

/// @dev HAKARI's hook (`src/HakariOracleHook.sol` at this repository's root): OpenZeppelin `BaseOracleHook`.
interface IHakariOracleHook {
    function poolManager() external view returns (address);
    function MAX_ABS_TICK_DELTA() external view returns (int24);
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext, PoolId underlyingPoolId) external;
    function stateById(PoolId id) external view returns (uint16 index, uint16 cardinality, uint16 cardinalityNext);
}

/// @notice Robinhood Chain **testnet 46630**: an AAPL/USDG Uniswap v4 pool **with HAKARI's oracle hook**, full-range
///         liquidity in it through PositionManager and Permit2, room in the hook for more observations, and a small
///         swap each way to switch that room on. The pool in `deployments/46630-hooked-pool.json` was made with these
///         steps (2026-09-27 01:53 JST); `script/DeployBand.s.sol` then puts the band and the settlement source over it.
///
///         The hook (`0x3b58…D080`) is HAKARI's deployment; any pool may name it. A pool is its key, so this is a new
///         pool beside any hookless AAPL/USDG pool. It is the operator's own stand-in on a testnet, not an
///         independent market. If the pool already exists, the script only adds liquidity and room.
///
///         Run without `--broadcast` to simulate. Environment (all optional except the key):
///           BAND_DEPLOYER_KEY             the operator (read from the environment, never from argv); must be allowed
///                                         to mint the testnet AAPL and USDG
///           UNISWAP_PRICE_WAD             the pool's opening price, WAD USDG per AAPL (default 624e18)
///           UNISWAP_LIQUIDITY_AAPL        AAPL on the pool's AAPL side, WAD (default 100 AAPL)
///           OBSERVATION_CARDINALITY       observations the hook keeps for the pool (default 128)
///           SWAP_ROUTER                   a v4-core PoolSwapTest (default: the one on 46630; 0 deploys one)
///         With `--broadcast` it writes deployments/46630-hooked-pool-rerun.json; a simulation writes nothing.
contract HookedPool is Script, UniswapV4Robinhood {
    using StateLibrary for IPoolManager;

    address internal constant AAPL = 0xEC654A00FBf55334f70B867bbbB2502406deba6B; // 18 decimals
    address internal constant USDG = 0xf46f82B1d1c341e6680798fE0a52285004112351; // 6 decimals
    address internal constant HOOK = 0x3b58D774cE351227B24A91103b20bA4fc068D080; // HakariOracleHook, Δ = 250
    address internal constant SWAP_ROUTER_46630 = 0xa5E02eAB263f7ceAE8259651138c158e15062f66;
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant SETTLE_PAIR = 0x0d;
    string internal constant OUT = "deployments/46630-hooked-pool-rerun.json";

    IPoolManager internal constant manager = IPoolManager(V4_POOL_MANAGER);
    IPositionManager internal constant posm = IPositionManager(V4_POSITION_MANAGER);

    struct Plan {
        PoolKey key;
        uint160 sqrtPriceX96;
        bool initialise;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 amount0Max;
        uint256 amount1Max;
    }

    function run() external {
        require(block.chainid == 46_630, "Robinhood Chain testnet 46630 only");
        require(V4_POOL_MANAGER.code.length > 0 && V4_POSITION_MANAGER.code.length > 0, "no v4 here");
        require(HOOK.code.length > 0, "no HAKARI hook here");
        require(IHakariOracleHook(HOOK).poolManager() == V4_POOL_MANAGER, "the hook serves another PoolManager");
        uint256 operatorKey = vm.envUint("BAND_DEPLOYER_KEY");
        address operator = vm.addr(operatorKey);
        uint256 priceWad = vm.envOr("UNISWAP_PRICE_WAD", uint256(624e18));
        uint256 aaplAmount = vm.envOr("UNISWAP_LIQUIDITY_AAPL", uint256(100e18));
        uint16 cardinality = uint16(vm.envOr("OBSERVATION_CARDINALITY", uint256(128)));
        address swapRouter = vm.envOr("SWAP_ROUTER", SWAP_ROUTER_46630);
        if (swapRouter != address(0)) {
            require(address(PoolSwapTest(swapRouter).manager()) == V4_POOL_MANAGER, "swap router of another manager");
        }

        Plan memory p = _plan(priceWad, aaplAmount);
        PoolId id = p.key.toId();
        console2.log("operator", operator);
        console2.log("pool id (AAPL/USDG, 0.30 %, spacing 60, HAKARI hook)");
        console2.logBytes32(PoolId.unwrap(id));
        console2.log(p.initialise ? "initialise at sqrtPriceX96" : "already initialised, at", p.sqrtPriceX96);

        uint256 tokenId = posm.nextTokenId();
        vm.startBroadcast(operatorKey);
        if (p.initialise) posm.initializePool(p.key, p.sqrtPriceX96);
        _mintAndApprove(AAPL, operator, p.amount0Max + 1e18);
        _mintAndApprove(USDG, operator, p.amount1Max + 1000e6);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            p.key, p.tickLower, p.tickUpper, uint256(p.liquidity), p.amount0Max, p.amount1Max, operator, bytes("")
        );
        params[1] = abi.encode(p.key.currency0, p.key.currency1);
        posm.modifyLiquidities(abi.encode(abi.encodePacked(MINT_POSITION, SETTLE_PAIR), params), block.timestamp + 600);
        // Room for `cardinality` observations (one per second that has a swap; a one-hour band pauses if an hour
        // holds more), then one swap each way: the first write after `increaseObservationCardinalityNext` is what
        // switches the room on.
        IHakariOracleHook(HOOK).increaseObservationCardinalityNext(cardinality, id);
        if (swapRouter == address(0)) swapRouter = address(new PoolSwapTest(manager));
        IERC20(AAPL).approve(swapRouter, type(uint256).max);
        IERC20(USDG).approve(swapRouter, type(uint256).max);
        _swap(PoolSwapTest(swapRouter), p.key, true, 0.01e18); // 0.01 AAPL in
        _swap(PoolSwapTest(swapRouter), p.key, false, 6.24e6); // 6.24 USDG in
        vm.stopBroadcast();

        (uint160 sqrtPriceX96, int24 tick,,) = manager.getSlot0(id);
        (uint16 index, uint16 card, uint16 cardNext) = IHakariOracleHook(HOOK).stateById(id);
        console2.log("pool sqrtPriceX96", sqrtPriceX96);
        console2.log("pool tick", int256(tick));
        console2.log("pool in-range liquidity", uint256(manager.getLiquidity(id)));
        console2.log("hook observations: index / cardinality / next", index, card, cardNext);
        console2.log("position NFT id", tokenId, "owner", operator);
        console2.log("swap router", swapRouter);
        console2.log("a one-hour band over this pool quotes once it has an hour of history");

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory j = "hookedPool";
            vm.serializeUint(j, "chainId", block.chainid);
            vm.serializeAddress(j, "poolManager", V4_POOL_MANAGER);
            vm.serializeAddress(j, "positionManager", V4_POSITION_MANAGER);
            vm.serializeAddress(j, "hakariOracleHook", HOOK);
            vm.serializeBytes32(j, "poolId", PoolId.unwrap(id));
            vm.serializeUint(j, "fee", FEE);
            vm.serializeInt(j, "tickSpacing", TICK_SPACING);
            vm.serializeUint(j, "openingPriceWad", priceWad);
            vm.serializeUint(j, "positionTokenId", tokenId);
            vm.serializeUint(j, "observationCardinalityNext", cardNext);
            vm.serializeUint(j, "poolCreatedAt", block.timestamp);
            vm.writeJson(vm.serializeAddress(j, "swapRouter", swapRouter), OUT);
        }
    }

    function _swap(PoolSwapTest router, PoolKey memory key, bool zeroForOne, uint256 amountIn) internal {
        router.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
    }

    /// @dev AAPL is currency0 (0xEC65… < 0xf46f…). Full-range liquidity worth `aaplAmount` on the AAPL side.
    function _plan(uint256 priceWad, uint256 aaplAmount) internal view returns (Plan memory p) {
        require(AAPL < USDG, "AAPL is currency0");
        p.key = PoolKey({
            currency0: Currency.wrap(AAPL),
            currency1: Currency.wrap(USDG),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(HOOK)
        });
        (uint160 existing,,,) = manager.getSlot0(p.key.toId());
        p.initialise = existing == 0;
        p.sqrtPriceX96 = p.initialise ? uint160(Math.sqrt(FullMath.mulDiv(priceWad, 1 << 192, 1e30))) : existing;
        p.tickLower = TickMath.minUsableTick(TICK_SPACING);
        p.tickUpper = TickMath.maxUsableTick(TICK_SPACING);
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(p.tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(p.tickUpper);
        p.liquidity =
            uint128(FullMath.mulDiv(FullMath.mulDiv(aaplAmount, p.sqrtPriceX96, 1 << 96), sqrtB, sqrtB - p.sqrtPriceX96));
        p.amount0Max = SqrtPriceMath.getAmount0Delta(p.sqrtPriceX96, sqrtB, p.liquidity, true) + 1;
        p.amount1Max = SqrtPriceMath.getAmount1Delta(sqrtA, p.sqrtPriceX96, p.liquidity, true) + 1;
    }

    function _mintAndApprove(address token, address operator, uint256 amount) internal {
        IMintable(token).mint(operator, amount);
        IERC20(token).approve(PERMIT2, type(uint256).max);
        IPermit2Approve(PERMIT2).approve(token, V4_POSITION_MANAGER, type(uint160).max, uint48(block.timestamp + 1 days));
    }
}
