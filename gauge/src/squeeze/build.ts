// The float-squeeze dataset behind web/squeeze/: data.json, plus data.js (the same JSON as a script) so the page also
// opens from file://. Nothing is measured here: the three collectors' outputs (squeeze/pools-swaps.ts, inventory.ts,
// supply.ts -> cache/squeeze/out/) are assembled on their shared 1-minute grid, the cross-prices are derived (BONER in
// USDG through HIMS and at the Friday NYSE close, the HIMS premium, the gap between the two BONER routes), and every
// figure DeFiPrime, the earlier research and gauge/data/hims-replay.json reported is set next to ours with a verdict.
// The collectors' exactness checks are carried into `checks`, beside integrity checks of the file itself. Two facts
// the collectors did not keep (the last HIMS mint before the window; main-pool logs in the blocks that share the
// window's last second) are fetched once and cached in cache/squeeze/build-extras.json. Read-only against 4663.
import { mkdirSync, writeFileSync } from "node:fs";
import { decodeEventLog, formatUnits, toEventSelector } from "viem";
import { MAINNET_RPCS, POOL_MANAGER, PUBLIC_MAINNET_RPC, readCache, redact, run, writeCache } from "../chain.ts";
import { poolManagerEvents } from "../abi.ts";
import { GRID, OVERSHOOT, PRICE, barIndex, himsPerBoner, isQuote, lastAtOrBefore, usdgPerBoner, usdgPerHims, type SwapRow } from "./pools-swaps.ts";
import {
  POOL_BONER_HIMS, POOL_HIMS_USDG, REF, WINDOW_END_BLOCK, WINDOW_END_TS, WINDOW_START_BLOCK, WINDOW_START_TS, blockTimestamps, cacheDir, logsClient,
} from "./common.ts";

const outDir = `${cacheDir}out/`;
const webDir = new URL("../../../web/squeeze/", import.meta.url).pathname;
const NAV = REF.nyseCloseFriPrice;
const EXPLORER = "https://robinhoodchain.blockscout.com";
const DEFIPRIME_URL = "https://defiprime.com/tokenized-stock-float-squeeze";
const DEFIPRIME = 'DeFiPrime, "The Weekend Float Squeeze" (2026-08-31)';
const RESEARCH = "earlier research, robinhood-v4 analysis (2026-09-25)";
const REPLAY = "HAKARI gauge/data/hims-replay.json";
const ZERO = "0x0000000000000000000000000000000000000000";
const AI_USDG = "0x508ab5b7a7b447598017eba58530c2a2a5d647b8074a2dc85aa533dfbed4d543";
const AI_BONER = "0x1f1778596d8c1ee3e1eaf64ea83a5e77063b142fa3ef59a7c81e520c516379bc";
const MON_0954_BLOCK = 50_772_447;
const MAX_BYTES = 1_500_000;

// ---- pure pieces (tested in test/squeeze-build.test.ts) ----

export type Num = number | null;

/** 6 significant digits (Number() drops trailing zeros); null for null/NaN/Infinity. Never used on counts, ts or blocks. */
export function sig6(x: number | null | undefined): Num {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const v = Number(x.toPrecision(6));
  return v === 0 ? 0 : v; // no -0
}
export const r6 = (a: readonly Num[]): Num[] => a.map(sig6);

/** BONER in USDG through HIMS and at `nav`, the HIMS premium over `nav` (%), and via-HIMS over direct BONER/USDG (%). */
export function derive(himsUsdg: readonly Num[], bonerHims: readonly Num[], bonerUsdg: readonly Num[], nav: number) {
  const via = himsUsdg.map((h, k) => (h === null || bonerHims[k] === null ? null : bonerHims[k]! * h));
  return {
    bonerUsdgViaHims: via,
    bonerUsdAtNav: bonerHims.map((b) => (b === null ? null : b * nav)),
    himsPremiumPct: himsUsdg.map((h) => (h === null ? null : (h / nav - 1) * 100)),
    routeGapPct: via.map((v, k) => (v === null || !bonerUsdg[k] ? null : (v / bonerUsdg[k]! - 1) * 100)),
  };
}

export type Match = "exact" | "close" | "differs";
/**
 * exact: ours rounds to the reference at the reference's own precision (decimals, or significant digits for "~"
 * figures); close: within closeRel of it (default 1%); otherwise differs.
 */
export function matchLevel(ours: Num | undefined, ref: number, p: { decimals?: number; sig?: number; closeRel?: number } = {}): Match {
  if (ours === null || ours === undefined || !Number.isFinite(ours)) return "differs";
  const exact = p.sig !== undefined
    ? Number(ours.toPrecision(p.sig)) === ref
    : Math.abs(ours - ref) <= 0.5 * 10 ** -(p.decimals ?? 2) + 1e-9 * Math.max(1, Math.abs(ref));
  if (exact) return "exact";
  return Math.abs(ours - ref) <= Math.abs(ref) * (p.closeRel ?? 0.01) ? "close" : "differs";
}
export const worst = (ms: Match[]): Match => (ms.includes("differs") ? "differs" : ms.includes("close") ? "close" : "exact");

/** Mints split wherever two consecutive ones are more than `gapSec` apart. */
export function mintClusters<T extends { ts: number; amount: number }>(mints: readonly T[], gapSec = 900) {
  const out: { first: T; last: T; count: number; total: number }[] = [];
  for (const m of [...mints].sort((a, b) => a.ts - b.ts)) {
    const c = out.at(-1);
    if (c && m.ts - c.last.ts <= gapSec) { c.last = m; c.count++; c.total += m.amount; }
    else out.push({ first: m, last: m, count: 1, total: m.amount });
  }
  return out;
}

/**
 * When a premium series settles: the first k >= from with |x[k]| <= band after which x never again exceeds
 * `ceiling` (nulls ignored); -1 if it never does.
 */
export function settledAt(x: readonly Num[], from: number, band: number, ceiling: number): number {
  let lastOver = -1;
  for (let k = x.length - 1; k >= Math.max(0, from); k--) if (x[k] !== null && x[k]! > ceiling) { lastOver = k; break; }
  for (let k = Math.max(0, from, lastOver + 1); k < x.length; k++) if (x[k] !== null && Math.abs(x[k]!) <= band) return k;
  return -1;
}

/** Index of the smallest / largest non-null value in [from, to); -1 if none. */
export function argExt(x: readonly Num[], max: boolean, from = 0, to = x.length): number {
  let m = -1;
  for (let k = from; k < to; k++) if (x[k] !== null && (m < 0 || (max ? x[k]! > x[m]! : x[k]! < x[m]!))) m = k;
  return m;
}

/** What is wrong with a time axis that should run start..end in steps of `step`. */
export function gridProblems(t: readonly number[], start: number, end: number, step: number): string[] {
  const p: string[] = [];
  if (t[0] !== start) p.push(`t[0] = ${t[0]}, not ${start}`);
  if (t.at(-1) !== end) p.push(`last t = ${t.at(-1)}, not ${end}`);
  for (let k = 1; k < t.length; k++) if (t[k] - t[k - 1] !== step) { p.push(`t[${k}] - t[${k - 1}] = ${t[k] - t[k - 1]}`); break; }
  return p;
}

/** Paths of numbers that are NaN or +-Infinity (JSON.stringify would silently write them as null). */
export function nonFinite(v: unknown, path = "$", out: string[] = []): string[] {
  if (typeof v === "number") { if (!Number.isFinite(v)) out.push(path); }
  else if (Array.isArray(v)) v.forEach((x, i) => nonFinite(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) nonFinite(x, `${path}.${k}`, out);
  return out;
}

/** Series (arrays, or groups of arrays one level down) whose length is not n. */
export function badLengths(series: Record<string, unknown>, n: number): string[] {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(series)) {
    if (Array.isArray(v)) { if (v.length !== n) bad.push(`${k} (${v.length})`); continue; }
    for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) if (!Array.isArray(vv) || vv.length !== n) bad.push(`${k}.${kk}`);
  }
  return bad;
}

/** Bars with high < low, or with swaps whose (priced) close, i.e. the bar's last swap, lies outside [low, high]. */
export function ohlcProblems(o: { close: readonly Num[]; high: readonly Num[]; low: readonly Num[] }, count: readonly number[]): number[] {
  const bad: number[] = [];
  for (let k = 0; k < o.close.length; k++) {
    const c = o.close[k], h = o.high[k], l = o.low[k];
    if (h !== null && l !== null && h < l) bad.push(k);
    else if (count[k] > 0 && c !== null && h !== null && l !== null && (c > h || c < l)) bad.push(k);
  }
  return bad;
}

/**
 * Bars whose high or low sits more than `factor` times beyond both neighbouring closes (the close before the bar and
 * the bar's own): a single print that far out is not a price the pool held.
 */
export function spikeProblems(o: { close: readonly Num[]; high: readonly Num[]; low: readonly Num[] }, factor = 5): number[] {
  const bad: number[] = [];
  for (let k = 1; k < o.close.length; k++) {
    const a = o.close[k - 1], b = o.close[k], h = o.high[k], l = o.low[k];
    if (a === null || b === null) continue;
    if ((h !== null && h > factor * Math.max(a, b)) || (l !== null && l * factor < Math.min(a, b))) bad.push(k);
  }
  return bad;
}

/** k where the two main pools hold more HIMS than the PoolManager, or the PoolManager more than the supply. */
export function floatSplitProblems(inA: readonly Num[], inB: readonly Num[], pm: readonly Num[], supply: readonly Num[], rel = 1e-5): number[] {
  const bad: number[] = [];
  for (let k = 0; k < pm.length; k++) {
    const a = inA[k] ?? 0, b = inB[k] ?? 0, p = pm[k], s = supply[k];
    if (p === null || s === null || a + b > p * (1 + rel) || p > s * (1 + rel)) bad.push(k);
  }
  return bad;
}

/** JSON with one key per line and every array of plain values on one line (the 4,081-point series stay compact). */
export function serialize(v: unknown): string {
  return JSON.stringify(v, null, 1).replace(/\[\n\s*([^[\]{}]*?)\n\s*\]/g, (_m, body: string) => `[${body.split(/,\n\s*/).join(",")}]`) + "\n";
}

// ---- the two facts fetched here (cached) ----

const EXTRAS = `${cacheDir}build-extras.json`;
const hex = (x: number) => `0x${x.toString(16)}`;

/** The last HIMS mint before `block`, from supply.ts's Transfer cache (1M-block segments of Transfers from 0x0 or the PoolManager). */
function lastMintBefore(block: number): { b: number; i: number; tx: string; v: string } | undefined {
  for (let s = Math.floor((block - 1) / 1e6) * 1e6; s >= 20_000_000; s -= 1_000_000) {
    const dir = `${cacheDir}hims-transfers/`;
    const list = (readCache(`${dir}from-${s}.json`) as any[] | undefined) ?? ((readCache(`${dir}from-${s}.tail.json`) as any)?.logs as any[] | undefined);
    const mints = (list ?? []).filter((x) => x.from === ZERO && x.b < block).sort((a, b) => a.b - b.b || a.i - b.i);
    if (mints.length) return mints.at(-1);
  }
  return undefined;
}

/**
 * The last mint before the window (its header timestamp) and every Swap/ModifyLiquidity of the three main pools in
 * blocks tailFrom..tailTo: the blocks after WINDOW_END_BLOCK that share the window's last timestamp, which the pool
 * tapes stop short of. Each is fetched once and kept in build-extras.json; a failure is reported, not cached.
 */
