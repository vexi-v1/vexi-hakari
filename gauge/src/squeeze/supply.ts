// Where the HIMS float sat over the 2026-08-28..31 weekend. Supply is rebuilt from mint/burn Transfers and the v4
// singleton's HIMS balance from Transfers into and out of the PoolManager, both folded from the token's deployment
// to a pinned recent head, where they are checked to the wei against totalSupply() and balanceOf(PoolManager). The
// weekend is sampled on the shared 1-minute grid, and every 10th grid minute is checked again, to the wei, against
// the same two calls on the archive node. Every fetch is cached under cache/squeeze/ and resumable, so a rerun asks
// the chain for nothing it has already seen. Writes cache/squeeze/out/supply-1m.json and supply-events.json.
// Read-only on 4663.
import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi } from "viem";
import { rmSync } from "node:fs";
import { POOL_MANAGER, PUBLIC_MAINNET_RPC, readCache, redact, run, sleep, writeCache, writeData } from "../chain.ts";
import {
  archiveCalls, BONER, blockTimestamps, cacheDir, HIMS, logsClient, REF, rpcBatch, STATE_RPC_LABEL, USDG,
  WINDOW_END_BLOCK, WINDOW_END_TS, WINDOW_START_BLOCK, WINDOW_START_TS,
} from "./common.ts";

export const ZERO = "0x0000000000000000000000000000000000000000";
export const PM = POOL_MANAGER.toLowerCase();
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const GRID_STEP = 60;
export const GRID_N = (WINDOW_END_TS - WINDOW_START_TS) / GRID_STEP + 1; // 4081

/** One HIMS Transfer, compact (this is also the cache format). */
export interface Xfer { b: number; i: number; tx: string; from: string; to: string; v: string }
export interface Timed extends Xfer { ts: number }

// ---------- pure folding (gauge/test/squeeze-supply.test.ts) ----------

const topicAddr = (t: string) => `0x${t.slice(26)}`.toLowerCase();
const topicOf = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

export function decodeTransfer(l: { blockNumber: string; logIndex: string; transactionHash: string; topics: string[]; data: string }): Xfer {
  if (l.topics[0] !== TRANSFER || l.topics.length !== 3) throw new Error(`not an ERC-20 Transfer: ${l.transactionHash}`);
  return { b: Number(BigInt(l.blockNumber)), i: Number(BigInt(l.logIndex)), tx: l.transactionHash, from: topicAddr(l.topics[1]), to: topicAddr(l.topics[2]), v: BigInt(l.data).toString() };
}

export const byLogOrder = (a: Xfer, b: Xfer) => a.b - b.b || a.i - b.i;

/** The two OR-filters overlap on mint-to-PM / PM-to-burn: keep one copy per (tx, logIndex), in log order. */
export function dedupe<T extends Xfer>(logs: T[]): T[] {
  const seen = new Map<string, T>();
  for (const l of logs) seen.set(`${l.tx}:${l.i}`, l);
  return [...seen.values()].sort(byLogOrder);
}

export function deltas(x: Xfer, pm = PM) {
  const v = BigInt(x.v);
  const minted = x.from === ZERO ? v : 0n;
  const burned = x.to === ZERO ? v : 0n;
  const pmIn = x.to === pm ? v : 0n;
  const pmOut = x.from === pm ? v : 0n;
  return { minted, burned, pmIn, pmOut, supply: minted - burned, pm: pmIn - pmOut };
}

/** Supply and PoolManager balance after every log in blocks <= `block`. */
export function stateAt(xs: Xfer[], block: number, pm = PM) {
  let supply = 0n, bal = 0n;
  for (const x of xs) {
    if (x.b > block) continue;
    const d = deltas(x, pm);
    supply += d.supply;
    bal += d.pm;
  }
  return { supply, pm: bal };
}

/**
 * The 1-minute grid. `seed` is the state before `xs` (xs must be timestamped and in log order). The close at
 * t_k folds every log with ts <= t_k; bars at t_k aggregate ts in (t_{k-1}, t_k] and are 0 at k = 0.
 */
export function buildGrid(seed: { supply: bigint; pm: bigint }, xs: Timed[], t0 = WINDOW_START_TS, step = GRID_STEP, n = GRID_N, pm = PM) {
  const cols = { t: [] as number[], supply: [] as bigint[], pm: [] as bigint[], minted: [] as bigint[], burned: [] as bigint[], mints: [] as number[], burns: [] as number[], pmIn: [] as bigint[], pmOut: [] as bigint[] };
  let supply = seed.supply, bal = seed.pm, j = 0;
  for (let k = 0; k < n; k++) {
    const tk = t0 + step * k;
    let minted = 0n, burned = 0n, mints = 0, burns = 0, pmIn = 0n, pmOut = 0n;
    for (; j < xs.length && xs[j].ts <= tk; j++) {
      if (j > 0 && byLogOrder(xs[j - 1], xs[j]) > 0) throw new Error("buildGrid needs logs in log order");
      const d = deltas(xs[j], pm);
      supply += d.supply;
      bal += d.pm;
      if (k === 0) continue;
      minted += d.minted; burned += d.burned; pmIn += d.pmIn; pmOut += d.pmOut;
      if (d.minted) mints++;
      if (d.burned) burns++;
    }
    cols.t.push(tk); cols.supply.push(supply); cols.pm.push(bal);
    cols.minted.push(minted); cols.burned.push(burned); cols.mints.push(mints); cols.burns.push(burns); cols.pmIn.push(pmIn); cols.pmOut.push(pmOut);
  }
  return cols;
}

