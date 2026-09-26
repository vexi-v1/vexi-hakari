// Every fix the Vexi venue has made on testnet 46630, replayed against HAKARI's bound. Vexi is our own options venue,
// built before the hackathon (none of its code is here: src/vexi-abi.ts re-declares what is called). It settles
// 15-minute options on a price it fixes from a hookless v4 pool on the official PoolManager, so for once the exposure
// settling on a pool's price is readable: per series the open interest is Σ Minted − Σ Burned (ERC-6909 supply replayed
// from logs), the settlement price is the Fixed log's S*, and every (market, expiry) cell compares Σ contracts × S* with
// CostModel.maxSafeExposure on the pricing pool as it stood before the fix window opened (replay.ts's mirror, pinned to
// the Solidity by test/fixtures/walk.json; arbReversionSeconds = 0, nobody but the venue has swapped on these pools).
// At one recent block each pool is also measured the way web/vexi/ does it, PushCostLens.roundTripCosts by address,
// next to the rebuild, with the head bound at the 0.5 % and 20 % rungs and the round trip of the 5 % rung (A22).
//   npm run vexi
// Reads data/vexi-markets.json. Writes data/vexi-fixes.json, web/vexi/baseline.json (the same minus per-series detail)
// and test/fixtures/vexi-series.json (series ids for the fork test). Logs are cached under cache/vexi/ in fixed block
// windows from the deploy block: a complete window is kept for good, only the tail is read again on the next run.
// Read-only against 46630.
import { rmSync } from "node:fs";
import { encodeAbiParameters, keccak256, toHex, zeroAddress } from "viem";
import { erc20Abi, lensAbi, poolManagerEvents, stateViewAbi } from "./abi.ts";
import { byLogOrder, getLogsHalving, POOL_MANAGER, readCache, run, sleep, STATE_VIEW, testnet, withRetry, writeCache, writeData, type LogFilter, type SerializedLog } from "./chain.ts";
import { SERIES_KIND, vexiMarkets, vexiSpotLeafAbi, vexiVenueAbi, vexiVenueEvents, type VexiMarket } from "./vexi-abi.ts";
import { maxSafeExposure, positionsAt, pushCostInQuote, rebuild, type RawLog } from "./replay.ts";
import { getSqrtPriceAtTick, poolStateFromPositions, type PoolState } from "./v4math.ts";
import { LADDER, MAX_WALK_STEPS, maxSafeFromQuotes, priceInQuote } from "../../web/live/core.js";
import { boundAtRung, quoteReserve } from "../../web/vexi/core.js";

type Client = ReturnType<typeof testnet>;
export const VEXI_CACHE_DIR = new URL("../cache/vexi/", import.meta.url).pathname;
/** Logs are read in windows of this many blocks from the deploy block; a complete window's file is final. */
export const LOG_WINDOW = 100_000n;
/** The 5 % rung of the ladder: A22 is the round trip that moves the asset that far, both ways, at the head. */
export const A22_TICKS = 488;
/** The state block: a few seconds behind the head so every endpoint in the ring has it (the public one keeps recent state only). */
const HEAD_LAG = 60n;
/**
 * The venue's own swap adapter: the only sender the six pricing pools have seen (Swap logs since deploy, 2026-09-26).
 * A swap inside a fix window from any other sender would be a third party moving the fix, and is counted apart.
 */
export const VENUE_SWAP_ADAPTER = "0x158d185aa7fab8390088186f5a255cc16ad783e4";
const WAD = 10n ** 18n;
const Q192 = 1n << 192n;

