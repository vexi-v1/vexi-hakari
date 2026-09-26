import { parseAbi, parseAbiItem } from "viem";

export const poolManagerEvents = {
  Initialize: parseAbiItem(
    "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  ),
  ModifyLiquidity: parseAbiItem(
    "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
  ),
  Swap: parseAbiItem(
    "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  ),
};

export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

export const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export const lensAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct PushQuote { uint160 sqrtPriceStart; int24 tickStart; uint160 sqrtPriceTarget; uint160 sqrtPriceReached; int24 tickReached; bool zeroForOne; uint256 amountIn; uint256 amountOut; uint256 amountBackOut; uint256 cost; uint256 costInCurrency0; uint256 costInCurrency1; }",
  "function quotePush(PoolKey key, int24 ticks, bool up) returns (PushQuote)",
  "function quotePushLadder(PoolKey key, int24[] ticks, bool up) returns (PushQuote[])",
  "function depthToMove(PoolKey key, int24 ticks, bool up, uint256 maxSteps) view returns (uint256 amountIn, uint256 amountOut, uint256 feePaid, bool complete)",
  "function roundTripCosts(PoolKey key, int24[] widths, bool up, uint256 maxSteps) view returns (uint256[] costInCurrency0, uint256[] costInCurrency1, bool[] complete)",
]);
