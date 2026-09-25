// Rebuild a v4 pool at any past block from its own logs: positions from ModifyLiquidity, the price and the
// pool's reported liquidity from the last Swap at or before the block. The public RPC keeps logs but not old
// state, so this is how a past weekend is priced. The walk is v4math.ts, pinned to PushCostLens.depthToMove.
import { getLogsChunked, mainnet, POOL_MANAGER, withRetry } from "./chain.ts";
import { poolManagerEvents } from "./abi.ts";
import { poolStateFromPositions, roundTripCost, type PoolState, type Position } from "./v4math.ts";

export interface RawLog { blockNumber: string; logIndex: number; transactionHash: string; args: Record<string, string> }
type Client = ReturnType<typeof mainnet>;

export const byOrder = (a: RawLog, b: RawLog) =>
  BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.logIndex - b.logIndex;

/** Fold ModifyLiquidity logs up to and including `block` into live positions. */
export function positionsAt(logs: RawLog[], block: bigint): Position[] {
  return positionsBefore(logs, block + 1n, 0);
}

/** Positions as they stood just before log (`block`, `logIndex`): everything earlier in log order. */
export function positionsBefore(logs: RawLog[], block: bigint, logIndex: number): Position[] {
  const map = new Map<string, Position>();
  for (const l of [...logs].sort(byOrder)) {
    const b = BigInt(l.blockNumber);
    if (b > block || (b === block && l.logIndex >= logIndex)) break;
    const key = `${l.args.sender}|${l.args.tickLower}|${l.args.tickUpper}|${l.args.salt}`;
    const p = map.get(key) ?? { tickLower: Number(l.args.tickLower), tickUpper: Number(l.args.tickUpper), liquidity: 0n };
    p.liquidity += BigInt(l.args.liquidityDelta);
    map.set(key, p);
  }
  return [...map.values()].filter((p) => p.liquidity > 0n);
}

/** Every ModifyLiquidity of `poolId` from `fromBlock` to `toBlock`. One topic-filtered query when it fits. */
export async function modifyLiquidityLogs(client: Client, poolId: `0x${string}`, fromBlock: bigint, toBlock: bigint, cacheFile: string) {
  return (await getLogsChunked(
    client,
    { address: POOL_MANAGER, event: poolManagerEvents.ModifyLiquidity, args: { id: poolId } },
    fromBlock,
    toBlock,
    cacheFile,
    { window: toBlock - fromBlock + 1n },
  )) as RawLog[];
}

/** The last Swap of `poolId` at or before `block`, searching back in widening windows. */
export async function lastSwapBefore(client: Client, poolId: `0x${string}`, block: bigint, cacheDir: string): Promise<RawLog | undefined> {
  let span = 20_000n;
  let to = block;
  for (let i = 0; i < 8; i++) {
    const from = to - span + 1n > 0n ? to - span + 1n : 0n;
    const logs = (await getLogsChunked(
      client,
      { address: POOL_MANAGER, event: poolManagerEvents.Swap, args: { id: poolId } },
      from,
      to,
      `${cacheDir}swaps-${poolId.slice(0, 10)}-${from}-${to}.json`,
      { window: to - from + 1n },
    )) as RawLog[];
    const before = logs.filter((l) => BigInt(l.blockNumber) <= block).sort(byOrder);
    if (before.length) return before[before.length - 1];
    to = from - 1n;
    span *= 4n;
    if (to <= 0n) break;
  }
  return undefined;
}

/** The pool at `block`, and whether the rebuild agrees with the chain's own liquidity at the last swap. */
export function rebuild(mods: RawLog[], swap: RawLog, block: bigint): { state: PoolState; positions: Position[]; liquidityMatches: boolean } {
  const sqrtP = BigInt(swap.args.sqrtPriceX96);
  const positions = positionsAt(mods, block);
  const state = poolStateFromPositions(positions, sqrtP);
  const atSwap = poolStateFromPositions(positionsBefore(mods, BigInt(swap.blockNumber), swap.logIndex), sqrtP);
  return { state, positions, liquidityMatches: atSwap.liquidity === BigInt(swap.args.liquidity) };
}

/**
 * Round-trip cost, in the quote currency's raw units, of moving the *stock* price by `ticks` in USDG terms.
 * stockUp: the stock gets dearer. With USDG as currency0 that is the v4 price going down.
 */
export function pushCostInQuote(state: PoolState, ticks: number, stockUp: boolean, quoteIsCurrency0: boolean, swapFee: number) {
  const v4Up = quoteIsCurrency0 ? !stockUp : stockUp;
  const r = roundTripCost(state, ticks, v4Up, swapFee, swapFee);
  // pushing the stock up is paid in USDG; pushing it down is paid in the stock: value that at the start price
  const inputIsQuote = stockUp;
  if (inputIsQuote) return { ...r, costQuote: r.cost, capitalQuote: r.amountIn };
  const s = state.sqrtPriceX96;
  const Q96 = 1n << 96n;
  // price = currency1 per currency0 (raw)
  const toQuote = (x: bigint) => (quoteIsCurrency0 ? (x * Q96 / s) * Q96 / s : (x * s / Q96) * s / Q96);
  return { ...r, costQuote: toQuote(r.cost), capitalQuote: toQuote(r.amountIn) };
}

/** First block with timestamp >= `ts` (binary search between two known blocks). */
export async function blockAtOrAfter(client: Client, ts: number, lo = 1n, hi?: bigint): Promise<{ number: bigint; timestamp: number }> {
  if (hi === undefined) hi = await withRetry("head", () => client.getBlockNumber());
  const get = (n: bigint) => withRetry(`block ${n}`, () => client.getBlock({ blockNumber: n }));
  let loB = lo;
  let hiB = hi;
  while (loB < hiB) {
    const mid = (loB + hiB) / 2n;
    const b = await get(mid);
    if (Number(b.timestamp) < ts) loB = mid + 1n;
    else hiB = mid;
  }
  const b = await get(loB);
  return { number: loB, timestamp: Number(b.timestamp) };
}
