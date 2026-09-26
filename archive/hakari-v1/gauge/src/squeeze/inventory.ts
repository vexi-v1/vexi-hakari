// What the three squeeze pools held, minute by minute, and what it cost to move HIMS. The swap tape
// (squeeze/pools-swaps.ts) gives prices; the inventory behind them needs every LP position, so every
// ModifyLiquidity of HIMS/USDG, BONER/HIMS and the main BONER/USDG pool since its Initialize is folded into
// positions keyed by (sender, tickLower, tickUpper, salt), in log order, in one sweep over logs and swaps together.
// The sweep proves itself twice: before every Swap of the tape, the rebuilt in-range liquidity at the swap's tick
// must equal the Swap event's own liquidity (BigInt, exact), and at sampled blocks it must equal StateView on the
// archive node. On the 1-minute grid it then reports each pool's principal and, for HIMS/USDG, HAKARI's round-trip
// cost to push HIMS +-10% (replay.ts pushCostInQuote, the walk gauge/data/hims-replay.json is built with).
// Everything fetched is cached under gauge/cache/squeeze/; a rerun asks the chain for nothing it has seen.
// Writes gauge/cache/squeeze/out/inventory-1m.json. Read-only against 4663.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decodeFunctionResult, encodeFunctionData, formatUnits, type PublicClient } from "viem";
import { POOL_MANAGER, STATE_VIEW, readCache, redact, run, sleep, writeCache } from "../chain.ts";
import { poolManagerEvents, stateViewAbi } from "../abi.ts";
import { ticksForPct } from "../pools.ts";
import { pushCostInQuote } from "../replay.ts";
import { getAmount0Delta, getAmount1Delta, getSqrtPriceAtTick, MAX_TICK, MIN_TICK, poolStateFromPositions, roundTripCost, type Position } from "../v4math.ts";
import { barIndex, checkPoint, GRID, type SwapRow } from "./pools-swaps.ts";
import {
  BONER, HIMS, USDG, POOL_BONER_HIMS, POOL_HIMS_USDG, cacheDir, blockTimestamps, archiveCalls, logsClient, STATE_RPC_IS_PUBLIC, STATE_RPC_LABEL,
  WINDOW_START_TS, WINDOW_END_TS, WINDOW_START_BLOCK, WINDOW_END_BLOCK,
} from "./common.ts";

const outDir = `${cacheDir}out/`;
const TICKS_10 = ticksForPct(10); // 953
const BONER_HIMS_HOOK = "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544";
/** gauge/data/hims-replay.json's five points (hims-replay.ts POINTS; not imported: that module talks to the chain). */
const REPLAY_BLOCKS = [50_265_277, 50_415_299, 50_444_948, 50_490_000, 50_772_447];
/** DeFiPrime's float table (block, HIMS in Uniswap v4 = the PoolManager's whole HIMS balance): context only. */
const FLOAT_TABLE: [number, number][] = [[48_555_213, 12_689.1], [49_125_754, 12_085.3], [49_980_825, 12_424.2], [50_265_277, 11_964.4], [50_415_299, 13_883.2], [50_772_447, 32_086.5]];
/**
 * Earlier research (docs/tokyo2026/research/robinhood-v4/analysis.json, 2026-09-25): block, HIMS principal in
 * HIMS/USDG and in BONER/HIMS, and each pool's active liquidity. Reference values to compare against, not inputs.
 */
const RESEARCH: [number, number, number, string, string][] = [
  [48_555_213, 2556.925823127889, 8730.794838980722, "217882137351768209", "834357870807548451609986"],
  [49_125_754, 2650.3932624086938, 8548.86460885548, "806590805733275543", "839895571475225907228661"],
  [49_980_825, 2395.103433048921, 7992.078036123814, "1330585451084765578", "847314483117187154709902"],
  [50_265_277, 2606.368537679237, 7067.677941033469, "1064940216329620533", "848825550103286204793964"],
  [50_415_299, 66.56223959847755, 12478.332761203392, "1920915748500146", "853493407146939217787941"],
  [50_444_948, 32.42785080409805, 12795.518864703427, "2027577432991291", "853881158714973023757226"],
  [50_452_000, 490.5707529050194, 14568.798716334635, "75422683723868935", "854267305971020210252807"],
  [50_490_000, 2035.6262550466115, 16968.084479009667, "649256272366125911", "855215724213919623370452"],
  [50_772_447, 2566.9324207810437, 18528.589321298463, "972790350893554942", "860134651341518972402252"],
];
/** Research's ModifyLiquidity counts over blocks 48,555,213..50,444,948 (same source). */
const RESEARCH_MOD_COUNTS: Record<string, { adds: number; removes: number; zero: number }> = {
  [POOL_HIMS_USDG]: { adds: 327, removes: 190, zero: 284 },
  [POOL_BONER_HIMS]: { adds: 8872, removes: 0, zero: 8 },
};

// ---- pure pieces (tested in test/squeeze-inventory.test.ts) ----

/** One ModifyLiquidity. ts is -Infinity for blocks before WINDOW_START_BLOCK (they are before the grid). */
export interface Mod { block: number; logIndex: number; ts: number; key: string; tickLower: number; tickUpper: number; delta: bigint }
/** One Swap of the tape: post-swap price, tick, in-range liquidity and fee as the event reports them. */
export interface Swp { block: number; logIndex: number; ts: number; sqrtPriceX96: bigint; tick: number; liquidity: bigint; fee: number }

const sqrtCache = new Map<number, bigint>();
/** TickMath.getSqrtPriceAtTick, memoised: the grid sums ask for the same few hundred ticks millions of times. */
export function sqrtAt(tick: number): bigint {
  let v = sqrtCache.get(tick);
  if (v === undefined) sqrtCache.set(tick, (v = getSqrtPriceAtTick(tick)));
  return v;
}