/** Mints in [fromBlock, toBlock]: count, total and the first mint at which half of the total had arrived. */
export function mintCluster<T extends Timed>(mints: T[], fromBlock: number, toBlock: number) {
  const inRange = mints.filter((m) => m.b >= fromBlock && m.b <= toBlock).sort(byLogOrder);
  const total = inRange.reduce((s, m) => s + BigInt(m.v), 0n);
  let cum = 0n, half: T | undefined, halfCum = 0n;
  for (const m of inRange) {
    cum += BigInt(m.v);
    if (!half && cum * 2n >= total) (half = m), (halfCum = cum);
  }
  return { count: inRange.length, total, first: inRange[0], last: inRange.at(-1), half, halfCum };
}

/**
 * For each target time, the known blocks around it: lo = the last known block with ts <= t, hi = the first with
 * ts > t. `known` maps block -> timestamp and must be non-decreasing in block number.
 */
export function brackets(known: Map<number, number>, targets: number[]) {
  const pts = [...known].sort((a, b) => a[0] - b[0]);
  pts.forEach((p, j) => {
    if (j > 0 && p[1] < pts[j - 1][1]) throw new Error(`timestamps go backwards at block ${p[0]}`);
  });
  return targets.map((t) => {
    let a = 0, z = pts.length; // first index with ts > t
    while (a < z) {
      const m = (a + z) >> 1;
      if (pts[m][1] > t) z = m;
      else a = m + 1;
    }
    if (a === 0 || a === pts.length) throw new Error(`no known blocks on both sides of ts ${t}`);
    return { t, lo: pts[a - 1][0], hi: pts[a][0] };
  });
}

/** The last block with timestamp <= t for every target: parallel bisection, one batched header fetch per round. */
export async function lastBlocksAtOrBefore(targets: number[], known: Map<number, number>, timeOf: (blocks: number[]) => Promise<Map<number, number>>) {
  const bs = brackets(known, targets);
  let rounds = 0;
  for (let open = bs.filter((x) => x.hi - x.lo > 1); open.length; open = bs.filter((x) => x.hi - x.lo > 1), rounds++) {
    const mids = open.map((x) => Math.floor((x.lo + x.hi) / 2));
    const ts = await timeOf([...new Set(mids)]);
    open.forEach((x, j) => {
      const tm = ts.get(mids[j]);
      if (tm === undefined || !Number.isFinite(tm)) throw new Error(`no timestamp for block ${mids[j]}`);
      if (tm <= x.t) x.lo = mids[j];
      else x.hi = mids[j];
    });
  }
  return { blocks: new Map(bs.map((x) => [x.t, x.lo])), rounds };
}

/** Exact comparison of on-chain values with reconstructed ones: mismatches and the largest |difference|, in wei. */
export function compareExact(pairs: { onchain: bigint; reconstructed: bigint }[]) {
  let maxAbs = 0n, mismatches = 0;
  for (const p of pairs) {
    const d = p.onchain > p.reconstructed ? p.onchain - p.reconstructed : p.reconstructed - p.onchain;
    if (d) mismatches++;
    if (d > maxAbs) maxAbs = d;
  }
  return { n: pairs.length, mismatches, maxAbsDiffWei: maxAbs.toString() };
}

// ---------- fetching (every result cached under cache/squeeze/; a rerun re-reads, it does not re-ask) ----------

class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(`${code} ${message}`); }
}

let publicChecked: Promise<void> | undefined;
/** The public endpoint's chain id, checked once before the first request that goes there (a cached rerun sends none). */
const checkPublicChain = () => (publicChecked ??= (async () => {
  const id = await logsClient().getChainId();
  if (id !== 4663) throw new Error(`public RPC answers chain ${id}, not 4663`);
})());

/** eth_getLogs goes to the public endpoint (the archive node caps ranges at 10,000 blocks); raw JSON-RPC so the node's own error text drives the window size. */
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  await checkPublicChain();
  const res = await fetch(PUBLIC_MAINNET_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const text = await res.text();
  let j: any;
  try { j = JSON.parse(text); } catch { throw new RpcError(res.status, redact(text.slice(0, 120))); }
  if (j.error) throw new RpcError(j.error.code, redact(String(j.error.message)));
  return j.result as T;
}

const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const SEG = 1_000_000; // cache granularity (one file per full segment and side)
const PAUSE_MS = 800;
/** Window state carried across calls: starts at 100k, widens to 400k over sparse stretches, halves on timeouts. */
const pace = { win: 100_000, max: 400_000 };
let requests = 0;

/**
 * Transfer logs in [from, to] for one topic filter; halves the window on timeouts and on the node's 10,000-log cap.
 * `onWindow(end, logs)` sees every finished window, so the caller can save progress as it goes.
 */