async function extras(ids: string[], tailFrom: number, tailTo: number) {
  const c = (readCache(EXTRAS) as any) ?? {};
  const errors: string[] = [];
  let dirty = false;
  if (!c.lastMintBeforeWindow) {
    try {
      const m = lastMintBefore(Number(WINDOW_START_BLOCK));
      if (!m) throw new Error("no mint before the window in cache/squeeze/hims-transfers (run squeeze/supply.ts)");
      const ts = (await blockTimestamps([m.b])).get(String(m.b));
      if (!Number.isFinite(ts)) throw new Error(`no timestamp for block ${m.b}`);
      c.lastMintBeforeWindow = { block: m.b, logIndex: m.i, tx: m.tx, amount: formatUnits(BigInt(m.v), 18), ts };
      dirty = true;
    } catch (e: any) { errors.push(`last mint before the window: ${redact(String(e?.message ?? e)).slice(0, 200)}`); }
  }
  const range = `${tailFrom}-${tailTo}`;
  if (tailTo >= tailFrom && c.tail?.range !== range) {
    try {
      const topics = [[toEventSelector(poolManagerEvents.Swap), toEventSelector(poolManagerEvents.ModifyLiquidity)], ids];
      const logs = (await logsClient().request({ method: "eth_getLogs", params: [{ address: POOL_MANAGER.toLowerCase(), fromBlock: hex(tailFrom), toBlock: hex(tailTo), topics }] } as any)) as any[];
      const blocks = Array.from({ length: tailTo - tailFrom + 1 }, (_, i) => tailFrom + i);
      const ts = await blockTimestamps(blocks);
      c.tail = {
        range, blockTs: Object.fromEntries(blocks.map((b) => [b, ts.get(String(b))])),
        logs: logs.map((l) => {
          const d = decodeEventLog({ abi: [poolManagerEvents.Swap, poolManagerEvents.ModifyLiquidity], data: l.data, topics: l.topics }) as any;
          return { block: Number(BigInt(l.blockNumber)), logIndex: Number(BigInt(l.logIndex)), tx: String(l.transactionHash).toLowerCase(), event: d.eventName, id: String(d.args.id).toLowerCase() };
        }),
      };
      dirty = true;
    } catch (e: any) { errors.push(`tail logs ${range}: ${redact(String(e?.message ?? e)).slice(0, 200)}`); }
  }
  if (dirty) writeCache(EXTRAS, c);
  return { lastMint: c.lastMintBeforeWindow as { block: number; logIndex: number; tx: string; amount: string; ts: number } | undefined, tail: (tailTo >= tailFrom ? c.tail : { range, blockTs: {}, logs: [] }) as { range: string; blockTs: Record<string, number>; logs: { block: number; logIndex: number; tx: string; event: string; id: string }[] } | undefined, errors };
}

// ---- formatting ----

const fmt = (x: number, d = 2) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const px = (x: number | null) => (x === null ? "n/a" : x.toFixed(2)); // a USDG price, always two decimals
const hms = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 19);
const hm = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16);
const iso = (ts: number) => new Date(ts * 1000).toISOString().replace(".000Z", "Z");
const DAY = { en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], zh: ["週日", "週一", "週二", "週三", "週四", "週五", "週六"] };
const day = (ts: number, lang: "en" | "zh") => DAY[lang][new Date(ts * 1000).getUTCDay()];
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---- main ----