/** Curve principal of positions at a price: v4math amount0Of / amount1Of summed per position (same rounding). */
export function principal(positions: Iterable<Position>, sqrtPriceX96: bigint): { amount0: bigint; amount1: bigint } {
  let amount0 = 0n, amount1 = 0n;
  for (const p of positions) {
    const lo = sqrtAt(p.tickLower), hi = sqrtAt(p.tickUpper);
    if (sqrtPriceX96 <= lo) amount0 += getAmount0Delta(lo, hi, p.liquidity, false);
    else if (sqrtPriceX96 >= hi) amount1 += getAmount1Delta(lo, hi, p.liquidity, false);
    else {
      amount0 += getAmount0Delta(sqrtPriceX96, hi, p.liquidity, false);
      amount1 += getAmount1Delta(lo, sqrtPriceX96, p.liquidity, false);
    }
  }
  return { amount0, amount1 };
}

/**
 * Live positions plus liquidityNet per tick in a Fenwick tree over a fixed tick set, so the pool's in-range
 * liquidity at any tick (positions with tickLower <= tick < tickUpper) is a prefix sum: O(log n) per query instead
 * of refolding every position for every swap. A position that would go negative means a missing log: it throws.
 */
export class TickBook {
  readonly positions = new Map<string, Position>();
  private readonly ticks: number[];
  private readonly index = new Map<number, number>();
  private readonly tree: bigint[];
  constructor(ticks: Iterable<number>) {
    this.ticks = [...new Set(ticks)].sort((a, b) => a - b);
    this.ticks.forEach((t, i) => this.index.set(t, i + 1));
    this.tree = new Array<bigint>(this.ticks.length + 1).fill(0n);
  }
  private add(tick: number, v: bigint) {
    let i = this.index.get(tick);
    if (i === undefined) throw new Error(`tick ${tick} not in the book`);
    for (; i < this.tree.length; i += i & -i) this.tree[i] += v;
  }
  apply(key: string, tickLower: number, tickUpper: number, delta: bigint) {
    const p = this.positions.get(key) ?? { tickLower, tickUpper, liquidity: 0n };
    p.liquidity += delta;
    if (p.liquidity < 0n) throw new Error(`position ${key} below zero: a ModifyLiquidity log is missing`);
    if (p.liquidity === 0n) this.positions.delete(key);
    else this.positions.set(key, p);
    if (delta !== 0n) { this.add(tickLower, delta); this.add(tickUpper, -delta); }
  }
  activeAt(tick: number): bigint {
    let lo = 0, hi = this.ticks.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.ticks[m] <= tick) lo = m + 1; else hi = m; }
    let s = 0n;
    for (let i = lo; i > 0; i -= i & -i) s += this.tree[i];
    return s;
  }
}

/** The pool as the sweep has it: positions, and price/tick/fee/liquidity of the last Swap applied. */
export interface Live { book: TickBook; version: number; sqrtPriceX96?: bigint; tick?: number; fee?: number; swapLiquidity?: bigint; swapBlock?: number }

export interface Visitor {
  /** Before the swap is applied: s holds every log strictly before it. */
  swap?(r: Swp, s: Live): void;
  /** Before the mod is applied: s.sqrtPriceX96 is the price it was made at. */
  mod?(m: Mod, s: Live): void;
  /** Grid point k: every event with ts <= gridTimes[k] applied, none later. */
  grid?(k: number, s: Live): void;
  /** Block checkpoint: every event with block <= b applied (end-of-block state), none later. */
  block?(b: number, s: Live): void;
}

/** One pass over mods and swaps in (block, logIndex) order, calling the visitor at every event, grid point and checkpoint. */
export function sweep(mods: Mod[], swaps: Swp[], gridTimes: number[], blocks: number[], v: Visitor): Live {
  type Ev = { swap: false; e: Mod } | { swap: true; e: Swp };
  const events: Ev[] = [...mods.map((e) => ({ swap: false as const, e })), ...swaps.map((e) => ({ swap: true as const, e }))];
  events.sort((a, b) => a.e.block - b.e.block || a.e.logIndex - b.e.logIndex);
  const s: Live = { book: new TickBook(mods.flatMap((m) => [m.tickLower, m.tickUpper])), version: 0 };
  const bl = [...new Set(blocks)].sort((a, b) => a - b);
  let k = 0, j = 0, lastTs = -Infinity;
  for (const ev of events) {
    const e = ev.e;
    if (Number.isFinite(e.ts)) { // pre-window mods carry -Infinity: before the grid, whatever their exact time
      if (e.ts < lastTs) throw new Error(`timestamps go backwards at block ${e.block}`);
      lastTs = e.ts;
    }
    while (k < gridTimes.length && gridTimes[k] < e.ts) v.grid?.(k++, s);
    while (j < bl.length && bl[j] < e.block) v.block?.(bl[j++], s);
    if (ev.swap) {
      v.swap?.(ev.e, s);
      Object.assign(s, { sqrtPriceX96: ev.e.sqrtPriceX96, tick: ev.e.tick, fee: ev.e.fee, swapLiquidity: ev.e.liquidity, swapBlock: ev.e.block });
    } else {
      v.mod?.(ev.e, s);
      s.book.apply(ev.e.key, ev.e.tickLower, ev.e.tickUpper, ev.e.delta);
    }
    s.version++;
  }
  while (k < gridTimes.length) v.grid?.(k++, s);
  while (j < bl.length) v.block?.(bl[j++], s);
  return s;
}

/** Signed token amounts a liquidity change moves at a price (positive = LP added to the pool). */
export function modAmounts(m: Pick<Mod, "tickLower" | "tickUpper" | "delta">, sqrtPriceX96: bigint): { amount0: bigint; amount1: bigint } {
  const neg = m.delta < 0n;
  const a = principal([{ tickLower: m.tickLower, tickUpper: m.tickUpper, liquidity: neg ? -m.delta : m.delta }], sqrtPriceX96);
  return neg ? { amount0: -a.amount0, amount1: -a.amount1 } : a;
}

// ---- chain access (cached) ----