export interface PoolKey { currency0: `0x${string}`; currency1: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}` }
export interface Series { id: `0x${string}`; symbol: string; kind: number; strikeWad: bigint; expiry: number }
export interface Fix { id: `0x${string}`; sStarWad: bigint; obsFrom: number | null; obsTo: number | null; nObs: number | null; late: boolean; tx: `0x${string}`; block: string }
export interface SeriesOi { id: `0x${string}`; kind: number; strikeWad: bigint; oi: bigint }
export interface Cell { symbol: string; expiry: number; fixes: Fix[]; series: SeriesOi[] }
export type LiquidityMatches = boolean | "n/a (no swap)";

/** A series id as the venue's 32-byte word, whatever form the log decoder gave it. */
export const idHex = (id: string | bigint) => toHex(BigInt(id), { size: 32 });

export const poolIdOf = (key: PoolKey) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));

/** [from, to] cut into windows of `size` blocks from `from`; the last one is complete only when it ends on the grid. */
export function windowsOf(from: bigint, to: bigint, size = LOG_WINDOW): { from: bigint; to: bigint; complete: boolean }[] {
  const out = [];
  for (let a = from; a <= to; a += size) {
    const end = a + size - 1n;
    out.push(end <= to ? { from: a, to: end, complete: true } : { from: a, to, complete: false });
  }
  return out;
}

export const logCacheFile = (tag: string, from: bigint, to: bigint, complete: boolean, cacheDir = VEXI_CACHE_DIR) =>
  `${cacheDir}${complete ? "" : "tail/"}${tag}-${from}-${to}.json`;

/** Every log of `filter` in [from, to], window by window: complete windows come from the cache after the first run. */
export async function logsInWindows(
  client: Client,
  filter: LogFilter,
  from: bigint,
  to: bigint,
  tag: string,
  opts: { cacheDir?: string; window?: bigint; pauseMs?: number; attempts?: number } = {},
): Promise<SerializedLog[]> {
  const out: SerializedLog[] = [];
  for (const w of windowsOf(from, to, opts.window ?? LOG_WINDOW)) {
    const logs = await getLogsHalving(client, filter, w.from, w.to, logCacheFile(tag, w.from, w.to, w.complete, opts.cacheDir), { pauseMs: opts.pauseMs, attempts: opts.attempts });
    out.push(...logs);
  }
  return out.sort(byLogOrder);
}

/** Timestamps of `blocks`, cached as one map (the swap blocks of the planning pull seed it). */
async function blockTimestamps(client: Client, blocks: Iterable<string>, file: string): Promise<Map<string, number>> {
  const known = (readCache(file) as Record<string, number> | undefined) ?? {};
  const want = [...new Set(blocks)].filter((b) => known[b] === undefined).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  for (const b of want) {
    known[b] = Number((await withRetry(`block ${b}`, () => client.getBlock({ blockNumber: BigInt(b) }))).timestamp);
    await sleep(120);
  }
  if (want.length) writeCache(file, known);
  return new Map(Object.entries(known));
}

/** SeriesOpened logs → the series the markets know, by id (a base that is not a market is counted, not kept). */
export function seriesFromLogs(logs: SerializedLog[], symbolOfBase: Map<string, string>): { series: Map<`0x${string}`, Series>; unknownBase: number } {
  const series = new Map<`0x${string}`, Series>();
  let unknownBase = 0;
  for (const l of logs) {
    const symbol = symbolOfBase.get(String(l.args.base).toLowerCase());
    if (!symbol) {
      unknownBase++;
      continue;
    }
    series.set(idHex(l.args.id as string), { id: idHex(l.args.id as string), symbol, kind: Number(l.args.kind), strikeWad: BigInt(l.args.strikeWad as string), expiry: Number(l.args.expiry) });
  }
  return { series, unknownBase };
}

/**
 * Open interest per series in base wei: Σ Minted.contracts − Σ Burned.contracts, never the venue API's supply figure
 * (it reads 0 once a series is redeemed). The venue pairs every option id with an odd twin (the deposit side; the guard
 * reads totalSupply(id & ~1)); every id seen live is even, and an odd one is not a series here.
 */
export function openInterest(minted: SerializedLog[], burned: SerializedLog[]): Map<`0x${string}`, bigint> {
  const oi = new Map<`0x${string}`, bigint>();
  const fold = (logs: SerializedLog[], sign: bigint) => {
    for (const l of logs) {
      const id = BigInt(l.args.id as string);
      if (id & 1n) continue;
      const k = idHex(id);
      oi.set(k, (oi.get(k) ?? 0n) + sign * BigInt(l.args.contracts as string));
    }
  };
  fold(minted, 1n);
  fold(burned, -1n);
  return oi;
}

/** Fixed and FixedLate logs by id; a second fix for one id is counted and the first kept. */
export function fixesFromLogs(fixed: SerializedLog[], late: SerializedLog[]): { fixes: Map<`0x${string}`, Fix>; duplicates: number } {
  const fixes = new Map<`0x${string}`, Fix>();
  let duplicates = 0;
  for (const l of [...fixed, ...late].sort(byLogOrder)) {
    const id = idHex(l.args.id as string);
    if (fixes.has(id)) {
      duplicates++;
      continue;
    }
    const isLate = l.eventName === "FixedLate";
    fixes.set(id, {
      id,
      sStarWad: BigInt(l.args.sStarWad as string),
      obsFrom: isLate ? null : Number(l.args.obsFrom),
      obsTo: isLate ? null : Number(l.args.obsTo),
      nObs: isLate ? null : Number(l.args.nObs),
      late: isLate,
      tx: l.transactionHash as `0x${string}`,
      block: l.blockNumber,
    });
  }
  return { fixes, duplicates };
}

/** (market, expiry) cells with at least one fix, each with its fixes and every opened series' open interest. */
export function cellsOf(series: Map<`0x${string}`, Series>, fixes: Map<`0x${string}`, Fix>, oi: Map<`0x${string}`, bigint>): Cell[] {
  const cells = new Map<string, Cell>();
  for (const s of series.values()) {
    const k = `${s.symbol}|${s.expiry}`;
    const c = cells.get(k) ?? { symbol: s.symbol, expiry: s.expiry, fixes: [], series: [] };
    const f = fixes.get(s.id);
    if (f) c.fixes.push(f);
    c.series.push({ id: s.id, kind: s.kind, strikeWad: s.strikeWad, oi: oi.get(s.id) ?? 0n });
    cells.set(k, c);
  }
  return [...cells.values()].filter((c) => c.fixes.length > 0).sort((a, b) => a.expiry - b.expiry || a.symbol.localeCompare(b.symbol));
}

/** Base wei × a WAD price in quote per base → the quote's raw units (floor). */
export const toQuoteRaw = (baseWei: bigint, priceWad: bigint, baseUnit: bigint, quoteUnit: bigint) => (baseWei * priceWad * quoteUnit) / (baseUnit * WAD);

/** Σ contracts × S* over the cell's series, calls and puts alike (they share one S*): the delta-1 upper bound, in quote raw units. */
export function cellExposureRaw(series: SeriesOi[], sStarWad: bigint, baseUnit: bigint, quoteUnit: bigint): bigint {
  const total = series.reduce((s, x) => s + x.oi, 0n);
  return toQuoteRaw(total, sStarWad, baseUnit, quoteUnit);
}

/** An option's payout per contract at `priceWad`, WAD quote per base. */
export const payoffWad = (kind: number, strikeWad: bigint, priceWad: bigint) =>
  kind === SERIES_KIND.put ? (strikeWad > priceWad ? strikeWad - priceWad : 0n) : priceWad > strikeWad ? priceWad - strikeWad : 0n;

/** S* pushed by `ticks` in the asset's direction, by the same tick math as the pool: S* × 1.0001^±ticks. */
export const pushedPriceWad = (sStarWad: bigint, ticks: number, assetUp: boolean) => {
  const s = getSqrtPriceAtTick(assetUp ? ticks : -ticks);
  return (sStarWad * s * s) / Q192;
};

/**
 * What the option payouts would actually have moved had the fix been pushed by `ticks`: Σ over the series of contracts ×
 * max(0, payoff(pushed S*) − payoff(S*)), the holder of every series that gains being the pusher. Quote raw units.
 */
export function transferAtRung(series: SeriesOi[], sStarWad: bigint, ticks: number, assetUp: boolean, baseUnit: bigint, quoteUnit: bigint): bigint {
  const pushed = pushedPriceWad(sStarWad, ticks, assetUp);
  let total = 0n;
  for (const s of series) {
    if (s.oi <= 0n) continue;
    const gain = payoffWad(s.kind, s.strikeWad, pushed) - payoffWad(s.kind, s.strikeWad, sStarWad);
    if (gain > 0n) total += toQuoteRaw(s.oi, gain, baseUnit, quoteUnit);
  }
  return total;
}

/** The last swap that settled before `cutoff` (timestamps by block), and the swaps that happened in [cutoff, expiry]. */
export function swapsAround(swaps: RawLog[], tsOf: (block: string) => number, cutoff: number, expiry: number) {
  let last: RawLog | undefined;
  let inWindow = 0;
  let inWindowForeign = 0;
  for (const s of swaps) {
    const t = tsOf(s.blockNumber);
    if (t < cutoff) last = s;
    else if (t <= expiry) {
      inWindow++;
      if (String(s.args.sender).toLowerCase() !== VENUE_SWAP_ADAPTER) inWindowForeign++;
    }
  }
  return { last, inWindow, inWindowForeign };
}

/**
 * The pool as it stood when the fix window opened: positions from the ModifyLiquidity logs that settled before `cutoff`,
 * the price from the last swap before it, or the Initialize price when the pool has not been swapped yet (AI, MEME).
 */
export function preWindowState(mods: RawLog[], swaps: RawLog[], initSqrtPriceX96: bigint, tsOf: (block: string) => number, cutoff: number, expiry: number) {
  const { last, inWindow, inWindowForeign } = swapsAround(swaps, tsOf, cutoff, expiry);
  const modsBefore = mods.filter((m) => tsOf(m.blockNumber) < cutoff);
  const lastModBlock = modsBefore.reduce((b, m) => (BigInt(m.blockNumber) > b ? BigInt(m.blockNumber) : b), 0n);
  if (last) {
    const at = BigInt(last.blockNumber) > lastModBlock ? BigInt(last.blockNumber) : lastModBlock;
    const { state, liquidityMatches } = rebuild(modsBefore, last, at);
    return { state, source: "swap" as const, block: last.blockNumber, liquidityMatches: liquidityMatches as LiquidityMatches, inWindow, inWindowForeign };
  }
  const state = poolStateFromPositions(positionsAt(modsBefore, lastModBlock), initSqrtPriceX96);
  return { state, source: "initialize" as const, block: null, liquidityMatches: "n/a (no swap)" as LiquidityMatches, inWindow, inWindowForeign };
}

/** A fix is thin when the ring held few observations or the span it covered was short: nObs ≤ 3 or span < 200 s. */
export const isThin = (nObs: number | null, span: number | null) => nObs == null || span == null || nObs <= 3 || span < 200;

/** The bound, the exposure and the strike-aware transfer of one cell on its pre-window state; money in whole quote units. */
export function measureCell(cell: Cell, state: PoolState, quoteIsCurrency0: boolean, fee: number, baseUnit: bigint, quoteUnit: bigint) {
  const unit = Number(quoteUnit);
  const fix = cell.fixes[0];
  const bound = maxSafeExposure(state, quoteIsCurrency0, fee);
  const exposureRaw = cellExposureRaw(cell.series, fix.sStarWad, baseUnit, quoteUnit);
  const exposure = Number(exposureRaw) / unit;
  const ratio = exposure / (bound.exposure / unit);
  let transferAtBinding = 0;
  let breakEven = 0;
  let maxBreakEven = { value: 0, ticks: 0, assetUp: true };
  for (const x of LADDER) {
    for (const assetUp of [true, false]) {
      const cost = Number(pushCostInQuote(state, x, assetUp, quoteIsCurrency0, fee).costQuote) / unit;
      const transfer = Number(transferAtRung(cell.series, fix.sStarWad, x, assetUp, baseUnit, quoteUnit)) / unit;
      const be = cost > 0 ? transfer / cost : 0;
      if (x === bound.ticks && assetUp === bound.stockUp) {
        transferAtBinding = transfer;
        breakEven = be;
      }
      if (be > maxBreakEven.value) maxBreakEven = { value: be, ticks: x, assetUp };
    }
  }
  const span = fix.obsTo != null && fix.obsFrom != null ? fix.obsTo - fix.obsFrom : null;
  return {
    sStar: Number(fix.sStarWad) / 1e18,
    nObs: fix.nObs,
    span,
    thin: isThin(fix.nObs, span),
    late: fix.late,
    contracts: Number(cell.series.reduce((s, x) => s + x.oi, 0n)) / Number(baseUnit),
    bound: bound.exposure / unit,
    bindingTicks: bound.ticks,
    bindingAssetUp: bound.stockUp,
    bindingCost: Number(bound.cost) / unit,
    exposure,
    ratio,
    trusted: ratio < 1,
    transferAtBinding,
    breakEven,
    maxBreakEven,
  };
}

/** The first expiry on the grid after `now` for which series are open, with their ids per market. */
export function nextOpenExpiry(series: Iterable<Series>, now: number): { expiry: number; perMarket: Record<string, `0x${string}`[]> } | null {
  const all = [...series];
  let expiry = Infinity;
  for (const s of all) if (s.expiry > now && s.expiry < expiry) expiry = s.expiry;
  if (!Number.isFinite(expiry)) return null;
  const perMarket: Record<string, `0x${string}`[]> = {};
  for (const s of all) if (s.expiry === expiry) (perMarket[s.symbol] ??= []).push(s.id);
  return { expiry, perMarket };
}

const must = (ok: unknown, what: string) => {
  if (!ok) throw new Error(what);
};

export async function main() {
  const file = vexiMarkets();
  const client = testnet();
  const headBlock = await withRetry("head", () => client.getBlock());
  const head = { number: headBlock.number!, timestamp: Number(headBlock.timestamp) };
  const check = head.number - HEAD_LAG;
  const deployBlock = BigInt(file.deployBlock);
  rmSync(`${VEXI_CACHE_DIR}tail/`, { recursive: true, force: true });
  console.log(`46630 head ${head.number} (${new Date(head.timestamp * 1000).toISOString()}), state at ${check}, logs from ${deployBlock}`);

  const [stepSeconds, windowSeconds, , fixWindowSeconds] = (await withRetry("terms", () => client.readContract({ address: file.venue, abi: vexiVenueAbi, functionName: "terms", blockNumber: check }))) as readonly [bigint, bigint, bigint, bigint];
  must(Number(stepSeconds) === file.terms.step && Number(windowSeconds) === file.terms.window && Number(fixWindowSeconds) === file.terms.fixWindow, `terms() ${stepSeconds}/${windowSeconds}/${fixWindowSeconds} differ from the market file`);
  const fixWindow = Number(fixWindowSeconds);
  const quoteUnit = 10n ** BigInt(file.quote.decimals);
  const usdgDecimals = Number(await withRetry("USDG decimals", () => client.readContract({ address: file.quote.address, abi: erc20Abi, functionName: "decimals", blockNumber: check })));
  must(usdgDecimals === file.quote.decimals, `USDG decimals ${usdgDecimals}, expected ${file.quote.decimals}`);

  // 1. each market's pricing pool, as the leaf names it, checked against the curated pool id
  interface Pool extends VexiMarket { key: PoolKey; quoteIsCurrency0: boolean; decimals0: number; decimals1: number; initBlock: string; initSqrtPriceX96: bigint }
  const pools: Pool[] = [];
  for (const m of file.markets) {
    const [k, known] = (await withRetry(`${m.symbol} poolOf`, () => client.readContract({ address: file.spotLeaf, abi: vexiSpotLeafAbi, functionName: "poolOf", args: [m.base, file.quote.address], blockNumber: check }))) as readonly [PoolKey, boolean];
    const key: PoolKey = { currency0: k.currency0.toLowerCase() as `0x${string}`, currency1: k.currency1.toLowerCase() as `0x${string}`, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: k.hooks.toLowerCase() as `0x${string}` };
    must(known, `${m.symbol}: the leaf knows no pool`);
    must(poolIdOf(key) === m.pricingPoolId, `${m.symbol}: keccak256(key) ${poolIdOf(key)} is not the curated ${m.pricingPoolId}`);
    must(key.hooks === zeroAddress, `${m.symbol}: hooked pool ${key.hooks}`);
    must(key.fee === 3000 && key.tickSpacing === 60, `${m.symbol}: fee ${key.fee}, spacing ${key.tickSpacing}`);
    const quoteIsCurrency0 = key.currency0 === file.quote.address;
    must(quoteIsCurrency0 ? key.currency1 === m.base : key.currency0 === m.base && key.currency1 === file.quote.address, `${m.symbol}: key names another pair`);
    const baseDecimals = Number(await withRetry(`${m.symbol} decimals`, () => client.readContract({ address: m.base, abi: erc20Abi, functionName: "decimals", blockNumber: check })));
    must(baseDecimals === m.decimals, `${m.symbol}: decimals ${baseDecimals}, expected ${m.decimals}`);
    const initFile = `${VEXI_CACHE_DIR}initialize-${m.pricingPoolId.slice(0, 10)}.json`;
    const init = await getLogsHalving(client, { address: POOL_MANAGER, event: poolManagerEvents.Initialize, args: { id: m.pricingPoolId } }, 0n, head.number, initFile, { pauseMs: 0 });
    if (init.length !== 1) {
      rmSync(initFile, { force: true });
      throw new Error(`${m.symbol}: ${init.length} Initialize logs for the pool`);
    }
    pools.push({ ...m, key, quoteIsCurrency0, decimals0: quoteIsCurrency0 ? usdgDecimals : baseDecimals, decimals1: quoteIsCurrency0 ? baseDecimals : usdgDecimals, initBlock: init[0].blockNumber, initSqrtPriceX96: BigInt(init[0].args.sqrtPriceX96 as string) });
    await sleep(150);
  }
  console.log(`six pools checked: keccak(key) = pool id, hookless, fee 3000, spacing 60, decimals ${file.quote.decimals}/18`);

  // 2. pool logs since deploy, and the timestamps of every block that changed a pool
  const poolLogs = new Map<string, { mods: RawLog[]; swaps: RawLog[] }>();
  for (const p of pools) {
    const tag = p.pricingPoolId.slice(0, 10);
    const mods = (await logsInWindows(client, { address: POOL_MANAGER, event: poolManagerEvents.ModifyLiquidity, args: { id: p.pricingPoolId } }, deployBlock, head.number, `pool-ModifyLiquidity-${tag}`)) as RawLog[];
    const swaps = (await logsInWindows(client, { address: POOL_MANAGER, event: poolManagerEvents.Swap, args: { id: p.pricingPoolId } }, deployBlock, head.number, `pool-Swap-${tag}`)) as RawLog[];
    for (const s of swaps) must(Number(s.args.fee) === p.key.fee, `${p.symbol}: a swap at fee ${s.args.fee}, the key says ${p.key.fee}`);
    poolLogs.set(p.symbol, { mods, swaps });
    console.log(`${p.symbol.padEnd(5)} ${mods.length} ModifyLiquidity, ${swaps.length} Swap`);
  }
  const ts = await blockTimestamps(client, [...poolLogs.values()].flatMap(({ mods, swaps }) => [...mods, ...swaps].map((l) => l.blockNumber)), `${VEXI_CACHE_DIR}block-ts.json`);
  const tsOf = (block: string) => {
    const t = ts.get(block);
    if (t === undefined) throw new Error(`no timestamp for block ${block}`);
    return t;
  };

  // 3. the venue's logs since deploy
  const venue = async (name: keyof typeof vexiVenueEvents) => {
    const logs = await logsInWindows(client, { address: file.venue, event: vexiVenueEvents[name] }, deployBlock, head.number, `venue-${name}`);
    console.log(`${name.padEnd(12)} ${logs.length} logs`);
    return logs;
  };
  const [opened, minted, burned, fixedLogs, lateLogs] = [await venue("SeriesOpened"), await venue("Minted"), await venue("Burned"), await venue("Fixed"), await venue("FixedLate")];

  // 4. join: series by id, open interest by id, fixes by id, cells by (market, expiry)
  const { series, unknownBase } = seriesFromLogs(opened, new Map(file.markets.map((m) => [m.base, m.symbol])));
  must(unknownBase === 0, `${unknownBase} series on a base that is not a market`);
  const oi = openInterest(minted, burned);
  const { fixes, duplicates } = fixesFromLogs(fixedLogs, lateLogs);
  must(duplicates === 0, `${duplicates} ids fixed twice`);
  for (const id of fixes.keys()) must(series.has(id), `fix for an unopened series ${id}`);
  for (const id of oi.keys()) must(series.has(id), `open interest on an unopened series ${id}`);
  const cells = cellsOf(series, fixes, oi);

  // 5. every cell against the bound on the pool's pre-window state
  const cellRows = [] as any[];
  const perMarket = new Map<string, { cells: number; withExposure: number; bounds: number[]; lastFix: any }>();
  for (const c of cells) {
    const p = pools.find((x) => x.symbol === c.symbol)!;
    const { mods, swaps } = poolLogs.get(c.symbol)!;
    const sStars = new Set(c.fixes.map((f) => f.sStarWad.toString()));
    must(sStars.size === 1, `${c.symbol} ${c.expiry}: ${sStars.size} different S* in one cell`);
    const pre = preWindowState(mods, swaps, p.initSqrtPriceX96, tsOf, c.expiry - fixWindow, c.expiry);
    const m = measureCell(c, pre.state, p.quoteIsCurrency0, p.key.fee, 10n ** BigInt(p.decimals), quoteUnit);
    const preWindowPrice = priceInQuote(pre.state.sqrtPriceX96, p.decimals0, p.decimals1, p.quoteIsCurrency0);
    const stats = perMarket.get(c.symbol) ?? { cells: 0, withExposure: 0, bounds: [], lastFix: null };
    stats.cells++;
    stats.bounds.push(m.bound);
    if (m.exposure > 0) stats.withExposure++;
    if (!stats.lastFix || c.expiry > stats.lastFix.expiry) stats.lastFix = { expiry: c.expiry, sStar: m.sStar, nObs: m.nObs, span: m.span, fixes: c.fixes.length };
    perMarket.set(c.symbol, stats);
    if (m.exposure <= 0) continue;
    cellRows.push({
      symbol: c.symbol,
      expiry: c.expiry,
      expiryUtc: new Date(c.expiry * 1000).toISOString(),
      fixTx: c.fixes[0].tx,
      fixBlock: c.fixes[0].block,
      fixesInCell: c.fixes.length,
      sStar: m.sStar,
      nObs: m.nObs,
      span: m.span,
      thin: m.thin,
      late: m.late,
      preWindowSource: pre.source,
      preWindowBlock: pre.block,
      preWindowTick: pre.state.tick,
      preWindowPrice,
      liquidityMatches: pre.liquidityMatches,
      bound: m.bound,
      bindingTicks: m.bindingTicks,
      bindingAssetUp: m.bindingAssetUp,
      bindingCost: m.bindingCost,
      contracts: m.contracts,
      exposure: m.exposure,
      ratio: m.ratio,
      trusted: m.trusted,
      transferAtBinding: m.transferAtBinding,
      breakEven: m.breakEven,
      maxBreakEven: m.maxBreakEven.value,
      maxBreakEvenRung: { ticks: m.maxBreakEven.ticks, assetUp: m.maxBreakEven.assetUp },
      sStarVsPreWindowBps: (m.sStar / preWindowPrice - 1) * 1e4,
      inWindowSwaps: pre.inWindow,
      inWindowForeignSwaps: pre.inWindowForeign,
      series: c.series.filter((s) => s.oi > 0n).map((s) => ({ id: s.id, kind: s.kind === SERIES_KIND.put ? "put" : "call", strike: Number(s.strikeWad) / 1e18, contracts: Number(s.oi) / 10 ** p.decimals, oi: s.oi.toString() })),
    });
  }
  cellRows.sort((a, b) => b.ratio - a.ratio);

  // 6. the head: the lens by address next to the rebuild, the reserve, the rungs
  const markets = [] as any[];
  for (const p of pools) {
    const { mods, swaps } = poolLogs.get(p.symbol)!;
    const walk = (up: boolean) => withRetry(`${p.symbol} roundTripCosts ${up ? "up" : "down"}`, () => client.readContract({ address: file.lens, abi: lensAbi, functionName: "roundTripCosts", args: [p.key, LADDER, up, BigInt(MAX_WALK_STEPS)], blockNumber: check }));
    const [up, down] = [await walk(true), await walk(false)];
    const [sqrtNow, tickNow] = (await withRetry(`${p.symbol} slot0`, () => client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [p.pricingPoolId], blockNumber: check }))) as readonly [bigint, number, number, number];
    const liquidityNow = (await withRetry(`${p.symbol} liquidity`, () => client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [p.pricingPoolId], blockNumber: check }))) as bigint;
    must(sqrtNow !== 0n, `${p.symbol}: the RPC returned no state at ${check}: retry`);
    const rebuilt = poolStateFromPositions(positionsAt(mods, check), sqrtNow);
    must(rebuilt.liquidity === liquidityNow, `${p.symbol}: rebuilt liquidity ${rebuilt.liquidity} is not StateView's ${liquidityNow} at ${check}`);
    const unit = Number(quoteUnit);
    const lens = maxSafeFromQuotes(up as any, down as any, LADDER, p.quoteIsCurrency0);
    const mirror = maxSafeExposure(rebuilt, p.quoteIsCurrency0, p.key.fee);
    const reserve = quoteReserve(liquidityNow, sqrtNow, p.quoteIsCurrency0, file.quote.decimals);
    const costAt = (ticks: number, assetUp: boolean) => Number((lens.rungs as any[]).find((r) => r.ticks === ticks && r.assetUp === assetUp)!.cost) / unit;
    const stats = perMarket.get(p.symbol) ?? { cells: 0, withExposure: 0, bounds: [], lastFix: null };
    const senders = new Set(swaps.map((s) => String(s.args.sender).toLowerCase()));
    markets.push({
      symbol: p.symbol,
      base: p.base,
      key: p.key,
      poolId: p.pricingPoolId,
      quoteIsCurrency0: p.quoteIsCurrency0,
      decimals: { base: p.decimals, quote: file.quote.decimals },
      initBlock: p.initBlock,
      modifyLiquidityLogs: mods.length,
      swaps: swaps.length,
      swapSenders: senders.size,
      allSwapsFromVenueAdapter: swaps.length ? [...senders].every((s) => s === VENUE_SWAP_ADAPTER) : null,
      liquidity: liquidityNow.toString(),
      headTick: tickNow,
      rebuiltTick: rebuilt.tick,
      spot: priceInQuote(sqrtNow, p.decimals0, p.decimals1, p.quoteIsCurrency0),
      quoteReserve: reserve,
      headBound: lens.exposure / unit,
      headBinding: { ticks: lens.binding.ticks, assetUp: lens.binding.assetUp, complete: lens.binding.complete },
      boundAtRung: { 50: boundAtRung(lens.rungs, 50) / unit, 1823: boundAtRung(lens.rungs, 1823) / unit },
      boundOverReserve: reserve > 0 ? lens.exposure / unit / reserve : null,
      a22: { up: costAt(A22_TICKS, true), down: costAt(A22_TICKS, false) },
      lensOverRebuilt: lens.exposure / mirror.exposure,
      rebuiltLiquidityMatchesStateView: true,
      fixes: [...fixes.values()].filter((f) => series.get(f.id)!.symbol === p.symbol).length,
      cells: stats.cells,
      cellsWithExposure: stats.withExposure,
      boundOverExpiries: stats.bounds.length ? { min: Math.min(...stats.bounds), max: Math.max(...stats.bounds) } : null,
      lastFix: stats.lastFix,
    });
    console.log(
      p.symbol.padEnd(5),
      "bound", (lens.exposure / unit).toFixed(0).padStart(7),
      "| rung 50", (boundAtRung(lens.rungs, 50) / unit).toFixed(0).padStart(7),
      "| 1823", (boundAtRung(lens.rungs, 1823) / unit).toFixed(0).padStart(7),
      "| reserve", reserve.toFixed(0).padStart(9),
      "| lens/rebuilt", (lens.exposure / mirror.exposure).toFixed(4),
      "| cells", String(stats.cells).padStart(3), "with exposure", stats.withExposure,
    );
    await sleep(150);
  }

  // outputs
  const nObsHistogram: Record<string, number> = {};
  for (const f of fixes.values()) if (f.nObs != null) nObsHistogram[f.nObs] = (nObsHistogram[f.nObs] ?? 0) + 1;
  const top = cellRows[0] ?? null;
  const topBe = cellRows.reduce((b: any, c: any) => (!b || c.maxBreakEven > b.maxBreakEven ? c : b), null);
  const bps = cellRows.map((c: any) => Math.abs(c.sStarVsPreWindowBps)).sort((a: number, b: number) => a - b);
  const summary = {
    fixesScanned: fixes.size,
    fixedLogs: fixedLogs.length,
    fixedLate: lateLogs.length,
    seriesOpened: series.size,
    mintedLogs: minted.length,
    burnedLogs: burned.length,
    expiries: new Set(cells.map((c) => c.expiry)).size,
    cells: cells.length,
    cellsWithExposure: cellRows.length,
    seriesWithExposure: [...oi.values()].filter((v) => v > 0n).length,
    totalExposure: cellRows.reduce((s: number, c: any) => s + c.exposure, 0),
    maxRatio: top ? top.ratio : 0,
    maxRatioCell: top ? { symbol: top.symbol, expiry: top.expiry, expiryUtc: top.expiryUtc, exposure: top.exposure, bound: top.bound, contracts: top.contracts, sStar: top.sStar } : null,
    allTrusted: cellRows.every((c: any) => c.trusted),
    maxBreakEven: topBe ? topBe.maxBreakEven : 0,
    maxBreakEvenCell: topBe ? { symbol: topBe.symbol, expiry: topBe.expiry, ticks: topBe.maxBreakEvenRung.ticks, assetUp: topBe.maxBreakEvenRung.assetUp, transferAtBinding: topBe.transferAtBinding, bindingCost: topBe.bindingCost } : null,
    nObsHistogram,
    thinFixes: [...fixes.values()].filter((f) => isThin(f.nObs, f.obsTo != null && f.obsFrom != null ? f.obsTo - f.obsFrom : null)).length,
    allLiquidityMatches: cellRows.every((c: any) => c.liquidityMatches !== false),
    sStarVsPreWindowAbsBps: bps.length ? { min: bps[0], median: bps[Math.floor(bps.length / 2)], max: bps[bps.length - 1] } : null,
    inWindowSwaps: cellRows.reduce((s: number, c: any) => s + c.inWindowSwaps, 0),
    inWindowForeignSwaps: cellRows.reduce((s: number, c: any) => s + c.inWindowForeignSwaps, 0),
  };
  const common = {
    generatedAt: new Date().toISOString(),
    chainId: file.chainId,
    head: { block: head.number.toString(), timestamp: head.timestamp },
    stateBlock: check.toString(),
    deployBlock: file.deployBlock,
    method:
      "Every Fixed/FixedLate log of the venue since its deploy block, joined to SeriesOpened by id; open interest per series = Σ Minted − Σ Burned (ERC-6909 supply replayed from logs). Per (market, expiry) cell: the pricing pool rebuilt from its ModifyLiquidity logs with the price of the last Swap before expiry − fixWindow (the Initialize price when the pool was never swapped), bound = CostModel.maxSafeExposure with arbReversionSeconds = 0 (replay.ts's mirror, pinned to the Solidity by test/fixtures/walk.json), exposure = Σ contracts × S* in USDG (calls and puts alike, the delta-1 upper bound), plus the strike-aware transfer: what the payouts would have moved had the fix been pushed by the binding rung, ÷ that push's round-trip cost. Head: PushCostLens.roundTripCosts by address at stateBlock, both tick directions, → maxSafeFromQuotes (web/live/core.js), next to the rebuild at the same block (lensOverRebuilt); quoteReserve = L ÷ √P (L × √P where USDG is currency1); a22 = the round trip of the 488-tick (5 %) rung with the asset pushed up / down, in USDG. Money in whole USDG unless named raw.",
    ladderTicks: LADDER,
    maxWalkSteps: MAX_WALK_STEPS,
    quote: file.quote,
    terms: file.terms,
    markets,
    summary,
  };
  writeData(new URL("../data/vexi-fixes.json", import.meta.url).pathname, { ...common, cells: cellRows });
  writeData(new URL("../../web/vexi/baseline.json", import.meta.url).pathname, { ...common, cells: cellRows.map(({ series: _series, ...rest }: any) => rest) });
  const next = nextOpenExpiry(series.values(), head.timestamp);
  writeData(new URL("../../test/fixtures/vexi-series.json", import.meta.url).pathname, {
    note: "Series ids of the Vexi venue on 46630 for the fork test, written by npm run vexi (gauge/src/vexi.ts): the cell with the largest exposure ÷ bound so far, and every series open at the first expiry after the head.",
    generatedAt: common.generatedAt,
    head: common.head,
    largestCell: top ? { symbol: top.symbol, expiry: top.expiry, exposure: top.exposure, bound: top.bound, ids: top.series.map((s: any) => s.id) } : null,
    nextExpiry: next,
  });
  console.log(
    `${summary.fixesScanned} fixes over ${summary.expiries} expiries and ${summary.cells} cells; ${summary.cellsWithExposure} cells / ${summary.seriesWithExposure} series with exposure, ${summary.totalExposure.toFixed(2)} USDG in total, max ratio ${summary.maxRatio.toFixed(4)}` +
      (top ? ` (${top.symbol} ${top.expiryUtc})` : "") +
      `; nObs ${JSON.stringify(nObsHistogram)}; ${summary.fixedLate} late`,
  );
  console.log("wrote data/vexi-fixes.json, web/vexi/baseline.json, test/fixtures/vexi-series.json");
}

if (import.meta.url === `file://${process.argv[1]}`) run(main);