export async function main() {
  const load = (file: string): any => {
    const v = readCache(file);
    if (v === undefined) throw new Error(`missing ${file.split("/gauge/").pop()}: run the collectors first (npm run squeeze)`);
    return v;
  };
  const sw = load(`${outDir}swaps-1m.json`), inv = load(`${outDir}inventory-1m.json`), sup = load(`${outDir}supply-1m.json`);
  const sev = load(`${outDir}supply-events.json`), pools = load(`${outDir}pools.json`), notable = load(`${outDir}notable-swaps.json`);
  const raw = load(`${outDir}swaps-raw-main.json`);
  const replay = load(new URL("../../data/hims-replay.json", import.meta.url).pathname);
  const t: number[] = sw.t;
  const n = GRID.n;
  const main3 = pools.main;

  const tapeOf = (name: string): SwapRow[] => raw[name].rows.map((r: any[]) => ({
    ts: r[0], block: r[1], logIndex: r[2], tx: r[3], sender: "", amount0: BigInt(r[4]), amount1: BigInt(r[5]), sqrtPriceX96: BigInt(r[6]), liquidity: BigInt(r[7]), tick: r[8], fee: r[9],
  }));
  const huT = tapeOf("himsUsdg"), bhT = tapeOf("bonerHims"), buT = tapeOf("bonerUsdg");
  const quoteHu = (r: SwapRow) => isQuote(r, PRICE.himsUsdg); // the same test pools-swaps.ts applies to high/low
  const inWin = (r: { ts: number }) => r.ts > WINDOW_START_TS && r.ts <= WINDOW_END_TS;
  const units = (x: bigint, d: number) => Number(formatUnits(x, d));

  const lastBlock: number = sup.grid.lastBlock; // last block with timestamp <= WINDOW_END_TS (exact headers)
  const extra = await extras([main3.himsUsdg.id, main3.bonerHims.id, main3.bonerUsdg.id], Number(WINDOW_END_BLOCK) + 1, lastBlock);
  for (const e of extra.errors) console.log(`  (not available: ${e})`);

  // 1. series
  const hu = sw.himsUsdg, bh = sw.bonerHims, bu = sw.bonerUsdg, ss = sup.series;
  const d = derive(hu.close, bh.close, bu.close, NAV);
  const ohlc = (x: any) => ({ close: r6(x.close), high: r6(x.high), low: r6(x.low) });
  const series = {
    himsUsdg: ohlc(hu), bonerHims: ohlc(bh), bonerUsdgDirect: ohlc(bu),
    bonerUsdgViaHims: r6(d.bonerUsdgViaHims), bonerUsdAtNav: r6(d.bonerUsdAtNav), himsPremiumPct: r6(d.himsPremiumPct), routeGapPct: r6(d.routeGapPct),
    himsSupply: r6(ss.himsSupply), himsInPoolManager: r6(ss.himsInPoolManager),
    himsInHimsUsdg: r6(inv.himsInHimsUsdg), usdgInHimsUsdg: r6(inv.usdgInHimsUsdg), himsInBonerHims: r6(inv.himsInBonerHims), bonerInBonerHims: r6(inv.bonerInBonerHims),
    usdgInBonerUsdg: r6(inv.usdgInBonerUsdg), bonerInBonerUsdg: r6(inv.bonerInBonerUsdg),
    liqHimsUsdg: r6(inv.liqHimsUsdg), liqBonerHims: r6(inv.liqBonerHims),
    pushUp10CostUsdg: r6(inv.pushUp10CostUsdg), pushUp10CapitalUsdg: r6(inv.pushUp10CapitalUsdg), pushDown10CostUsdg: r6(inv.pushDown10CostUsdg),
    volUsdgHimsUsdg: r6(hu.volume), volHimsBonerHims: r6(bh.volume), volUsdgBonerUsdg: r6(bu.volume),
    swapsHimsUsdg: hu.count as number[], swapsBonerHims: bh.count as number[], swapsBonerUsdg: bu.count as number[],
    netHimsOutOfHimsUsdg: r6(hu.netHimsOutOfHimsUsdg), netHimsIntoBonerHims: r6(bh.netHimsIntoBonerHims),
    himsMinted: r6(ss.himsMinted), himsBurned: r6(ss.himsBurned),
  };

  // 2. the moments
  const mints = (sev.mints as any[]).map((m) => ({ ...m, amount: Number(m.amount) }));
  const burns = (sev.burns as any[]).map((b) => ({ ...b, amount: Number(b.amount) }));
  const firstMint = mints[0];
  const kMint = barIndex(firstMint.ts); // the first grid point at or after the first Monday mint
  const kMaxClose = argExt(hu.close, true);
  const kMinHims = argExt(inv.himsInHimsUsdg, false);
  const kMaxBonerPool = argExt(inv.himsInBonerHims, true, 0, kMint);
  const kMaxBonerPoolAll = argExt(inv.himsInBonerHims, true);
  const kMinPush = argExt(inv.pushUp10CostUsdg, false);
  const kMaxVia = argExt(d.bonerUsdgViaHims, true);
  const kCalm = settledAt(d.himsPremiumPct, kMint, 2, 10);
  const peak = notable.maxPriceHimsUsdg, drained = notable.himsUsdgDrained.swaps[0];
  const peakRow = huT.find((r) => r.tx === peak.tx && r.logIndex === peak.logIndex)!;
  const peakPaid = PRICE.himsUsdg.avg(peakRow)!; // what the peak swap itself paid per HIMS, fee included
  const peakLiqPct = (Number(peak.liquidity) / Number(peak.liquidityBefore)) * 100;
  const monday = sev.clusters.mondayMints, half = monday.halfArrived;

  type Ev = { id: string; ts: number; toTs?: number; block: number | null; tx: string | null; kind: string; amount: Num; unit: string | null; label: { en: string; zh: string } };
  const events: Ev[] = [];
  const add = (e: Partial<Ev> & Pick<Ev, "id" | "ts" | "kind" | "label">) => events.push({ block: null, tx: null, amount: null, unit: null, ...e });
  add({ id: "nyse-close-fri", ts: REF.nyseCloseFri, kind: "nyse", amount: NAV, unit: "USD", label: { en: `NYSE close: HIMS $${NAV}`, zh: `紐約證交所收盤：HIMS ${NAV} 美元` } });
  for (const b of burns) add({ id: `burn-${b.block}-${b.logIndex}`, ts: b.ts, block: b.block, tx: b.tx, kind: "burn", amount: b.amount, unit: "HIMS", label: { en: `Burn: ${fmt(b.amount, 3)} HIMS redeemed from ${short(b.from)}`, zh: `銷毀：贖回錢包 ${short(b.from)} 銷毀 ${fmt(b.amount, 3)} HIMS` } });
  add({ id: "mint-rule-close", ts: REF.mintRuleClose, kind: "note", label: { en: "Mint/redeem window closes (Sat 02:00 Berlin): HIMS supply frozen until Monday", zh: "鑄造／贖回時段關閉（柏林時間週六 02:00）：HIMS 流通量凍結到週一" } });
  add({ id: "reopen-24x5", ts: REF.session24x5Reopen, kind: "reopen", label: { en: "24/5 trading session reopens (Sun 20:00 ET)", zh: "24/5 交易時段重新開盤（美東時間週日 20:00）" } });
  for (const m of mints) {
    const first = m === firstMint;
    add({
      id: first ? "mint-first" : `mint-${m.block}-${m.logIndex}`, ts: m.ts, block: m.block, tx: m.tx, kind: "mint", amount: m.amount, unit: "HIMS",
      label: first
        ? { en: `First mint after Friday: ${fmt(m.amount, 3)} HIMS to the issuer wallet ${short(m.to)}`, zh: `週五之後第一筆鑄造：${fmt(m.amount, 3)} HIMS 進入發行方錢包 ${short(m.to)}` }
        : { en: `Mint: ${fmt(m.amount, 3)} HIMS`, zh: `鑄造：${fmt(m.amount, 3)} HIMS` },
    });
  }
  const clusters = mintClusters(mints, 900);
  clusters.forEach((c, i) => add({
    id: `mint-cluster-${i + 1}`, ts: c.first.ts, toTs: c.last.ts, block: c.first.block, kind: "mintCluster", amount: sig6(c.total), unit: "HIMS",
    label: { en: `Mint burst: ${c.count} mints, ${fmt(c.total, 1)} HIMS (${hm(c.first.ts)}–${hm(c.last.ts)} UTC)`, zh: `集中鑄造：${c.count} 筆，共 ${fmt(c.total, 1)} HIMS（UTC ${hm(c.first.ts)}–${hm(c.last.ts)}）` },
  }));
  add({ id: "mints-half-delivered", ts: half.ts, block: half.block, tx: half.tx, kind: "note", amount: sig6(Number(half.cumulative)), unit: "HIMS", label: { en: `Half of the Monday-morning mints delivered: ${fmt(Number(half.cumulative), 1)} of ${fmt(Number(monday.total), 2)} HIMS`, zh: `週一上午的鑄造量過半：${fmt(Number(monday.total), 2)} HIMS 中已送達 ${fmt(Number(half.cumulative), 1)}` } });
  const floatRow = (block: number) => (sev.defiprimeFloat as any[]).find((r) => r.block === block);
  add({ id: "mints-by-0954", ts: floatRow(MON_0954_BLOCK).ts, block: MON_0954_BLOCK, kind: "note", amount: sig6(Number(monday.total)), unit: "HIMS", label: { en: `By 09:54 UTC: ${monday.count} mints since 00:43:30, ${fmt(Number(monday.total), 2)} HIMS, ${monday.burnsInRange ? `${monday.burnsInRange} burns` : "no burns"}`, zh: `到 UTC 09:54：自 00:43:30 起 ${monday.count} 筆鑄造，共 ${fmt(Number(monday.total), 2)} HIMS，${monday.burnsInRange ? `銷毀 ${monday.burnsInRange} 筆` : "沒有銷毀"}` } });
  add({ id: "dollar-pool-drained", ts: drained.swap.ts, block: drained.swap.block, tx: drained.swap.tx, kind: "note", amount: sig6(drained.swap.amount1), unit: "HIMS", label: { en: `The dollar pool runs out of HIMS: one swap buys the last ${fmt(drained.swap.amount1, 2)} HIMS for ${fmt(-drained.swap.amount0, 2)} USDG`, zh: `美元池的 HIMS 被買光：一筆交易以 ${fmt(-drained.swap.amount0, 2)} USDG 買走最後 ${fmt(drained.swap.amount1, 2)} HIMS` } });
  add({ id: "peak-swap", ts: peak.ts, block: peak.block, tx: peak.tx, kind: "peak", amount: sig6(peak.priceAfter), unit: "USDG/HIMS", label: { en: `Highest post-swap pool price: HIMS at ${px(peak.priceAfter)} USDG (the swap itself paid ${px(peakPaid)} USDG per HIMS on average), with almost no liquidity left in range`, zh: `最高成交後池價：HIMS ${px(peak.priceAfter)} USDG（這筆交易本身平均每 HIMS 付 ${px(peakPaid)} USDG），當下區間內幾乎沒有流動性` } });
  const maxClose = hu.close[kMaxClose] as number;
  add({ id: "peak-close", ts: t[kMaxClose], kind: "peak", amount: sig6(maxClose), unit: "USDG/HIMS", label: { en: `Highest minute close: HIMS ${px(maxClose)} USDG, ${fmt((maxClose / NAV - 1) * 100, 0)}% over the NYSE close`, zh: `最高分鐘收盤：HIMS ${px(maxClose)} USDG，比紐約收盤價高 ${fmt((maxClose / NAV - 1) * 100, 0)}%` } });
  add({ id: "min-hims-dollar-pool", ts: t[kMinHims], kind: "note", amount: sig6(inv.himsInHimsUsdg[kMinHims]), unit: "HIMS", label: { en: `Dollar pool down to ${fmt(inv.himsInHimsUsdg[kMinHims], 2)} HIMS (against ${fmt(inv.usdgInHimsUsdg[kMinHims], 0)} USDG)`, zh: `美元池只剩 ${fmt(inv.himsInHimsUsdg[kMinHims], 2)} HIMS（對上 ${fmt(inv.usdgInHimsUsdg[kMinHims], 0)} USDG）` } });
  const bonerShare = (inv.himsInBonerHims[kMaxBonerPool] / ss.himsSupply[kMaxBonerPool]) * 100;
  add({ id: "max-hims-boner-pool", ts: t[kMaxBonerPool], kind: "note", amount: sig6(inv.himsInBonerHims[kMaxBonerPool]), unit: "HIMS", label: { en: `BONER/HIMS pool holds ${fmt(inv.himsInBonerHims[kMaxBonerPool], 0)} HIMS, ${fmt(bonerShare, 1)}% of the frozen supply`, zh: `BONER/HIMS 池持有 ${fmt(inv.himsInBonerHims[kMaxBonerPool], 0)} HIMS，占凍結流通量的 ${fmt(bonerShare, 1)}%` } });
  add({ id: "min-push-up", ts: t[kMinPush], kind: "note", amount: sig6(inv.pushUp10CostUsdg[kMinPush]), unit: "USDG", label: { en: `Cheapest moment to push HIMS +10%: ${fmt(inv.pushUp10CostUsdg[kMinPush], 2)} USDG round trip`, zh: `把 HIMS 推高 10% 最便宜的時刻：往返成本 ${fmt(inv.pushUp10CostUsdg[kMinPush], 2)} USDG` } });
  (notable.arbitrages as any[]).forEach((a, i) => add({ id: `arb-${i + 1}`, ts: huT.find((r) => r.tx === a.tx)!.ts, block: a.block, tx: a.tx, kind: "arb", amount: a.grossUsdgFromSwapDeltas, unit: "USDG", label: { en: `4-hop arbitrage USDG→HIMS→BONER→AI→USDG: gross +${a.grossUsdgFromSwapDeltas} USDG`, zh: `四跳循環套利 USDG→HIMS→BONER→AI→USDG：毛利 +${a.grossUsdgFromSwapDeltas} USDG` } }));
  if (kCalm >= 0) {
    const mins = Math.round((t[kCalm] - firstMint.ts) / 60);
    add({ id: "premium-gone", ts: t[kCalm], kind: "note", amount: sig6(d.himsPremiumPct[kCalm]), unit: "%", label: { en: `HIMS back within 2% of the NYSE close, ${mins} minutes after the first mint; the premium never tops 10% again`, zh: `首筆鑄造後 ${mins} 分鐘，HIMS 回到紐約收盤價 2% 以內；此後溢價再也沒有超過 10%` } });
  }
  add({ id: "boner-peak-via-hims", ts: t[kMaxVia], kind: "peak", amount: sig6(d.bonerUsdgViaHims[kMaxVia]), unit: "USDG/BONER", label: { en: `BONER's highest minute close through HIMS: $${d.bonerUsdgViaHims[kMaxVia]!.toPrecision(3)}`, zh: `BONER 經由 HIMS 換算的最高分鐘收盤：${d.bonerUsdgViaHims[kMaxVia]!.toPrecision(3)} 美元` } });
  add({ id: "nyse-open-mon", ts: REF.nyseOpenMon, kind: "nyse", label: { en: "NYSE opens", zh: "紐約證交所開盤" } });
  events.sort((a, b) => a.ts - b.ts);

  // 3. notable swaps (prices recomputed from the raw tape)
  const huIdx = (tx: string, logIndex?: number) => huT.findIndex((r) => r.tx === tx && (logIndex === undefined || r.logIndex === logIndex));
  const moves = huT.map((r, i) => ({ r, i, prev: huT[i - 1] }))
    .filter(({ r, prev }) => prev && inWin(r) && quoteHu(r) && quoteHu(prev))
    .map(({ r, i, prev }) => ({ r, i, before: usdgPerHims(prev.sqrtPriceX96), after: usdgPerHims(r.sqrtPriceX96) }));
  const drop = moves.reduce((m, x) => (x.after / x.before < m.after / m.before ? x : m));
  const huWin = huT.filter(inWin), bhWin = bhT.filter(inWin), buWin = buT.filter(inWin);
  const bigBuy = huWin.reduce((m, r) => (r.amount1 > m.amount1 ? r : m));
  const bigInflow = bhWin.reduce((m, r) => (r.amount1 < m.amount1 ? r : m));
  const bigBonerBuy = buWin.reduce((m, r) => (r.amount0 < m.amount0 ? r : m));
  const hims = (x: bigint) => fmt(Math.abs(units(x, 18)), 2), usdg = (x: bigint) => fmt(Math.abs(units(x, 6)), 2);
  const nsHu = (r: SwapRow, en: string, zh: string) =>
    ({ pool: "himsUsdg", ts: r.ts, block: r.block, logIndex: r.logIndex, tx: r.tx, usdgPerHims: sig6(quoteHu(r) ? usdgPerHims(r.sqrtPriceX96) : null), avgUsdgPerHims: sig6(PRICE.himsUsdg.avg(r)), note: en, noteZh: zh });
  const avgOf = (r: SwapRow) => fmt(PRICE.himsUsdg.avg(r)!, 2);
  const iDrain = huIdx(drained.swap.tx, drained.swap.logIndex), iRestore = huIdx(drained.nextSwap.tx, drained.nextSwap.logIndex);
  const iPeak = huIdx(peak.tx, peak.logIndex), iMin = huIdx(notable.minPriceHimsUsdg.tx, notable.minPriceHimsUsdg.logIndex);
  const iBefore = huIdx(notable.firstMintAfterFriday.lastHimsUsdgSwapBefore.tx, notable.firstMintAfterFriday.lastHimsUsdgSwapBefore.logIndex);
  const iAfter = huIdx(notable.firstMintAfterFriday.firstHimsUsdgSwapAfter.tx, notable.firstMintAfterFriday.firstHimsUsdgSwapAfter.logIndex);
  const pct = (a: number, b: number) => fmt((a / b - 1) * 100, 1);
  const notableSwaps: any[] = [
    nsHu(huT[iMin], `Lowest post-swap HIMS pool price in the window, Friday before the NYSE close (${hims(huT[iMin].amount1)} HIMS sold)`, `觀察期間內 HIMS 最低的成交後池價，週五紐約收盤前（賣出 ${hims(huT[iMin].amount1)} HIMS）`),
    nsHu(huT[iDrain], `Bought the last ${hims(huT[iDrain].amount1)} HIMS for ${usdg(huT[iDrain].amount0)} USDG: zero liquidity left in range, the v4 price ran to the tick limit (no quote)`, `以 ${usdg(huT[iDrain].amount0)} USDG 買走最後 ${hims(huT[iDrain].amount1)} HIMS：區間內流動性歸零，v4 價格衝到 tick 上限（沒有報價）`),
    nsHu(huT[iRestore], `Same second: a ${hims(huT[iRestore].amount1)} HIMS sale restores a real price`, `同一秒內：賣出 ${hims(huT[iRestore].amount1)} HIMS，價格恢復成真實報價`),
    nsHu(huT[iPeak], `Highest post-swap pool price with liquidity in range: ${hims(huT[iPeak].amount1)} HIMS bought for ${usdg(huT[iPeak].amount0)} USDG (${avgOf(huT[iPeak])} USDG per HIMS on average, fee included) left the pool price ${pct(usdgPerHims(huT[iPeak].sqrtPriceX96), usdgPerHims(huT[iPeak - 1].sqrtPriceX96))}% higher`, `區間內仍有流動性時的最高成交後池價：以 ${usdg(huT[iPeak].amount0)} USDG 買進 ${hims(huT[iPeak].amount1)} HIMS（含手續費平均每 HIMS ${avgOf(huT[iPeak])} USDG），讓池價單筆上漲 ${pct(usdgPerHims(huT[iPeak].sqrtPriceX96), usdgPerHims(huT[iPeak - 1].sqrtPriceX96))}%`),
    nsHu(huT[iBefore], "Last dollar-pool swap before the first Monday mint (00:43:30 UTC)", "週一首筆鑄造（UTC 00:43:30）前，美元池最後一筆交易"),
    nsHu(huT[iAfter], "First dollar-pool swap after the first Monday mint", "週一首筆鑄造後，美元池第一筆交易"),
    nsHu(drop.r, `Largest one-swap drop: ${hims(drop.r.amount1)} HIMS sold at ${avgOf(drop.r)} USDG on average, pool price ${fmt(drop.before, 2)} → ${fmt(drop.after, 2)} USDG (${pct(drop.after, drop.before)}%)`, `單筆最大跌幅：以平均 ${avgOf(drop.r)} USDG 賣出 ${hims(drop.r.amount1)} HIMS，池價 ${fmt(drop.before, 2)} → ${fmt(drop.after, 2)} USDG（${pct(drop.after, drop.before)}%）`),
    nsHu(bigBuy, `Largest HIMS purchase from the dollar pool: ${hims(bigBuy.amount1)} HIMS for ${usdg(bigBuy.amount0)} USDG`, `美元池單筆最大 HIMS 買單：以 ${usdg(bigBuy.amount0)} USDG 買進 ${hims(bigBuy.amount1)} HIMS`),
    ...(notable.arbitrages as any[]).map((a, i) => {
      const r = huT[huIdx(a.tx)];
      return nsHu(r, `Arbitrage ${i + 1}, first leg: ${usdg(r.amount0)} USDG → ${hims(r.amount1)} HIMS, then BONER, AI and back to USDG (gross +${a.grossUsdgFromSwapDeltas} USDG)`, `套利 ${i + 1} 第一腿：${usdg(r.amount0)} USDG → ${hims(r.amount1)} HIMS，再經 BONER、AI 換回 USDG（毛利 +${a.grossUsdgFromSwapDeltas} USDG）`);
    }),
    { pool: "bonerHims", ts: bigInflow.ts, block: bigInflow.block, logIndex: bigInflow.logIndex, tx: bigInflow.tx, price: sig6(himsPerBoner(bigInflow.sqrtPriceX96)), avgPrice: sig6(PRICE.bonerHims.avg(bigInflow)), unit: "HIMS per BONER", note: `Largest HIMS payment into BONER/HIMS: ${hims(bigInflow.amount1)} HIMS for ${fmt(units(bigInflow.amount0, 18), 0)} BONER`, noteZh: `單筆最大 HIMS 流入 BONER/HIMS：以 ${hims(bigInflow.amount1)} HIMS 買進 ${fmt(units(bigInflow.amount0, 18), 0)} BONER` },
    { pool: "bonerUsdg", ts: bigBonerBuy.ts, block: bigBonerBuy.block, logIndex: bigBonerBuy.logIndex, tx: bigBonerBuy.tx, price: sig6(usdgPerBoner(bigBonerBuy.sqrtPriceX96)), avgPrice: sig6(PRICE.bonerUsdg.avg(bigBonerBuy)), unit: "USDG per BONER", note: `Largest USDG purchase of BONER in the main BONER/USDG pool: ${usdg(bigBonerBuy.amount0)} USDG for ${fmt(units(bigBonerBuy.amount1, 18), 0)} BONER`, noteZh: `BONER/USDG 主池單筆最大 USDG 買單：以 ${usdg(bigBonerBuy.amount0)} USDG 買進 ${fmt(units(bigBonerBuy.amount1, 18), 0)} BONER` },
  ];
  // swaps whose post-swap price is not a quote although liquidity stayed in range (pools-swaps.ts isQuote): the
  // pool price they left is where they ran out of input in a far, thin position, so high/low leave them out
  const MAIN_NAMES = { himsUsdg: "HIMS/USDG", bonerHims: "BONER/HIMS", bonerUsdg: "BONER/USDG" } as const;
  const BASE_QUOTE = { himsUsdg: ["HIMS", "USDG"], bonerHims: ["BONER", "HIMS"], bonerUsdg: ["BONER", "USDG"] } as const;
  const CUR = { himsUsdg: ["USDG", "HIMS"], bonerHims: ["BONER", "HIMS"], bonerUsdg: ["USDG", "BONER"] } as const;
  const p3 = (x: number) => x.toPrecision(3);
  const overshoots = (notable.overshoots.swaps as any[]).filter((o) => o.swap.pool in MAIN_NAMES).map((o) => {
    const sw_ = o.swap, pool = sw_.pool as keyof typeof MAIN_NAMES, [base, quote] = BASE_QUOTE[pool], [c0, c1] = CUR[pool];
    const buy = sw_.amount0 < 0; // the trader paid currency0
    const paid = { amount: Math.abs(buy ? sw_.amount0 : sw_.amount1), sym: buy ? c0 : c1 }, got = { amount: Math.abs(buy ? sw_.amount1 : sw_.amount0), sym: buy ? c1 : c0 };
    const liqPct = (Number(sw_.liquidity) / Number(sw_.liquidityBefore)) * 100;
    const same = o.nextSwap && o.nextSwap.block === sw_.block;
    return { o, pool, name: MAIN_NAMES[pool], base, quote, paid, got, liqPct, same, post: sw_.priceAfter as number, avg: sw_.avgPrice as number, next: o.nextSwap?.priceAfter as number | undefined, ratio: o.postOverAvg as number };
  });
  for (const x of overshoots) {
    const sw_ = x.o.swap, amt = (a: { amount: number; sym: string }) => `${fmt(a.amount, a.sym === "USDG" ? 2 : 0)} ${a.sym}`;
    notableSwaps.push({
      pool: x.pool, ts: sw_.ts, block: sw_.block, logIndex: sw_.logIndex, tx: sw_.tx, ...(x.pool === "himsUsdg" ? { usdgPerHims: null, avgUsdgPerHims: sig6(x.avg) } : { price: null, avgPrice: sig6(x.avg), unit: `${x.quote} per ${x.base}` }),
      note: `Not a quote, left out of high/low: ${amt(x.paid)} paid for ${amt(x.got)} (${p3(x.avg)} ${x.quote} per ${x.base} on average) ran through the ${x.name} range and stopped in a far, thin position at a pool price of ${p3(x.post)}, ${fmt(x.ratio, 0)}x what it paid, with ${fmt(x.liqPct, 1)}% of the previous swap's in-range liquidity; the next swap${x.same ? " in the same block" : ""} took the price back to ${x.next === undefined ? "n/a" : p3(x.next)}`,
      noteZh: `不是報價，不計入最高／最低值：以 ${amt(x.paid)} 換得 ${amt(x.got)}（平均每 ${x.base} ${p3(x.avg)} ${x.quote}），穿過 ${x.name} 池的價格區間，停在遠處流動性極薄的位置，留下 ${p3(x.post)} 的池價，是實際平均成交價的 ${fmt(x.ratio, 0)} 倍，區間內流動性只剩前一筆交易後的 ${fmt(x.liqPct, 1)}%；${x.same ? "同一個區塊內的" : ""}下一筆交易把價格拉回 ${x.next === undefined ? "n/a" : p3(x.next)}`,
    });
  }
  notableSwaps.sort((a, b) => a.ts - b.ts || a.block - b.block || a.logIndex - b.logIndex);

  // 4. anchors: ours next to what others reported
  const anchors: any[] = [];
  const at = (tape: SwapRow[], block: number) => lastAtOrBefore(tape, block)!;
  const FLOAT_PRICE: Record<number, number> = { 48_555_213: 28.17, 49_125_754: 30.36, 49_980_825: 29.68, 50_265_277: 29.38, 50_415_299: 43.27, 50_772_447: 29.48 };
  for (const r of sev.defiprimeFloat as any[]) {
    const s = at(huT, r.block), p = usdgPerHims(s.sqrtPriceX96), supply = Number(r.supply.measured), pm = Number(r.inPoolManager.measured);
    anchors.push({
      label: `DeFiPrime float table, ${r.label} UTC`, ts: r.ts, block: r.block,
      ours: { himsSupply: sig6(supply), himsInPoolManager: sig6(pm), usdgPerHims: sig6(p), priceSwapTx: s.tx },
      reference: { himsSupply: r.supply.reference, himsInUniswapV4: r.inPoolManager.reference, usdgPerHims: FLOAT_PRICE[r.block], source: DEFIPRIME },
      match: worst([matchLevel(supply, r.supply.reference, { decimals: 1 }), matchLevel(pm, r.inPoolManager.reference, { decimals: 1 }), matchLevel(p, FLOAT_PRICE[r.block], { decimals: 2 })]),
      note: `supply and PoolManager HIMS equal totalSupply() and balanceOf(PoolManager) on the archive node to the wei (${fmt(supply, 3)} / ${fmt(pm, 3)}); the price is the last HIMS/USDG swap at or before the block (${hms(s.ts)} UTC), which the archive's slot0 confirms`,
    });
  }
  const PROGRESSION: [string, number, number | null][] = [
    ["2026-08-30T21:46:00Z", 29.73, 3.1], ["2026-08-30T22:28:00Z", 36.22, null], ["2026-08-30T23:02:00Z", 39.94, 38.5], ["2026-08-30T23:36:00Z", 61.15, 112.0],
    ["2026-08-30T23:53:00Z", 43.27, null], ["2026-08-31T00:13:00Z", 34.33, null], ["2026-08-31T00:43:00Z", 54.5, 89.0], ["2026-08-31T00:47:00Z", 55.61, null],
    ["2026-08-31T00:55:00Z", 32.37, null], ["2026-08-31T01:59:00Z", 29.31, 1.6],
  ];
  for (const [when, ref, refPrem] of PROGRESSION) {
    const t0 = Date.parse(when) / 1000, k = (t0 - GRID.start) / GRID.step;
    const carried = [...huT].reverse().find((r) => r.ts <= t0 && quoteHu(r))!;
    const cands = [carried, ...huT.filter((r) => r.ts >= t0 && r.ts < t0 + 60 && quoteHu(r))];
    const best = cands.reduce((m, r) => (Math.abs(usdgPerHims(r.sqrtPriceX96) - ref) < Math.abs(usdgPerHims(m.sqrtPriceX96) - ref) ? r : m));
    const p = usdgPerHims(best.sqrtPriceX96), prem = (p / NAV - 1) * 100;
    anchors.push({
      label: `DeFiPrime price progression, ${day(t0, "en")} ${hm(t0)} UTC`, ts: t0, block: best.block,
      ours: { usdgPerHims: sig6(p), premiumPct: sig6(prem), swapTs: best.ts, swapTx: best.tx, closeAtMinute: sig6(hu.close[k]), barHigh: sig6(hu.high[k + 1]), barLow: sig6(hu.low[k + 1]), barSwaps: hu.count[k + 1] },
      reference: { usdgPerHims: ref, ...(refPrem !== null ? { premiumPct: refPrem } : {}), source: DEFIPRIME },
      match: worst([matchLevel(p, ref, { decimals: 2 }), ...(refPrem !== null ? [matchLevel(prem, refPrem, { decimals: 1 })] : [])]),
      note: `DeFiPrime quotes a single swap; ours is ${best === carried ? `the price carried into ${hm(t0)} (last swap ${hms(best.ts)} UTC)` : `the swap at ${hms(best.ts)} UTC`}; the bar ending ${hm(t0 + 60)} ranged ${px(hu.low[k + 1])}–${px(hu.high[k + 1])} over ${hu.count[k + 1]} swaps, and the grid close was ${px(hu.close[k])} at ${hm(t0)} and ${px(hu.close[k + 1])} at ${hm(t0 + 60)}`,
    });
  }
  const RESEARCH_TABLE: [number, number, number, number][] = [
    [50_265_277, 29.3819, 2606.37, 7067.68], [50_415_299, 43.2709, 66.56, 12478.33], [50_444_948, 54.497, 32.43, 12795.52], [50_490_000, 29.3114, 2035.63, 16968.08], [50_772_447, 29.4802, 2566.93, 18528.59],
  ];
  const pointTs = (block: number) => (replay.points as any[]).find((p) => Number(p.block) === block).timestamp as number;
  for (const [block, spot, huHims, bhHims] of RESEARCH_TABLE) {
    const rc = (inv.researchCheck as any[]).find((r) => r.block === block);
    const p = usdgPerHims(at(huT, block).sqrtPriceX96);
    const maxDiff = Math.max(Math.abs(rc.himsUsdg.absDiff), Math.abs(rc.bonerHims.absDiff));
    anchors.push({
      label: `Earlier research, block ${fmt(block, 0)}`, ts: pointTs(block), block,
      ours: { usdgPerHims: sig6(p), himsInHimsUsdg: sig6(rc.himsUsdg.himsPrincipal), himsInBonerHims: sig6(rc.bonerHims.himsPrincipal), activeLiquidityEqual: rc.himsUsdg.activeLiquidityEqual && rc.bonerHims.activeLiquidityEqual },
      reference: { usdgPerHims: spot, himsInHimsUsdg: huHims, himsInBonerHims: bhHims, source: RESEARCH },
      match: worst([matchLevel(p, spot, { decimals: 4 }), matchLevel(rc.himsUsdg.himsPrincipal, huHims, { decimals: 2 }), matchLevel(rc.bonerHims.himsPrincipal, bhHims, { decimals: 2 })]),
      note: `curve principal at the end of the block, rebuilt from every ModifyLiquidity since Initialize; within ${maxDiff.toExponential(1)} HIMS of the research's unrounded values, and both pools' active liquidity is string-equal to it`,
    });
  }
  for (const rp of replay.points as any[]) {
    const block = Number(rp.block), mine = (inv.replayCheck as any[]).find((r) => r.block === block);
    const kk = barIndex(rp.timestamp);
    anchors.push({
      label: `HAKARI hims-replay, block ${fmt(block, 0)}`, ts: rp.timestamp, block,
      ours: { pushUp10CostUsdg: sig6(Number(mine.ours.pushUp10.roundTripCostUsdg)), pushDown10CostHims: sig6(Number(mine.ours.pushDown10.roundTripCostHims)), himsInHimsUsdg: sig6(Number(mine.ours.himsPrincipal)), gridPushUp10CostUsdg: sig6(inv.pushUp10CostUsdg[kk]), gridTs: t[kk] },
      reference: { pushUp10CostUsdg: Number(rp.pushUp10.roundTripCostUsdg), pushDown10CostHims: Number(rp.pushDown10.roundTripCostHims), himsInHimsUsdg: Number(rp.himsPrincipal), source: REPLAY },
      match: mine.identical ? "exact" : worst([matchLevel(Number(mine.ours.pushUp10.roundTripCostUsdg), Number(rp.pushUp10.roundTripCostUsdg), { decimals: 6 })]),
      note: mine.identical
        ? `the minute sweep's state at the end of this block reproduces hims-replay.json field by field (costs to the micro-USDG / wei, fee ${rp.swapFeePips} pips); the grid point ${hm(t[kk])} UTC, which also includes later events up to that second, gives ${fmt(inv.pushUp10CostUsdg[kk], 2)} USDG`
        : `differs from hims-replay.json: ${mine.diffs.join("; ")}`,
    });
  }
  const facts = sev.defiprimeFacts;
  anchors.push({
    label: "DeFiPrime: Friday redemption burns", ts: burns[0].ts, block: burns[0].block,
    ours: { amountsHims: burns.map((b) => b.amount), times: burns.map((b) => hms(b.ts)), from: burns[0].from },
    reference: { amountsHims: [500, 400], times: ["20:37", "21:21"], from: "0xa8553db0049fc6843c0d00d0efc08d31848e3c74", source: DEFIPRIME },
    match: facts.burnsFriday.matches ? "exact" : "differs", note: "the only two HIMS burns in the window; both from the redemption wallet, both signed by 0x6e40…d8c1",
  });
  anchors.push({
    label: "DeFiPrime: first mint after Friday", ts: firstMint.ts, block: firstMint.block,
    ours: { time: hms(firstMint.ts), amountHims: firstMint.amount, tx: firstMint.tx, signer: firstMint.txFrom },
    reference: { time: "00:43:30", amountHims: 1000, tx: "0x459aee54624bbef4ccabb6e872ec08414c97cd97bda4f92048cabb011e5a066b", signer: "0x2b94105fff37630f98e1f24811dad588fc5c3a87", source: DEFIPRIME },
    match: facts.firstMintAfterWeekend.matches ? "exact" : "differs", note: `no mint in the window before it; the previous HIMS mint was at block ${extra.lastMint ? fmt(extra.lastMint.block, 0) : "?"}, before the window`,
  });
  anchors.push({
    label: "DeFiPrime: Monday mints 00:43–09:54 UTC", ts: firstMint.ts, block: MON_0954_BLOCK,
    ours: { count: monday.count, totalHims: sig6(Number(monday.total)), burns: monday.burnsInRange },
    reference: { count: 294, totalHims: 18750.5, burns: 0, source: DEFIPRIME },
    match: monday.count === 294 && monday.burnsInRange === 0 ? matchLevel(Number(monday.total), 18750.5, { decimals: 1 }) : "differs",
    note: `blocks ${fmt(monday.fromBlock, 0)}–${fmt(MON_0954_BLOCK, 0)}; exact total ${monday.total} HIMS, all to ${short(sev.mintRecipients[0].address)}; ${sev.clusters.mintsInWindowAfterMon0954} more mints follow before 14:00 UTC`,
  });
  const bonerAt = (block: number) => {
    const via = himsPerBoner(at(bhT, block).sqrtPriceX96) * usdgPerHims(at(huT, block).sqrtPriceX96), direct = usdgPerBoner(at(buT, block).sqrtPriceX96);
    return { via, direct };
  };
  for (const [block, ref, sigd, when] of [[48_555_213, 0.0036, 2, "Friday"], [50_265_277, 0.0024, 2, "Sunday evening"], [MON_0954_BLOCK, 0.0147, 3, "Monday 09:54 UTC"]] as const) {
    const b = bonerAt(block), row = floatRow(block);
    anchors.push({
      label: `DeFiPrime: BONER in USD, ${when}`, ts: row.ts, block,
      ours: { usdgPerBonerViaHims: sig6(b.via), usdgPerBonerDirect: sig6(b.direct), ...(block === MON_0954_BLOCK ? { impliedCapUsd: sig6(b.via * 1e9) } : {}) },
      reference: { usdPerBoner: ref, ...(block === MON_0954_BLOCK ? { impliedCapUsd: 14_700_000 } : {}), source: DEFIPRIME },
      match: worst([matchLevel(b.via, ref, { sig: sigd, closeRel: 0.05 }), ...(block === MON_0954_BLOCK ? [matchLevel(b.via * 1e9, 14_700_000, { sig: 3, closeRel: 0.05 })] : [])]),
      note: `BONER/HIMS times HIMS/USDG at the last swaps at or before block ${fmt(block, 0)} (${row.label} UTC); the direct BONER/USDG pool quoted ${sig6(b.direct)}${when === "Sunday evening" ? "; DeFiPrime says only 'Sunday evening', compared at its Sun 19:40 float-table block" : ""}`,
    });
  }
  const kEv0 = barIndex(Date.parse("2026-08-30T20:00:00Z") / 1000), kEv1 = barIndex(Date.parse("2026-08-31T02:00:00Z") / 1000);
  let kSammy = kEv0;
  for (let k = kEv0; k <= kEv1; k++) {
    const fit = (j: number) => Math.abs(inv.himsInHimsUsdg[j] - 92) / 92 + Math.abs(inv.usdgInHimsUsdg[j] - 135_000) / 135_000;
    if (fit(k) < fit(kSammy)) kSammy = k;
  }
  anchors.push({
    label: "@0xSammy during the event: ~92 HIMS against ~$135K USDG in the dollar pool", ts: t[kSammy], block: null,
    ours: { himsInHimsUsdg: sig6(inv.himsInHimsUsdg[kSammy]), usdgInHimsUsdg: sig6(inv.usdgInHimsUsdg[kSammy]) },
    reference: { himsInHimsUsdg: 92, usdgInHimsUsdg: 135_000, source: "@0xSammy on X, as cited by DeFiPrime" },
    match: worst([matchLevel(inv.himsInHimsUsdg[kSammy], 92, { sig: 2, closeRel: 0.1 }), matchLevel(inv.usdgInHimsUsdg[kSammy], 135_000, { sig: 3, closeRel: 0.1 })]),
    note: `the post gives no time; the best-fitting grid minute between Sun 20:00 and Mon 02:00 UTC is ${day(t[kSammy], "en")} ${hm(t[kSammy])} UTC (curve principal of the HIMS/USDG pool)`,
  });
  anchors.push({
    label: "DeFiPrime: BONER/HIMS pool held about 13,100 of 15,227 HIMS (~86%) at the peak", ts: t[kMaxBonerPool], block: null,
    ours: { himsInBonerHims: sig6(inv.himsInBonerHims[kMaxBonerPool]), shareOfSupplyPct: sig6(bonerShare) },
    reference: { himsInBonerHims: 13_100, shareOfSupplyPct: 86, source: DEFIPRIME },
    match: worst([matchLevel(inv.himsInBonerHims[kMaxBonerPool], 13_100, { sig: 3, closeRel: 0.05 }), matchLevel(bonerShare, 86, { sig: 2, closeRel: 0.05 })]),
    note: `our largest minute value before the first Monday mint (${hm(t[kMaxBonerPool])} UTC; curve principal, uncollected fees excluded); DeFiPrime gives no exact moment`,
  });
  const k0954 = barIndex(floatRow(MON_0954_BLOCK).ts) - 1; // grid point 09:54:00, just before the block
  const buTvl = inv.usdgInBonerUsdg[k0954] + inv.bonerInBonerUsdg[k0954] * bu.close[k0954];
  anchors.push({
    label: "DeFiPrime: the largest BONER/USDG pool held about $160K", ts: t[k0954], block: null,
    ours: { poolId: main3.bonerUsdg.id, valueUsdg: sig6(buTvl), usdg: sig6(inv.usdgInBonerUsdg[k0954]), boner: sig6(inv.bonerInBonerUsdg[k0954]) },
    reference: { valueUsd: 160_000, source: DEFIPRIME },
    match: matchLevel(buTvl, 160_000, { sig: 2, closeRel: 0.05 }),
    note: `USDG plus BONER at the pool price, curve principal at ${hm(t[k0954])} UTC Monday (the article's last table row); the pool was picked by window swap volume, and its value moves a lot over the window (up to ${fmt(Math.max(...inv.usdgInBonerUsdg.map((u: number, j: number) => u + inv.bonerInBonerUsdg[j] * bu.close[j])), 0)} USDG before 14:00)`,
  });
  const ARB_REF: Record<string, number> = { "0x885e483376149b0e53f68df7122383a135528d86fa8c3c2f33497dd875ae6b58": 2.712406, "0x7cad4c90c45c8ff09e1071fbc057cc0b28a455901a9c3b3d9371b1f95b491a42": 5.611365 };
  for (const a of notable.arbitrages as any[]) {
    anchors.push({
      label: `Earlier research: 4-hop arbitrage at block ${fmt(a.block, 0)}`, ts: huT.find((r) => r.tx === a.tx)!.ts, block: a.block,
      ours: { grossUsdg: a.grossUsdgFromSwapDeltas, swapEvents: a.swapEvents, path: a.path.join(" > ") },
      reference: { grossUsdg: ARB_REF[a.tx], source: RESEARCH },
      match: matchLevel(a.grossUsdgFromSwapDeltas, ARB_REF[a.tx], { decimals: 6 }),
      note: "sum of the USDG legs' Swap deltas; six Swap events because the BONER/HIMS hook swaps twice inside the transaction; gross only, gas and any off-log cost not deducted",
    });
  }

  // 5. checks: the collectors' exactness, then this file's integrity
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const NAMES = { himsUsdg: "HIMS/USDG", bonerHims: "BONER/HIMS", bonerUsdg: "BONER/USDG" } as const;
  check("Main pool keys", main3.himsUsdg.id === POOL_HIMS_USDG && main3.bonerHims.id === POOL_BONER_HIMS && main3.bonerUsdg.currency0 === "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    "HIMS/USDG and BONER/HIMS PoolKeys verified against their Initialize logs; BONER/USDG is the USDG/BONER pool with the largest window USDG volume");
  const disc = pools.meta.discovery, cov = disc.coverage, deployBlock = sev.deployment?.codeFirstAtBlock;
  check("Pool discovery covers every HIMS pool", !!cov?.complete && deployBlock != null && Number(disc.fromBlock) <= deployBlock,
    cov ? `Initialize logs with HIMS or BONER from block ${fmt(Number(disc.fromBlock), 0)} (HIMS deployed at ${deployBlock == null ? "?" : fmt(deployBlock, 0)}): ${pools.all.length} pools. Of ${fmt(cov.txs, 0)} window txs moving HIMS in or out of the PoolManager, ${fmt(cov.swap.txs, 0)} swap in a discovered HIMS pool and ${fmt(cov.liquidityOrDonate.txs, 0)} change its liquidity; ${cov.protocolFees?.txs ?? 0} (${fmt(cov.protocolFees?.himsMoved ?? 0, 1)} HIMS) are protocol fees taken out by the PoolManager's fee controller; ${fmt(cov.noHimsPoolEvent.txs, 0)} (${fmt(cov.noHimsPoolEvent.himsMoved, 1)} HIMS) touch no HIMS pool, ${cov.undiscoveredPool.txs} an undiscovered pool, ${cov.tapeGap.txs} a swap missing from the tapes`
      : "pools.json has no coverage section (rerun squeeze/pools-swaps.ts)");
  for (const [p, name] of Object.entries(NAMES)) {
    const lc = inv.liquidityCheck[p];
    check(`${name}: rebuilt liquidity = every Swap event's liquidity`, lc.allMatch, `${lc.match}/${lc.swaps} swaps exact as BigInt (${lc.windowMatch}/${lc.windowSwaps} inside the window)`);
    const ac = inv.archiveCheck.pools[p];
    check(`${name}: rebuild = StateView on the archive node`, ac.allMatch, `sqrtPrice ${ac.sqrtPriceExact}, tick ${ac.tickExact}, liquidity ${ac.liquidityExact} exact of ${ac.blocksChecked} blocks (every 10 min, every minute Sun 21:30–Mon 02:00 UTC, and the named blocks)`);
    const tc = notable.archiveChecks.pools[p];
    check(`${name}: swap tape = archive slot0`, tc.priceMismatches === 0, `${tc.priceExact}/${tc.blocksChecked} sampled blocks: slot0 just before the next swap equals the swap behind the minute close (no missed swap)`);
  }
  const head = sev.headCheck;
  check("HIMS totalSupply rebuilt to the wei at the head", head.totalSupply.exact, `block ${fmt(head.block, 0)}: ${formatUnits(BigInt(head.totalSupply.reconstructed), 18)} HIMS from ${head.logs.mints} mints and ${head.logs.burns} burns since deployment`);
  check("PoolManager HIMS balance rebuilt to the wei at the head", head.poolManagerBalance.exact, `block ${fmt(head.block, 0)}: ${formatUnits(BigInt(head.poolManagerBalance.reconstructed), 18)} HIMS from ${fmt(head.logs.deduped, 0)} Transfers`);
  const a10 = sup.checks.archiveEvery10Min;
  check("Supply and PoolManager balance = archive every 10 minutes", a10.totalSupply.mismatches === 0 && a10.poolManagerBalance.mismatches === 0, `${a10.points} grid points: totalSupply ${a10.totalSupply.mismatches} mismatches, balanceOf(PoolManager) ${a10.poolManagerBalance.mismatches} (max diff ${a10.poolManagerBalance.maxAbsDiffWei} wei)`);
  const rpc = inv.replayCheck as any[];
  check("gauge/data/hims-replay.json reproduced", rpc.every((r) => r.identical), `${rpc.filter((r) => r.identical).length}/${rpc.length} blocks identical field by field (price, liquidity, principal, ±10% push)`);
  const rc = inv.researchCheck as any[];
  check("Earlier research active liquidity reproduced", rc.every((r) => r.himsUsdg.activeLiquidityEqual && r.bonerHims.activeLiquidityEqual), `${rc.length} blocks, both pools, string-equal; principal within ${Math.max(...rc.flatMap((r) => [Math.abs(r.himsUsdg.absDiff), Math.abs(r.bonerHims.absDiff)])).toExponential(1)} HIMS`);
  const ml = inv.modifyLiquidity;
  const mlOk = ["himsUsdg", "bonerHims"].every((p) => JSON.stringify(ml[p].researchRange.ours) === JSON.stringify(ml[p].researchRange.research));
  check("ModifyLiquidity counts = earlier research", mlOk && ml.himsUsdgUpToReplayEnd.ours === ml.himsUsdgUpToReplayEnd.replay, `blocks 48,555,213–50,444,948 adds/removes/zero: HIMS/USDG ${Object.values(ml.himsUsdg.researchRange.ours).join("/")}, BONER/HIMS ${Object.values(ml.bonerHims.researchRange.ours).join("/")}; HIMS/USDG logs to block 50,772,447: ${ml.himsUsdgUpToReplayEnd.ours} (replay ${ml.himsUsdgUpToReplayEnd.replay})`);
  check("DeFiPrime supply facts", facts.burnsFriday.matches && facts.firstMintAfterWeekend.matches && facts.mondayMints.matches && (sev.defiprimeFloat as any[]).every((r) => r.supply.withinRounding && r.inPoolManager.withinRounding && r.supply.exactVsArchive && r.inPoolManager.exactVsArchive),
    "Friday burns, first Monday mint, 294 Monday mints, and all 12 float-table supply / in-v4 values (within the table's rounding, equal to the archive's)");
  check("4-hop arbitrage gross from swap deltas", (notable.arbitrages as any[]).every((a) => a.matches), (notable.arbitrages as any[]).map((a) => `${short(a.tx)} ${a.grossUsdgFromSwapDeltas} USDG`).join(", "));
  const bs = sev.tokens.BONER;
  check("BONER supply is 1e9 across the window", bs.totalSupplyAtWindowStart === "1000000000" && bs.totalSupplyAtWindowEnd === "1000000000", `totalSupply at blocks ${bs.windowBlocks.join(" and ")}: ${bs.totalSupplyAtWindowStart} / ${bs.totalSupplyAtWindowEnd}`);
  const pi = inv.pushIncomplete;
  check("Every ±10% push walk completes", !pi.up10.length && !pi.down10.length && !pi.noQuote.length, `incomplete up ${pi.up10.length}, down ${pi.down10.length}, no quote ${pi.noQuote.length} of ${n} minutes`);
  const tail = extra.tail;
  if (!tail) check("Pool tapes reach every block with timestamp <= toTs", false, `not verified: ${extra.errors.join("; ")}`);
  else {
    const perPool = Object.entries(NAMES).map(([p, name]) => `${name} ${tail.logs.filter((l) => l.id === main3[p].id && l.event === "Swap").length} swaps / ${tail.logs.filter((l) => l.id === main3[p].id && l.event === "ModifyLiquidity").length} LP changes`);
    check("Pool tapes reach every block with timestamp <= toTs", tail.logs.length === 0,
      lastBlock > Number(WINDOW_END_BLOCK)
        ? `the tapes end at block ${fmt(Number(WINDOW_END_BLOCK), 0)}; blocks ${tail.range.split("-").map((b) => fmt(Number(b), 0)).join("–")} share its timestamp ${hms(WINDOW_END_TS)} UTC (${Object.values(tail.blockTs).every((x) => x === WINDOW_END_TS) ? "exact headers" : "per headers"}) and ${tail.logs.length ? `hold ${perPool.join(", ")} missing from the last bar` : "hold no Swap or ModifyLiquidity of the three main pools, so the last bar is complete"}`
        : "no block after the tapes' last block has timestamp <= toTs");
  }
  // own integrity
  const tProblems = gridProblems(t, WINDOW_START_TS, WINDOW_END_TS, 60);
  const sameAxis = JSON.stringify(t) === JSON.stringify(inv.t) && JSON.stringify(t) === JSON.stringify(ss.t);
  check("Time axis", t.length === n && tProblems.length === 0 && sameAxis, `${t.length} points, ${iso(t[0])} to ${iso(t.at(-1)!)} in 60 s steps${tProblems.length ? `; ${tProblems.join("; ")}` : ""}; swaps, inventory and supply grids ${sameAxis ? "share it" : "DIFFER"}`);
  const bad = badLengths(series, n);
  check(`Every series has ${n} points`, bad.length === 0, bad.length ? `wrong: ${bad.join(", ")}` : `${Object.keys(series).length} series (OHLC groups counted once)`);
  const k0bad = ["himsUsdg", "bonerHims", "bonerUsdgDirect"].flatMap((g) => ((series as any)[g].high[0] !== null || (series as any)[g].low[0] !== null ? [g] : []))
    .concat(["volUsdgHimsUsdg", "volHimsBonerHims", "volUsdgBonerUsdg", "swapsHimsUsdg", "swapsBonerHims", "swapsBonerUsdg", "netHimsOutOfHimsUsdg", "netHimsIntoBonerHims", "himsMinted", "himsBurned"].filter((s) => (series as any)[s][0] !== 0));
  check("Bars are null/0 at k = 0", k0bad.length === 0, k0bad.length ? `not empty at k = 0: ${k0bad.join(", ")}` : "high/low null, volumes, counts, flows, mints and burns 0");
  const nullCloses = ["himsUsdg", "bonerHims", "bonerUsdgDirect"].map((g) => (series as any)[g].close.filter((x: Num) => x === null).length);
  check("No gaps in the price closes", nullCloses.every((x) => x === 0), `null closes: HIMS/USDG ${nullCloses[0]}, BONER/HIMS ${nullCloses[1]}, BONER/USDG ${nullCloses[2]} (seeded from the last swap before the window)`);
  const ohlcBad = [ohlcProblems(series.himsUsdg, hu.count), ohlcProblems(series.bonerHims, bh.count), ohlcProblems(series.bonerUsdgDirect, bu.count)];
  check("low <= close <= high in every bar with swaps", ohlcBad.every((b) => b.length === 0), `bad bars: ${ohlcBad.map((b) => b.length).join(" / ")} (HIMS/USDG, BONER/HIMS, BONER/USDG)`);
  const spikes = [spikeProblems(series.himsUsdg), spikeProblems(series.bonerHims), spikeProblems(series.bonerUsdgDirect)];
  const leftOut = [hu, bh, bu].map((x) => (x.unpriced as number[]).reduce((a, b) => a + b, 0));
  check("Bar high/low within 5x of the neighbouring closes", spikes.every((b) => b.length === 0),
    `bars beyond 5x of both the previous and their own close: ${spikes.map((b) => b.length).join(" / ")}${spikes.some((b) => b.length) ? ` (first at ${spikes.map((b) => (b.length ? iso(t[b[0]]) : "-")).join(", ")})` : ""}; swaps left out of high/low as non-quotes (range drained, or a pool price more than ${OVERSHOOT}x from what the swap paid): ${leftOut.join(" / ")} (HIMS/USDG, BONER/HIMS, BONER/USDG)`);
  const fsBad = floatSplitProblems(series.himsInHimsUsdg, series.himsInBonerHims, series.himsInPoolManager, series.himsSupply);
  check("Float split: main pools <= PoolManager <= supply", fsBad.length === 0, fsBad.length ? `violated at ${fsBad.length} points, first ${iso(t[fsBad[0]])}` : `HIMS in HIMS/USDG + BONER/HIMS <= PoolManager HIMS <= supply at all ${n} points`);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  const netSupply = ss.himsSupply.at(-1) - ss.himsSupply[0], mintedNet = sum(ss.himsMinted) - sum(ss.himsBurned);
  check("Supply change = minted - burned", Math.abs(netSupply - mintedNet) < 1e-6, `${fmt(ss.himsSupply[0], 3)} -> ${fmt(ss.himsSupply.at(-1), 3)} HIMS; minted ${fmt(sum(ss.himsMinted), 3)}, burned ${fmt(sum(ss.himsBurned), 3)}`);
  const mintEv = events.filter((e) => e.kind === "mint");
  check("Mint and burn events = supply bars", mintEv.length === sum(ss.mintCount) && Math.abs(sum(mintEv.map((e) => e.amount!)) - sum(ss.himsMinted)) < 1e-6 && burns.length === sum(ss.burnCount),
    `${mintEv.length} mint events (${sum(ss.mintCount)} in the bars), ${burns.length} burns (${sum(ss.burnCount)} in the bars)`);
  const totals = Object.entries({ himsUsdg: hu, bonerHims: bh, bonerUsdg: bu }).map(([p, s]) => {
    const w = main3[p].window;
    return { name: NAMES[p as keyof typeof NAMES], ok: sum(s.count) === w.swaps && Math.abs(sum(s.volume) - w.volume) <= w.volume * 1e-6, text: `${NAMES[p as keyof typeof NAMES]} ${sum(s.count)} swaps / ${fmt(sum(s.volume), 2)} ${w.volumeUnit}` };
  });
  check("Bars add up to the window totals", totals.every((x) => x.ok), totals.map((x) => x.text).join("; "));
  const d2 = derive(series.himsUsdg.close, series.bonerHims.close, series.bonerUsdgDirect.close, NAV);
  const off = (a: Num[], b: Num[], tol: (x: number) => number) => a.filter((x, k) => (x === null) !== (b[k] === null) || (x !== null && Math.abs(x - b[k]!) > tol(x))).length;
  const derivedOff = off(d2.bonerUsdgViaHims, series.bonerUsdgViaHims, (x) => Math.abs(x) * 2e-5) + off(d2.bonerUsdAtNav, series.bonerUsdAtNav, (x) => Math.abs(x) * 2e-5)
    + off(d2.himsPremiumPct, series.himsPremiumPct, (x) => 1e-3 * Math.max(1, Math.abs(x))) + off(d2.routeGapPct, series.routeGapPct, (x) => 5e-3 * Math.max(1, Math.abs(x)));
  const collectorVia = off(d.bonerUsdgViaHims, sw.derived.usdgPerBonerViaHims, (x) => Math.abs(x) * 1e-8);
  check("Derived series recompute from the rounded closes", derivedOff === 0 && collectorVia === 0, `${derivedOff} points off beyond rounding; BONER via HIMS equals pools-swaps.ts's own product at ${n - collectorVia}/${n} points`);

  // 6. caveats
  const lm = extra.lastMint;
  const copy = pools.otherHimsPools.active[0], buW = main3.bonerUsdg.window, bhW = main3.bonerHims.window;
  const mUsd = (x: number) => `${(x / 1e6).toFixed(x >= 1e7 ? 1 : 2)}M`, wanUsd = (x: number) => `${fmt(x / 1e4, 0)} 萬`;
  const caveats = [
    { en: `Every series sits on a 1-minute grid. A close is the state after the last event at or before that minute (carried forward); high, low, volumes and flows cover the minute ending there. Prices are post-swap pool prices, the marginal price each swap left behind, not what the swap paid: in notableSwaps, usdgPerHims / price is that pool price and avgUsdgPerHims / avgPrice what the swap paid on average, fee included. Brief states between grid points, such as the ${px(peak.priceAfter)} USDG post-swap peak or the moment the dollar pool ran dry, show only in high/low or in the events.`, zh: `所有序列都取樣在 1 分鐘格點上。收盤值是該分鐘（含）之前最後一筆事件後的狀態（向前沿用）；最高、最低、成交量與流量涵蓋截至該點的那一分鐘。價格都是成交後池價，也就是每筆交易留下的邊際價格，不是這筆交易實際付出的價格：notableSwaps 裡的 usdgPerHims／price 是這個池價，avgUsdgPerHims／avgPrice 是這筆交易含手續費的平均成交價。格點之間的短暫狀態，例如 ${px(peak.priceAfter)} USDG 的最高成交後池價或美元池被買空的那一刻，只會出現在最高／最低值或事件中。` },
    { en: "At 23:24:59 UTC one swap left the HIMS/USDG pool with no liquidity in range, which sends the v4 price to the tick limit. That swap counts in volume and flows but not in high/low; a swap in the same second restored a real price.", zh: "UTC 23:24:59 有一筆交易讓 HIMS/USDG 池的區間內流動性歸零，v4 價格因此衝到 tick 上限。這筆交易計入成交量與流量，但不計入最高／最低值；同一秒內的下一筆交易讓價格恢復成真實報價。" },
    { en: `The highest post-swap prices (up to ${px(peak.priceAfter)} USDG per HIMS) are marginal quotes left with almost no liquidity in range, not prices anyone paid: the swap that left ${px(peak.priceAfter)} bought ${fmt(Math.abs(peak.amount1), 2)} HIMS for ${fmt(Math.abs(peak.amount0), 2)} USDG, ${px(peakPaid)} USDG per HIMS on average, fee included, and in-range liquidity fell to ${fmt(peakLiqPct, 1)}% of what the previous swap left, so nobody could have sold size at that price.`, zh: `最高的成交後池價（最高每 HIMS ${px(peak.priceAfter)} USDG）是區間內幾乎沒有流動性時留下的邊際報價，不是任何人實際付出的價格：留下 ${px(peak.priceAfter)} 的那筆交易以 ${fmt(Math.abs(peak.amount0), 2)} USDG 買進 ${fmt(Math.abs(peak.amount1), 2)} HIMS，含手續費平均每 HIMS ${px(peakPaid)} USDG，交易後區間內流動性只剩前一筆交易後的 ${fmt(peakLiqPct, 1)}%，沒有人能在這個價格大量賣出。` },
    ...overshoots.map((x) => ({
      en: `A post-swap price counts in high/low only when it lies within ${OVERSHOOT}x of what the swap itself paid on average. ${overshoots.length === 1 ? "One swap in the three main pools fails that" : `${overshoots.length} swaps in the three main pools fail that`}: at ${hms(x.o.swap.ts)} UTC a ${x.name} swap paid ${fmt(x.paid.amount, x.paid.sym === "USDG" ? 2 : 0)} ${x.paid.sym} for ${fmt(x.got.amount, x.got.sym === "USDG" ? 2 : 0)} ${x.got.sym} (${p3(x.avg)} ${x.quote} per ${x.base}), ran through the pool's range and stopped in a far, thin position, leaving a pool price of ${p3(x.post)} (${fmt(x.ratio, 0)}x) with ${fmt(x.liqPct, 1)}% of the previous swap's in-range liquidity; the next swap${x.same ? " in the same block" : ""} took it back to ${x.next === undefined ? "n/a" : p3(x.next)}. Like the drained HIMS/USDG swap, it counts in volume and flows but not in high/low.`,
      zh: `成交後池價與這筆交易本身的平均成交價相差在 ${OVERSHOOT} 倍以內，才計入最高／最低值。${overshoots.length === 1 ? "三個主池裡有一筆交易不符合" : `三個主池裡有 ${overshoots.length} 筆交易不符合`}：UTC ${hms(x.o.swap.ts)}，一筆 ${x.name} 交易以 ${fmt(x.paid.amount, x.paid.sym === "USDG" ? 2 : 0)} ${x.paid.sym} 換得 ${fmt(x.got.amount, x.got.sym === "USDG" ? 2 : 0)} ${x.got.sym}（平均每 ${x.base} ${p3(x.avg)} ${x.quote}），穿過池子的價格區間，停在遠處流動性極薄的位置，留下 ${p3(x.post)} 的池價（${fmt(x.ratio, 0)} 倍），區間內流動性只剩前一筆交易後的 ${fmt(x.liqPct, 1)}%；${x.same ? "同一個區塊內的" : ""}下一筆交易就把價格拉回 ${x.next === undefined ? "n/a" : p3(x.next)}。它和 HIMS/USDG 被買空的那筆交易一樣，計入成交量與流量，但不計入最高／最低值。`,
    })).slice(0, 1),
    { en: "himsInPoolManager is the Uniswap v4 PoolManager's whole HIMS balance (every HIMS pool, unpaid fees, ERC-6909 claims), which is what DeFiPrime calls 'HIMS in Uniswap v4'. The per-pool amounts are curve principal of live positions at the close price, without uncollected fees, so the two main pools sum to less.", zh: "himsInPoolManager 是 Uniswap v4 PoolManager 持有的全部 HIMS（所有 HIMS 池、未領取的手續費、ERC-6909 憑證），也就是 DeFiPrime 所說的「Uniswap v4 裡的 HIMS」。各池的數量是有效部位在收盤價下的曲線本金，不含未領取手續費，所以兩個主池加總會比較少。" },
    { en: `pushUp10 / pushDown10 are HAKARI's round-trip fee cost of walking this one pool ±10% (953 ticks) at the last swap's fee, the same walk as gauge/data/hims-replay.json. They ignore other pools and the arbitrage that would follow (the busiest copycat USDG/HIMS pool, fee ${copy.fee}, traded ${mUsd(copy.volume)} USDG in the window). The down cost is paid in HIMS and converted to USDG at the close.`, zh: `pushUp10／pushDown10 是 HAKARI 在這一個池子裡把價格推動 ±10%（953 個 tick）的往返手續費成本，使用最後一筆交易的費率，與 gauge/data/hims-replay.json 相同的計算。它們不考慮其他池子與隨之而來的套利（成交最多的仿冒 USDG/HIMS 池，費率 ${copy.fee}，在觀察期間成交了 ${wanUsd(copy.volume)} USDG）。往下推的成本以 HIMS 支付，並以收盤價換算成 USDG。` },
    { en: "bonerUsdAtNav values BONER's HIMS price at the Friday NYSE close (28.84, as reported by DeFiPrime, not from an exchange feed): what BONER would be worth if HIMS traded at NAV. It is a counterfactual, not a quote.", zh: "bonerUsdAtNav 用週五紐約證交所收盤價（28.84，取自 DeFiPrime，並非交易所行情）換算 BONER 的 HIMS 價格：也就是 HIMS 若以淨值交易時 BONER 的價值。這是假設情境，不是報價。" },
    { en: `The BONER/USDG series uses the USDG/BONER pool with the most USDG swap volume in the window (fee ${main3.bonerUsdg.fee}, ${mUsd(buW.volume)} USDG). ${pools.bonerUsdgPools - 1} other USDG/BONER pools exist, most of them spam; they are listed under pools.others only if they traded.`, zh: `BONER/USDG 序列採用觀察期間內 USDG 成交量最大的 USDG/BONER 池（費率 ${main3.bonerUsdg.fee}，成交 ${wanUsd(buW.volume)} USDG）。另外還有 ${pools.bonerUsdgPools - 1} 個 USDG/BONER 池，大多是垃圾池；有成交的才列在 pools.others。` },
    { en: `The BONER/HIMS hook swaps and adds liquidity inside users' transactions: the pool counts ${fmt(bhW.swaps, 0)} Swap events in ${fmt(bhW.uniqueTxs, 0)} transactions, so its swap count and HIMS volume include the hook's own legs, and its liquidity series is rebuilt from every ModifyLiquidity (equal to StateView), not taken from the Swap events.`, zh: `BONER/HIMS 的 hook 會在使用者的交易裡自行交換並加入流動性：這個池在 ${fmt(bhW.uniqueTxs, 0)} 筆交易裡有 ${fmt(bhW.swaps, 0)} 個 Swap 事件，所以它的交易筆數與 HIMS 成交量包含 hook 自己的部分；流動性序列是由每一筆 ModifyLiquidity 重建（與 StateView 一致），不是取自 Swap 事件。` },
    { en: `The Saturday 02:00 to Monday 02:00 Berlin mint/redeem closure is secondary data (gauge/src/mint-window.ts). What the chain shows is the observed silence: no HIMS mint from ${lm ? `${day(lm.ts, "en")} ${hm(lm.ts)} UTC` : "before the window"} until Monday 00:43:30 UTC, with two redemption burns on Friday evening.`, zh: `柏林時間週六 02:00 到週一 02:00 的鑄造／贖回關閉時段屬於二手資料（gauge/src/mint-window.ts）。鏈上能看到的是實際的空窗：從 ${lm ? `UTC ${day(lm.ts, "zh")} ${hm(lm.ts)}` : "觀察期間開始前"} 到週一 UTC 00:43:30 沒有任何 HIMS 鑄造，只有週五晚間兩筆贖回銷毀。` },
    { en: "Times are block-header timestamps in UTC, to the second; several blocks share a second, and events inside a second are ordered by block and log index.", zh: "時間為區塊標頭的時間戳（UTC，精確到秒）；同一秒內可能有好幾個區塊，同一秒的事件依區塊與 log 順序排列。" },
    { en: "Everything is read from Robinhood Chain (4663) logs and archive state, read-only. Reference figures (DeFiPrime, the earlier research, @0xSammy) are only compared in anchors, never copied into the series. Volumes are |amount| per swap, on the USDG side for the dollar pools and the HIMS side for BONER/HIMS.", zh: "所有數值皆以唯讀方式讀自 Robinhood Chain（4663）的 log 與歷史狀態。參考數字（DeFiPrime、先前的研究、@0xSammy）只在 anchors 裡比對，從不寫進序列。成交量是每筆交易的 |amount|：美元池以 USDG 計，BONER/HIMS 以 HIMS 計。" },
  ];
  if (tail && tail.logs.length) {
    const sw_ = tail.logs.filter((l) => l.event === "Swap").length, lp = tail.logs.length - sw_;
    caveats.push({
      en: `The pool tapes end at block ${fmt(Number(WINDOW_END_BLOCK), 0)}, the first block at 14:00:00 UTC; blocks ${tail.range.split("-").map((b) => fmt(Number(b), 0)).join("–")} carry the same timestamp and hold ${sw_} main-pool swaps and ${lp} LP changes that the last minute does not include (the supply series does include them).`,
      zh: `各池的交易紀錄止於區塊 ${fmt(Number(WINDOW_END_BLOCK), 0)}（UTC 14:00:00 的第一個區塊）；區塊 ${tail.range.split("-").map((b) => fmt(Number(b), 0)).join("–")} 的時間戳相同，其中有 ${sw_} 筆主池交易與 ${lp} 筆流動性變動未計入最後一分鐘（流通量序列則有計入）。`,
    });
  }

  // 7. pools and the file
  const keyOf = (p: any, label: string) => ({ id: p.id, currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks, initBlock: p.initBlock, label });
  const role = (p: any) => (p.pair === "USDG/HIMS" ? " (copycat USDG/HIMS pool)" : p.pair === "USDG/BONER" ? " (other USDG/BONER pool)" : p.id === AI_BONER ? " (4-hop arbitrage leg)" : "");
  const others = [...pools.otherHimsPools.active, ...pools.otherBonerPools.active].map((p: any) => ({
    id: p.id, label: `${p.pair} · ${p.fee === 8_388_608 ? "dynamic fee" : `fee ${p.fee}`}${p.hooks !== ZERO ? " · hook" : ""}`, swapsInWindow: p.swaps, volumeNote: `${fmt(p.volume, 0)} ${p.volumeUnit} in ${fmt(p.swaps, 0)} swaps${role(p)}`,
  }));
  others.push({ id: AI_USDG, label: "AI/USDG", swapsInWindow: null, volumeNote: "4-hop arbitrage leg; not scanned (neither HIMS nor BONER)" });
  const tok = (k: string) => ({ address: sev.tokens[k].address, decimals: sev.tokens[k].decimals, name: sev.tokens[k].name, symbol: sev.tokens[k].symbol });
  const data = {
    version: 1,
    generatedAt: new Date().toISOString(),
    chain: { id: 4663, name: "Robinhood Chain", explorer: EXPLORER, sources: ["Robinhood Chain public RPC (logs)", "archive RPC (headers, state checks)"] },
    window: { fromTs: WINDOW_START_TS, toTs: WINDOW_END_TS, fromBlock: Number(WINDOW_START_BLOCK), toBlock: Number(WINDOW_END_BLOCK), stepSec: 60, lastBlockAtOrBeforeToTs: lastBlock },
    tokens: { HIMS: tok("HIMS"), BONER: tok("BONER"), USDG: tok("USDG") },
    pools: {
      himsUsdg: keyOf(main3.himsUsdg, "HIMS/USDG main pool (fee 9000 pips; swaps pay 9991 with the protocol fee)"),
      bonerHims: keyOf(main3.bonerHims, "BONER/HIMS main pool (dynamic fee, hook 0x4e34…a544)"),
      bonerUsdg: keyOf(main3.bonerUsdg, `BONER/USDG main pool (largest window USDG volume of ${pools.bonerUsdgPools} USDG/BONER pools)`),
      others,
    },
    reference: {
      nyseCloseFri: { ts: REF.nyseCloseFri, price: NAV, source: `${DEFIPRIME}, ${DEFIPRIME_URL}` },
      mintRuleClosed: { fromTs: REF.mintRuleClose, toTs: REF.session24x5Reopen, rule: "Robinhood stock-token mint/redeem window closed Sat 02:00 to Mon 02:00 Europe/Berlin (Sat 00:00 to Mon 00:00 UTC this weekend); secondary data, gauge/src/mint-window.ts" },
      observedMintSilence: {
        fromTs: lm?.ts ?? WINDOW_START_TS, toTs: firstMint.ts,
        note: lm ? `no HIMS mint between block ${fmt(lm.block, 0)} (${iso(lm.ts)}, ${fmt(Number(lm.amount), 3)} HIMS) and the first Monday mint at block ${fmt(firstMint.block, 0)}; only the two Friday redemption burns in between` : "no HIMS mint from the window start until the first Monday mint",
      },
      session24x5Reopen: REF.session24x5Reopen,
      nyseOpenMon: REF.nyseOpenMon,
    },
    t,
    series,
    events,
    notableSwaps,
    anchors,
    checks,
    caveats,
  };
  const nf = nonFinite(data);
  check("No NaN or Infinity", nf.length === 0, nf.length ? `at ${nf.slice(0, 5).join(", ")}` : "every number is finite; undefined values are null");
  const secretHosts = MAINNET_RPCS.filter((u) => u !== PUBLIC_MAINNET_RPC).map((u) => { try { return new URL(u).hostname; } catch { return u; } });
  const sizeCheck = { name: "data.json under 1.5 MB", pass: true, detail: "" };
  const urlCheck = { name: "No RPC endpoint or key in the file", pass: true, detail: "" };
  checks.push(urlCheck, sizeCheck);
  let text = "";
  for (let pass = 0; pass < 2; pass++) { // the size check describes the file it sits in: settle it in two passes
    text = serialize(data);
    const urls = [...new Set(text.match(/https?:\/\/[^\s"',)]+/g) ?? [])];
    const stray = urls.filter((u) => !u.startsWith(EXPLORER) && !u.startsWith(DEFIPRIME_URL));
    const leaked = secretHosts.filter((h) => h && text.includes(h)).length + MAINNET_RPCS.filter((u) => u !== PUBLIC_MAINNET_RPC && text.includes(u)).length;
    Object.assign(urlCheck, { pass: stray.length === 0 && leaked === 0 && !text.includes(PUBLIC_MAINNET_RPC), detail: `URLs in the file: ${urls.join(", ") || "none"}${stray.length ? `; unexpected: ${stray.length}` : ""}; configured RPC hosts found: ${leaked}` });
    const bytes = Buffer.byteLength(text);
    Object.assign(sizeCheck, { pass: bytes <= MAX_BYTES, detail: `${fmt(bytes, 0)} bytes` });
  }
  mkdirSync(webDir, { recursive: true });
  writeFileSync(`${webDir}data.json`, text);
  writeFileSync(`${webDir}data.js`, `window.SQUEEZE_DATA = ${text.trimEnd()};\n`);

  // 8. summary
  const failed = checks.filter((c) => !c.pass);
  const keyNumbers = {
    peakHimsUsdgPostSwapPrice: { value: sig6(peak.priceAfter), avgPaid: sig6(peakPaid), time: iso(peak.ts), block: peak.block, tx: peak.tx },
    overshoots: overshoots.map((x) => ({ pool: x.pool, time: iso(x.o.swap.ts), postSwapPrice: sig6(x.post), avgPaid: sig6(x.avg), ratio: sig6(x.ratio), tx: x.o.swap.tx })),
    peakHimsUsdgMinuteClose: { value: sig6(maxClose), time: iso(t[kMaxClose]) },
    minHimsInHimsUsdg: { value: sig6(inv.himsInHimsUsdg[kMinHims]), usdg: sig6(inv.usdgInHimsUsdg[kMinHims]), time: iso(t[kMinHims]) },
    maxHimsInBonerHimsBeforeFirstMint: { value: sig6(inv.himsInBonerHims[kMaxBonerPool]), shareOfSupplyPct: sig6(bonerShare), time: iso(t[kMaxBonerPool]) },
    maxHimsInBonerHims: { value: sig6(inv.himsInBonerHims[kMaxBonerPoolAll]), time: iso(t[kMaxBonerPoolAll]) },
    minPushUp10CostUsdg: { value: sig6(inv.pushUp10CostUsdg[kMinPush]), capitalUsdg: sig6(inv.pushUp10CapitalUsdg[kMinPush]), time: iso(t[kMinPush]) },
    himsSupply: { start: ss.himsSupply[0], frozen: ss.himsSupply[barIndex(REF.mintRuleClose)], end: ss.himsSupply.at(-1) },
    bonerAtPeakClose: { time: iso(t[kMaxClose]), viaHimsUsd: sig6(d.bonerUsdgViaHims[kMaxClose]), atNavUsd: sig6(d.bonerUsdAtNav[kMaxClose]), directUsdg: sig6(bu.close[kMaxClose]) },
    premiumGone: kCalm >= 0 ? { time: iso(t[kCalm]), minutesAfterFirstMint: Math.round((t[kCalm] - firstMint.ts) / 60) } : null,
    anchors: { exact: anchors.filter((a) => a.match === "exact").length, close: anchors.filter((a) => a.match === "close").length, differs: anchors.filter((a) => a.match === "differs").length },
    checks: { pass: checks.length - failed.length, fail: failed.length },
    dataJsonBytes: Buffer.byteLength(text),
  };
  console.log(JSON.stringify(keyNumbers, null, 1));
  for (const a of anchors.filter((x) => x.match !== "exact")) console.log(`  anchor ${a.match}: ${a.label}`);
  for (const c of failed) console.log(`  CHECK FAILED: ${c.name}: ${c.detail}`);
  console.log(`wrote web/squeeze/data.json (${fmt(Buffer.byteLength(text), 0)} bytes) and data.js; ${events.length} events, ${notableSwaps.length} notable swaps, ${anchors.length} anchors, ${checks.length} checks`);
  return keyNumbers;
}

if (import.meta.url === `file://${process.argv[1]}`) run(main as () => Promise<any>);