async function transfersIn(topics: unknown[], from: number, to: number, p = pace, onWindow?: (end: number, logs: Xfer[]) => void): Promise<Xfer[]> {
  const out: Xfer[] = [];
  let b = from, strikes = 0;
  while (b <= to) {
    const e = Math.min(b + p.win - 1, to);
    try {
      requests++;
      const raw = await rpc<any[]>("eth_getLogs", [{ address: HIMS, fromBlock: hex(b), toBlock: hex(e), topics }]);
      if (raw.length >= 10_000 && e > b) {
        p.win = Math.max(1, Math.floor((e - b + 1) / 2)); // might be capped: take it again in halves
      } else {
        const got = raw.map(decodeTransfer);
        out.push(...got);
        onWindow?.(e, got);
        b = e + 1;
        strikes = 0;
        if (raw.length < 1_500) p.win = Math.min(p.max, p.win * 2);
      }
    } catch (err: any) {
      const msg = redact(String(err?.message ?? err));
      if (/timed out|timeout|too many results|exceeds limit|limit exceeded|response size/i.test(msg) && e > b) {
        p.win = Math.max(1, Math.floor((e - b + 1) / 2));
      } else {
        if (++strikes > 8) throw new Error(`getLogs ${b}-${e}: ${msg}`);
        await sleep((err?.code === 429 ? 4000 : 2000) * strikes);
      }
    }
    await sleep(PAUSE_MS);
  }
  return out;
}

/**
 * One side's Transfers in [start, head], cached per 1M-block segment: a finished segment in <side>-<s>.json, the
 * segment that holds the head in <side>-<s>.tail.json ({ to, logs }), saved after every window. A rerun, or a later
 * head, only asks for blocks past what is on disk.
 */
async function transfersSide(name: string, topics: unknown[], start: number, head: number): Promise<Xfer[]> {
  const all: Xfer[] = [];
  for (let s = Math.floor(start / SEG) * SEG; s <= head; s += SEG) {
    const e = s + SEG - 1, upTo = Math.min(e, head);
    const full = `${cacheDir}hims-transfers/${name}-${s}.json`, tailFile = `${cacheDir}hims-transfers/${name}-${s}.tail.json`;
    let logs = readCache(full) as Xfer[] | undefined;
    if (!logs) {
      const tail = (readCache(tailFile) as { to: number; logs: Xfer[] } | undefined) ?? { to: s - 1, logs: [] };
      if (tail.to < upTo) {
        const from = tail.to + 1;
        await transfersIn(topics, from, upTo, pace, (end, got) => {
          tail.to = end;
          tail.logs.push(...got);
          if (end < e) writeCache(tailFile, tail);
        });
        console.log(`  ${name} ${from}-${upTo}: ${tail.logs.length} logs in the segment (window now ${pace.win}, ${requests} requests)`);
      }
      if (tail.to >= e) {
        writeCache(full, tail.logs);
        rmSync(tailFile, { force: true });
      }
      logs = tail.logs.filter((x) => x.b <= upTo);
    }
    all.push(...logs);
  }
  return all;
}

/** Mint/burn and PoolManager Transfer filters, one per side: main() and poolManagerTransfers() share their caches. */
const SIDES = { from: [TRANSFER, [topicOf(ZERO), topicOf(PM)]], to: [TRANSFER, null, [topicOf(ZERO), topicOf(PM)]] };

/** HIMS Transfers into or out of the PoolManager in blocks [from, to], read from (or added to) main()'s segment cache. */
export async function poolManagerTransfers(from: number, to: number): Promise<Xfer[]> {
  const xs = dedupe([...(await transfersSide("from", SIDES.from, from, to)), ...(await transfersSide("to", SIDES.to, from, to))]);
  return xs.filter((x) => x.b >= from && x.b <= to && (x.from === PM || x.to === PM));
}

/** The first HIMS Transfer is a mint (nothing else can move a token that does not exist yet). */
async function firstMint(head: number): Promise<Xfer> {
  const file = `${cacheDir}hims-first-mint.json`;
  const cached = readCache(file) as Xfer | undefined;
  if (cached) return cached;
  const wide = { win: 5_000_000, max: 5_000_000 }; // mints alone are sparse
  for (let s = 0; s <= head; s += 5_000_000) {
    const logs = await transfersIn([TRANSFER, topicOf(ZERO)], s, Math.min(s + 4_999_999, head), wide);
    if (logs.length) {
      const first = logs.sort(byLogOrder)[0];
      writeCache(file, first);
      return first;
    }
  }
  throw new Error("HIMS has never been minted?");
}

/**
 * The block HIMS's code first appears in (bisection over eth_getCode on the archive node, every probe cached in
 * hims-deploy.json), and the transaction in that block that touched it. Replaces the Blockscout lookup, which sits
 * behind a bot check.
 */
async function deployment(firstMintBlock: number) {
  const file = `${cacheDir}hims-deploy.json`;
  const c = (readCache(file) as { probes: Record<string, boolean>; block?: number; txs?: unknown[]; error?: string } | undefined) ?? { probes: {} };
  if (c.block !== undefined || c.error) return c;
  const hasCode = async (b: number) => {
    c.probes[b] ??= (await rpcBatch([{ method: "eth_getCode", params: [HIMS, hex(b)] }]))[0] !== "0x";
    writeCache(file, c);
    return c.probes[b];
  };
  try {
    if (!(await hasCode(firstMintBlock))) throw new Error(`no code at the first mint's block ${firstMintBlock}`);
    let lo = 0, hi = firstMintBlock; // no code at lo, code at hi
    if (await hasCode(lo)) throw new Error("code at block 0");
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await hasCode(mid)) hi = mid;
      else lo = mid;
    }
    c.block = hi;
    const receipts = (await rpcBatch([{ method: "eth_getBlockReceipts", params: [hex(hi)] }]))[0] as any[];
    c.txs = receipts
      .filter((r) => String(r.contractAddress ?? "").toLowerCase() === HIMS || r.logs.some((l: any) => String(l.address).toLowerCase() === HIMS))
      .map((r) => ({ tx: r.transactionHash, from: String(r.from).toLowerCase(), to: r.to && String(r.to).toLowerCase(), contractAddress: r.contractAddress && String(r.contractAddress).toLowerCase() }));
  } catch (e: any) {
    c.error = redact(String(e?.message ?? e)).slice(0, 300);
  }
  writeCache(file, c);
  return c;
}

