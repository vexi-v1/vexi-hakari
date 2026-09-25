// The float squeeze as a swap tape. DeFiPrime's weekend (2026-08-28..31) is three prices moving against each
// other: HIMS in USDG, BONER in HIMS and BONER in USDG. Every v4 Swap carries the post-swap sqrtPriceX96, so each
// price is rebuilt from Swap logs on a one-minute grid (carry-forward closes, (t-1, t] bars). Pools are found from
// their Initialize logs since HIMS's deployment, and the real BONER/USDG pool is picked by swap volume, because ~80
// spam USDG/BONER pools share the same two tokens. The tape is then checked against archive state (StateView slot0 /
// liquidity) at sampled blocks, and the pool list against every HIMS Transfer into or out of the PoolManager.
// Everything fetched is cached under gauge/cache/squeeze/ and a rerun fetches nothing twice.
// Writes gauge/cache/squeeze/out/{pools,swaps-1m,notable-swaps,swaps-raw-main}.json. Read-only against 4663.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, parseAbiItem, toEventSelector, type PublicClient } from "viem";
import { POOL_MANAGER, STATE_VIEW, readCache, redact, run, sleep, writeCache } from "../chain.ts";
import { poolManagerEvents, stateViewAbi } from "../abi.ts";
import {
  AI_MEME, BONER, HIMS, USDG, POOL_BONER_HIMS, POOL_HIMS_USDG, INIT_BONER_HIMS, INIT_HIMS_USDG, cacheDir, blockTimestamps,
  archiveCalls, logsClient, rpcBatch, STATE_RPC_IS_PUBLIC, STATE_RPC_LABEL, WINDOW_START_TS, WINDOW_END_TS, WINDOW_START_BLOCK, WINDOW_END_BLOCK,
} from "./common.ts";
import { poolManagerTransfers } from "./supply.ts";

/**
 * Initialize logs are searched from HIMS's deployment (code first at block 20,950,062: supply.ts bisects eth_getCode,
 * cache hims-deploy.json; main() checks that neither HIMS nor BONER has code a block earlier) to the window's end.
 * The range is two segments with caches of their own: the first search began at 41.5M, and the earlier segment was
 * added when 19 older HIMS pools turned up (HIMS/ETH, busy in the window, among them). Each segment's Swap cache is
 * keyed by that segment's pool ids, so adding a segment refetches nothing already on disk.
 */
export const DISCOVERY = [
  { name: "HIMS deployment to 41.5M", from: 20_950_062n, to: 41_499_999n, cache: "-early" },
  { name: "41.5M to the window end", from: 41_500_000n, to: WINDOW_END_BLOCK, cache: "" },
] as const;
const LOOKBACK = 200_000n; // ~5.6 h of blocks before the window; extended per pool if no seed swap is in it
const POOL_AI_USDG = "0x508ab5b7a7b447598017eba58530c2a2a5d647b8074a2dc85aa533dfbed4d543";
const POOL_AI_BONER = "0x1f1778596d8c1ee3e1eaf64ea83a5e77063b142fa3ef59a7c81e520c516379bc";
const FIRST_MINT_TX = "0x459aee54624bbef4ccabb6e872ec08414c97cd97bda4f92048cabb011e5a066b";
const ARB_TXS = [
  { tx: "0x885e483376149b0e53f68df7122383a135528d86fa8c3c2f33497dd875ae6b58", block: 50_445_017n, reportedGrossUsdg: 2.712406 },
  { tx: "0x7cad4c90c45c8ff09e1071fbc057cc0b28a455901a9c3b3d9371b1f95b491a42", block: 50_445_018n, reportedGrossUsdg: 5.611365 },
];
const outDir = `${cacheDir}out/`;
const ZERO = "0x0000000000000000000000000000000000000000";
const SYMBOL: Record<string, string> = { [HIMS]: "HIMS", [BONER]: "BONER", [USDG]: "USDG", [AI_MEME]: "AI", [ZERO]: "ETH" };
const DECIMALS: Record<string, number> = { [HIMS]: 18, [BONER]: 18, [USDG]: 6, [AI_MEME]: 18 };

/** The one-minute grid: t_k = start + step * k, k = 0..n-1 (4081 points, Fri 18:00 to Mon 14:00 UTC). */
export const GRID = { start: WINDOW_START_TS, step: 60, n: (WINDOW_END_TS - WINDOW_START_TS) / 60 + 1 };

// ---- pure pieces (tested in test/squeeze-swaps.test.ts) ----

export interface SwapRow { ts: number; block: number; logIndex: number; tx: string; sender: string; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; tick: number; fee: number }

/** v4 raw price: currency1 base units per currency0 base unit. */
export const rawPrice = (sqrtPriceX96: bigint) => { const r = Number(sqrtPriceX96) / 2 ** 96; return r * r; };
/** HIMS/USDG main pool: currency0 = USDG (6 dec), currency1 = HIMS (18 dec). */
export const usdgPerHims = (sqrtPriceX96: bigint) => 1e12 / rawPrice(sqrtPriceX96);
/** BONER/HIMS main pool: currency0 = BONER, currency1 = HIMS, both 18 dec. */
export const himsPerBoner = (sqrtPriceX96: bigint) => rawPrice(sqrtPriceX96);
/** USDG/BONER pools: currency0 = USDG (6 dec, the lower address), currency1 = BONER (18 dec). */
export const usdgPerBoner = (sqrtPriceX96: bigint) => 1e12 / rawPrice(sqrtPriceX96);
export const units = (x: bigint, decimals: number) => Number(formatUnits(x, decimals));

/** Grid index k whose bar (t_{k-1}, t_k] holds ts; k <= 0 means at or before the grid start. */
export const barIndex = (ts: number, start = GRID.start, step = GRID.step) => Math.ceil((ts - start) / step);

export const byTape = (a: { block: number; logIndex: number }, b: { block: number; logIndex: number }) => a.block - b.block || a.logIndex - b.logIndex;

export interface Series { close: (number | null)[]; high: (number | null)[]; low: (number | null)[]; volume: number[]; count: number[]; unpriced: number[]; flow: number[]; liquidity: (bigint | null)[]; fee: (number | null)[]; closeIsQuote: (boolean | null)[] }

/** A swap that leaves no in-range liquidity ran the price to the tick limit: its post-swap price is not a quote. */
export const priced = (r: SwapRow) => r.liquidity > 0n;

/** |num| / |den| in whole tokens; null when either side is under 1,000 base units, where rounding would dominate. */
const perUnit = (num: bigint, numDec: number, den: bigint, denDec: number) => {
  const n = num < 0n ? -num : num, d = den < 0n ? -den : den;
  return n < 1_000n || d < 1_000n ? null : units(n, numDec) / units(d, denDec);
};

/** Per main pool: the post-swap price and the swap's own average price (fee included), in the same unit. */
export interface PoolPrice { unit: string; price: (sqrtPriceX96: bigint) => number; avg: (r: SwapRow) => number | null }
export const PRICE = {
  himsUsdg: { unit: "USDG per HIMS", price: usdgPerHims, avg: (r) => perUnit(r.amount0, 6, r.amount1, 18) },
  bonerHims: { unit: "HIMS per BONER", price: himsPerBoner, avg: (r) => perUnit(r.amount1, 18, r.amount0, 18) },
  bonerUsdg: { unit: "USDG per BONER", price: usdgPerBoner, avg: (r) => perUnit(r.amount0, 6, r.amount1, 18) },
  himsUsdgAlt: { unit: "USDG per HIMS", price: usdgPerHims, avg: (r) => perUnit(r.amount0, 6, r.amount1, 18) },
} as const satisfies Record<string, PoolPrice>;

/**
 * How far a post-swap price may sit from the swap's own average price and still count as a quote. Fee aside, the
 * average lies between the pool prices before and after the swap (their geometric mean through even liquidity), so a
 * 10x gap takes a move of more than 10x in one swap (100x through even liquidity). In this window every swap that
 * stayed in its range is within 1.75x (the 124.70 HIMS/USDG peak); the one past 10x is at 537x.
 */
export const OVERSHOOT = 10;

/**
 * A post-swap price is a quote (it enters high/low and may be a close) when the swap left liquidity in range and the
 * price lies within OVERSHOOT of what the swap itself paid on average. A swap past that ran out of its range and
 * stopped in a far, near-empty position, e.g. BONER/USDG at 2026-08-30T23:19:54Z: 0.026 USDG per BONER paid, 14.1 left.
 */
export function isQuote(r: SwapRow, p: PoolPrice): boolean {
  if (!priced(r)) return false;
  const avg = p.avg(r);
  if (avg === null) return true; // dust: the average is rounding, the price did not move
  const post = p.price(r.sqrtPriceX96);
  return Math.max(post / avg, avg / post) <= OVERSHOOT;
}

