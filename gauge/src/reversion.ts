// How fast is a pushed price pulled back? SafeSettle's arbReversionSeconds, measured per pool from the Swap tape
// instead of taken on the caller's word (README § Limitations: "three inputs are trusted").
//
// A push: a block whose swaps move the pool's tick at least `minTicks` from where the previous swap block left it. Two
// thresholds: 10 ticks (0.1 %), and the pool's swap fee in ticks (1 tick ≈ 1 bp), below which pulling a price back earns
// less than the fee. The pull-back: the first later swap block that leaves the tick within 50 % (half) and within 10 %
// (ninety) of the push, from where it started. Censored at an hour, at the end of the window, and at the mint window's
// next change, so a weekday push is never "pulled back" by weekend flow or the other way round.
//
// Nothing here tells a push from a genuine price move: a trade that follows the stock, or an arbitrageur correcting a
// stale price, is not undone, and counts as not pulled back. So the times read slow, which is the safe side for
// SafeSettle (a fast reversion overstates what faking costs), and the recommendation is built on that side: the
// shortest of 10 s, 60 s, 10 min and 1 h within which at least 90 % of fee-width pushes were 90 % undone, over at least
// 10 pushes; otherwise 0, "not measured to be pulled back", which prices the pool as if arbitrage were closed.
//
//   npm run reversion                    (the weekend of 2026-09-19..20, mint closed, and the week after, mint open)
// Reads data/stock-pools.json. Swaps from the public RPC (chunked, cached), exact block timestamps for the push and
// pull-back blocks from the state RPC (squeeze/common.ts). Writes data/reversion.json. Read-only against 4663.
import { readFileSync } from "node:fs";
import { poolManagerEvents } from "./abi.ts";
import { mainnet, POOL_MANAGER, readCache, run, serializeLog, withRetry, writeCache, writeData } from "./chain.ts";
import { mintWindowClosedAt } from "./mint-window.ts";
import { byOrder, type RawLog } from "./replay.ts";
import { blockTimestamps, logsClient } from "./squeeze/common.ts";

type Client = ReturnType<typeof mainnet>;
const cacheDir = new URL("../cache/reversion/", import.meta.url).pathname;

/** Sat 2026-09-19 00:00 UTC (Sat 02:00 Berlin: the mint window closes) to Sat 2026-09-26 00:00 UTC (it closes again). */
export const WINDOW = { start: Date.parse("2026-09-19T00:00:00Z") / 1000, end: Date.parse("2026-09-26T00:00:00Z") / 1000 };
export const CAP_SECONDS = 3600;
export const MIN_TICKS_FLOOR = 10;

export interface SwapBlock { block: number; tick: number }
export interface Push { block: number; from: number; to: number; ticks: number; half?: number; ninety?: number; horizon: number }

/** One entry per swap block: the tick after its last swap. */
export function swapBlocks(swaps: RawLog[]): SwapBlock[] {
  const out: SwapBlock[] = [];
  for (const s of [...swaps].sort(byOrder)) {
    const b = Number(s.blockNumber), tick = Number(s.args.tick);
    // a swap that leaves no liquidity in range ran to a tick limit: its tick is not a price anyone can trade at
    if (BigInt(s.args.liquidity) === 0n) continue;
    if (out.length && out[out.length - 1].block === b) out[out.length - 1].tick = tick;
    else out.push({ block: b, tick });
  }
  return out;
}

/**
 * Pushes of at least `minTicks`, each with the first later swap block that brings the tick back within 50 % and within
 * 10 % of the push, if one comes before `horizonOf(push block)` (a block number). Blocks only: seconds come later.
 */
export function findPushes(tape: SwapBlock[], minTicks: number, horizonOf: (block: number) => number): Push[] {
  const out: Push[] = [];
  for (let i = 1; i < tape.length; i++) {
    const from = tape[i - 1].tick, to = tape[i].tick, d = to - from;
    if (Math.abs(d) < minTicks) continue;
    const p: Push = { block: tape[i].block, from, to, ticks: d, horizon: horizonOf(tape[i].block) };
    for (let j = i + 1; j < tape.length && tape[j].block <= p.horizon; j++) {
      const left = Math.sign(d) * (tape[j].tick - from); // what is left of the push, in ticks, on the push's side
      if (p.half === undefined && left <= 0.5 * Math.abs(d)) p.half = tape[j].block;
      if (left <= 0.1 * Math.abs(d)) {
        p.ninety = tape[j].block;
        break;
      }
    }
    out.push(p);
  }
  return out;
}

/** Quantile of pull-back times with the unreturned ones counted as longer than any measured one (null = "over the cap"). */
export function quantile(times: (number | null)[], q: number): number | null {
  const sorted = [...times].sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b));
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

export const HORIZONS = [10, 60, 600, 3600] as const;