interface RawLog { blockNumber: string; logIndex: number; transactionHash: string; args: Record<string, string> }

function ser(l: any): RawLog {
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(l.args ?? {})) args[k] = typeof v === "string" ? v.toLowerCase() : String(v);
  return { blockNumber: l.blockNumber.toString(), logIndex: l.logIndex, transactionHash: l.transactionHash, args };
}

/**
 * getLogs over [from, to] through the public endpoint, one window at a time, appended to `<file>.ndjson` with the
 * next block kept in `<file>.next`: a rerun resumes, a finished range is read from disk and asks nothing. The public
 * RPC refuses a query matching more than 10,000 logs, so the window halves on that (or on repeated errors) and grows
 * back once answers are small.
 */
async function logsResumable(client: PublicClient, event: any, args: Record<string, unknown>, from: bigint, to: bigint, file: string, window = 100_000n): Promise<RawLog[]> {
  const logFile = `${file}.ndjson`, nextFile = `${file}.next`;
  if (!existsSync(nextFile)) { mkdirSync(dirname(logFile), { recursive: true }); writeFileSync(logFile, ""); }
  let a = existsSync(nextFile) ? BigInt(readFileSync(nextFile, "utf8").trim()) : from;
  const name = file.split("/").pop();
  console.log(a > to ? `  ${name}: ${from}..${to} cached` : `  ${name}: fetching ${a}..${to} (${a - from} blocks cached)`);
  let w = window, fails = 0, throttled = 0, calls = 0, got = 0;
  while (a <= to) {
    const b = a + w - 1n > to ? to : a + w - 1n;
    let logs: any[] | undefined, err = "";
    try {
      logs = await client.getLogs({ address: POOL_MANAGER, event, args: args as any, fromBlock: a, toBlock: b });
    } catch (e: any) {
      err = redact(String(e?.details ?? e?.shortMessage ?? e?.message ?? e)).slice(0, 160);
    }
    if (!logs) {
      // 429 is the endpoint throttling (other collectors share it): wait it out, the window is not the problem
      if (/429|too many requests|rate limit/i.test(err)) {
        if (++throttled > 12) throw new Error(`getLogs ${a}-${b}: still throttled after 12 waits: ${err}`);
        console.log(`  ${a}-${b}: throttled, waiting ${10 * throttled} s`);
        await sleep(10_000 * throttled);
        continue;
      }
      const capped = /exceeds limit|limit exceeded/i.test(err);
      if (!capped && ++fails < 3) { await sleep(2000 * fails); continue; }
      if (w <= 10n) throw new Error(`getLogs ${a}-${b}: ${err}`);
      w /= 2n; fails = 0;
      if (!capped) console.log(`  ${a}-${b}: ${err}; window -> ${w}`);
      continue;
    }
    fails = 0; throttled = 0;
    if (logs.length) appendFileSync(logFile, logs.map((l) => JSON.stringify(ser(l))).join("\n") + "\n");
    writeFileSync(nextFile, String(b + 1n));
    got += logs.length;
    if (++calls % 20 === 0) console.log(`  ${name}: at block ${b}, ${got} logs this run, window ${w}`);
    a = b + 1n;
    if (logs.length < 2_500 && w < window) w = w * 2n > window ? window : w * 2n;
    await sleep(800);
  }
  const seen = new Set<string>();
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s) as RawLog).filter((l) => {
    const k = `${l.blockNumber}:${l.logIndex}`;
    if (seen.has(k)) return false; // a window re-fetched after an interrupted run
    seen.add(k);
    return BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to;
  });
}

/**
 * Exact block timestamps. Looked up first in this collector's own copy (timestamps-inventory.json) and in the other
 * collectors' caches (read-only; they may be mid-write, so a failed read is skipped), and only what none has is
 * asked of blockTimestamps() (archive node, which caches in the shared timestamps.json too).
 */
const OWN_TS = `${cacheDir}timestamps-inventory.json`;
async function timestamps(blocks: Iterable<string | number | bigint>): Promise<Map<string, number>> {
  const want = [...new Set([...blocks].map((b) => BigInt(b).toString()))];
  const own = (readCache(OWN_TS) as Record<string, number> | undefined) ?? {};
  let missing = want.filter((b) => own[b] === undefined);
  const before = missing.length;
  for (const f of ["timestamps-swaps.json", "timestamps.json", "timestamps-supply.json"]) {
    if (!missing.length) break;
    let other: Record<string, number> = {};
    try { other = (readCache(`${cacheDir}${f}`) as Record<string, number> | undefined) ?? {}; } catch { continue; }
    for (const b of missing) if (Number.isFinite(other[b])) own[b] = other[b];
    missing = missing.filter((b) => own[b] === undefined);
  }
  console.log(`  timestamps: ${want.length - missing.length}/${want.length} cached${missing.length ? `, ${missing.length} to fetch (${STATE_RPC_LABEL})` : ""}`);
  for (let i = 0; i < missing.length; i += 2_000) {
    const slice = missing.slice(i, i + 2_000);
    for (let attempt = 0; ; attempt++) {
      try {
        for (const [b, t] of await blockTimestamps(slice)) if (Number.isFinite(t)) own[b] = t;
        break;
      } catch (e: any) {
        if (attempt >= 5) throw e;
        await sleep((STATE_RPC_IS_PUBLIC ? 15_000 : 3_000) * (attempt + 1));
      }
    }
    writeCache(OWN_TS, own);
  }
  if (missing.length < before) writeCache(OWN_TS, own); // copied from the other caches: keep our own copy too
  const out = new Map<string, number>();
  for (const b of want) {
    if (!Number.isFinite(own[b])) throw new Error(`no timestamp for block ${b}`);
    out.set(b, own[b]);
  }
  return out;
}

