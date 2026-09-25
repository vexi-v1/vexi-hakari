// Δ calibration (Panoptic's method): from a pool's recent Swap events, the distribution of tick moves
// between consecutive swap blocks; the 99th percentile is the suggested maxAbsTickDelta for a
// HakariOracleHook on a pool like this. Also reported per second, using block timestamps, since the
// oracle writes at most once per second. Writes data/delta.json.
import { getLogsChunked, mainnet, POOL_MANAGER, writeData } from "./chain.ts";
import { poolManagerEvents } from "./abi.ts";
import { POOLS, type PoolInfo } from "./pools.ts";

const LOOKBACK = 300_000n; // blocks; a few hours of Robinhood Chain
const MAX_BLOCK_LOOKUPS = 1500;

interface RawLog { blockNumber: string; logIndex: number; args: Record<string, string> }

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** Per-block last tick, then absolute moves between consecutive swap blocks. Exported for the test. */
export function tickMoves(logs: RawLog[]): { blocks: bigint[]; moves: number[]; lastTickByBlock: Map<bigint, number> } {
  const lastTickByBlock = new Map<bigint, number>();
  const sorted = [...logs].sort((a, b) => (BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.logIndex - b.logIndex));
  for (const l of sorted) lastTickByBlock.set(BigInt(l.blockNumber), Number(l.args.tick));
  const blocks = [...lastTickByBlock.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const moves: number[] = [];
  for (let i = 1; i < blocks.length; i++) moves.push(Math.abs(lastTickByBlock.get(blocks[i])! - lastTickByBlock.get(blocks[i - 1])!));
  return { blocks, moves, lastTickByBlock };
}

async function calibrate(client: ReturnType<typeof mainnet>, p: PoolInfo, head: bigint) {
  const from = head - LOOKBACK;
  const logs = (await getLogsChunked(
    client,
    { address: POOL_MANAGER, event: poolManagerEvents.Swap, args: { id: p.id } },
    from,
    head,
    new URL(`../cache/swaps/${p.id}-${from}-${head}.json`, import.meta.url).pathname,
  )) as RawLog[];
  const { blocks, moves, lastTickByBlock } = tickMoves(logs);
  // timestamps for a capped sample of the swap blocks, so a per-second figure can be given
  const sample = blocks.length > MAX_BLOCK_LOOKUPS ? blocks.slice(blocks.length - MAX_BLOCK_LOOKUPS) : blocks;
  const ts = new Map<bigint, number>();
  for (let i = 0; i < sample.length; i += 20) {
    const batch = sample.slice(i, i + 20);
    const headers = await Promise.all(batch.map((b) => client.getBlock({ blockNumber: b })));
    headers.forEach((h, j) => ts.set(batch[j], Number(h.timestamp)));
  }
  const perSecond: number[] = [];
  for (let i = 1; i < sample.length; i++) {
    const dt = ts.get(sample[i])! - ts.get(sample[i - 1])!;
    const d = Math.abs(lastTickByBlock.get(sample[i])! - lastTickByBlock.get(sample[i - 1])!);
    perSecond.push(dt > 0 ? d / dt : d);
  }
  const sortedMoves = [...moves].sort((a, b) => a - b);
  const sortedPerSec = [...perSecond].sort((a, b) => a - b);
  const result = {
    name: p.name,
    id: p.id,
    fromBlock: from.toString(),
    toBlock: head.toString(),
    swaps: logs.length,
    swapBlocks: blocks.length,
    perSwapBlock: { p50: percentile(sortedMoves, 50), p90: percentile(sortedMoves, 90), p99: percentile(sortedMoves, 99), max: sortedMoves.at(-1) ?? 0 },
    perSecond: { sampled: sample.length, p50: percentile(sortedPerSec, 50), p99: percentile(sortedPerSec, 99), max: sortedPerSec.at(-1) ?? 0 },
    suggestedDelta: Math.max(1, Math.ceil(percentile(sortedMoves, 99))),
  };
  console.log(p.name, "swaps", logs.length, "p99 move/block", result.perSwapBlock.p99, "max", result.perSwapBlock.max, "→ Δ", result.suggestedDelta);
  return result;
}

export async function main() {
  const client = mainnet();
  const head = await client.getBlockNumber();
  const pools = [] as any[];
  for (const p of POOLS) pools.push(await calibrate(client, p, head));
  writeData(new URL("../data/delta.json", import.meta.url).pathname, {
    method: "99th percentile of |tick move| between consecutive swap blocks over the lookback (Panoptic); Δ = that, rounded up",
    lookbackBlocks: LOOKBACK.toString(),
    head: head.toString(),
    generatedAt: new Date().toISOString(),
    pools,
  });
  console.log("wrote data/delta.json");
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