export function summarize(times: (number | null)[]) {
  const n = times.length;
  const within = (s: number) => (n ? times.filter((t) => t !== null && t <= s).length / n : null);
  const undone = times.filter((t): t is number => t !== null);
  return {
    n,
    p50: quantile(times, 0.5),
    p90: quantile(times, 0.9),
    within10s: within(10), within60s: within(60), within600s: within(600), within3600s: within(3600),
    /** among the pushes undone within the cap: how long they took (the fast part, arbitrage at work) */
    undoneP50: quantile(undone, 0.5),
  };
}

/** SafeSettle's input from the fee-width pushes' 90 %-undone times: see the header. */
export function recommend(ninety: (number | null)[], minPushes = 10): { arbReversionSeconds: number; why: string } {
  if (ninety.length < minPushes) return { arbReversionSeconds: 0, why: `${ninety.length} fee-width pushes in the window, fewer than ${minPushes}: not measured, pass 0` };
  for (const h of HORIZONS) {
    const share = ninety.filter((t) => t !== null && t <= h).length / ninety.length;
    if (share >= 0.9) return { arbReversionSeconds: h, why: `${Math.round(share * 100)} % of ${ninety.length} fee-width pushes were 90 % undone within ${h} s` };
  }
  const share = ninety.filter((t) => t !== null).length / ninety.length;
  return { arbReversionSeconds: 0, why: `only ${Math.round(share * 100)} % of ${ninety.length} fee-width pushes were 90 % undone within an hour: pass 0` };
}

/**
 * Every Swap of one pool in [from, to], from the public RPC (private endpoints cap the block range), in 600k-block chunks;
 * a chunk it refuses (10,000-log cap, timeout) is halved at once.
 */
export async function swapLogs(poolId: `0x${string}`, from: bigint, to: bigint, cacheFile: string): Promise<RawLog[]> {
  const cached = readCache(cacheFile) as RawLog[] | undefined;
  if (cached) return cached;
  const client = logsClient();
  const out: RawLog[] = [];
  const range = async (a: bigint, b: bigint, depth: number): Promise<void> => {
    let logs: any[];
    try {
      logs = await client.getLogs({ address: POOL_MANAGER, event: poolManagerEvents.Swap, args: { id: poolId }, fromBlock: a, toBlock: b });
    } catch (e: any) {
      const msg = String(e?.details ?? e?.shortMessage ?? e);
      if (/exceed|timed out|too many|429/i.test(msg) && b > a && depth < 24) {
        const mid = a + (b - a) / 2n;
        await range(a, mid, depth + 1);
        await range(mid + 1n, b, depth + 1);
        return;
      }
      logs = await withRetry(`Swap ${a}-${b}`, () => client.getLogs({ address: POOL_MANAGER, event: poolManagerEvents.Swap, args: { id: poolId }, fromBlock: a, toBlock: b }));
    }
    for (const l of logs) out.push(serializeLog(l) as RawLog);
  };
  for (let a = from; a <= to; a += 600_000n) await range(a, a + 599_999n > to ? to : a + 599_999n, 0);
  out.sort(byOrder);
  writeCache(cacheFile, out);
  return out;
}