/** StateView slot0 + liquidity of `id` at end of each block, through archiveCalls() (cached per call and block). */
async function stateViewAt(id: string, blocks: number[]) {
  const to = STATE_VIEW.toLowerCase();
  const slot0 = encodeFunctionData({ abi: stateViewAbi, functionName: "getSlot0", args: [id as `0x${string}`] });
  const liq = encodeFunctionData({ abi: stateViewAbi, functionName: "getLiquidity", args: [id as `0x${string}`] });
  const uniq = [...new Set(blocks)];
  const calls = uniq.flatMap((block) => [{ to, data: slot0, block }, { to, data: liq, block }]);
  let cached: Record<string, string> = {};
  try { cached = (readCache(`${cacheDir}archive-calls.json`) as Record<string, string> | undefined) ?? {}; } catch { /* mid-write: count as new */ }
  const fresh = calls.filter((c) => cached[`${c.to}|${c.data.toLowerCase()}|${c.block}`] === undefined).length;
  const res = await archiveCalls(calls);
  const out = new Map<number, { sqrtPriceX96: bigint; tick: number; liquidity: bigint }>();
  uniq.forEach((b, i) => {
    const [sqrtPriceX96, tick] = decodeFunctionResult({ abi: stateViewAbi, functionName: "getSlot0", data: res[2 * i] as `0x${string}` });
    const liquidity = decodeFunctionResult({ abi: stateViewAbi, functionName: "getLiquidity", data: res[2 * i + 1] as `0x${string}` });
    out.set(b, { sqrtPriceX96, tick: Number(tick), liquidity });
  });
  return { state: out, calls: calls.length, fresh };
}

// ---- output helpers ----

/** Arrays of plain values stay on one line: the 4,081-point series would otherwise be 100k lines. */
function writeJson(file: string, value: unknown) {
  const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)
    .replace(/\[\n\s*([^[\]{}]*?)\n\s*\]/g, (_m, body: string) => `[${body.split(/,\n\s*/).join(", ")}]`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text + "\n");
}

const iso = (ts: number) => new Date(ts * 1000).toISOString().replace(".000Z", "Z");
const sig = (x: number | null, d = 10) => (x === null || !Number.isFinite(x) ? null : Number(x.toPrecision(d)));
const units = (x: bigint, d: number) => Number(formatUnits(x, d));
const usdgPerHims = (s: bigint) => { const r = Number(s) / 2 ** 96; return 1e12 / (r * r); };

// ---- main ----

const POOLS = [
  { name: "himsUsdg", dec0: 6, dec1: 18, sym0: "USDG", sym1: "HIMS", c0: USDG, c1: HIMS },
  { name: "bonerHims", dec0: 18, dec1: 18, sym0: "BONER", sym1: "HIMS", c0: BONER, c1: HIMS },
  { name: "bonerUsdg", dec0: 6, dec1: 18, sym0: "USDG", sym1: "BONER", c0: USDG, c1: BONER },
] as const;
type Name = (typeof POOLS)[number]["name"];