/**
 * Exact timestamps through blockTimestamps() (the shared timestamps.json). Other collectors rewrite that file too,
 * so a read can land mid-write or lose entries: this collector keeps its own copy in timestamps-supply.json, saved
 * after every slice, and asks blockTimestamps() only for blocks missing from both.
 */
const OWN_TS = `${cacheDir}timestamps-supply.json`;
async function timestamps(blocks: Iterable<number | string>): Promise<Map<string, number>> {
  const want = [...new Set([...blocks].map(String))];
  const own = (readCache(OWN_TS) as Record<string, number> | undefined) ?? {};
  const missing = want.filter((b) => own[b] === undefined);
  if (missing.length > 500) console.log(`  timestamps: ${want.length - missing.length}/${want.length} in timestamps-supply.json, ${missing.length} via ${STATE_RPC_LABEL} (or the shared cache)`);
  for (let i = 0; i < missing.length; i += 2_000) {
    const slice = missing.slice(i, i + 2_000);
    for (let attempt = 0; ; attempt++) {
      try {
        for (const [b, t] of await blockTimestamps(slice)) if (Number.isFinite(t)) own[b] = t;
        break;
      } catch (e: any) {
        if (attempt >= 5) throw new Error(redact(String(e?.message ?? e)));
        console.log(`  timestamps retry in ${3 * (attempt + 1)} s: ${redact(String(e?.message ?? e)).slice(0, 100)}`);
        await sleep(3_000 * (attempt + 1));
      }
    }
    writeCache(OWN_TS, own);
  }
  const out = new Map<string, number>();
  for (const b of want) {
    if (!Number.isFinite(own[b])) throw new Error(`no timestamp for block ${b}`);
    out.set(b, own[b]);
  }
  return out;
}

/** archiveCalls() (shared archive-calls.json) behind a private copy, archive-calls-supply.json, for the same reason. */
const OWN_CALLS = `${cacheDir}archive-calls-supply.json`;
type Call = { to: string; data: string; block: number };
async function calls(cs: Call[]): Promise<string[]> {
  const key = (c: Call) => `${c.to.toLowerCase()}|${c.data.toLowerCase()}|${c.block}`;
  const own = (readCache(OWN_CALLS) as Record<string, string> | undefined) ?? {};
  const missing = [...new Map(cs.map((c) => [key(c), c])).values()].filter((c) => own[key(c)] === undefined);
  if (missing.length > 50) console.log(`  eth_call: ${missing.length} to resolve via ${STATE_RPC_LABEL} (or the shared cache)`);
  for (let i = 0; i < missing.length; i += 500) {
    const slice = missing.slice(i, i + 500);
    for (let attempt = 0; ; attempt++) {
      try {
        (await archiveCalls(slice)).forEach((r, j) => (own[key(slice[j])] = r));
        break;
      } catch (e: any) {
        if (attempt >= 5) throw new Error(redact(String(e?.message ?? e)));
        await sleep(3_000 * (attempt + 1));
      }
    }
    writeCache(OWN_CALLS, own);
  }
  return cs.map((c) => own[key(c)]);
}

/** tx.from for each hash (the signer behind a mint or burn), 50 per batch on the archive node, cached. */
async function txSenders(hashes: string[]): Promise<Map<string, string>> {
  const file = `${cacheDir}hims-mint-burn-senders.json`;
  const cache = (readCache(file) as Record<string, string> | undefined) ?? {};
  const want = [...new Set(hashes)].filter((h) => !cache[h]);
  for (let i = 0; i < want.length; i += 50) {
    const slice = want.slice(i, i + 50);
    const txs = await rpcBatch(slice.map((h) => ({ method: "eth_getTransactionByHash", params: [h] })));
    txs.forEach((t, j) => (cache[slice[j]] = String(t.from).toLowerCase()));
    writeCache(file, cache);
    await sleep(150);
  }
  return new Map(hashes.map((h) => [h, cache[h]]));
}

/** The head everything is checked at, pinned once in hims-head.json so a rerun re-checks the same block from cache. `--new-head` re-pins. */
async function pinnedHead(): Promise<{ head: number; ts: number }> {
  const file = `${cacheDir}hims-head.json`;
  const cached = readCache(file) as { head: number; ts: number } | undefined;
  if (cached && !process.argv.includes("--new-head")) return cached;
  await checkPublicChain();
  const head = Number(await logsClient().getBlockNumber()) - 20; // a little behind the public tip, so both endpoints have it
  const ts = (await timestamps([head])).get(String(head))!;
  writeCache(file, { head, ts, pinnedAt: new Date().toISOString() });
  return { head, ts };
}