async function firstBlockAtOrAfter(client: Client, ts: number, lo: bigint, hi: bigint) {
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await withRetry(`block ${mid}`, () => client.getBlock({ blockNumber: mid }));
    if (Number(b.timestamp) >= ts) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

export async function main() {
  const client = mainnet();
  const pools = JSON.parse(readFileSync(new URL("../data/stock-pools.json", import.meta.url), "utf8")).pools as any[];
  const pinFile = `${cacheDir}window.json`;
  let pin = readCache(pinFile) as { start: string; end: string } | undefined;
  if (!pin) {
    const head = await client.getBlockNumber();
    const start = await firstBlockAtOrAfter(client, WINDOW.start, 60_000_000n, head);
    const end = (await firstBlockAtOrAfter(client, WINDOW.end, start, head)) - 1n;
    pin = { start: start.toString(), end: end.toString() };
    writeCache(pinFile, pin);
  }
  const [startBlock, endBlock] = [BigInt(pin.start), BigInt(pin.end)];
  console.log(`window ${new Date(WINDOW.start * 1000).toISOString()} → ${new Date(WINDOW.end * 1000).toISOString()}: blocks ${startBlock}–${endBlock}`);

  // the mint window's two changes inside the window, as blocks: Mon 2026-09-21 00:00 UTC opens it
  const opensTs = Date.parse("2026-09-21T00:00:00Z") / 1000;
  const opens = (readCache(`${cacheDir}opens.json`) as string | undefined) ?? (await firstBlockAtOrAfter(client, opensTs, startBlock, endBlock)).toString();
  writeCache(`${cacheDir}opens.json`, opens);
  const opensBlock = Number(opens);
  const capBlocks = Math.ceil(CAP_SECONDS * 9.89 * 1.05); // a block horizon a little past the cap; seconds are checked exactly below
  const horizonOf = (block: number) => Math.min(block + capBlocks, block < opensBlock ? opensBlock - 1 : Number(endBlock));

  const perPool = [] as any[];
  const allPushes: { pool: string; p: Push }[] = [];
  for (const pool of pools) {
    const swaps = await swapLogs(pool.id, startBlock, endBlock, `${cacheDir}swaps-${pool.id.slice(0, 10)}-${startBlock}-${endBlock}.json`);
    const tape = swapBlocks(swaps);
    const feePips = swaps.length ? Number(swaps[swaps.length - 1].args.fee) : pool.fee;
    const feeTicks = Math.max(MIN_TICKS_FLOOR, Math.round(feePips / 100));
    const small = findPushes(tape, MIN_TICKS_FLOOR, horizonOf);
    const wide = small.filter((p) => Math.abs(p.ticks) >= feeTicks);
    small.forEach((p) => allPushes.push({ pool: pool.id, p }));
    perPool.push({ pool, swaps: swaps.length, swapBlocks: tape.length, feePips, feeTicks, small, wide });
    console.log(pool.symbol.padEnd(6), `${swaps.length} swaps, ${tape.length} swap blocks, ${small.length} pushes of ≥ ${MIN_TICKS_FLOOR} ticks, ${wide.length} of ≥ ${feeTicks} (the fee)`);
  }

  // exact seconds for every push block and every pull-back block
  const need = new Set<number>();
  for (const { p } of allPushes) {
    need.add(p.block);
    if (p.half !== undefined) need.add(p.half);
    if (p.ninety !== undefined) need.add(p.ninety);
  }
  console.log(`${need.size} block timestamps (cached first)`);
  const ts = await blockTimestamps([...need]);
  const t = (b: number) => ts.get(String(b))!;

  const out = perPool.map(({ pool, swaps, swapBlocks: n, feePips, feeTicks, small, wide }) => {
    const timed = (ps: Push[]) =>
      ps.map((p) => {
        const t0 = t(p.block);
        const secs = (b?: number) => (b === undefined ? null : t(b) - t0 <= CAP_SECONDS ? t(b) - t0 : null);
        return { block: p.block, time: new Date(t0 * 1000).toISOString(), mintWindowClosed: mintWindowClosedAt(new Date(t0 * 1000)), ticks: p.ticks, half: secs(p.half), ninety: secs(p.ninety) };
      });
    const regime = (rows: any[], closed: boolean) => {
      const r = rows.filter((x) => x.mintWindowClosed === closed);
      return { half: summarize(r.map((x) => x.half)), ninety: summarize(r.map((x) => x.ninety)) };
    };
    const smallRows = timed(small), wideRows = timed(wide);
    return {
      symbol: pool.symbol, id: pool.id, fee: pool.fee, feePips, feeTicks, swaps, swapBlocks: n,
      pushesOf10Ticks: { open: regime(smallRows, false), closed: regime(smallRows, true) },
      pushesOfFeeWidth: { open: regime(wideRows, false), closed: regime(wideRows, true) },
      recommendation: recommend(wideRows.filter((x) => !x.mintWindowClosed).map((x) => x.ninety)),
      pushes: smallRows,
    };
  });

  const pct = (x: number | null) => (x === null ? "  —" : `${Math.round(x * 100)}%`.padStart(4));
  for (const r of out) {
    const a = r.pushesOf10Ticks.open, w = r.pushesOfFeeWidth.open;
    console.log(r.symbol.padEnd(6), `≥10 ticks, mint open: n=${String(a.half.n).padStart(4)} half back ≤60 s ${pct(a.half.within60s)} ≤1 h ${pct(a.half.within3600s)} | 90% back ≤60 s ${pct(a.ninety.within60s)} ≤1 h ${pct(a.ninety.within3600s)}`, `| fee width (${r.feeTicks}): n=${w.ninety.n}`, `→ arbReversionSeconds ${r.recommendation.arbReversionSeconds}`);
  }
  writeData(new URL("../data/reversion.json", import.meta.url).pathname, {
    generatedAt: new Date().toISOString(),
    window: { start: new Date(WINDOW.start * 1000).toISOString(), end: new Date(WINDOW.end * 1000).toISOString(), startBlock: startBlock.toString(), endBlock: endBlock.toString(), mintOpensBlock: opensBlock },
    method:
      "A push is a swap block that moves the tick at least 10 ticks (pushesOf10Ticks), or at least the pool's swap fee in ticks (pushesOfFeeWidth), from where the previous swap block left it. Its pull-back times are the seconds (exact block timestamps) until the first later swap block leaves the tick within 50 % (half) and within 10 % (ninety) of the push, from where it started; null = not within an hour, before the window ends, or before the mint window changes state. Genuine price moves are not told apart from pushes, so they count as not pulled back: the times read slow, the safe side for SafeSettle. recommendation: the shortest of 10 s, 60 s, 600 s, 3600 s within which at least 90 % of the weekday fee-width pushes (at least 10 of them) were 90 % undone; otherwise 0.",
    capSeconds: CAP_SECONDS,
    pools: out,
  });
  console.log("wrote data/reversion.json");
}

if (import.meta.url === `file://${process.argv[1]}`) run(main);