/**
 * Fold a pool's swaps onto the grid. close/liquidity/fee at t_k are the state after the last swap with ts <= t_k
 * (carried forward, seeded by any swap before the grid); high/low/volume/count/flow aggregate swaps with ts in
 * (t_{k-1}, t_k], and are null/0 at k = 0. Swaps failing `isPriced` count in volume/count/flow (and in `unpriced`)
 * but not in high/low; closeIsQuote[k] says whether the close's swap passes it (null before the first swap).
 */
export function buildSeries(rows: SwapRow[], grid: { start: number; step: number; n: number }, price: (r: SwapRow) => number, volume: (r: SwapRow) => number, flow: (r: SwapRow) => number, isPriced: (r: SwapRow) => boolean = priced): Series {
  const s: Series = { close: [], high: [], low: [], volume: [], count: [], unpriced: [], flow: [], liquidity: [], fee: [], closeIsQuote: [] };
  const tape = [...rows].sort(byTape);
  let j = 0;
  let last: SwapRow | undefined;
  for (let k = 0; k < grid.n; k++) {
    const t = grid.start + grid.step * k;
    let hi: number | null = null, lo: number | null = null, vol = 0, cnt = 0, un = 0, fl = 0;
    for (; j < tape.length && tape[j].ts <= t; j++) {
      const r = tape[j];
      last = r;
      if (k === 0) continue; // everything up to t_0 only seeds the close
      if (isPriced(r)) {
        const p = price(r);
        hi = hi === null ? p : Math.max(hi, p);
        lo = lo === null ? p : Math.min(lo, p);
      } else un++;
      vol += volume(r);
      fl += flow(r);
      cnt++;
    }
    s.close.push(last ? price(last) : null);
    s.liquidity.push(last ? last.liquidity : null);
    s.fee.push(last ? last.fee : null);
    s.closeIsQuote.push(last ? isPriced(last) : null);
    s.high.push(hi); s.low.push(lo); s.volume.push(vol); s.count.push(cnt); s.unpriced.push(un); s.flow.push(fl);
  }
  return s;
}

/** The last swap at or before `block` (the whole block included), as hims-replay.ts reads "state at a block". */
export function lastAtOrBefore(tape: SwapRow[], block: number): SwapRow | undefined {
  let found: SwapRow | undefined;
  for (const r of tape) { if (r.block > block) break; found = r; }
  return found;
}

/**
 * Where to read archive state to test the tape at grid time t: the last block before the next swap. If the tape
 * missed a swap anywhere between the close's swap and that block, slot0 there differs from the close's swap.
 * Returns undefined before the pool's first swap.
 */
export function checkPoint(tape: SwapRow[], t: number, endBlock: number): { row: SwapRow; block: number } | undefined {
  let i = -1;
  while (i + 1 < tape.length && tape[i + 1].ts <= t) i++;
  if (i < 0) return undefined;
  const next = tape[i + 1];
  return { row: tape[i], block: next ? Math.max(tape[i].block, next.block - 1) : endBlock };
}

// ---- chain access ----

interface RawLog { blockNumber: string; logIndex: number; transactionHash: string; args: Record<string, string> }
interface PoolKeyRow { id: string; currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string; initBlock: number; initTx: string; initTick: number }

function ser(l: any): RawLog {
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(l.args ?? {})) args[k] = typeof v === "string" ? v.toLowerCase() : String(v);
  return { blockNumber: l.blockNumber.toString(), logIndex: l.logIndex, transactionHash: l.transactionHash, args };
}

/**
 * getLogs over [from, to], walking forward one window at a time. The public RPC refuses a query that matches more
 * than 10,000 logs ("logs matched by query exceeds limit"), and the HIMS/BONER pools reach ~900 swaps per 1,000
 * blocks on busy hours, so the window halves on that error (or after repeated failures) and grows back to
 * `window` once responses are small again; a rate limit (429 or the CDN's challenge page) waits instead. Logs are
 * appended to `<file>.ndjson` and progress kept in `<file>.next`, so a rerun resumes where it stopped.
 */