/** Last block with ts <= t for each grid time, cached in grid-blocks.json ({ ts: block }), shared with other collectors. */
async function gridBlocks(times: number[], known: Map<number, number>): Promise<Map<number, number>> {
  const file = `${cacheDir}grid-blocks.json`;
  const cache = (readCache(file) as Record<string, number> | undefined) ?? {};
  const want = times.filter((t) => cache[t] === undefined);
  if (want.length) {
    const timeOf = async (bs: number[]) => new Map([...(await timestamps(bs))].map(([b, t]) => [Number(b), t]));
    const { blocks, rounds } = await lastBlocksAtOrBefore(want, known, timeOf);
    for (const [t, b] of blocks) cache[t] = b;
    writeCache(file, { ...((readCache(file) as Record<string, number> | undefined) ?? {}), ...cache });
    console.log(`  grid blocks: ${want.length} resolved in ${rounds} bisection rounds`);
  }
  return new Map(times.map((t) => [t, cache[t]]));
}

const erc20 = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);
const TOTAL_SUPPLY = encodeFunctionData({ abi: erc20, functionName: "totalSupply" });
const BALANCE_OF_PM = encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [PM as `0x${string}`] });
const decode = (functionName: "totalSupply" | "balanceOf" | "decimals" | "symbol" | "name", data: string) =>
  decodeFunctionResult({ abi: erc20, functionName, data: data as `0x${string}` }) as any;

// ---------- reference numbers (compared against, never written as measured) ----------

/** DeFiPrime, "The Weekend Float Squeeze" (2026-08-31), float table: UTC label, block, HIMS supply, HIMS in Uniswap v4. */
const DEFIPRIME_FLOAT = [
  { label: "Fri 19:40", block: 48_555_213, supply: 16_126.8, inV4: 12_689.1 },
  { label: "Sat 11:40", block: 49_125_754, supply: 15_226.8, inV4: 12_085.3 },
  { label: "Sun 11:40", block: 49_980_825, supply: 15_226.8, inV4: 12_424.2 },
  { label: "Sun 19:40", block: 50_265_277, supply: 15_226.8, inV4: 11_964.4 },
  { label: "Sun 23:53", block: 50_415_299, supply: 15_226.8, inV4: 13_883.2 },
  { label: "Mon 09:54", block: 50_772_447, supply: 33_977.3, inV4: 32_086.5 },
];
const DEFIPRIME_REDEMPTION_WALLET = "0xa8553db0049fc6843c0d00d0efc08d31848e3c74";
const DEFIPRIME_ISSUER_WALLET = "0xcfaece2151502da2a21d47234ae1f08618a60a94";
const DEFIPRIME_MM_WALLET = "0x1a18a8b96eac3f980133a18402d04194f1faa4e7";
const DEFIPRIME_FIRST_MINT = { tx: "0x459aee54624bbef4ccabb6e872ec08414c97cd97bda4f92048cabb011e5a066b", iso: "2026-08-31T00:43:30Z", amount: 1000, signer: "0x2b94105fff37630f98e1f24811dad588fc5c3a87" };
const MON_0954_BLOCK = 50_772_447;

const hims = (x: bigint) => formatUnits(x, 18);
const num = (x: bigint) => Number(formatUnits(x, 18));
const iso = (ts: number) => new Date(ts * 1000).toISOString().replace(".000Z", "Z");
/** A one-decimal table value is consistent with an exact one when they differ by at most half the last digit. */
const withinRounding = (exact: number, ref: number) => Math.abs(exact - ref) <= 0.05 + 1e-9;