export async function main() {
  const pools = readCache(`${outDir}pools.json`) as any;
  const raw = readCache(`${outDir}swaps-raw-main.json`) as any;
  if (!pools || !raw) throw new Error("run squeeze/pools-swaps.ts first (out/pools.json, out/swaps-raw-main.json)");
  const key = Object.fromEntries(POOLS.map((p) => [p.name, pools.main[p.name]])) as Record<Name, any>;
  if (key.himsUsdg.id !== POOL_HIMS_USDG || key.bonerHims.id !== POOL_BONER_HIMS) throw new Error("pools.json main pools are not the known HIMS/USDG and BONER/HIMS");
  for (const p of POOLS) {
    if (raw[p.name].id !== key[p.name].id || key[p.name].currency0 !== p.c0 || key[p.name].currency1 !== p.c1) throw new Error(`${p.name}: pools.json / swaps-raw-main.json disagree`);
  }

  // 1. every ModifyLiquidity of the three pools since the oldest Initialize (one OR-filter on the pool ids)
  const ids = POOLS.map((p) => key[p.name].id as string).sort();
  const from = BigInt(Math.min(...POOLS.map((p) => key[p.name].initBlock as number)));
  const tag = createHash("sha1").update(ids.join(",")).digest("hex").slice(0, 10);
  const logs = await logsResumable(logsClient(), poolManagerEvents.ModifyLiquidity, { id: ids }, from, WINDOW_END_BLOCK, `${cacheDir}modliq-${tag}-${from}.json`);
  console.log(`ModifyLiquidity ${from}..${WINDOW_END_BLOCK}: ${logs.length}`);

  // 2. exact timestamps for the ones inside the window (earlier blocks are before t_0 by WINDOW_START_BLOCK's definition)
  const ts = await timestamps(logs.filter((l) => BigInt(l.blockNumber) >= WINDOW_START_BLOCK).map((l) => l.blockNumber));
  const modsOf = (id: string): (Mod & { sender: string; tx: string })[] => logs.filter((l) => l.args.id === id).map((l) => ({
    block: Number(l.blockNumber), logIndex: l.logIndex, ts: BigInt(l.blockNumber) >= WINDOW_START_BLOCK ? ts.get(l.blockNumber)! : -Infinity,
    key: `${l.args.sender}|${l.args.tickLower}|${l.args.tickUpper}|${l.args.salt}`, tickLower: Number(l.args.tickLower), tickUpper: Number(l.args.tickUpper),
    delta: BigInt(l.args.liquidityDelta), sender: l.args.sender, tx: l.transactionHash,
  }));
  const swapsOf = (name: Name): Swp[] => raw[name].rows.map((r: any[]) => ({
    ts: r[0], block: r[1], logIndex: r[2], sqrtPriceX96: BigInt(r[6]), liquidity: BigInt(r[7]), tick: r[8], fee: r[9],
  }));
  const tapeOf = (name: Name): SwapRow[] => raw[name].rows.map((r: any[]) => ({
    ts: r[0], block: r[1], logIndex: r[2], tx: r[3], sender: "", amount0: BigInt(r[4]), amount1: BigInt(r[5]), sqrtPriceX96: BigInt(r[6]), liquidity: BigInt(r[7]), tick: r[8], fee: r[9],
  }));

  // archive sample: the blocks squeeze/pools-swaps.ts checked the tape at (every 10 min, every minute 21:30Z..02:00Z;
  // the last block before the next swap), so most calls are already cached, plus the replay/research/float blocks
  const t = Array.from({ length: GRID.n }, (_, k) => GRID.start + GRID.step * k);
  const SQUEEZE = [1_788_125_400, 1_788_141_600];
  const sampleTimes = t.filter((x, k) => k % 10 === 0 || (x >= SQUEEZE[0] && x <= SQUEEZE[1]));
  const namedBlocks = [...new Set([...REPLAY_BLOCKS, ...RESEARCH.map((r) => r[0]), ...FLOAT_TABLE.map((f) => f[0])])].sort((a, b) => a - b);
  const researchFrom = 48_555_213, researchTo = 50_444_948;
  const inWindow = (x: number) => x > WINDOW_START_TS && x <= WINDOW_END_TS;

  const series: Record<string, unknown> = {};
  const checks: Record<string, unknown> = {};
  const modCounts: Record<string, unknown> = {};
  const atBlock = new Map<Name, Map<number, { sqrtPriceX96: bigint; tick: number; fee: number; swapBlock: number; active: bigint; live: number; amount0: bigint; amount1: bigint; push?: any }>>();
  const archive: Record<string, unknown> = {};
  let archiveCallsTotal = 0, archiveCallsFresh = 0;

  for (const p of POOLS) {
    const id = key[p.name].id as string;
    const mods = modsOf(id), swaps = swapsOf(p.name), tape = tapeOf(p.name);
    const sampleBlocks = [...new Set(sampleTimes.map((x) => checkPoint(tape, x, Number(WINDOW_END_BLOCK))).filter((c) => c !== undefined).map((c) => c.block))];
    const blocks = [...new Set([...sampleBlocks, ...namedBlocks])];

    const n = GRID.n;
    const a0 = new Array<number | null>(n).fill(null), a1 = new Array<number | null>(n).fill(null), liq = new Array<number | null>(n).fill(null), live = new Array<number>(n).fill(0);
    const adds = new Array<number>(n).fill(0), removes = new Array<number>(n).fill(0), zero = new Array<number>(n).fill(0);
    const lp0 = new Array<number>(n).fill(0), lp1 = new Array<number>(n).fill(0);
    const col = <T,>() => new Array<T | null>(n).fill(null);
    const push = p.name === "himsUsdg" ? { upCost: col<number>(), upCapital: col<number>(), upComplete: col<boolean>(), downCost: col<number>(), downCapital: col<number>(), downComplete: col<boolean>() } : undefined;
    const check = { swaps: 0, match: 0, windowSwaps: 0, windowMatch: 0, mismatches: [] as unknown[], tickOffPrice: 0, onTickBoundary: 0, boundaryWouldMismatchByPriceTick: 0 };
    const counts = { total: mods.length, window: { adds: 0, removes: 0, zero: 0 }, researchRange: { adds: 0, removes: 0, zero: 0 }, bySenderInWindow: new Map<string, number>(), lpNet0Window: 0n, lpNet1Window: 0n };
    const blockState = new Map<number, any>();
    let lastVersion = -1, lastRow: { a0: number; a1: number; liq: number; live: number; push?: any } | undefined;

    const end = sweep(mods, swaps, t, blocks, {
      swap(r, s) {
        const active = s.book.activeAt(r.tick);
        const ok = active === r.liquidity;
        check.swaps++; if (ok) check.match++;
        if (inWindow(r.ts)) { check.windowSwaps++; if (ok) check.windowMatch++; }
        if (!ok && check.mismatches.length < 20) check.mismatches.push({ block: r.block, logIndex: r.logIndex, tick: r.tick, event: r.liquidity.toString(), rebuilt: active.toString() });
        // the event tick is slot0's tick; the price-derived tick differs only when a downward swap stops exactly on a
        // tick it crossed (sqrtPrice = sqrt(tick + 1)): then the pool already excludes ranges starting there
        if (r.tick > MIN_TICK && r.tick < MAX_TICK && !(sqrtAt(r.tick) <= r.sqrtPriceX96 && r.sqrtPriceX96 < sqrtAt(r.tick + 1))) {
          if (r.sqrtPriceX96 === sqrtAt(r.tick + 1)) { check.onTickBoundary++; if (s.book.activeAt(r.tick + 1) !== r.liquidity) check.boundaryWouldMismatchByPriceTick++; }
          else check.tickOffPrice++;
        }
      },
      mod(m, s) {
        const kind = m.delta > 0n ? "adds" : m.delta < 0n ? "removes" : "zero";
        if (m.block >= researchFrom && m.block <= researchTo) counts.researchRange[kind]++;
        if (!inWindow(m.ts)) return;
        counts.window[kind]++;
        counts.bySenderInWindow.set((m as any).sender, (counts.bySenderInWindow.get((m as any).sender) ?? 0) + 1);
        const k = barIndex(m.ts);
        (kind === "adds" ? adds : kind === "removes" ? removes : zero)[k]++;
        if (s.sqrtPriceX96 !== undefined && m.delta !== 0n) {
          const d = modAmounts(m, s.sqrtPriceX96);
          lp0[k] += units(d.amount0, p.dec0); lp1[k] += units(d.amount1, p.dec1);
          counts.lpNet0Window += d.amount0; counts.lpNet1Window += d.amount1;
        }
      },
      grid(k, s) {
        if (s.sqrtPriceX96 === undefined) return;
        if (s.version !== lastVersion) {
          lastVersion = s.version;
          const positions = [...s.book.positions.values()];
          const pr = principal(positions, s.sqrtPriceX96);
          lastRow = { a0: units(pr.amount0, p.dec0), a1: units(pr.amount1, p.dec1), liq: Number(s.book.activeAt(s.tick!)), live: positions.length };
          if (push) {
            // a close that drained the range sits at the tick limit: no quote there, so no push either
            if (s.swapLiquidity === 0n && (s.tick! <= MIN_TICK + 1 || s.tick! >= MAX_TICK - 1)) lastRow.push = null;
            else {
              const state = poolStateFromPositions(positions, s.sqrtPriceX96);
              const up = pushCostInQuote(state, TICKS_10, true, true, s.fee!);
              const down = pushCostInQuote(state, TICKS_10, false, true, s.fee!);
              lastRow.push = { upCost: units(up.costQuote, 6), upCapital: units(up.capitalQuote, 6), upComplete: up.complete, downCost: units(down.costQuote, 6), downCapital: units(down.capitalQuote, 6), downComplete: down.complete };
            }
          }
        }
        const r = lastRow!;
        a0[k] = sig(r.a0); a1[k] = sig(r.a1); liq[k] = r.liq; live[k] = r.live;
        if (push && r.push) {
          push.upCost[k] = sig(r.push.upCost); push.upCapital[k] = sig(r.push.upCapital); push.upComplete[k] = r.push.upComplete;
          push.downCost[k] = sig(r.push.downCost); push.downCapital[k] = sig(r.push.downCapital); push.downComplete[k] = r.push.downComplete;
        }
      },
      block(b, s) {
        if (s.sqrtPriceX96 === undefined) return;
        const positions = [...s.book.positions.values()];
        const pr = principal(positions, s.sqrtPriceX96);
        const row: any = { sqrtPriceX96: s.sqrtPriceX96, tick: s.tick!, fee: s.fee!, swapBlock: s.swapBlock!, active: s.book.activeAt(s.tick!), live: positions.length, amount0: pr.amount0, amount1: pr.amount1 };
        if (p.name === "himsUsdg" && REPLAY_BLOCKS.includes(b)) {
          // exactly hims-replay.ts: state from positions at the price of the last swap at or before the block
          const state = poolStateFromPositions(positions, s.sqrtPriceX96);
          const up = pushCostInQuote(state, TICKS_10, true, true, s.fee!);
          const down = roundTripCost(state, TICKS_10, true, s.fee!, s.fee!);
          const downQ = pushCostInQuote(state, TICKS_10, false, true, s.fee!);
          row.push = { stateLiquidity: state.liquidity, up, down, downCostUsdg: downQ.costQuote };
        }
        blockState.set(b, row);
      },
    });
    atBlock.set(p.name, blockState);

    // every position the sweep left must still be >= 0 (TickBook throws otherwise); record what is live at the end
    const hookMods = p.name === "bonerHims" ? mods.filter((m) => m.sender === BONER_HIMS_HOOK).length : undefined;
    // LP changes made inside a swap's transaction (the BONER/HIMS hook flow) vs standalone LP transactions
    const swapTxs = new Set(tape.map((r) => r.tx));
    const windowMods = mods.filter((m) => inWindow(m.ts));
    const sameTx = windowMods.filter((m) => swapTxs.has(m.tx)).length;
    modCounts[p.name] = {
      poolId: id, fromBlock: String(key[p.name].initBlock), toBlock: WINDOW_END_BLOCK.toString(), sinceInitialize: counts.total,
      beforeWindow: mods.filter((m) => m.block < Number(WINDOW_START_BLOCK)).length,
      inWindow: counts.window, inWindowBySender: Object.fromEntries([...counts.bySenderInWindow].sort((x, y) => y[1] - x[1])),
      ...(hookMods !== undefined ? { sinceInitializeFromHook: hookMods } : {}),
      inWindowInASwapTx: sameTx, inWindowStandalone: windowMods.length - sameTx,
      distinctPositionKeys: new Set(mods.map((m) => m.key)).size, livePositionsAtWindowEnd: end.book.positions.size,
      lpNetInWindow: { [p.sym0]: units(counts.lpNet0Window, p.dec0), [p.sym1]: units(counts.lpNet1Window, p.dec1), note: "principal moved by ModifyLiquidity at the pool price of the moment (positive = added)" },
      researchRange: { blocks: `${researchFrom}..${researchTo}`, ours: counts.researchRange, research: RESEARCH_MOD_COUNTS[id] ?? null },
    };
    checks[p.name] = { ...check, allMatch: check.match === check.swaps };
    series[p.name] = { a0, a1, liq, live, adds, removes, zero, lp0: lp0.map((x) => sig(x)), lp1: lp1.map((x) => sig(x)), push };
    console.log(`${p.name}: ${mods.length} ModifyLiquidity (${counts.window.adds} adds / ${counts.window.removes} removes / ${counts.window.zero} zero in the window), liquidity = Swap event at ${check.match}/${check.swaps} swaps (window ${check.windowMatch}/${check.windowSwaps}); boundary ticks ${check.onTickBoundary}, tick off price ${check.tickOffPrice}`);

    // 7. archive: StateView slot0 + liquidity at end of block vs the rebuild (positions <= block, last swap's tick)
    try {
      const sv = await stateViewAt(id, blocks);
      archiveCallsTotal += sv.calls; archiveCallsFresh += sv.fresh;
      let priceExact = 0, tickExact = 0, liqExact = 0;
      const misses: unknown[] = [];
      for (const b of blocks) {
        const mine = blockState.get(b), st = sv.state.get(b)!;
        if (!mine) continue;
        const pOk = st.sqrtPriceX96 === mine.sqrtPriceX96, tOk = st.tick === mine.tick, lOk = st.liquidity === mine.active;
        priceExact += +pOk; tickExact += +tOk; liqExact += +lOk;
        if ((!pOk || !tOk || !lOk) && misses.length < 20) misses.push({ block: b, archiveLiquidity: st.liquidity.toString(), rebuiltLiquidity: mine.active.toString(), archiveSqrtPriceX96: st.sqrtPriceX96.toString(), rebuiltSqrtPriceX96: mine.sqrtPriceX96.toString(), archiveTick: st.tick, rebuiltTick: mine.tick });
      }
      const checked = blocks.filter((b) => blockState.has(b)).length;
      const squeezeBlocks = sampleBlocks.length; // includes every minute 21:30Z..02:00Z
      archive[p.name] = { poolId: id, blocksChecked: checked, sampleBlocks: squeezeBlocks, namedBlocks: namedBlocks.length, sqrtPriceExact: priceExact, tickExact, liquidityExact: liqExact, allMatch: priceExact === checked && tickExact === checked && liqExact === checked, firstMismatches: misses };
      console.log(`  archive ${p.name}: ${checked} blocks, sqrtPrice ${priceExact}, tick ${tickExact}, liquidity ${liqExact} exact`);
    } catch (e: any) {
      archive[p.name] = { available: false, error: redact(String(e?.message ?? e)).slice(0, 200) };
      console.log(`  archive ${p.name} skipped: ${(archive[p.name] as any).error}`);
    }
  }

  // 4. reproduce gauge/data/hims-replay.json and the earlier research
  const replay = readCache(new URL("../../data/hims-replay.json", import.meta.url).pathname) as any;
  const hu = atBlock.get("himsUsdg")!, bh = atBlock.get("bonerHims")!;
  const f6 = (x: bigint) => formatUnits(x, 6), f18 = (x: bigint) => formatUnits(x, 18);
  const replayCheck = REPLAY_BLOCKS.map((b) => {
    const r = hu.get(b)!, rp = replay?.points?.find((x: any) => Number(x.block) === b);
    const ours = {
      lastSwapBlock: String(r.swapBlock), sqrtPriceX96: r.sqrtPriceX96.toString(), swapFeePips: r.fee, livePositions: r.live, activeLiquidity: r.push.stateLiquidity.toString(),
      himsPrincipal: f18(r.amount1), usdgPrincipal: f6(r.amount0),
      pushUp10: { usdgIn: f6(r.push.up.amountIn), himsOut: f18(r.push.up.amountOut), roundTripCostUsdg: f6(r.push.up.cost), complete: r.push.up.complete },
      pushDown10: { himsIn: f18(r.push.down.amountIn), usdgOut: f6(r.push.down.amountOut), roundTripCostHims: f18(r.push.down.cost), complete: r.push.down.complete },
      pushDown10CostUsdg: f6(r.push.downCostUsdg),
    };
    const theirs = rp && {
      lastSwapBlock: rp.lastSwapBlock, sqrtPriceX96: rp.sqrtPriceX96, swapFeePips: rp.swapFeePips, livePositions: rp.livePositions, activeLiquidity: rp.activeLiquidity,
      himsPrincipal: rp.himsPrincipal, usdgPrincipal: rp.usdgPrincipal,
      pushUp10: { usdgIn: rp.pushUp10.usdgIn, himsOut: rp.pushUp10.himsOut, roundTripCostUsdg: rp.pushUp10.roundTripCostUsdg, complete: rp.pushUp10.complete },
      pushDown10: { himsIn: rp.pushDown10.himsIn, usdgOut: rp.pushDown10.usdgOut, roundTripCostHims: rp.pushDown10.roundTripCostHims, complete: rp.pushDown10.complete },
    };
    const diffs: string[] = [];
    if (theirs) {
      const cmp = (a: any, b: any, path: string) => { for (const k of Object.keys(b)) typeof b[k] === "object" ? cmp(a[k], b[k], `${path}${k}.`) : String(a[k]) !== String(b[k]) && diffs.push(`${path}${k}: ours ${a[k]} vs replay ${b[k]}`); };
      cmp(ours, theirs, "");
    }
    return { block: b, ours, identical: theirs ? diffs.length === 0 : null, diffs };
  });
  const himsModsToReplayEnd = modsOf(key.himsUsdg.id).filter((m) => m.block <= 50_772_447).length;
  const researchCheck = RESEARCH.map(([b, huHims, bhHims, huL, bhL]) => {
    const x = hu.get(b)!, y = bh.get(b)!;
    return {
      block: b,
      himsUsdg: { himsPrincipal: sig(units(x.amount1, 18), 12), research: huHims, absDiff: sig(units(x.amount1, 18) - huHims, 4), activeLiquidity: x.active.toString(), researchActiveLiquidity: huL, activeLiquidityEqual: x.active.toString() === huL },
      bonerHims: { himsPrincipal: sig(units(y.amount1, 18), 12), research: bhHims, absDiff: sig(units(y.amount1, 18) - bhHims, 4), activeLiquidity: y.active.toString(), researchActiveLiquidity: bhL, activeLiquidityEqual: y.active.toString() === bhL },
    };
  });
  const floatContext = FLOAT_TABLE.map(([b, v4]) => {
    const inMain = units(hu.get(b)!.amount1, 18) + units(bh.get(b)!.amount1, 18);
    return { block: b, himsPrincipalHimsUsdg: sig(units(hu.get(b)!.amount1, 18)), himsPrincipalBonerHims: sig(units(bh.get(b)!.amount1, 18)), sumMainPools: sig(inMain), defiprimeHimsInV4: v4, shareOfV4: sig(inMain / v4, 4) };
  });

  // 5. the grid file
  const S = series as Record<Name, any>;
  const pu = S.himsUsdg.push;
  const incomplete = (a: (boolean | null)[]) => a.map((c, k) => (c === false ? k : -1)).filter((k) => k >= 0);
  const out = {
    meta: {
      grid: { start: GRID.start, end: WINDOW_END_TS, step: GRID.step, n: GRID.n, startIso: iso(GRID.start), endIso: iso(WINDOW_END_TS) },
      conventions: {
        state: "at t_k: every ModifyLiquidity and Swap with block timestamp <= t_k applied (carry-forward); price = the last Swap's sqrtPriceX96, tick = that Swap's tick (slot0)",
        principal: "sum over live positions of v4math amount0Of / amount1Of at the close price, whole tokens; curve principal only (no uncollected fees)",
        liquidity: "in-range liquidity rebuilt from positions at the close tick (= StateView getLiquidity), as a float; includes LP changes after the last swap",
        push: "HIMS/USDG only. replay.ts pushCostInQuote(state, ticksForPct(10) = 953, stockUp, quoteIsCurrency0 = true, fee = the last Swap's fee pips), state = poolStateFromPositions(positions, close price), exactly as gauge/data/hims-replay.json. up: HIMS +10% in USDG, cost and capital (USDG in) in USDG. down: HIMS -10%, paid in HIMS, cost and capital converted to USDG at the close price. Round-trip cost = fee on the push + the sell-back fee valued at the start price. complete false = the walk ran out of initialized ticks before the target",
        bars: "adds/removes/zero and lp flows count ModifyLiquidity with timestamp in (t_{k-1}, t_k]; 0 at k = 0",
        lpFlows: "token principal moved by the bar's ModifyLiquidity at the price of the moment, whole tokens, positive = LPs added to the pool",
      },
      pools: Object.fromEntries(POOLS.map((p) => [p.name, { id: key[p.name].id, currency0: p.sym0, currency1: p.sym1, fee: key[p.name].fee, tickSpacing: key[p.name].tickSpacing, hooks: key[p.name].hooks, initBlock: key[p.name].initBlock }])),
      sources: { swaps: "out/swaps-raw-main.json (squeeze/pools-swaps.ts)", modifyLiquidity: `cache/squeeze/modliq-${tag}-${from}.json.ndjson (public RPC getLogs, all three pools, blocks ${from}..${WINDOW_END_BLOCK})`, archive: STATE_RPC_LABEL },
      generatedAt: new Date().toISOString(),
    },
    t,
    himsInHimsUsdg: S.himsUsdg.a1, usdgInHimsUsdg: S.himsUsdg.a0,
    himsInBonerHims: S.bonerHims.a1, bonerInBonerHims: S.bonerHims.a0,
    usdgInBonerUsdg: S.bonerUsdg.a0, bonerInBonerUsdg: S.bonerUsdg.a1,
    liqHimsUsdg: S.himsUsdg.liq, liqBonerHims: S.bonerHims.liq, liqBonerUsdg: S.bonerUsdg.liq,
    livePositions: { himsUsdg: S.himsUsdg.live, bonerHims: S.bonerHims.live, bonerUsdg: S.bonerUsdg.live },
    pushUp10CostUsdg: pu.upCost, pushUp10CapitalUsdg: pu.upCapital, pushUp10Complete: pu.upComplete,
    pushDown10CostUsdg: pu.downCost, pushDown10CapitalUsdg: pu.downCapital, pushDown10Complete: pu.downComplete,
    lpBars: Object.fromEntries(POOLS.map((p) => [p.name, { adds: S[p.name].adds, removes: S[p.name].removes, zero: S[p.name].zero, [`net${p.sym0}`]: S[p.name].lp0, [`net${p.sym1}`]: S[p.name].lp1 }])),
    liquidityCheck: checks,
    modifyLiquidity: { ...modCounts, himsUsdgUpToReplayEnd: { toBlock: 50_772_447, ours: himsModsToReplayEnd, replay: replay?.modifyLiquidityLogs ?? null } },
    pushIncomplete: { up10: incomplete(pu.upComplete), down10: incomplete(pu.downComplete), noQuote: pu.upCost.map((c: number | null, k: number) => (c === null ? k : -1)).filter((k: number) => k >= 0) },
    replayCheck,
    researchCheck,
    floatTableContext: { note: "DeFiPrime's 'HIMS in Uniswap v4' is the PoolManager's whole HIMS balance (every pool, fees, claims); the two main pools' curve principal is part of it", rows: floatContext },
    archiveCheck: { rpc: STATE_RPC_LABEL, calls: archiveCallsTotal, newCalls: archiveCallsFresh, method: "StateView getSlot0 + getLiquidity at end of block vs the rebuild (positions <= block, last swap <= block)", sampling: "blocks squeeze/pools-swaps.ts checked (grid every 10 min, every minute 2026-08-30T21:30Z..2026-08-31T02:00Z; last block before the next swap) plus the hims-replay, research and DeFiPrime float-table blocks", pools: archive },
  };
  writeJson(`${outDir}inventory-1m.json`, out);

  // console summary
  const minHims = S.himsUsdg.a1.reduce((m: any, v: number | null, k: number) => (v !== null && (m === null || v < m.v) ? { k, v } : m), null);
  const upCosts = pu.upCost as (number | null)[];
  const minUp = upCosts.reduce<any>((m, v, k) => (v !== null && (m === null || v < m.v) ? { k, v } : m), null);
  const maxUp = upCosts.reduce<any>((m, v, k) => (v !== null && (m === null || v > m.v) ? { k, v } : m), null);
  console.log(`HIMS in HIMS/USDG min ${minHims.v} at ${iso(t[minHims.k])}; push +10% cost min ${minUp.v} USDG at ${iso(t[minUp.k])}, max ${maxUp.v} at ${iso(t[maxUp.k])}; incomplete up ${out.pushIncomplete.up10.length} down ${out.pushIncomplete.down10.length}`);
  for (const r of replayCheck) console.log(`  replay ${r.block}: ${r.identical ? "identical" : `DIFF ${r.diffs.join("; ")}`}`);
  for (const r of researchCheck) console.log(`  research ${r.block}: HIMS/USDG ${r.himsUsdg.himsPrincipal} vs ${r.himsUsdg.research} (L ${r.himsUsdg.activeLiquidityEqual}), BONER/HIMS ${r.bonerHims.himsPrincipal} vs ${r.bonerHims.research} (L ${r.bonerHims.activeLiquidityEqual})`);
  console.log(`  HIMS/USDG mods <= 50772447: ${himsModsToReplayEnd} (replay ${replay?.modifyLiquidityLogs}); archive calls ${archiveCallsTotal}, new ${archiveCallsFresh}`);
  console.log(`wrote ${outDir}inventory-1m.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) run(main);