async function logsAdaptive(client: PublicClient, event: any, args: Record<string, unknown>, from: bigint, to: bigint, file: string, window = 100_000n): Promise<RawLog[]> {
  const logFile = `${file}.ndjson`, nextFile = `${file}.next`;
  let a = existsSync(nextFile) ? BigInt(readFileSync(nextFile, "utf8").trim()) : from;
  if (a === from) { mkdirSync(dirname(logFile), { recursive: true }); writeFileSync(logFile, ""); }
  let w = window, fails = 0, waits = 0, calls = 0, got = 0;
  while (a <= to) {
    const b = a + w - 1n > to ? to : a + w - 1n;
    let logs: any[] | undefined, err = "";
    try {
      logs = await client.getLogs({ address: POOL_MANAGER, event, args: args as any, fromBlock: a, toBlock: b });
    } catch (e: any) {
      err = redact(String(e?.details ?? e?.shortMessage ?? e?.message ?? e)).slice(0, 160);
    }
    // a rate limit (HTTP 429, or the CDN's HTML challenge page) says nothing about the range: wait, keep the window
    if (!logs && /\b429\b|too many requests|rate limit|rate exceeds|<!doctype|just a moment/i.test(err)) {
      if (++waits > 8) throw new Error(`getLogs ${a}-${b}: still throttled after ${waits - 1} waits`);
      console.log(`  ${a}-${b}: throttled (${/<!doctype/i.test(err) ? "HTML challenge page" : err.slice(0, 60)}); waiting ${15 * waits} s`);
      await sleep(15_000 * waits);
      continue;
    }
    if (logs) waits = 0;
    if (!logs) {
      const capped = /exceeds limit/i.test(err);
      if (!capped && ++fails < 3) { await sleep(2000 * fails); continue; }
      if (w <= 10n) throw new Error(`getLogs ${a}-${b}: ${err}`);
      w /= 2n; fails = 0;
      if (!capped) console.log(`  ${a}-${b}: ${err}; window -> ${w}`);
      continue;
    }
    fails = 0;
    if (logs.length) appendFileSync(logFile, logs.map((l) => JSON.stringify(ser(l))).join("\n") + "\n");
    writeFileSync(nextFile, String(b + 1n));
    got += logs.length;
    if (++calls % 25 === 0) console.log(`  ${file.split("/").pop()}: at block ${b}, ${got} logs this run, window ${w}`);
    a = b + 1n;
    if (logs.length < 2_500 && w < window) w = w * 2n > window ? window : w * 2n;
    await sleep(800);
  }
  const seen = new Set<string>();
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s) as RawLog).filter((l) => {
    const k = `${l.blockNumber}:${l.logIndex}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to;
  });
}

/**
 * Exact timestamps through blockTimestamps() (archive node, cached in the shared timestamps.json). Other collectors
 * rewrite that shared file too, so a read can land mid-write or lose entries: this collector also keeps its own
 * copy in timestamps-swaps.json, saved after every slice, and asks blockTimestamps() only for blocks missing there.
 */
const OWN_TS = `${cacheDir}timestamps-swaps.json`;
async function timestamps(blocks: Iterable<string | number | bigint>): Promise<Map<string, number>> {
  const want = [...new Set([...blocks].map((b) => BigInt(b).toString()))];
  const own = (readCache(OWN_TS) as Record<string, number> | undefined) ?? {};
  const missing = want.filter((b) => own[b] === undefined);
  if (missing.length) console.log(`  timestamps: ${want.length - missing.length}/${want.length} cached, ${missing.length} to resolve (${STATE_RPC_LABEL})`);
  for (let i = 0; i < missing.length; i += 2_000) {
    const slice = missing.slice(i, i + 2_000);
    for (let attempt = 0; ; attempt++) {
      try {
        for (const [b, t] of await blockTimestamps(slice)) if (Number.isFinite(t)) own[b] = t;
        break;
      } catch (e: any) {
        if (attempt >= 5) throw e;
        const wait = (STATE_RPC_IS_PUBLIC ? 15_000 : 3_000) * (attempt + 1);
        console.log(`  timestamps retry in ${wait / 1000} s: ${redact(String(e?.message ?? e)).slice(0, 100)}`);
        await sleep(wait);
      }
    }
    writeCache(OWN_TS, own);
    if (missing.length > 2_000) console.log(`  timestamps ${Math.min(i + 2_000, missing.length)}/${missing.length}`);
  }
  const out = new Map<string, number>();
  for (const b of want) {
    if (!Number.isFinite(own[b])) throw new Error(`no timestamp for block ${b}`);
    out.set(b, own[b]);
  }
  return out;
}

/** Whether each (address, block) has code, from eth_getCode on the archive node, cached in discovery-code.json. */
async function hasCode(pairs: { address: string; block: bigint }[]): Promise<boolean[]> {
  const file = `${cacheDir}discovery-code.json`;
  const c = (readCache(file) as Record<string, boolean> | undefined) ?? {};
  const key = (p: { address: string; block: bigint }) => `${p.address}|${p.block}`;
  const want = pairs.filter((p) => c[key(p)] === undefined);
  if (want.length) {
    const res = await rpcBatch(want.map((p) => ({ method: "eth_getCode", params: [p.address, `0x${p.block.toString(16)}`] })));
    want.forEach((p, i) => (c[key(p)] = res[i] !== "0x"));
    writeCache(file, c);
  }
  return pairs.map((p) => c[key(p)]);
}

/** Every pool with HIMS or BONER on either side, per DISCOVERY segment (Initialize logs, cached per segment and side). */
async function discoverPools(client: PublicClient) {
  const found = new Map<string, PoolKeyRow>();
  const segments: ((typeof DISCOVERY)[number] & { initializeLogs: Record<string, number>; ids: string[] })[] = [];
  for (const seg of DISCOVERY) {
    const perSide: Record<string, number> = {};
    for (const side of ["currency0", "currency1"] as const) {
      const logs = await logsAdaptive(client, poolManagerEvents.Initialize, { [side]: [HIMS, BONER] }, seg.from, seg.to, `${cacheDir}initialize-${side}${seg.cache}.json`);
      perSide[side] = logs.length;
      for (const l of logs) {
        found.set(l.args.id, {
          id: l.args.id, currency0: l.args.currency0, currency1: l.args.currency1, fee: Number(l.args.fee), tickSpacing: Number(l.args.tickSpacing),
          hooks: l.args.hooks, initBlock: Number(l.blockNumber), initTx: l.transactionHash, initTick: Number(l.args.tick),
        });
      }
    }
    const ids = [...found.values()].filter((p) => BigInt(p.initBlock) >= seg.from && BigInt(p.initBlock) <= seg.to).map((p) => p.id).sort();
    console.log(`Initialize ${seg.from}..${seg.to} (${seg.name}): currency0 in {HIMS, BONER} ${perSide.currency0}, currency1 ${perSide.currency1}, pools ${ids.length}`);
    segments.push({ ...seg, initializeLogs: perSide, ids });
  }
  return { pools: [...found.values()].sort((a, b) => a.initBlock - b.initBlock), segments };
}

const toRow = (l: RawLog, ts: Map<string, number>): SwapRow => ({
  ts: ts.get(l.blockNumber)!, block: Number(l.blockNumber), logIndex: l.logIndex, tx: l.transactionHash, sender: l.args.sender,
  amount0: BigInt(l.args.amount0), amount1: BigInt(l.args.amount1), sqrtPriceX96: BigInt(l.args.sqrtPriceX96),
  liquidity: BigInt(l.args.liquidity), tick: Number(l.args.tick), fee: Number(l.args.fee),
});

/** Walk back from the lookback start in 100k windows until the pool's last pre-window swap is found. */
async function seedSwap(client: PublicClient, id: string, before: bigint, initBlock: bigint): Promise<RawLog | undefined> {
  for (let to = before - 1n; to >= initBlock; to -= 100_000n) {
    const from = to - 99_999n < initBlock ? initBlock : to - 99_999n;
    const logs = await logsAdaptive(client, poolManagerEvents.Swap, { id }, from, to, `${cacheDir}seed-${id.slice(2, 10)}-${from}-${to}.json`);
    if (logs.length) return logs.sort((a, b) => byTape({ block: Number(a.blockNumber), logIndex: a.logIndex }, { block: Number(b.blockNumber), logIndex: b.logIndex })).at(-1);
  }
  return undefined;
}

/** The first post-Friday mint's receipt (block and logs only), fetched once and cached. */
async function mintReceipt(): Promise<{ blockNumber: number; logs: { address: string; topics: string[]; data: string; logIndex: number }[] }> {
  const file = `${cacheDir}first-mint-receipt.json`;
  const cached = readCache(file) as Awaited<ReturnType<typeof mintReceipt>> | undefined;
  if (cached) return cached;
  const [r] = await rpcBatch([{ method: "eth_getTransactionReceipt", params: [FIRST_MINT_TX] }]);
  const out = { blockNumber: Number(BigInt(r.blockNumber)), logs: r.logs.map((l: any) => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data, logIndex: Number(BigInt(l.logIndex)) })) };
  writeCache(file, out);
  return out;
}

const DONATE = parseAbiItem("event Donate(bytes32 indexed id, address indexed sender, uint256 amount0, uint256 amount1)");
/** Emitted by the PoolManager's protocol fee controller for every currency it collects (amount = what left the PoolManager). */
const FEES_COLLECTED = parseAbiItem("event FeesCollected(address indexed currency, uint256 amount)");
const POOL_EVENT: Record<string, string> = {
  [toEventSelector(poolManagerEvents.Swap)]: "Swap", [toEventSelector(poolManagerEvents.ModifyLiquidity)]: "ModifyLiquidity", [toEventSelector(DONATE)]: "Donate",
};
const FEES_TOPIC = toEventSelector(FEES_COLLECTED);

/** A receipt, reduced: PoolManager pool events as [event, poolId], the fee controller's FeesCollected as [currency, amount]. */
interface ReceiptFacts { pool: [string, string][]; fees?: [string, string][] }

/**
 * ReceiptFacts per tx, from the archive node, cached by tx in pm-receipts.json so no receipt is fetched twice. Early
 * entries kept only `pool` (a bare array); such a receipt is fetched again only when `needFees` says its fees matter.
 */
async function receiptFacts(txs: string[], feeControllers: Set<string>, needFees: (f: ReceiptFacts) => boolean): Promise<Map<string, ReceiptFacts>> {
  const file = `${cacheDir}pm-receipts.json`, pm = POOL_MANAGER.toLowerCase();
  const raw = (readCache(file) as Record<string, ReceiptFacts | [string, string][]> | undefined) ?? {};
  const c: Record<string, ReceiptFacts> = Object.fromEntries(Object.entries(raw).map(([tx, v]) => [tx, Array.isArray(v) ? { pool: v } : v]));
  const want = [...new Set(txs)].filter((tx) => c[tx] === undefined || (c[tx].fees === undefined && needFees(c[tx])));
  if (want.length) console.log(`  receipts: ${txs.length - want.length} cached, ${want.length} to fetch (${STATE_RPC_LABEL})`);
  for (let i = 0; i < want.length; i += 50) {
    const slice = want.slice(i, i + 50);
    const rs = await rpcBatch(slice.map((tx) => ({ method: "eth_getTransactionReceipt", params: [tx] })));
    rs.forEach((r, j) => (c[slice[j]] = {
      pool: r.logs.filter((l: any) => l.address.toLowerCase() === pm && POOL_EVENT[l.topics[0]]).map((l: any) => [POOL_EVENT[l.topics[0]], l.topics[1].toLowerCase()]),
      fees: r.logs.filter((l: any) => feeControllers.has(l.address.toLowerCase()) && l.topics[0] === FEES_TOPIC).map((l: any) => [`0x${l.topics[1].slice(26)}`.toLowerCase(), BigInt(l.data).toString()]),
    }));
    writeCache(file, c);
    await sleep(150);
  }
  return new Map(txs.map((tx) => [tx, c[tx]]));
}

/**
 * Is pool discovery complete? Every HIMS Transfer into or out of the PoolManager in the window should sit in a
 * transaction that swapped in a discovered HIMS pool (the tapes) or, per its receipt, changed liquidity in or donated
 * to one, or be protocol fees leaving through the PoolManager's fee controller (its FeesCollected for HIMS equals the
 * tx's HIMS outflow). A receipt with a pool event on an undiscovered id is a discovery gap, one with a Swap on a
 * discovered HIMS pool that the tape lacks is a tape gap; anything else touches no HIMS pool at all.
 */
async function discoveryCoverage(pools: PoolKeyRow[], swapLogs: RawLog[]) {
  const himsIds = new Set(pools.filter((p) => p.currency0 === HIMS || p.currency1 === HIMS).map((p) => p.id)), known = new Set(pools.map((p) => p.id));
  const [a, b] = [Number(WINDOW_START_BLOCK), Number(WINDOW_END_BLOCK)];
  const pm = POOL_MANAGER.toLowerCase();
  const ctlCall = encodeFunctionData({ abi: parseAbi(["function protocolFeeController() view returns (address)"]), functionName: "protocolFeeController" });
  const controllers = new Set((await archiveCalls([a, b].map((block) => ({ to: pm, data: ctlCall, block })))).map((r) => `0x${r.slice(26)}`.toLowerCase()));
  const xs = await poolManagerTransfers(a, b);
  const swapTx = new Set(swapLogs.filter((l) => himsIds.has(l.args.id) && Number(l.blockNumber) >= a && Number(l.blockNumber) <= b).map((l) => l.transactionHash));
  const byTx = new Map<string, { moved: bigint; into: bigint; out: bigint }>();
  for (const x of xs) {
    const t = byTx.get(x.tx) ?? { moved: 0n, into: 0n, out: 0n };
    t.moved += BigInt(x.v);
    if (x.to === pm) t.into += BigInt(x.v);
    else t.out += BigInt(x.v);
    byTx.set(x.tx, t);
  }
  const rest = [...byTx.keys()].filter((tx) => !swapTx.has(tx));
  const onHimsPool = (f: ReceiptFacts) => f.pool.some(([, id]) => himsIds.has(id));
  const facts = await receiptFacts(rest, controllers, (f) => !onHimsPool(f));
  const kind = (tx: string) => {
    const f = facts.get(tx)!, t = byTx.get(tx)!;
    if (f.pool.some(([e, id]) => e === "Swap" && himsIds.has(id))) return "tapeGap";
    if (onHimsPool(f)) return "liquidityOrDonate";
    const himsFees = (f.fees ?? []).filter(([cur]) => cur === HIMS).reduce((s, [, v]) => s + BigInt(v), 0n);
    if (t.into === 0n && himsFees > 0n && himsFees === t.out) return "protocolFees";
    return f.pool.some(([, id]) => !known.has(id)) ? "undiscoveredPool" : "noHimsPoolEvent";
  };
  const groups: Record<string, string[]> = { swap: [...byTx.keys()].filter((tx) => swapTx.has(tx)), liquidityOrDonate: [], protocolFees: [], noHimsPoolEvent: [], undiscoveredPool: [], tapeGap: [] };
  for (const tx of rest) groups[kind(tx)].push(tx);
  const sum = (txs: string[]) => sig(units(txs.reduce((s, tx) => s + byTx.get(tx)!.moved, 0n), 18), 8);
  return {
    question: "does every HIMS Transfer into or out of the PoolManager in the window belong to a tx with a Swap, ModifyLiquidity or Donate on a discovered HIMS pool (or to a protocol fee collection)?",
    method: "Swaps from the tapes; for the other txs, PoolManager Swap/ModifyLiquidity/Donate events and the protocol fee controller's FeesCollected from their receipts (archive node, cached in cache/squeeze/pm-receipts.json)",
    blocks: `${a}..${b}`, transfers: xs.length, txs: byTx.size, himsMoved: sum([...byTx.keys()]), himsPools: himsIds.size, protocolFeeController: [...controllers],
    ...Object.fromEntries(Object.entries(groups).map(([k, txs]) => [k, { txs: txs.length, himsMoved: sum(txs), ...(k === "swap" ? {} : { firstTxs: txs.slice(0, 5) }) }])),
    undiscoveredPoolIds: [...new Set(groups.undiscoveredPool.flatMap((tx) => facts.get(tx)!.pool.filter(([, id]) => !known.has(id)).map(([, id]) => id)))],
    complete: groups.undiscoveredPool.length === 0 && groups.tapeGap.length === 0,
  };
}

/**
 * StateView getSlot0 / getLiquidity of `id` at each block, through archiveCalls() (cached by call and block).
 * Blocks are the end-of-block state, i.e. after every swap of that block.
 */
async function stateViewAt(id: string, blocks: number[]): Promise<Map<number, { sqrtPriceX96: bigint; tick: number; liquidity: bigint }>> {
  const to = STATE_VIEW.toLowerCase();
  const slot0 = encodeFunctionData({ abi: stateViewAbi, functionName: "getSlot0", args: [id as `0x${string}`] });
  const liq = encodeFunctionData({ abi: stateViewAbi, functionName: "getLiquidity", args: [id as `0x${string}`] });
  const uniq = [...new Set(blocks)];
  const res = await archiveCalls(uniq.flatMap((block) => [{ to, data: slot0, block }, { to, data: liq, block }]));
  const out = new Map<number, { sqrtPriceX96: bigint; tick: number; liquidity: bigint }>();
  uniq.forEach((b, i) => {
    const [sqrtPriceX96, tick] = decodeFunctionResult({ abi: stateViewAbi, functionName: "getSlot0", data: res[2 * i] as `0x${string}` });
    const liquidity = decodeFunctionResult({ abi: stateViewAbi, functionName: "getLiquidity", data: res[2 * i + 1] as `0x${string}` });
    out.set(b, { sqrtPriceX96, tick: Number(tick), liquidity });
  });
  return out;
}

// ---- output helpers ----

/** writeData, but arrays of plain values stay on one line: the 4,081-point series would otherwise be 100k lines. */
function writeJson(file: string, value: unknown) {
  const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)
    .replace(/\[\n\s*([^[\]{}]*?)\n\s*\]/g, (_m, body: string) => `[${body.split(/,\n\s*/).join(", ")}]`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text + "\n");
}

const iso = (ts: number) => new Date(ts * 1000).toISOString().replace(".000Z", "Z");
const sig = (x: number | null, d = 10) => (x === null || !Number.isFinite(x) ? null : Number(x.toPrecision(d)));
const inWindow = (r: SwapRow) => r.ts > WINDOW_START_TS && r.ts <= WINDOW_END_TS;
const label = (p: PoolKeyRow) => `${SYMBOL[p.currency0] ?? p.currency0.slice(0, 10)}/${SYMBOL[p.currency1] ?? p.currency1.slice(0, 10)}`;

/** The side a pool's volume is counted in: USDG if it has it, else HIMS, else BONER. */
function volumeSide(p: { currency0: string; currency1: string }) {
  for (const tok of [USDG, HIMS, BONER]) {
    if (p.currency0 === tok) return { side: 0 as const, unit: SYMBOL[tok], decimals: DECIMALS[tok] };
    if (p.currency1 === tok) return { side: 1 as const, unit: SYMBOL[tok], decimals: DECIMALS[tok] };
  }
  throw new Error(`pool ${p.currency0}/${p.currency1} has no volume side`);
}

function windowStats(p: PoolKeyRow, rows: SwapRow[]) {
  const v = volumeSide(p);
  const w = rows.filter(inWindow);
  const volume = w.reduce((s, r) => s + units(v.side === 0 ? (r.amount0 < 0n ? -r.amount0 : r.amount0) : r.amount1 < 0n ? -r.amount1 : r.amount1, v.decimals), 0);
  return {
    swaps: w.length, uniqueTxs: new Set(w.map((r) => r.tx)).size, uniqueSenders: new Set(w.map((r) => r.sender)).size,
    volume: sig(volume, 12), volumeUnit: v.unit,
    firstSwap: w[0] ? iso(w[0].ts) : null, lastSwap: w.at(-1) ? iso(w.at(-1)!.ts) : null,
    lastLiquidity: w.at(-1)?.liquidity.toString() ?? null,
  };
}

export async function main() {
  const client = logsClient(); // getLogs: the public endpoint serves 100k-block windows, the archive node only 10k

  // 1. every pool with HIMS or BONER on either side, from the first block either token has code
  const lo = DISCOVERY[0].from;
  const [himsAtLo, himsBefore, bonerBefore] = await hasCode([{ address: HIMS, block: lo }, { address: HIMS, block: lo - 1n }, { address: BONER, block: lo - 1n }]);
  if (!himsAtLo || himsBefore || bonerBefore) throw new Error(`pool discovery must start where HIMS first has code and BONER has none yet; block ${lo} is not that`);
  const { pools, segments } = await discoverPools(client);
  const byId = new Map(pools.map((p) => [p.id, p]));
  const hu = byId.get(POOL_HIMS_USDG), bh = byId.get(POOL_BONER_HIMS);
  if (!hu || hu.currency0 !== USDG || hu.currency1 !== HIMS || hu.fee !== 9000 || hu.tickSpacing !== 90 || hu.hooks !== ZERO || BigInt(hu.initBlock) !== INIT_HIMS_USDG) throw new Error("HIMS/USDG key mismatch");
  if (!bh || bh.currency0 !== BONER || bh.currency1 !== HIMS || bh.fee !== 8_388_608 || bh.tickSpacing !== 8 || bh.hooks !== "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544" || BigInt(bh.initBlock) !== INIT_BONER_HIMS) throw new Error("BONER/HIMS key mismatch");
  console.log(`pools: ${pools.length} (HIMS/USDG and BONER/HIMS keys verified)`);

  // 2. swaps of all of them, window plus lookback, one OR-array of ids per call and one cache per discovery segment
  const from = WINDOW_START_BLOCK - LOOKBACK;
  const logs: RawLog[] = [];
  const swapCaches: { segment: string; pools: number; cache: string; logs: number }[] = [];
  for (const seg of segments) {
    if (!seg.ids.length) continue; // an empty id filter would match every pool
    const tag = createHash("sha1").update(seg.ids.join(",")).digest("hex").slice(0, 10);
    const got = await logsAdaptive(client, poolManagerEvents.Swap, { id: seg.ids }, from, WINDOW_END_BLOCK, `${cacheDir}swaps-${tag}.json`);
    swapCaches.push({ segment: seg.name, pools: seg.ids.length, cache: `cache/squeeze/swaps-${tag}.json.ndjson`, logs: got.length });
    for (const l of got) logs.push(l); // push(...got) overflows the stack at 150k logs
  }
  const n = logs.length;
  console.log(`Swap logs ${from}..${WINDOW_END_BLOCK}: ${n} (${swapCaches.map((c) => `${c.logs} from ${c.pools} pools of ${c.segment}`).join(", ")})`);

  // 3. per-pool tapes: every swap from WINDOW_START_BLOCK on, plus the pool's last swap before it (its seed).
  // The lookback is only there to find seeds, so only those blocks and the window's get timestamps.
  const order = (a: RawLog, b: RawLog) => byTape({ block: Number(a.blockNumber), logIndex: a.logIndex }, { block: Number(b.blockNumber), logIndex: b.logIndex });
  const kept: RawLog[] = [];
  const lastBefore = new Map<string, RawLog>();
  for (const l of [...logs].sort(order)) {
    if (BigInt(l.blockNumber) >= WINDOW_START_BLOCK) kept.push(l);
    else lastBefore.set(l.args.id, l);
  }
  kept.push(...lastBefore.values());
  console.log(`window swaps ${kept.length - lastBefore.size}, seeds from the lookback ${lastBefore.size}, blocks to time ${new Set(kept.map((l) => l.blockNumber)).size}`);
  const ts = await timestamps(kept.map((l) => l.blockNumber));
  const tapes = new Map<string, SwapRow[]>();
  for (const l of kept) {
    const list = tapes.get(l.args.id) ?? [];
    list.push(toRow(l, ts));
    tapes.set(l.args.id, list);
  }
  for (const list of tapes.values()) list.sort(byTape);
  const tapeOf = (id: string) => tapes.get(id) ?? [];

  // 4. the real BONER/USDG pool is the USDG/BONER pool with the most USDG volume inside the window
  const stats = new Map(pools.map((p) => [p.id, windowStats(p, tapeOf(p.id))]));
  const bonerUsdgCandidates = pools
    .filter((p) => p.currency0 === USDG && p.currency1 === BONER)
    .map((p) => ({ ...p, window: stats.get(p.id)! }))
    .sort((a, b) => (b.window.volume ?? 0) - (a.window.volume ?? 0));
  const bu = bonerUsdgCandidates[0];
  if (!bu) throw new Error("no USDG/BONER pool found");
  console.log(`USDG/BONER pools: ${bonerUsdgCandidates.length}; main ${bu.id} (${bu.window.volume} USDG, ${bu.window.swaps} swaps)`);
  const MAIN = { himsUsdg: hu, bonerHims: bh, bonerUsdg: bu as PoolKeyRow } as const;
  // the busiest copycat USDG/HIMS pool traded close to the main one's volume, so it gets a series of its own
  const ha = pools.filter((p) => p.currency0 === USDG && p.currency1 === HIMS && p.id !== hu.id).sort((a, b) => (stats.get(b.id)!.volume ?? 0) - (stats.get(a.id)!.volume ?? 0))[0];
  console.log(`busiest other USDG/HIMS pool ${ha.id} (fee ${ha.fee}, ${stats.get(ha.id)!.volume} USDG, ${stats.get(ha.id)!.swaps} swaps)`);

  // 5. seed each main pool with its last swap before the lookback if the lookback has none
  const seeds: Record<string, string> = {};
  for (const [name, p] of Object.entries(MAIN)) {
    const tape = tapeOf(p.id);
    if (tape.some((r) => r.block < Number(WINDOW_START_BLOCK))) { seeds[name] = "in lookback"; continue; }
    const seed = await seedSwap(client, p.id, from, BigInt(p.initBlock));
    if (!seed) { seeds[name] = "none (no swap before the window)"; continue; }
    const t = await timestamps([seed.blockNumber]);
    tape.unshift(toRow(seed, t));
    tapes.set(p.id, tape);
    seeds[name] = `extended back to block ${seed.blockNumber}`;
  }
  console.log("seeds:", seeds);

  // 6. one-minute series
  const huT = tapeOf(hu.id), bhT = tapeOf(bh.id), buT = tapeOf(bu.id), haT = tapeOf(ha.id);
  const absU = (x: bigint, d: number) => units(x < 0n ? -x : x, d);
  const q = (p: PoolPrice) => (r: SwapRow) => isQuote(r, p);
  const sHu = buildSeries(huT, GRID, (r) => usdgPerHims(r.sqrtPriceX96), (r) => absU(r.amount0, 6), (r) => units(r.amount1, 18), q(PRICE.himsUsdg));
  const sHuUsdg = buildSeries(huT, GRID, () => 0, () => 0, (r) => -units(r.amount0, 6));
  const sBh = buildSeries(bhT, GRID, (r) => himsPerBoner(r.sqrtPriceX96), (r) => absU(r.amount1, 18), (r) => -units(r.amount1, 18), q(PRICE.bonerHims));
  const sBu = buildSeries(buT, GRID, (r) => usdgPerBoner(r.sqrtPriceX96), (r) => absU(r.amount0, 6), (r) => -units(r.amount0, 6), q(PRICE.bonerUsdg));
  const sHa = buildSeries(haT, GRID, (r) => usdgPerHims(r.sqrtPriceX96), (r) => absU(r.amount0, 6), (r) => units(r.amount1, 18), q(PRICE.himsUsdgAlt));
  const arr = (a: (number | null)[], d = 10) => a.map((x) => sig(x, d));
  // a close whose swap is not a quote (range drained, or stopped far past its own average price) is written as
  // null; liquidity null at that k means "no swap yet" instead
  const quoted = (x: Series) => x.close.map((c, k) => (x.closeIsQuote[k] === false ? null : c));
  const huClose = quoted(sHu);
  const liq = (a: (bigint | null)[]) => a.map((x) => (x === null ? null : Number(x)));
  const t = Array.from({ length: GRID.n }, (_, k) => GRID.start + GRID.step * k);
  const swaps1m = {
    meta: {
      grid: { start: GRID.start, end: WINDOW_END_TS, step: GRID.step, n: GRID.n, startIso: iso(GRID.start), endIso: iso(WINDOW_END_TS) },
      conventions: {
        close: "state after the last Swap with timestamp <= t_k (carried forward; seeded from the last swap before the window); null when that swap's post-swap price is not a quote (see unpriced), null with liquidity null = no swap yet",
        bars: "high/low/volume/count/flows aggregate Swaps with timestamp in (t_{k-1}, t_k]; null/0 at k = 0",
        prices: "post-swap sqrtPriceX96 of each Swap: the marginal pool price the swap left, not the price it paid (that is |quote delta| / |base delta|, in notable-swaps.json as avgPrice); high/low are post-swap prices of quoting swaps only (the pre-swap price of a bar's first swap is the previous close)",
        unpriced: `swaps in the bar whose post-swap price is not a quote: they left zero in-range liquidity (price run to the tick limit, e.g. HIMS/USDG drained of HIMS at 2026-08-30T23:24:59Z) or a price more than ${OVERSHOOT}x from their own average price (ran out of range into a far, near-empty position, e.g. BONER/USDG at 2026-08-30T23:19:54Z; notable-swaps.json overshoots); counted in volume/count/flows, left out of high/low`,
        amounts: "v4 Swap amount0/amount1 are the trader's deltas: positive = trader receives from the pool",
        liquidity: "Swap event liquidity (in-range L after the swap) as a float; exact values in swaps-raw-main.json",
        feePips: "Swap event fee field (LP + protocol fee, pips)",
      },
      pools: {
        himsUsdg: { id: hu.id, price: "USDG per HIMS", volume: "USDG (|amount0|)", netHimsOutOfHimsUsdg: "sum(amount1) in HIMS: HIMS traders took out of the pool (positive = pool lost HIMS)", netUsdgIntoHimsUsdg: "-sum(amount0) in USDG: USDG traders paid in" },
        bonerHims: { id: bh.id, price: "HIMS per BONER", volume: "HIMS (|amount1|)", netHimsIntoBonerHims: "-sum(amount1) in HIMS: HIMS traders paid into the pool (positive = pool gained HIMS)", hook: "every Swap event of the pool counts, whatever its sender (none in the window has sender = the hook); the hook's liquidity adds are ModifyLiquidity, not in these flows" },
        bonerUsdg: { id: bu.id, price: "USDG per BONER", volume: "USDG (|amount0|)", netUsdgIntoBonerUsdg: "-sum(amount0) in USDG: USDG traders paid in", pickedBy: "largest USDG swap volume in the window among the USDG/BONER pools (pools.json bonerUsdgTop5)" },
        himsUsdgAlt: { id: ha.id, fee: ha.fee, initBlock: ha.initBlock, price: "USDG per HIMS", volume: "USDG (|amount0|)", netHimsOutOfHimsUsdgAlt: "sum(amount1) in HIMS (positive = pool lost HIMS)", note: "the busiest copycat USDG/HIMS pool (not one of the three main pools); null closes before its first swap" },
        derived: { usdgPerBonerViaHims: "bonerHims.close * himsUsdg.close (BONER priced through HIMS)" },
      },
      seeds,
      generatedAt: new Date().toISOString(),
    },
    t,
    himsUsdg: { close: arr(quoted(sHu)), high: arr(sHu.high), low: arr(sHu.low), volume: arr(sHu.volume), count: sHu.count, unpriced: sHu.unpriced, netHimsOutOfHimsUsdg: arr(sHu.flow), netUsdgIntoHimsUsdg: arr(sHuUsdg.flow), liquidity: liq(sHu.liquidity), feePips: sHu.fee },
    bonerHims: { close: arr(quoted(sBh)), high: arr(sBh.high), low: arr(sBh.low), volume: arr(sBh.volume), count: sBh.count, unpriced: sBh.unpriced, netHimsIntoBonerHims: arr(sBh.flow), liquidity: liq(sBh.liquidity), feePips: sBh.fee },
    bonerUsdg: { close: arr(quoted(sBu)), high: arr(sBu.high), low: arr(sBu.low), volume: arr(sBu.volume), count: sBu.count, unpriced: sBu.unpriced, netUsdgIntoBonerUsdg: arr(sBu.flow), liquidity: liq(sBu.liquidity), feePips: sBu.fee },
    himsUsdgAlt: { close: arr(quoted(sHa)), high: arr(sHa.high), low: arr(sHa.low), volume: arr(sHa.volume), count: sHa.count, unpriced: sHa.unpriced, netHimsOutOfHimsUsdgAlt: arr(sHa.flow), liquidity: liq(sHa.liquidity), feePips: sHa.fee },
    derived: { usdgPerBonerViaHims: quoted(sBh).map((b, k) => (b === null || huClose[k] === null ? null : sig(b * huClose[k]!))) },
  };
  writeJson(`${outDir}swaps-1m.json`, swaps1m);

  // 7. registry
  const roleOf = (id: string) => (id === hu.id ? "himsUsdg" : id === bh.id ? "bonerHims" : id === bu.id ? "bonerUsdg" : "other");
  const reg = pools.map((p) => ({ role: roleOf(p.id), ...(p.id === ha.id ? { series: "himsUsdgAlt" } : {}), pair: label(p), ...p, dynamicFee: p.fee === 8_388_608, tapeRows: tapeOf(p.id).length, window: stats.get(p.id)! }));
  const others = (pred: (p: PoolKeyRow) => boolean) => {
    const list = reg.filter((p) => p.role === "other" && pred(p));
    // volumes are in different units (USDG, HIMS, BONER), so they are ranked within their unit, USDG pools first
    const unitRank = (u: string) => ["USDG", "HIMS", "BONER"].indexOf(u);
    const active = list.filter((p) => p.window.swaps > 0).sort((a, b) => unitRank(a.window.volumeUnit) - unitRank(b.window.volumeUnit) || (b.window.volume ?? 0) - (a.window.volume ?? 0));
    return { pools: list.length, withWindowSwaps: active.length, windowSwaps: active.reduce((s, p) => s + p.window.swaps, 0), active: active.map((p) => ({ id: p.id, pair: p.pair, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks, initBlock: p.initBlock, ...p.window })) };
  };
  const isHims = (p: PoolKeyRow) => p.currency0 === HIMS || p.currency1 === HIMS;
  const coverage = await discoveryCoverage(pools, logs);
  const cv = coverage as any;
  console.log(`discovery coverage: ${cv.txs} txs move HIMS through the PoolManager; swap ${cv.swap.txs}, LP/donate ${cv.liquidityOrDonate.txs}, protocol fees ${cv.protocolFees.txs} (${cv.protocolFees.himsMoved} HIMS), no HIMS pool event ${cv.noHimsPoolEvent.txs} (${cv.noHimsPoolEvent.himsMoved} HIMS), undiscovered pool ${cv.undiscoveredPool.txs}, tape gap ${cv.tapeGap.txs}`);
  const poolsOut = {
    meta: {
      discovery: {
        event: "Initialize", fromBlock: lo.toString(), toBlock: WINDOW_END_BLOCK.toString(), filter: "currency0 or currency1 in {HIMS, BONER}",
        lowerBound: `block ${lo}: HIMS's code first appears there (eth_getCode on the archive node: none at ${lo - 1n}, code at ${lo}); BONER has no code at ${lo - 1n} either`,
        segments: segments.map((s) => ({ name: s.name, fromBlock: s.from.toString(), toBlock: s.to.toString(), initializeLogs: s.initializeLogs, pools: s.ids.length, cache: `cache/squeeze/initialize-{currency0,currency1}${s.cache}.json.ndjson` })),
        coverage,
      },
      swapRange: { fromBlock: from.toString(), toBlock: WINDOW_END_BLOCK.toString(), logs: n, caches: swapCaches }, windowDefinition: "Swap timestamp in (WINDOW_START_TS, WINDOW_END_TS]", volumeSide: "USDG if the pool has it, else HIMS, else BONER; |delta| summed", generatedAt: new Date().toISOString() },
    main: Object.fromEntries(Object.entries(MAIN).map(([k, p]) => [k, reg.find((r) => r.id === p.id)])),
    bonerUsdgTop5: bonerUsdgCandidates.slice(0, 5).map((p) => ({ id: p.id, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks, initBlock: p.initBlock, ...p.window })),
    bonerUsdgPools: bonerUsdgCandidates.length,
    otherHimsPools: others(isHims),
    otherBonerPools: others((p) => !isHims(p)),
    all: reg,
  };
  writeJson(`${outDir}pools.json`, poolsOut);

  // 8. raw rows of the three main pools (for exact liquidity checks downstream)
  const rawRows = (tape: SwapRow[]) => tape.map((r) => [r.ts, r.block, r.logIndex, r.tx, r.amount0.toString(), r.amount1.toString(), r.sqrtPriceX96.toString(), r.liquidity.toString(), r.tick, r.fee]);
  writeJson(`${outDir}swaps-raw-main.json`, {
    columns: ["ts", "block", "logIndex", "tx", "amount0", "amount1", "sqrtPriceX96", "liquidity", "tick", "fee"],
    note: "amounts are the trader's raw deltas (positive = received from the pool); rows are every swap from WINDOW_START_BLOCK to WINDOW_END_BLOCK plus the pool's last swap before the window (the seed)",
    fromBlock: WINDOW_START_BLOCK.toString(), toBlock: WINDOW_END_BLOCK.toString(),
    himsUsdg: { id: hu.id, currency0: USDG, currency1: HIMS, rows: rawRows(huT) },
    bonerHims: { id: bh.id, currency0: BONER, currency1: HIMS, rows: rawRows(bhT) },
    bonerUsdg: { id: bu.id, currency0: USDG, currency1: BONER, rows: rawRows(buT) },
    himsUsdgAlt: { id: ha.id, currency0: USDG, currency1: HIMS, fee: ha.fee, rows: rawRows(haT) },
  });

  // 9. notable swaps and the cross-checks against DeFiPrime and earlier research
  const view = (pool: keyof typeof PRICE, tape: SwapRow[], i: number, dec0: number, dec1: number) => {
    const r = tape[i], p = PRICE[pool];
    return {
      pool, time: iso(r.ts), ts: r.ts, block: r.block, logIndex: r.logIndex, tx: r.tx, sender: r.sender,
      amount0: units(r.amount0, dec0), amount1: units(r.amount1, dec1), priceBefore: i > 0 ? sig(p.price(tape[i - 1].sqrtPriceX96)) : null, priceAfter: sig(p.price(r.sqrtPriceX96)),
      avgPrice: sig(p.avg(r)), priceUnit: p.unit, isQuote: isQuote(r, p),
      liquidityBefore: i > 0 ? tape[i - 1].liquidity.toString() : null, liquidity: r.liquidity.toString(), tick: r.tick, feePips: r.fee,
    };
  };
  const huView = (i: number) => view("himsUsdg", huT, i, 6, 18);
  const huWin = huT.map((r, i) => ({ r, i })).filter(({ r }) => inWindow(r));
  const huPriced = huWin.filter(({ r }) => isQuote(r, PRICE.himsUsdg));
  // swaps that left liquidity in range but a post-swap price far past their own average price (not drained ones)
  const DEC = { himsUsdg: [6, 18], bonerHims: [18, 18], bonerUsdg: [6, 18], himsUsdgAlt: [6, 18] } as const;
  const overshoots = (["himsUsdg", "bonerHims", "bonerUsdg", "himsUsdgAlt"] as const).flatMap((pool) => {
    const tape = { himsUsdg: huT, bonerHims: bhT, bonerUsdg: buT, himsUsdgAlt: haT }[pool];
    return tape.flatMap((r, i) => (inWindow(r) && priced(r) && !isQuote(r, PRICE[pool])
      ? [{ swap: view(pool, tape, i, ...DEC[pool]), nextSwap: i + 1 < tape.length ? view(pool, tape, i + 1, ...DEC[pool]) : null, postOverAvg: sig(PRICE[pool].price(r.sqrtPriceX96) / PRICE[pool].avg(r)!, 6) }]
      : []));
  });
  const maxHu = huPriced.reduce((m, x) => (usdgPerHims(x.r.sqrtPriceX96) > usdgPerHims(m.r.sqrtPriceX96) ? x : m));
  const minHu = huPriced.reduce((m, x) => (usdgPerHims(x.r.sqrtPriceX96) < usdgPerHims(m.r.sqrtPriceX96) ? x : m));
  const kMax = barIndex(maxHu.r.ts);
  const maxClose = sHu.close.reduce<{ k: number; v: number }>((m, v, k) => (v !== null && v > m.v ? { k, v } : m), { k: -1, v: -Infinity });
  const drained = huWin.filter(({ r }) => !priced(r)).map(({ i }) => ({ swap: huView(i), nextSwap: i + 1 < huT.length ? huView(i + 1) : null }));

  const at = (iso8601: string) => Date.parse(iso8601) / 1000;
  const progression: [string, number][] = [
    ["2026-08-30T21:46:00Z", 29.73], ["2026-08-30T22:28:00Z", 36.22], ["2026-08-30T23:02:00Z", 39.94], ["2026-08-30T23:36:00Z", 61.15], ["2026-08-30T23:53:00Z", 43.27],
    ["2026-08-31T00:13:00Z", 34.33], ["2026-08-31T00:43:00Z", 54.5], ["2026-08-31T00:47:00Z", 55.61], ["2026-08-31T00:55:00Z", 32.37], ["2026-08-31T01:59:00Z", 29.31],
  ];
  const relErr = (a: number | null, b: number) => (a === null ? null : sig((a - b) / b, 4));
  const progressionCheck = progression.map(([time, dp]) => {
    const t0 = at(time), k = (t0 - GRID.start) / GRID.step;
    let near = 0;
    huT.forEach((r, i) => { if (Math.abs(r.ts - (t0 + 30)) < Math.abs(huT[near].ts - (t0 + 30))) near = i; });
    const inMinute = huT.filter((r) => r.ts >= t0 && r.ts < t0 + 60).map((r) => sig(usdgPerHims(r.sqrtPriceX96), 8));
    const candidates = [sHu.close[k], sHu.close[k + 1], sHu.high[k + 1], sHu.low[k + 1], usdgPerHims(huT[near].sqrtPriceX96), ...(inMinute as number[])].filter((x): x is number => x !== null);
    const best = candidates.reduce((m, x) => (Math.abs(x - dp) < Math.abs(m - dp) ? x : m));
    return {
      time, defiprime: dp, closeAtMinuteStart: sig(sHu.close[k], 8), closeAtMinuteEnd: sig(sHu.close[k + 1], 8),
      minuteHigh: sig(sHu.high[k + 1], 8), minuteLow: sig(sHu.low[k + 1], 8), minuteSwaps: sHu.count[k + 1], swapPricesInMinute: inMinute,
      nearestSwap: huView(near), closestOfTheseToDefiprime: sig(best, 8), closestRelErr: relErr(best, dp), matchWithin1pct: Math.abs(best - dp) / dp <= 0.01,
    };
  });

  const floatTable: [number, string, number][] = [
    [48_555_213, "2026-08-28T19:40Z", 28.17], [49_125_754, "2026-08-29T11:40Z", 30.36], [49_980_825, "2026-08-30T11:40Z", 29.68],
    [50_265_277, "2026-08-30T19:40Z", 29.38], [50_415_299, "2026-08-30T23:53Z", 43.27], [50_772_447, "2026-08-31T09:54Z", 29.48],
  ];
  const research: [number, number][] = [[50_265_277, 29.3819], [50_415_299, 43.2709], [50_444_948, 54.497], [50_490_000, 29.3114], [50_772_447, 29.4802]];
  const replay = (readCache(new URL("../../data/hims-replay.json", import.meta.url).pathname) as any)?.points ?? [];
  const blockTs = await timestamps([...floatTable.map((f) => f[0]), ...research.map((r) => r[0])]);

  // 10. archive state vs the tape. slot0 at the last block before the next swap must equal the swap behind the
  // close (else the tape missed a swap in between); getLiquidity there equals the Swap event's liquidity unless an
  // in-range LP change came after it. Every 10 minutes, and every minute Sun 21:30 to Mon 02:00 UTC.
  const SQUEEZE = [1_788_125_400, 1_788_141_600];
  const sampleTimes = t.filter((x, k) => k % 10 === 0 || (x >= SQUEEZE[0] && x <= SQUEEZE[1]));
  const priceOf = { himsUsdg: usdgPerHims, bonerHims: himsPerBoner, bonerUsdg: usdgPerBoner, himsUsdgAlt: usdgPerHims } as const;
  const huState = new Map<number, { sqrtPriceX96: bigint; tick: number; liquidity: bigint }>();
  let archive: Record<string, unknown>;
  try {
    const perPool: Record<string, unknown> = {};
    for (const [name, p, tape] of [["himsUsdg", hu, huT], ["bonerHims", bh, bhT], ["bonerUsdg", bu, buT], ["himsUsdgAlt", ha, haT]] as const) {
      const pts = new Map(sampleTimes.map((x) => checkPoint(tape, x, Number(WINDOW_END_BLOCK))).filter((c) => c !== undefined).map((c) => [c.block, c.row]));
      const extra = name === "himsUsdg" ? [...floatTable.map((f) => f[0]), ...research.map((r) => r[0])] : [];
      const state = await stateViewAt(p.id, [...pts.keys(), ...extra]);
      if (name === "himsUsdg") for (const b of extra) huState.set(b, state.get(b)!);
      const price = priceOf[name];
      let priceExact = 0, liquidityExact = 0;
      const priceMisses: unknown[] = [], liqRel: number[] = [];
      for (const [block, row] of pts) {
        const st = state.get(block)!;
        if (st.sqrtPriceX96 === row.sqrtPriceX96 && st.tick === row.tick) priceExact++;
        else priceMisses.push({ block, tapeSwapBlock: row.block, tapeSwapTx: row.tx, tapePrice: sig(price(row.sqrtPriceX96)), archivePrice: sig(price(st.sqrtPriceX96)) });
        if (st.liquidity === row.liquidity) liquidityExact++;
        else liqRel.push(Math.abs(Number(st.liquidity - row.liquidity)) / Number(row.liquidity));
      }
      liqRel.sort((a, b) => a - b);
      perPool[name] = {
        poolId: p.id, blocksChecked: pts.size, priceExact, priceMismatches: priceMisses.length, firstPriceMismatches: priceMisses.slice(0, 20),
        liquidityExact, liquidityDiffers: liqRel.length, liquidityDiffMedianRel: liqRel.length ? sig(liqRel[liqRel.length >> 1], 4) : null, liquidityDiffMaxRel: liqRel.length ? sig(liqRel.at(-1)!, 4) : null,
      };
      console.log(`  archive ${name}: slot0 = tape at ${priceExact}/${pts.size} blocks, liquidity = Swap event at ${liquidityExact}/${pts.size}`);
    }
    archive = {
      available: true, rpc: STATE_RPC_LABEL, calls: "StateView getSlot0 + getLiquidity (end-of-block state)",
      sampling: "grid times every 10 min, every minute 2026-08-30T21:30Z..2026-08-31T02:00Z; block = last block before the next swap",
      liquidityNote: "a liquidity difference is not a tape error: LP changes after the swap move it (the BONER/HIMS hook adds liquidity after every user swap, so there it always differs)",
      pools: perPool,
    };
  } catch (e: any) {
    archive = { available: false, rpc: STATE_RPC_LABEL, error: redact(String(e?.message ?? e)).slice(0, 200) };
    console.log(`  archive checks skipped: ${archive.error}`);
  }
  const floatCheck = floatTable.map(([block, time, dp]) => {
    const r = lastAtOrBefore(huT, block)!;
    const bts = blockTs.get(String(block))!, k = Math.floor((bts - GRID.start) / GRID.step);
    const p = usdgPerHims(r.sqrtPriceX96);
    const st = huState.get(block);
    let near = 0;
    huT.forEach((x, i) => { if (Math.abs(x.ts - bts) < Math.abs(huT[near].ts - bts)) near = i; });
    return {
      block, defiprimeTime: time, blockTime: iso(bts), defiprime: dp, lastSwapAtOrBefore: sig(p, 8), lastSwapBlock: r.block, lastSwapTx: r.tx, relErr: relErr(p, dp), matchWithin1pct: Math.abs(p - dp) / dp <= 0.01,
      gridCloseAtMinuteStart: sig(sHu.close[k], 8), gridCloseAtMinuteEnd: sig(sHu.close[k + 1], 8), minuteHigh: sig(sHu.high[k + 1], 8), minuteLow: sig(sHu.low[k + 1], 8), minuteSwaps: sHu.count[k + 1],
      nearestSwapPrice: sig(usdgPerHims(huT[near].sqrtPriceX96), 8), nearestSwapTime: iso(huT[near].ts),
      archiveSlot0Price: st ? sig(usdgPerHims(st.sqrtPriceX96), 8) : null, archiveEqualsTape: st ? st.sqrtPriceX96 === r.sqrtPriceX96 : null, archiveLiquidity: st?.liquidity.toString() ?? null,
    };
  });
  const researchCheck = research.map(([block, spot]) => {
    const r = lastAtOrBefore(huT, block)!;
    const p = usdgPerHims(r.sqrtPriceX96);
    const rp = replay.find((x: any) => Number(x.block) === block);
    return { block, blockTime: iso(blockTs.get(String(block))!), research: spot, ours: sig(p, 8), relErr: relErr(p, spot), archiveEqualsTape: huState.has(block) ? huState.get(block)!.sqrtPriceX96 === r.sqrtPriceX96 : null, lastSwapTx: r.tx, lastSwapLiquidity: r.liquidity.toString(), feePips: r.fee, replayLastSwapTx: rp?.lastSwapTx ?? null, sameSwapAsReplay: rp ? rp.lastSwapTx === r.tx : null, liquidityMatchesReplay: rp ? rp.swapEventLiquidity === r.liquidity.toString() : null };
  });

  // first mint after Friday: the swap that follows it on the dollar pool
  const receipt = await mintReceipt();
  const mintLog = receipt.logs.find((l) => l.address === HIMS && l.topics[1] === `0x${"0".repeat(64)}`);
  const mintBlock = receipt.blockNumber, mintIdx = mintLog?.logIndex ?? receipt.logs[0].logIndex;
  const mintTs = (await timestamps([mintBlock])).get(String(mintBlock))!;
  const afterMint = huT.findIndex((r) => r.block > mintBlock || (r.block === mintBlock && r.logIndex > mintIdx));
  const beforeMint = afterMint - 1;

  // the two 4-hop arbitrages: every Swap in their blocks, grouped by tx
  const arbLogs = await logsAdaptive(client, poolManagerEvents.Swap, {}, ARB_TXS[0].block, ARB_TXS[1].block, `${cacheDir}arb-blocks-${ARB_TXS[0].block}-${ARB_TXS[1].block}.json`, 2n);
  const known: Record<string, { pair: string; c0: string; c1: string }> = {
    [hu.id]: { pair: "USDG/HIMS", c0: USDG, c1: HIMS }, [bh.id]: { pair: "BONER/HIMS", c0: BONER, c1: HIMS },
    [POOL_AI_BONER]: { pair: "AI/BONER", c0: AI_MEME, c1: BONER }, [POOL_AI_USDG]: { pair: "AI/USDG", c0: AI_MEME, c1: USDG },
  };
  const arbs = ARB_TXS.map(({ tx, block, reportedGrossUsdg }) => {
    const legs = arbLogs.filter((l) => l.transactionHash.toLowerCase() === tx).sort((a, b) => a.logIndex - b.logIndex).map((l) => {
      const k = known[l.args.id] ?? (byId.has(l.args.id) ? { pair: label(byId.get(l.args.id)!), c0: byId.get(l.args.id)!.currency0, c1: byId.get(l.args.id)!.currency1 } : { pair: "unknown", c0: "", c1: "" });
      const d0 = DECIMALS[k.c0] ?? 18, d1 = DECIMALS[k.c1] ?? 18;
      return { logIndex: l.logIndex, poolId: l.args.id, pair: k.pair, sender: l.args.sender, amount0: units(BigInt(l.args.amount0), d0), amount1: units(BigInt(l.args.amount1), d1), usdgDelta: k.c0 === USDG ? BigInt(l.args.amount0) : k.c1 === USDG ? BigInt(l.args.amount1) : 0n };
    });
    const gross = legs.reduce((s, l) => s + l.usdgDelta, 0n);
    const inOurTapes = { himsUsdg: huT.some((r) => r.tx === tx), bonerHims: bhT.some((r) => r.tx === tx), aiBoner: tapeOf(POOL_AI_BONER).some((r) => r.tx === tx) };
    return { tx, block: Number(block), swapEvents: legs.length, path: legs.map((l) => l.pair), inOurTapes, grossUsdgFromSwapDeltas: units(gross, 6), reportedGrossUsdg, matches: Math.abs(units(gross, 6) - reportedGrossUsdg) < 1e-6, legs: legs.map(({ usdgDelta, ...l }) => ({ ...l, usdgDelta: units(usdgDelta, 6) })) };
  });

  const bhWin = bhT.map((r, i) => ({ r, i })).filter(({ r }) => inWindow(r));
  const maxIn = bhWin.reduce((m, x) => (-x.r.amount1 > -m.r.amount1 ? x : m));
  const notable = {
    meta: { generatedAt: new Date().toISOString(), priceUnits: { himsUsdg: "USDG per HIMS", bonerHims: "HIMS per BONER", bonerUsdg: "USDG per BONER" }, amounts: "trader deltas in whole tokens (positive = received from the pool)", prices: "priceBefore/priceAfter are post-swap pool prices (marginal quotes the swaps left); avgPrice is what this swap paid on average, |quote delta| / |base delta| with the fee, null under 1,000 base units" },
    maxPriceHimsUsdg: { ...huView(maxHu.i), note: "highest post-swap pool price among quoting swaps (the marginal price it left, not what it paid: see avgPrice)", barTime: iso(GRID.start + GRID.step * kMax), barHigh: sig(sHu.high[kMax], 8) },
    maxMinuteCloseHimsUsdg: { time: iso(GRID.start + GRID.step * maxClose.k), close: sig(maxClose.v, 8) },
    minPriceHimsUsdg: huView(minHu.i),
    himsUsdgDrained: { note: "swaps that left zero in-range liquidity: the price ran to the tick limit (no HIMS left to buy); the next swap restores a real price", swaps: drained },
    overshoots: { note: `swaps that left liquidity in range but a post-swap price more than ${OVERSHOOT}x from their own average price: they ran out of their range and stopped in a far, near-empty position; left out of high/low like drained swaps`, swaps: overshoots },
    firstMintAfterFriday: {
      tx: FIRST_MINT_TX, block: mintBlock, logIndex: mintIdx, time: iso(mintTs), expectedTime: "2026-08-31T00:43:30Z",
      amountHims: mintLog ? units(BigInt(mintLog.data), 18) : null, to: mintLog ? `0x${mintLog.topics[2]!.slice(26)}` : null,
      lastHimsUsdgSwapBefore: beforeMint >= 0 ? huView(beforeMint) : null, firstHimsUsdgSwapAfter: afterMint >= 0 ? huView(afterMint) : null,
    },
    arbitrages: arbs,
    largestHimsInflowBonerHims: view("bonerHims", bhT, maxIn.i, 18, 18),
    defiprimePriceProgression: progressionCheck,
    defiprimeFloatTablePrices: floatCheck,
    researchSpotChecks: researchCheck,
    archiveChecks: archive,
  };
  writeJson(`${outDir}notable-swaps.json`, notable);

  console.log(`HIMS/USDG window swaps ${stats.get(hu.id)!.swaps}, BONER/HIMS ${stats.get(bh.id)!.swaps}, BONER/USDG ${bu.window.swaps}`);
  console.log(`max HIMS ${sig(usdgPerHims(maxHu.r.sqrtPriceX96), 8)} USDG at ${iso(maxHu.r.ts)} (block ${maxHu.r.block}); max minute close ${sig(maxClose.v, 8)} at ${iso(GRID.start + GRID.step * maxClose.k)}; drained swaps ${drained.length}; overshoots ${overshoots.map((o) => `${o.swap.pool} ${o.swap.time} ${o.swap.priceAfter} (paid ${o.swap.avgPrice})`).join(", ") || "none"}`);
  for (const c of progressionCheck) console.log(`  ${c.time} DeFiPrime ${c.defiprime} | close ${c.closeAtMinuteStart}->${c.closeAtMinuteEnd} hi ${c.minuteHigh} lo ${c.minuteLow} | nearest ${c.nearestSwap.priceAfter} @ ${c.nearestSwap.time} | ${c.matchWithin1pct ? "ok" : "MISS"} (${c.closestRelErr})`);
  for (const c of floatCheck) console.log(`  block ${c.block} DeFiPrime ${c.defiprime} ours ${c.lastSwapAtOrBefore} (${c.relErr}) archive ${c.archiveSlot0Price} = tape ${c.archiveEqualsTape} | minute ${c.gridCloseAtMinuteStart}->${c.gridCloseAtMinuteEnd} hi ${c.minuteHigh} lo ${c.minuteLow} | nearest ${c.nearestSwapPrice} @ ${c.nearestSwapTime}`);
  for (const c of researchCheck) console.log(`  block ${c.block} research ${c.research} ours ${c.ours} sameSwapAsReplay ${c.sameSwapAsReplay} liquidity ${c.liquidityMatchesReplay}`);
  for (const a of arbs) console.log(`  arb ${a.tx.slice(0, 10)} ${a.swapEvents} swaps ${a.path.join(" > ")} gross ${a.grossUsdgFromSwapDeltas} (reported ${a.reportedGrossUsdg}) in tapes ${JSON.stringify(a.inOurTapes)}`);
  console.log(`wrote ${outDir}{pools,swaps-1m,notable-swaps,swaps-raw-main}.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) run(main);