export async function main() {
  console.log(`state and headers: ${STATE_RPC_LABEL}; logs: public RPC (chain id checked before its first request)`);

  // 1. a pinned head, its state, then every mint/burn/PoolManager Transfer from deployment to that head
  const { head, ts: headTs } = await pinnedHead();
  const at = (to: string, data: string) => ({ to, data, block: head });
  const tokenMeta = (a: string) => [at(a, encodeFunctionData({ abi: erc20, functionName: "symbol" })), at(a, encodeFunctionData({ abi: erc20, functionName: "name" })), at(a, encodeFunctionData({ abi: erc20, functionName: "decimals" }))];
  const headRaw = await calls([at(HIMS, TOTAL_SUPPLY), at(HIMS, BALANCE_OF_PM), at(BONER, TOTAL_SUPPLY), ...tokenMeta(HIMS), ...tokenMeta(BONER), ...tokenMeta(USDG)]);
  const [himsSupplyH, himsInPmH, bonerSupplyH] = headRaw.slice(0, 3).map((r) => decode("totalSupply", r) as bigint);
  const tokens: Record<string, { address: string; symbol: string; name: string; decimals: number }> = {};
  (["HIMS", "BONER", "USDG"] as const).forEach((k, j) => {
    const r = headRaw.slice(3 + 3 * j, 6 + 3 * j);
    tokens[k] = { address: { HIMS, BONER, USDG }[k], symbol: decode("symbol", r[0]), name: decode("name", r[1]), decimals: Number(decode("decimals", r[2])) };
  });
  console.log(`head ${head} (${iso(headTs)}): totalSupply ${hims(himsSupplyH)} HIMS, balanceOf(PM) ${hims(himsInPmH)} HIMS`);

  const first = await firstMint(head);
  const deploy = await deployment(first.b);
  console.log(`first HIMS Transfer (a mint) at block ${first.b}; code first at block ${deploy.block ?? `? (${deploy.error})`}`);
  // From the block the code appeared in (the token was deployed ~14.5M blocks before its first mint), not from the
  // first mint: a transfer to or from the PoolManager cannot predate supply, and the scan shows it.
  const scanFrom = deploy.block ?? first.b;
  const scanStart = Math.floor(scanFrom / SEG) * SEG;
  const fromSide = await transfersSide("from", SIDES.from, scanFrom, head);
  const toSide = await transfersSide("to", SIDES.to, scanFrom, head);
  const beforeFirstMint = [...fromSide, ...toSide].filter((x) => x.b < first.b || (x.b === first.b && x.i < first.i)).length;
  const xs = dedupe([...fromSide, ...toSide]);
  const atHead = stateAt(xs, head);
  const headCheck = {
    block: head, ts: headTs, iso: iso(headTs), rpc: STATE_RPC_LABEL,
    logs: { fromSide: fromSide.length, toSide: toSide.length, deduped: xs.length, mints: xs.filter((x) => x.from === ZERO).length, burns: xs.filter((x) => x.to === ZERO).length, scanFromBlock: scanStart, beforeFirstMint },
    totalSupply: { reconstructed: atHead.supply.toString(), onchain: himsSupplyH.toString(), diff: (atHead.supply - himsSupplyH).toString(), exact: atHead.supply === himsSupplyH },
    poolManagerBalance: { reconstructed: atHead.pm.toString(), onchain: himsInPmH.toString(), diff: (atHead.pm - himsInPmH).toString(), exact: atHead.pm === himsInPmH },
  };
  console.log("head check", JSON.stringify(headCheck));

  // 2. the window on the 1-minute grid (timestamps from headers, never interpolated)
  const WSB = Number(WINDOW_START_BLOCK), WEB = Number(WINDOW_END_BLOCK), GUARD = WEB + 10_000;
  const near = xs.filter((x) => x.b >= WSB && x.b <= GUARD);
  const refBlocks = DEFIPRIME_FLOAT.map((r) => r.block);
  console.log(`window: ${near.length} logs in ${new Set(near.map((x) => x.b)).size} blocks`);
  const ts = await timestamps([...near.map((x) => x.b), ...refBlocks, WSB - 1, WSB, WEB, GUARD]);
  if (!(ts.get(String(WSB - 1))! < WINDOW_START_TS && ts.get(String(WSB))! >= WINDOW_START_TS)) throw new Error("WINDOW_START_BLOCK is not the first block at or after the window start");
  if (!(ts.get(String(GUARD))! > WINDOW_END_TS)) throw new Error("guard block is not past the window end");
  const known = new Map([...ts].map(([b, t]) => [Number(b), t]));
  const checkKs = Array.from({ length: GRID_N }, (_, k) => k).filter((k) => k % 10 === 0);
  const gb = await gridBlocks(checkKs.map((k) => WINDOW_START_TS + GRID_STEP * k), known);
  const lastBlock = gb.get(WINDOW_END_TS)!;
  const timed: Timed[] = near.filter((x) => x.b <= lastBlock).map((x) => ({ ...x, ts: ts.get(String(x.b))! }));
  timed.forEach((x, j) => {
    if (!Number.isFinite(x.ts) || x.ts > WINDOW_END_TS || (j > 0 && x.ts < timed[j - 1].ts)) throw new Error(`bad timestamp at block ${x.b}`);
  });
  const seed = stateAt(xs.filter((x) => x.b < WSB), WSB - 1);
  const grid = buildGrid(seed, timed);

  // 3. exact archive cross-check at every 10th grid minute and at DeFiPrime's six blocks
  const checkBlocks = checkKs.map((k) => ({ k, t: grid.t[k], block: gb.get(grid.t[k])! }));
  const archived = await calls(checkBlocks.flatMap((c) => [{ to: HIMS, data: TOTAL_SUPPLY, block: c.block }, { to: HIMS, data: BALANCE_OF_PM, block: c.block }]));
  const archiveRows = checkBlocks.map((c, j) => ({ ...c, supply: BigInt(archived[2 * j]), pm: BigInt(archived[2 * j + 1]) }));
  const archiveCheck = {
    rpc: STATE_RPC_LABEL,
    points: checkBlocks.length,
    blockRule: "last block with timestamp <= t_k (bisection over exact headers)",
    totalSupply: compareExact(archiveRows.map((r) => ({ onchain: r.supply, reconstructed: grid.supply[r.k] }))),
    poolManagerBalance: compareExact(archiveRows.map((r) => ({ onchain: r.pm, reconstructed: grid.pm[r.k] }))),
    checkpoints: archiveRows.map((r) => ({ k: r.k, t: r.t, block: r.block, himsSupplyRaw: r.supply.toString(), himsInPoolManagerRaw: r.pm.toString() })),
  };
  console.log(`archive check: supply ${JSON.stringify(archiveCheck.totalSupply)}, PM ${JSON.stringify(archiveCheck.poolManagerBalance)}`);

  // 4. mints and burns in the window, with the signer behind each
  const mb = timed.filter((x) => x.from === ZERO || x.to === ZERO);
  const senders = await txSenders(mb.map((x) => x.tx));
  const ev = (x: Timed) => ({ kind: x.from === ZERO ? "mint" : "burn", ts: x.ts, iso: iso(x.ts), block: x.b, logIndex: x.i, tx: x.tx, amount: hims(BigInt(x.v)), amountRaw: x.v, from: x.from, to: x.to, txFrom: senders.get(x.tx) });
  const mints = mb.filter((x) => x.from === ZERO);
  const burns = mb.filter((x) => x.to === ZERO);
  const firstAfter = mints.find((m) => m.ts >= REF.mintRuleClose);
  const lastBefore = [...mints].reverse().find((m) => m.ts < REF.mintRuleClose);
  const monday = firstAfter ? mintCluster(mints, firstAfter.b, MON_0954_BLOCK) : undefined;
  const mondayBurns = firstAfter ? burns.filter((b) => b.b >= firstAfter.b && b.b <= MON_0954_BLOCK) : [];
  const tally = (list: Timed[], addr: (x: Timed) => string) => {
    const m = new Map<string, { count: number; total: bigint }>();
    for (const x of list) {
      const a = m.get(addr(x)) ?? { count: 0, total: 0n };
      a.count++;
      a.total += BigInt(x.v);
      m.set(addr(x), a);
    }
    return [...m].map(([address, a]) => ({ address, count: a.count, total: hims(a.total) })).sort((a, b) => b.count - a.count);
  };

  // 5. DeFiPrime's float table and event facts, compared
  const refArchived = await calls(refBlocks.flatMap((block) => [{ to: HIMS, data: TOTAL_SUPPLY, block }, { to: HIMS, data: BALANCE_OF_PM, block }]));
  const float = DEFIPRIME_FLOAT.map((r, j) => {
    const s = stateAt(xs, r.block);
    const onSupply = BigInt(refArchived[2 * j]), onPm = BigInt(refArchived[2 * j + 1]);
    const t = ts.get(String(r.block))!;
    return {
      label: r.label, block: r.block, ts: t, iso: iso(t),
      supply: { measured: hims(s.supply), archive: hims(onSupply), exactVsArchive: s.supply === onSupply, reference: r.supply, diff: +(num(s.supply) - r.supply).toFixed(6), withinRounding: withinRounding(num(s.supply), r.supply) },
      inPoolManager: { measured: hims(s.pm), archive: hims(onPm), exactVsArchive: s.pm === onPm, reference: r.inV4, diff: +(num(s.pm) - r.inV4).toFixed(6), withinRounding: withinRounding(num(s.pm), r.inV4) },
    };
  });
  const fridayBurns = burns.filter((b) => b.ts < REF.mintRuleClose);
  // BONER is not exactly 1e9 at the head: read it at the window's edges too (archive node, cached)
  const [bonerStart, bonerEnd] = (await calls([{ to: BONER, data: TOTAL_SUPPLY, block: WSB }, { to: BONER, data: TOTAL_SUPPLY, block: lastBlock }])).map(BigInt);
  const facts = {
    burnsFriday: {
      reference: "500 HIMS at Fri 20:37 UTC and 400 HIMS at 21:21 UTC from 0xa8553db0…3e74",
      measured: fridayBurns.map((b) => ({ iso: iso(b.ts), amount: hims(BigInt(b.v)), from: b.from, txFrom: senders.get(b.tx), tx: b.tx })),
      matches:
        fridayBurns.length === 2 && fridayBurns.every((b) => b.from === DEFIPRIME_REDEMPTION_WALLET) &&
        num(BigInt(fridayBurns[0].v)) === 500 && num(BigInt(fridayBurns[1].v)) === 400 &&
        iso(fridayBurns[0].ts).startsWith("2026-08-28T20:37") && iso(fridayBurns[1].ts).startsWith("2026-08-28T21:21"),
    },
    firstMintAfterWeekend: {
      reference: DEFIPRIME_FIRST_MINT,
      measured: firstAfter && ev(firstAfter),
      matches: !!firstAfter && firstAfter.tx === DEFIPRIME_FIRST_MINT.tx && iso(firstAfter.ts) === DEFIPRIME_FIRST_MINT.iso && num(BigInt(firstAfter.v)) === DEFIPRIME_FIRST_MINT.amount && senders.get(firstAfter.tx) === DEFIPRIME_FIRST_MINT.signer,
    },
    mondayMints: {
      reference: "Mon 00:43-09:54 UTC: 294 mints, 18,750.5 HIMS, no burns",
      measured: monday && { fromBlock: firstAfter!.b, toBlock: MON_0954_BLOCK, count: monday.count, total: hims(monday.total), burns: mondayBurns.length },
      matches: !!monday && monday.count === 294 && withinRounding(num(monday.total), 18_750.5) && mondayBurns.length === 0,
    },
    walletsSeen: {
      redemptionWalletBurns: burns.filter((b) => b.from === DEFIPRIME_REDEMPTION_WALLET).length,
      mintsToIssuerWallet: mints.filter((m) => m.to === DEFIPRIME_ISSUER_WALLET).length,
      mintsToMarketMakerWallet: mints.filter((m) => m.to === DEFIPRIME_MM_WALLET).length,
    },
  };
  console.log("float table", JSON.stringify(float, null, 1));
  console.log("facts", JSON.stringify(facts, null, 1));

  const out = `${cacheDir}out/`;
  writeData(`${out}supply-1m.json`, {
    generatedAt: new Date().toISOString(),
    source: "HIMS ERC-20 Transfer logs (mint, burn, into/out of the v4 PoolManager) on Robinhood Chain 4663, folded from deployment; timestamps from block headers",
    grid: { t0: WINDOW_START_TS, step: GRID_STEP, n: GRID_N, startBlock: WSB, lastBlock },
    units: "HIMS (18 decimals) as decimal numbers; counts are integers",
    definitions: {
      himsSupply: "totalSupply after every log with ts <= t_k (carry forward)",
      himsInPoolManager: "HIMS held by the v4 PoolManager singleton across all pools (reserves of every HIMS pool plus ERC-6909 claims and unpaid fees; not one pool's reserves), ts <= t_k",
      himsOutsidePoolManager: "himsSupply - himsInPoolManager",
      himsMinted: "HIMS minted with ts in (t_{k-1}, t_k]; 0 at k = 0", himsBurned: "same, burned",
      mintCount: "mint Transfers in the bucket", burnCount: "burn Transfers in the bucket",
      pmInflow: "HIMS transferred into the PoolManager in the bucket", pmOutflow: "HIMS transferred out of the PoolManager in the bucket",
    },
    checks: {
      head: { block: head, totalSupplyExact: headCheck.totalSupply.exact, poolManagerBalanceExact: headCheck.poolManagerBalance.exact },
      archiveEvery10Min: { points: archiveCheck.points, totalSupply: archiveCheck.totalSupply, poolManagerBalance: archiveCheck.poolManagerBalance },
    },
    seed: { beforeBlock: WSB, himsSupply: hims(seed.supply), himsInPoolManager: hims(seed.pm) },
    series: {
      t: grid.t,
      himsSupply: grid.supply.map(num),
      himsInPoolManager: grid.pm.map(num),
      himsOutsidePoolManager: grid.supply.map((s, k) => num(s - grid.pm[k])),
      himsMinted: grid.minted.map(num),
      himsBurned: grid.burned.map(num),
      mintCount: grid.mints,
      burnCount: grid.burns,
      pmInflow: grid.pmIn.map(num),
      pmOutflow: grid.pmOut.map(num),
    },
  });
  writeData(`${out}supply-events.json`, {
    generatedAt: new Date().toISOString(),
    tokens: {
      HIMS: { ...tokens.HIMS, totalSupplyAtHead: hims(himsSupplyH), totalSupplyAtHeadRaw: himsSupplyH.toString() },
      BONER: {
        ...tokens.BONER, totalSupplyAtHead: formatUnits(bonerSupplyH, tokens.BONER.decimals), totalSupplyAtHeadRaw: bonerSupplyH.toString(), isOneBillion: bonerSupplyH === 10n ** 27n,
        totalSupplyAtWindowStart: formatUnits(bonerStart, 18), totalSupplyAtWindowEnd: formatUnits(bonerEnd, 18), windowBlocks: [WSB, lastBlock],
      },
      USDG: tokens.USDG,
      headBlock: head,
    },
    deployment: { codeFirstAtBlock: deploy.block ?? null, txs: deploy.txs ?? [], error: deploy.error, method: "bisection over eth_getCode on the archive node" },
    firstTransfer: { block: first.b, tx: first.tx, to: first.to, amount: hims(BigInt(first.v)), note: "first HIMS Transfer found by eth_getLogs from block 0 (a mint)" },
    headCheck,
    archiveCheck,
    window: { startTs: WINDOW_START_TS, endTs: WINDOW_END_TS, startBlock: WSB, lastBlock, logs: timed.length },
    mints: mints.map(ev),
    burns: burns.map(ev),
    mintRecipients: tally(mints, (m) => m.to),
    burnSources: tally(burns, (b) => b.from),
    signers: tally(mb, (x) => senders.get(x.tx)!).map(({ address, count }) => ({ txFrom: address, count })),
    clusters: {
      lastMintBeforeMintRuleClose: lastBefore && ev(lastBefore),
      mintsBetweenNyseCloseAndMintRuleClose: mints.filter((m) => m.ts > REF.nyseCloseFri && m.ts < REF.mintRuleClose).length,
      lastBurnInWindow: burns.length ? ev(burns[burns.length - 1]) : null,
      firstMintAfterWeekend: firstAfter && ev(firstAfter),
      mondayMints: monday && {
        fromBlock: firstAfter!.b, toBlock: MON_0954_BLOCK, count: monday.count, total: hims(monday.total), burnsInRange: mondayBurns.length,
        first: monday.first && ev(monday.first), last: monday.last && ev(monday.last),
        halfArrived: monday.half && { ...ev(monday.half), cumulative: hims(monday.halfCum), note: "first mint at which cumulative minted >= half of the range total" },
      },
      mintsInWindowAfterMon0954: firstAfter ? mints.filter((m) => m.b > MON_0954_BLOCK).length : 0,
    },
    defiprimeFloat: float,
    defiprimeFacts: facts,
    rpc: { getLogsRequestsThisRun: requests },
  });
  console.log(`wrote ${out}supply-1m.json and supply-events.json (${requests} getLogs requests this run)`);
}

if (import.meta.url === `file://${process.argv[1]}`) run(main);
