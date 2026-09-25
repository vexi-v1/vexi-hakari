// What HAKARI would have read and decided on HIMS/USDG at every minute of the 2026-08-28..31 weekend, had the pool
// carried HakariOracleHook. It did not: HIMS/USDG was created with no hook (hooks = 0x0), so every number here is a
// counterfactual replay of HAKARI's own rules over the pool's real swaps and positions, not something read on-chain.
//
// 1. The hook's observations, exactly as OpenZeppelin's BaseOracleHook + the Panoptic truncated Oracle library write
//    them (lib/uniswap-hooks/src/oracles/panoptic/libraries/Oracle.sol, ported below line by line): one observation
//    before the first swap of each second, at the pool's tick before that swap, the truncated series moved at most Δ
//    per observation. Then HakariOracleHook.twaps(): raw and truncated TWAP ticks over 10, 30 and 60 minutes, for
//    Δ = 10 (HIMS's p99 calibration, gauge/data/delta.json) and Δ = 3.
// 2. SafeSettle v1 (98bc7d7) with nobody pushing back (arbReversionSeconds = 0): the max safe exposure on the pool
//    rebuilt at each minute (replay.ts maxSafeExposure, pinned to CostModel.maxSafeExposure by
//    test/max-safe-exposure.test.ts), plus the gap between the two TWAPs as one more move when it exceeds 10 ticks,
//    and the decision for 1,000 / 10,000 / 100,000 USDG settling (trust the raw TWAP, or refuse).
// 3. SafeSettle v0 (the first rule, last at fced71c): raw when the two TWAPs are within 10 ticks, otherwise raw or
//    truncated depending on whether faking the gap costs more than it earns. It never refuses.
// Inputs are the squeeze collectors' caches (npm run squeeze): out/swaps-raw-main.json, the ModifyLiquidity ndjson and
// the block-timestamp caches under gauge/cache/squeeze/. Pool state comes from inventory.ts's sweep, so a minute here
// is the same minute as web/squeeze/data.json. Nothing is fetched unless a timestamp is missing (then cache-first
// through common.ts). Writes gauge/cache/squeeze/out/hakari-1m.json (per minute) and gauge/data/hims-hook-replay.json
// (summary). Read-only against 4663.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { readCache, run } from "../chain.ts";
import { gainPerUnit, LADDER, maxSafeExposure, pushCostInQuote } from "../replay.ts";
import { getSqrtPriceAtTick, MAX_TICK, MIN_TICK, poolStateFromPositions, type PoolState, type Position } from "../v4math.ts";
import { principal, sweep, type Live, type Mod, type Swp } from "./inventory.ts";
import { blockTimestamps, cacheDir, POOL_HIMS_USDG, REF, WINDOW_END_BLOCK, WINDOW_END_TS, WINDOW_START_BLOCK, WINDOW_START_TS } from "./common.ts";

// ───────────────────────── 1. the truncated oracle, as Oracle.sol writes it ─────────────────────────

/** Oracle.Observation. Cumulatives are int56 on-chain; BigInt here, so the arithmetic is exact. */
export interface Observation {
  blockTimestamp: number;
  prevTruncatedTick: number;
  tickCumulative: bigint;
  tickCumulativeTruncated: bigint;
  initialized: boolean;
}

const EMPTY: Observation = Object.freeze({ blockTimestamp: 0, prevTruncatedTick: 0, tickCumulative: 0n, tickCumulativeTruncated: 0n, initialized: false });
const U32 = 2 ** 32;

/** Oracle.transform: the truncated tick moves at most `maxAbsTickDelta` from the previous truncated tick, per call. */
export function transform(last: Observation, blockTimestamp: number, tick: number, maxAbsTickDelta: number): Observation {
  let truncatedTick = tick;
  const tickDelta = tick - last.prevTruncatedTick;
  if (tickDelta > maxAbsTickDelta || tickDelta < -maxAbsTickDelta) {
    truncatedTick = last.prevTruncatedTick + (tickDelta > 0 ? maxAbsTickDelta : -maxAbsTickDelta);
  }
  const timeDelta = BigInt((blockTimestamp - last.blockTimestamp + U32) % U32); // uint32, safe for one overflow
  return {
    blockTimestamp,
    prevTruncatedTick: truncatedTick,
    tickCumulative: last.tickCumulative + BigInt(tick) * timeDelta,
    tickCumulativeTruncated: last.tickCumulativeTruncated + BigInt(truncatedTick) * timeDelta,
    initialized: true,
  };
}

/** Oracle.lte: is `a` chronologically <= `b`, both at or before `time` (32-bit timestamps). */
export function lte(time: number, a: number, b: number): boolean {
  if (a <= time && b <= time) return a <= b;
  const aAdjusted = a > time ? a : a + U32;
  const bAdjusted = b > time ? b : b + U32;
  return aAdjusted <= bAdjusted;
}

export class TargetPredatesOldestObservation extends Error {
  constructor(readonly oldestTimestamp: number, readonly targetTimestamp: number) {
    super(`TargetPredatesOldestObservation(${oldestTimestamp}, ${targetTimestamp})`);
  }
}

/** One pool's Observation[65535] ring buffer plus BaseOracleHook's ObservationState (index, cardinality, next). */
export class TruncatedOracle {
  private readonly slots: Observation[] = [];
  index = 0;
  cardinality = 0;
  cardinalityNext = 0;
  constructor(readonly maxAbsTickDelta: number) {}

  slot(i: number): Observation {
    return this.slots[i] ?? EMPTY;
  }

  /** Oracle.initialize, as BaseOracleHook._afterInitialize calls it. */
  initialize(time: number, tick: number) {
    this.slots[0] = { blockTimestamp: time, prevTruncatedTick: tick, tickCumulative: 0n, tickCumulativeTruncated: 0n, initialized: true };
    this.index = 0;
    this.cardinality = 1;
    this.cardinalityNext = 1;
  }

  /** Oracle.grow via increaseObservationCardinalityNext: pre-touch the slots, uninitialized. */
  grow(next: number) {
    if (!this.slot(0).initialized) throw new Error("PoolNotInitialized");
    if (next > 65535) throw new Error("cardinality is a uint16 up to 65535");
    if (next <= this.cardinalityNext) return;
    for (let i = this.cardinalityNext; i < next; i++) this.slots[i] = { ...EMPTY, blockTimestamp: 1 };
    this.cardinalityNext = next;
  }

  /** Oracle.write: at most once per timestamp; cardinality grows only when the index wraps onto the last slot. */
  write(blockTimestamp: number, tick: number): boolean {
    const last = this.slot(this.index);
    if (last.blockTimestamp === blockTimestamp) return false;
    const cardinalityUpdated = this.cardinalityNext > this.cardinality && this.index === this.cardinality - 1 ? this.cardinalityNext : this.cardinality;
    const indexUpdated = (this.index + 1) % cardinalityUpdated;
    this.slots[indexUpdated] = transform(last, blockTimestamp, tick, this.maxAbsTickDelta);
    this.index = indexUpdated;
    this.cardinality = cardinalityUpdated;
    return true;
  }

  private binarySearch(time: number, target: number): [Observation, Observation] {
    let left = (this.index + 1) % this.cardinality;
    let right = left + this.cardinality - 1;
    for (let guard = 0; guard < 64; guard++) {
      const mid = Math.floor((left + right) / 2);
      const beforeOrAt = this.slot(mid % this.cardinality);
      if (!beforeOrAt.initialized) {
        left = mid + 1;
        continue;
      }
      const atOrAfter = this.slot((mid + 1) % this.cardinality);
      const targetAtOrAfter = lte(time, beforeOrAt.blockTimestamp, target);
      if (targetAtOrAfter && lte(time, target, atOrAfter.blockTimestamp)) return [beforeOrAt, atOrAfter];
      if (!targetAtOrAfter) right = mid - 1;
      else left = mid + 1;
    }
    throw new Error("binarySearch did not converge");
  }

  private getSurroundingObservations(time: number, target: number, tick: number): [Observation, Observation] {
    let beforeOrAt = this.slot(this.index);
    if (lte(time, beforeOrAt.blockTimestamp, target)) {
      if (beforeOrAt.blockTimestamp === target) return [beforeOrAt, EMPTY];
      return [beforeOrAt, transform(beforeOrAt, target, tick, this.maxAbsTickDelta)];
    }
    beforeOrAt = this.slot((this.index + 1) % this.cardinality);
    if (!beforeOrAt.initialized) beforeOrAt = this.slot(0);
    if (!lte(time, beforeOrAt.blockTimestamp, target)) throw new TargetPredatesOldestObservation(beforeOrAt.blockTimestamp, target);
    return this.binarySearch(time, target);
  }

  /** Oracle.observeSingle: cumulatives as of `secondsAgo` before `time`, `tick` being slot0's tick now. */
  observeSingle(time: number, secondsAgo: number, tick: number): [bigint, bigint] {
    if (secondsAgo === 0) {
      let last = this.slot(this.index);
      if (last.blockTimestamp !== time) last = transform(last, time, tick, this.maxAbsTickDelta);
      return [last.tickCumulative, last.tickCumulativeTruncated];
    }
    const target = (time - secondsAgo + U32) % U32;
    const [beforeOrAt, atOrAfter] = this.getSurroundingObservations(time, target, tick);
    if (target === beforeOrAt.blockTimestamp) return [beforeOrAt.tickCumulative, beforeOrAt.tickCumulativeTruncated];
    if (target === atOrAfter.blockTimestamp) return [atOrAfter.tickCumulative, atOrAfter.tickCumulativeTruncated];
    const observationTimeDelta = BigInt(atOrAfter.blockTimestamp - beforeOrAt.blockTimestamp);
    const targetDelta = BigInt(target - beforeOrAt.blockTimestamp);
    // BigInt division truncates toward zero, as Solidity's int56 division does
    return [
      beforeOrAt.tickCumulative + ((atOrAfter.tickCumulative - beforeOrAt.tickCumulative) / observationTimeDelta) * targetDelta,
      beforeOrAt.tickCumulativeTruncated + ((atOrAfter.tickCumulativeTruncated - beforeOrAt.tickCumulativeTruncated) / observationTimeDelta) * targetDelta,
    ];
  }

  /** Oracle.observe. */
  observe(time: number, secondsAgos: number[], tick: number): { tickCumulatives: bigint[]; tickCumulativesTruncated: bigint[] } {
    const tickCumulatives: bigint[] = [];
    const tickCumulativesTruncated: bigint[] = [];
    for (const s of secondsAgos) {
      const [c, t] = this.observeSingle(time, s, tick);
      tickCumulatives.push(c);
      tickCumulativesTruncated.push(t);
    }
    return { tickCumulatives, tickCumulativesTruncated };
  }
}

/** HakariOracleHook._avg: Uniswap's convention, rounding toward negative infinity. */
export function avgTick(delta: bigint, window: number): number {
  const w = BigInt(window);
  let t = delta / w;
  if (delta < 0n && delta % w !== 0n) t -= 1n;
  return Number(t);
}

export interface Twaps {
  rawTick: number;
  truncTick: number;
  /** the exact averages before HakariOracleHook rounds them to int24 (for comparing with float replays) */
  rawAvg: number;
  truncAvg: number;
}

/** HakariOracleHook (BaseOracleHook + twaps) on one pool, driven by the pool's swaps. One hook, one Δ. */
export class HookReplay {
  readonly oracle: TruncatedOracle;
  constructor(readonly delta: number) {
    this.oracle = new TruncatedOracle(delta);
  }
  get initialized() {
    return this.oracle.slot(0).initialized;
  }
  /** BaseOracleHook._afterInitialize. */
  afterInitialize(time: number, tick: number) {
    this.oracle.initialize(time, tick);
  }
  increaseObservationCardinalityNext(next: number) {
    this.oracle.grow(next);
  }
  /** BaseOracleHook._beforeSwap: write at slot0's tick *before* the swap. Returns whether an observation was written. */
  beforeSwap(time: number, slot0Tick: number): boolean {
    return this.oracle.write(time, slot0Tick);
  }
  /** HakariOracleHook.twaps(id, window) called at `time` with the pool at `slot0Tick`. Throws as the contract reverts. */
  twaps(time: number, window: number, slot0Tick: number): Twaps {
    if (window === 0) throw new Error("WindowZero");
    const o = this.oracle.observe(time, [window, 0], slot0Tick);
    const raw = o.tickCumulatives[1] - o.tickCumulatives[0];
    const trunc = o.tickCumulativesTruncated[1] - o.tickCumulativesTruncated[0];
    return { rawTick: avgTick(raw, window), truncTick: avgTick(trunc, window), rawAvg: Number(raw) / window, truncAvg: Number(trunc) / window };
  }
}

/**
 * How long an assumption about the truncated series' starting point matters: the truncated series started at
 * `init.tick + offset` instead of `init.tick`, fed the same observations. Returns the timestamp of the first
 * observation after which the two coincide (and stay equal, since they then see the same inputs), or null.
 */
export function truncatedStartForgottenAt(init: { ts: number; tick: number }, writes: { ts: number; tick: number }[], delta: number, offset: number): number | null {
  let a = init.tick, b = init.tick + offset;
  if (a === b) return init.ts;
  const step = (prev: number, tick: number) => {
    const d = tick - prev;
    return d > delta ? prev + delta : d < -delta ? prev - delta : tick;
  };
  for (const w of writes) {
    a = step(a, w.tick);
    b = step(b, w.tick);
    if (a === b) return w.ts;
  }
  return null;
}

/**
 * The least cardinality at which every `window`-second read still finds the observation at or before its left edge.
 * The worst read sits at an observation time (later reads in the same gap start later and span no more). Reads whose
 * window starts before the first observation revert whatever the cardinality and are skipped.
 */
export function minCardinality(obsTimes: number[], window: number): number {
  let best = 1, j = 0;
  for (let i = 0; i < obsTimes.length; i++) {
    const target = obsTimes[i] - window;
    if (target < obsTimes[0]) continue;
    while (obsTimes[j] <= target) j++;
    best = Math.max(best, i - j + 2); // the observations after the left edge, plus the one at or before it
  }
  return best;
}

/**
 * The hook's TWAP reads again from its recorded observations alone, with the buffer grown to `cardinality` after
 * initialization: per read (in time order, each after every write at or before its second) and window, the int24 raw
 * and truncated ticks, or null where the contract reverts (TargetPredatesOldestObservation).
 */
export function rereadAtCardinality(
  init: { ts: number; tick: number },
  writes: { ts: number; tick: number }[],
  reads: { time: number; tick: number }[],
  delta: number,
  windows: number[],
  cardinality: number,
): ({ raw: number; trunc: number } | null)[][] {
  const h = new HookReplay(delta);
  h.afterInitialize(init.ts, init.tick);
  h.increaseObservationCardinalityNext(cardinality);
  let j = 0;
  return reads.map((r) => {
    for (; j < writes.length && writes[j].ts <= r.time; j++) h.beforeSwap(writes[j].ts, writes[j].tick);
    return windows.map((w) => {
      try {
        const t = h.twaps(r.time, w, r.tick);
        return { raw: t.rawTick, trunc: t.truncTick };
      } catch (e) {
        if (e instanceof TargetPredatesOldestObservation) return null;
        throw e;
      }
    });
  });
}

// ───────────────────────── 2. the settlement rules ─────────────────────────

/** SafeSettle.TOLERANCE_TICKS (v0 and v1). */
export const TOLERANCE_TICKS = 10;

/** USDG per HIMS at a tick of HIMS/USDG (currency0 = USDG, 6 dec; currency1 = HIMS, 18 dec). */
export const usdgPerHimsAtTick = (tick: number) => 1e12 / Math.pow(1.0001, tick);

export interface Bound {
  /** max safe exposure, quote raw units (USDG × 1e6) */
  exposure: number;
  ticks: number;
  stockUp: boolean;
  cost: bigint;
  complete: boolean;
  /** true when the move that sets it is the gap between the two TWAPs, not a ladder rung */
  gapBinds: boolean;
}

/**
 * SafeSettle v1's bound with nobody pushing back (arbReversionSeconds = 0): the ladder (replay.ts maxSafeExposure,
 * pinned to CostModel) and, as CostModel.maxSafeExposure's `extraTicks`, the gap between the two TWAPs when it
 * exceeds TOLERANCE_TICKS. HIMS/USDG quotes in currency0 (USDG).
 */
export function v1Bound(state: PoolState, fee: number, gapTicks: number, ladder?: ReturnType<typeof maxSafeExposure>): Bound {
  const l = ladder ?? maxSafeExposure(state, true, fee);
  let best: Bound = { exposure: l.exposure, ticks: l.ticks, stockUp: l.stockUp, cost: l.cost, complete: l.complete, gapBinds: false };
  const gap = Math.abs(gapTicks);
  if (gap > TOLERANCE_TICKS) {
    for (const stockUp of [true, false]) {
      const r = pushCostInQuote(state, gap, stockUp, true, fee);
      const exposure = Number(r.costQuote) / gainPerUnit(gap, stockUp);
      if (exposure < best.exposure) best = { exposure, ticks: gap, stockUp, cost: r.costQuote, complete: r.complete, gapBinds: true };
    }
  }
  return best;
}

/** SafeSettle v1: trust the raw TWAP iff the exposure is below the bound (`exposure < maxSafeExposure`). */
export const v1Trusts = (b: Bound, exposureUsdg: number) => exposureUsdg * 1e6 < b.exposure;

export interface V0 {
  gap: number; // rawTick - truncTick
  checked: boolean; // false: |gap| <= 10, raw with no cost check
  costQuote?: bigint; // cost to fake the gap, USDG raw units
  complete?: boolean;
  gainPerUnit?: number;
  /** v0 settles on raw below this exposure and on truncated above it (null when unchecked) */
  thresholdUsdg?: number;
}

/**
 * SafeSettle v0 (last at fced71c) with arbReversionSeconds = 0: within 10 ticks, raw; otherwise the cost of pushing
 * from the truncated price to the raw one through the liquidity there now (PushCostLens.roundTripCostBetween, no
 * re-pushes), against the gain on the exposure. Cost > gain: raw; else truncated. It never refuses.
 */
export function v0Decision(positions: Position[], rawTick: number, truncTick: number, fee: number): V0 {
  const gap = rawTick - truncTick;
  const x = Math.abs(gap);
  if (x <= TOLERANCE_TICKS) return { gap, checked: false };
  const stockUp = gap < 0; // quote is currency0: the asset moves against the tick
  const state = poolStateFromPositions(positions, getSqrtPriceAtTick(truncTick));
  const r = pushCostInQuote(state, x, stockUp, true, fee);
  const g = gainPerUnit(x, stockUp);
  return { gap, checked: true, costQuote: r.costQuote, complete: r.complete, gainPerUnit: g, thresholdUsdg: Number(r.costQuote) / 1e6 / g };
}

/** v0's pick for an exposure: 0 = raw, unchecked (gap <= 10); 1 = raw (faking costs more than it earns); 2 = truncated. */
export function v0Pick(d: V0, exposureUsdg: number): 0 | 1 | 2 {
  if (!d.checked) return 0;
  return Number(d.costQuote!) > exposureUsdg * 1e6 * d.gainPerUnit! ? 1 : 2;
}

// ───────────────────────── 3. inputs (the squeeze collectors' caches) ─────────────────────────

export interface Inputs {
  mods: Mod[];
  swaps: Swp[];
  pool: { id: string; fee: number; tickSpacing: number; hooks: string; initBlock: number; currency0: string; currency1: string };
  sources: Record<string, string>;
}

const outDir = `${cacheDir}out/`;

/** Everything from disk; a missing block timestamp (none, as of 2026-09-26) is fetched cache-first through common.ts. */
export async function loadInputs(): Promise<Inputs> {
  const pools = readCache(`${outDir}pools.json`) as any;
  const raw = readCache(`${outDir}swaps-raw-main.json`) as any;
  if (!pools || !raw) throw new Error("missing gauge/cache/squeeze/out/pools.json or swaps-raw-main.json: run `npm run squeeze` first");
  const key = pools.main.himsUsdg;
  if (key.id !== POOL_HIMS_USDG || raw.himsUsdg.id !== POOL_HIMS_USDG) throw new Error("pools.json / swaps-raw-main.json: himsUsdg is not the known HIMS/USDG pool");
  if (key.hooks !== "0x0000000000000000000000000000000000000000") throw new Error("HIMS/USDG was expected to have no hook");
  // the inventory collector's ModifyLiquidity cache: one OR-filter over the three main pools since the oldest Initialize
  const ids = ["himsUsdg", "bonerHims", "bonerUsdg"].map((n) => pools.main[n].id as string).sort();
  const from = Math.min(...["himsUsdg", "bonerHims", "bonerUsdg"].map((n) => pools.main[n].initBlock as number));
  const tag = createHash("sha1").update(ids.join(",")).digest("hex").slice(0, 10);
  const modFile = `${cacheDir}modliq-${tag}-${from}.json`;
  if (!existsSync(`${modFile}.next`) || BigInt(readFileSync(`${modFile}.next`, "utf8").trim()) <= WINDOW_END_BLOCK) {
    throw new Error(`ModifyLiquidity cache ${modFile}.ndjson is missing or incomplete: run \`npm run squeeze\` (inventory) first`);
  }
  const seen = new Set<string>();
  const logs = readFileSync(`${modFile}.ndjson`, "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s)).filter((l: any) => {
    const k = `${l.blockNumber}:${l.logIndex}`;
    if (seen.has(k) || l.args.id !== POOL_HIMS_USDG || BigInt(l.blockNumber) > WINDOW_END_BLOCK) return false;
    seen.add(k);
    return true;
  });
  // exact timestamps for the mods inside the window (earlier blocks are before t_0 by WINDOW_START_BLOCK's definition)
  const need = [...new Set(logs.filter((l: any) => BigInt(l.blockNumber) >= WINDOW_START_BLOCK).map((l: any) => String(l.blockNumber)))] as string[];
  const ts = new Map<string, number>();
  for (const f of ["timestamps-inventory.json", "timestamps-swaps.json", "timestamps.json", "timestamps-supply.json"]) {
    let c: Record<string, number> = {};
    try { c = (readCache(`${cacheDir}${f}`) as Record<string, number> | undefined) ?? {}; } catch { continue; }
    for (const b of need) if (!ts.has(b) && Number.isFinite(c[b])) ts.set(b, c[b]);
  }
  const missing = need.filter((b) => !ts.has(b));
  if (missing.length) for (const [b, t] of await blockTimestamps(missing)) ts.set(b, t);
  const mods: Mod[] = logs.map((l: any) => ({
    block: Number(l.blockNumber), logIndex: l.logIndex, ts: BigInt(l.blockNumber) >= WINDOW_START_BLOCK ? ts.get(String(l.blockNumber))! : -Infinity,
    key: `${l.args.sender}|${l.args.tickLower}|${l.args.tickUpper}|${l.args.salt}`, tickLower: Number(l.args.tickLower), tickUpper: Number(l.args.tickUpper),
    delta: BigInt(l.args.liquidityDelta),
  }));
  const swaps: Swp[] = raw.himsUsdg.rows.map((r: any[]) => ({ ts: r[0], block: r[1], logIndex: r[2], sqrtPriceX96: BigInt(r[6]), liquidity: BigInt(r[7]), tick: r[8], fee: r[9] }));
  return {
    mods, swaps,
    pool: { id: key.id, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks, initBlock: key.initBlock, currency0: key.currency0, currency1: key.currency1 },
    sources: {
      swaps: `gauge/cache/squeeze/out/swaps-raw-main.json (squeeze/pools-swaps.ts): ${swaps.length} HIMS/USDG Swap events, the last one before the window (the seed) and every one in blocks ${WINDOW_START_BLOCK}..${WINDOW_END_BLOCK}`,
      modifyLiquidity: `gauge/cache/squeeze/modliq-${tag}-${from}.json.ndjson (squeeze/inventory.ts): ${mods.length} HIMS/USDG ModifyLiquidity logs from its Initialize to block ${WINDOW_END_BLOCK}`,
      timestamps: "gauge/cache/squeeze/timestamps-*.json (exact block timestamps from the collectors)",
    },
  };
}

// ───────────────────────── 4. the replay ─────────────────────────

export interface ReplayConfig {
  deltas: number[];
  windows: number[];
  exposures: number[];
  /**
   * observation slots the hook's buffer is grown to right after initialization (increaseObservationCardinalityNext).
   * 1,024 is a buffer a pool creator can pay for: Oracle.grow writes each new slot once, about 22.1k gas a cold slot,
   * so ~22.6M gas, which several calls can split. The whole uint16 range (65,535 slots) would be ~1.45B gas; the
   * replay does not assume it. Every read here needs at most oracle.minCardinality slots and is the same at any
   * cardinality at or above it (checked in main).
   */
  cardinality: number;
}

export const DEFAULT_CONFIG: ReplayConfig = { deltas: [10, 3], windows: [600, 1800, 3600], exposures: [1_000, 10_000, 100_000], cardinality: 1024 };

export interface ConfigRead {
  rawTick: number;
  truncTick: number;
  rawAvg: number;
  truncAvg: number;
  v1: Bound | null;
  trusted: boolean[] | null;
  v0: V0 | null;
  v0Picks: (0 | 1 | 2)[] | null;
}

export interface PointRead {
  time: number;
  block?: number;
  tick: number;
  sqrtPriceX96: bigint;
  fee: number;
  livePositions: number;
  /** curve principal of the live positions at the price (whole tokens, no fees), as inventory-1m.json reports it */
  himsInPositions: number;
  usdgInPositions: number;
  /** SafeSettle v1's ladder bound with nobody pushing back (= replay.ts maxSafeExposure), null at a tick limit */
  ladder: ReturnType<typeof maxSafeExposure> | null;
  /** the +10 % push cost in USDG, as inventory-1m.json computes it (for cross-checking the rebuilt state) */
  pushUp10CostUsdg: number | null;
  /** keyed `d${Δ}w${window}`; null where the window predates the hook's first observation (the contract reverts) */
  configs: Record<string, ConfigRead | null>;
}

export interface ObservationWrite {
  ts: number;
  tick: number;
  /** prevTruncatedTick after this write, per Δ */
  trunc: Record<number, number>;
}

export interface ReplayResult {
  times: PointRead[];
  blocks: PointRead[];
  init: { ts: number; tick: number; block: number };
  writes: ObservationWrite[];
}

export const cfgKey = (d: number, w: number) => `d${d}w${w}`;

/**
 * Sweep the pool's ModifyLiquidity and Swap logs in order (inventory.ts sweep), driving one HookReplay per Δ from the
 * swaps, and read HAKARI at each time in `times` (state after every event with timestamp <= t) and at the end of each
 * block in `blocks`. The hook's record starts at the first swap in `swaps` (the seed), initialized at its post-swap
 * tick: what the hook stored before that is unknown here.
 */
export function replay(inp: Pick<Inputs, "mods" | "swaps">, times: number[], blocks: number[], cfg: ReplayConfig = DEFAULT_CONFIG, blockTime?: (b: number) => number): ReplayResult {
  const hooks = cfg.deltas.map((d) => new HookReplay(d));
  const writes: ObservationWrite[] = [];
  let init: ReplayResult["init"] | undefined;
  const ladderCache = { version: -1, ladder: null as PointRead["ladder"], push: null as number | null, positions: [] as Position[], state: undefined as PoolState | undefined, hims: 0, usdg: 0 };

  const read = (s: Live, time: number, block?: number): PointRead => {
    if (s.sqrtPriceX96 === undefined || s.tick === undefined || s.fee === undefined) throw new Error(`no swap before ${time}`);
    if (ladderCache.version !== s.version) {
      ladderCache.version = s.version;
      ladderCache.positions = [...s.book.positions.values()];
      const pr = principal(ladderCache.positions, s.sqrtPriceX96);
      ladderCache.hims = Number(pr.amount1) / 1e18;
      ladderCache.usdg = Number(pr.amount0) / 1e6;
      // a swap that drained the range parks the price at the tick limit: no quote there (inventory.ts does the same)
      const atLimit = s.swapLiquidity === 0n && (s.tick <= MIN_TICK + 1 || s.tick >= MAX_TICK - 1);
      if (atLimit) {
        ladderCache.state = undefined;
        ladderCache.ladder = null;
        ladderCache.push = null;
      } else {
        const state = poolStateFromPositions(ladderCache.positions, s.sqrtPriceX96);
        ladderCache.state = state;
        ladderCache.ladder = maxSafeExposure(state, true, s.fee);
        ladderCache.push = Number(pushCostInQuote(state, 953, true, true, s.fee).costQuote) / 1e6;
      }
    }
    const configs: Record<string, ConfigRead | null> = {};
    for (const h of hooks) {
      for (const w of cfg.windows) {
        let tw: Twaps;
        try {
          tw = h.twaps(time, w, s.tick);
        } catch (e) {
          if (e instanceof TargetPredatesOldestObservation) { configs[cfgKey(h.delta, w)] = null; continue; }
          throw e;
        }
        const gap = tw.rawTick - tw.truncTick;
        const v1 = ladderCache.state && ladderCache.ladder ? v1Bound(ladderCache.state, s.fee, gap, ladderCache.ladder) : null;
        const v0 = ladderCache.state ? v0Decision(ladderCache.positions, tw.rawTick, tw.truncTick, s.fee) : null;
        configs[cfgKey(h.delta, w)] = {
          ...tw,
          v1,
          trusted: v1 ? cfg.exposures.map((e) => v1Trusts(v1, e)) : null,
          v0,
          v0Picks: v0 ? cfg.exposures.map((e) => v0Pick(v0, e)) : null,
        };
      }
    }
    return { time, block, tick: s.tick, sqrtPriceX96: s.sqrtPriceX96, fee: s.fee, livePositions: ladderCache.positions.length, himsInPositions: ladderCache.hims, usdgInPositions: ladderCache.usdg, ladder: ladderCache.ladder, pushUp10CostUsdg: ladderCache.push, configs };
  };

  const timeReads: PointRead[] = [];
  const blockReads: PointRead[] = [];
  sweep(inp.mods, inp.swaps, times, blocks, {
    swap(r, s) {
      if (!init) {
        // the seed: the hook's record starts here, at the tick this swap leaves (the probe's convention too)
        for (const h of hooks) {
          h.afterInitialize(r.ts, r.tick);
          h.increaseObservationCardinalityNext(cfg.cardinality);
        }
        init = { ts: r.ts, tick: r.tick, block: r.block };
        return;
      }
      // BaseOracleHook._beforeSwap: slot0's tick before this swap = the tick the previous swap left
      let wrote = false;
      for (const h of hooks) wrote = h.beforeSwap(r.ts, s.tick!) || wrote;
      if (wrote) writes.push({ ts: r.ts, tick: s.tick!, trunc: Object.fromEntries(hooks.map((h) => [h.delta, h.oracle.slot(h.oracle.index).prevTruncatedTick])) });
    },
    grid(k, s) {
      timeReads[k] = read(s, times[k]);
    },
    block(b, s) {
      if (!blockTime) throw new Error("block reads need blockTime()");
      blockReads.push(read(s, blockTime(b), b));
    },
  });
  if (!init) throw new Error("no swaps");
  return { times: timeReads, blocks: blockReads, init, writes };
}

// ───────────────────────── 5. main: the per-minute file and the summary ─────────────────────────

/** gauge/data/hims-replay.json's five blocks (hims-replay.ts POINTS; not imported: that module talks to the chain). */
export const REPLAY_BLOCKS = [50_265_277, 50_415_299, 50_444_948, 50_490_000, 50_772_447];

/**
 * Moments the page and README name. 00:43:30 is the second of the first Monday mint: the mint's block 50,444,949 and
 * the block before it, 50,444,948, share that timestamp. A read covers the whole second, so it comes after the mint's
 * block; the pool is still as it was at 50,444,948 (its last swap was at 00:43:23; no swap or liquidity change follows
 * until 00:43:32), which the tests check.
 */
export const FIRST_MINT = { ts: 1_788_137_010, block: 50_444_949, lastBlockBefore: 50_444_948 };
export const MOMENTS = [
  { id: "sun-1940", ts: 1_788_118_800, label: "Sun 19:40 UTC: before the squeeze (hims-replay point 1)" },
  { id: "sun-2325", ts: 1_788_132_300, label: "Sun 23:25: a swap at 23:24:59 bought the last HIMS in the LPs' ranges; the positions hold 3.68 HIMS" },
  { id: "sun-2336", ts: 1_788_132_960, label: "Sun 23:36: DeFiPrime samples 61.15 at 23:36:14" },
  { id: "sun-2353", ts: 1_788_133_980, label: "Sun 23:53: 12 USDG to push +10 % (hims-replay point 2 is at 23:53:36)" },
  { id: "mon-004330", ts: 1_788_137_010, label: "Mon 00:43:30: the second of the first Monday mint (block 50,444,949); the pool is as at block 50,444,948, the last block before it, at 54.50" },
  { id: "mon-0159", ts: 1_788_141_540, label: "Mon 01:59: back near 29.3 after the mints (hims-replay point 4 is at 01:59:17)" },
];

/** The internal review's hims_sim.py (2026-09-26, outside this repo): its printed output, to compare against. */
const PROBE = {
  swaps1940to004330: 3220,
  seconds1940to004330: 1687,
  // [ts, Δ, window] -> [raw, trunc, gap ticks], prices in USDG per HIMS to 2 decimals
  rows: [
    [1_788_118_800, 10, 600, 29.38, 29.38, 0], [1_788_118_800, 10, 1800, 29.41, 29.42, 0], [1_788_118_800, 10, 3600, 29.46, 29.46, 0],
    [1_788_133_980, 10, 600, 48.16, 51.41, 652], [1_788_133_980, 10, 1800, 52.52, 50.60, 373], [1_788_133_980, 10, 3600, 45.93, 43.77, 481],
    [1_788_137_010, 10, 600, 51.51, 50.39, 220], [1_788_137_010, 10, 1800, 48.21, 48.18, 6], [1_788_137_010, 10, 3600, 44.92, 48.69, 805],
    [1_788_118_800, 3, 600, 29.38, 29.47, 29], [1_788_118_800, 3, 1800, 29.41, 29.50, 27], [1_788_118_800, 3, 3600, 29.46, 29.55, 31],
    [1_788_133_980, 3, 600, 48.16, 42.26, 1307], [1_788_133_980, 3, 1800, 52.52, 39.91, 2746], [1_788_133_980, 3, 3600, 45.93, 36.81, 2213],
    [1_788_137_010, 3, 600, 51.51, 44.24, 1522], [1_788_137_010, 3, 1800, 48.21, 43.07, 1127], [1_788_137_010, 3, 3600, 44.92, 42.78, 488],
  ] as [number, number, number, number, number, number][],
  spot: { 1_788_118_800: 29.38, 1_788_133_980: 43.27, 1_788_137_010: 54.5 } as Record<number, number>,
};

const sig = (x: number | null | undefined, d = 6) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toPrecision(d)));
const iso = (ts: number) => new Date(ts * 1000).toISOString().replace(".000Z", "Z");
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Arrays of plain values on one line (4,081-point series would otherwise be 100k lines, as in inventory.ts), and with
 * `compact`, small objects of plain values on one line too, so the committed summary stays short.
 */
function writeJson(file: string, value: unknown, compact = false) {
  let text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)
    .replace(/\[\n\s*([^[\]{}]*?)\n\s*\]/g, (_m, body: string) => `[${body.split(/,\n\s*/).join(", ")}]`);
  if (compact) {
    // innermost objects first, repeatedly, while the result stays under ~150 characters
    for (let pass = 0; pass < 3; pass++) {
      text = text.replace(/\{\n\s*([^{}]*?)\n\s*\}/g, (m, body: string) => {
        const one = `{ ${body.split(/,\n\s*/).join(", ")} }`;
        return one.length <= 150 && !/\[\s*\{/.test(body) ? one : m;
      });
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text + "\n");
}

const pickName = (pick: 0 | 1 | 2) => (pick === 2 ? "truncated" : pick === 1 ? "raw (cost > gain)" : "raw (unchecked)");

/** One configuration's read, compact, for the committed JSON. */
function describeConfig(c: ConfigRead | null, cfg: ReplayConfig) {
  if (!c) return null;
  return {
    twapTicks: { raw: c.rawTick, trunc: c.truncTick, gap: c.rawTick - c.truncTick },
    usdgPerHims: { raw: r2(usdgPerHimsAtTick(c.rawTick)), trunc: r2(usdgPerHimsAtTick(c.truncTick)) },
    v1: c.v1 && {
      maxSafeExposureUsdg: sig(c.v1.exposure / 1e6),
      binding: `${c.v1.gapBinds ? "the TWAP gap, " : ""}${c.v1.ticks} ticks, HIMS ${c.v1.stockUp ? "up" : "down"}`,
      decide: Object.fromEntries(cfg.exposures.map((e, i) => [e, c.trusted![i] ? "trust raw" : "refuse"])),
    },
    v0: c.v0 && {
      thresholdUsdg: c.v0.checked ? sig(c.v0.thresholdUsdg!) : null,
      settle: Object.fromEntries(cfg.exposures.map((e, i) => { const pick = c.v0Picks![i]; return [e, `${pickName(pick)} ${r2(usdgPerHimsAtTick(pick === 2 ? c.truncTick : c.rawTick))}`]; })),
    },
  };
}

/** One read, compact: the pool, the ladder bound, and every configuration (or just `only`). */
function describe(p: PointRead, cfg: ReplayConfig, only?: string) {
  const configs: Record<string, unknown> = {};
  for (const d of cfg.deltas) for (const w of cfg.windows) {
    const k = cfgKey(d, w);
    if (!only || only === k) configs[k] = describeConfig(p.configs[k], cfg);
  }
  return {
    pool: { tick: p.tick, usdgPerHims: sig(usdgPerHimsAtTick(p.tick)), swapFeePips: p.fee, livePositions: p.livePositions, himsInPositions: sig(p.himsInPositions), usdgInPositions: sig(p.usdgInPositions), pushUp10CostUsdg: sig(p.pushUp10CostUsdg) },
    maxSafeExposureUsdg: p.ladder ? sig(p.ladder.exposure / 1e6) : null,
    binding: p.ladder ? { ticks: p.ladder.ticks, himsUp: p.ladder.stockUp, costUsdg: sig(Number(p.ladder.cost) / 1e6), complete: p.ladder.complete } : null,
    configs,
  };
}

export async function main() {
  const cfg = DEFAULT_CONFIG;
  const t0 = Date.now();
  const inp = await loadInputs();
  const n = (WINDOW_END_TS - WINDOW_START_TS) / 60 + 1;
  const grid = Array.from({ length: n }, (_, k) => WINDOW_START_TS + 60 * k);
  const extra = MOMENTS.map((m) => m.ts).filter((t) => (t - WINDOW_START_TS) % 60 !== 0);
  const times = [...new Set([...grid, ...extra])].sort((a, b) => a - b);
  const replayJson = readCache(new URL("../../data/hims-replay.json", import.meta.url).pathname) as any;
  const blockTs = new Map<number, number>(replayJson.points.map((p: any) => [Number(p.block), Number(p.timestamp)]));
  const res = replay(inp, times, REPLAY_BLOCKS, cfg, (b) => {
    const t = blockTs.get(b);
    if (t === undefined) throw new Error(`no timestamp for block ${b}`);
    return t;
  });
  const at = new Map(res.times.map((p) => [p.time, p]));
  const gridReads = grid.map((t) => at.get(t)!);
  console.log(`replayed ${inp.swaps.length} swaps, ${inp.mods.length} ModifyLiquidity, ${res.writes.length} observations, ${times.length} reads in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // ── checks ──
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  // (c) the five hims-replay.json blocks, to the unit
  const replayCheck = res.blocks.map((p) => {
    const theirs = replayJson.points.find((x: any) => Number(x.block) === p.block).maxSafeExposureUsdg;
    const ours = { usdg: p.ladder!.exposure / 1e6, bindingTicks: p.ladder!.ticks, bindingStockUp: p.ladder!.stockUp, bindingCostUsdg: Number(p.ladder!.cost) / 1e6 };
    const identical = ours.usdg === theirs.usdg && ours.bindingTicks === theirs.bindingTicks && ours.bindingStockUp === theirs.bindingStockUp && ours.bindingCostUsdg === theirs.bindingCostUsdg;
    return { block: p.block!, timestamp: p.time, time: iso(p.time), ours, himsReplayJson: theirs, identical };
  });
  checks.push({ name: "Max safe exposure at the five hims-replay.json blocks", pass: replayCheck.every((r) => r.identical), detail: replayCheck.map((r) => `${r.block}: ${r.ours.usdg} vs ${r.himsReplayJson.usdg} USDG, ${r.ours.bindingTicks} ticks ${r.ours.bindingStockUp ? "up" : "down"} (${r.identical ? "identical" : "DIFFERENT"})`).join("; ") });
  // the rebuilt state at every minute is the dataset's: its +10 % push cost equals inventory-1m.json's
  const inv = readCache(`${outDir}inventory-1m.json`) as any;
  if (inv?.pushUp10CostUsdg?.length === n) {
    let same = 0, both = 0;
    gridReads.forEach((p, k) => {
      const a = sig(p.pushUp10CostUsdg, 10), b = inv.pushUp10CostUsdg[k];
      if (a === null && b === null) same++;
      else if (a !== null && b !== null) { both++; if (a === b) same++; }
    });
    checks.push({ name: "Pool state at every grid minute equals inventory-1m.json's", pass: same === n, detail: `push +10 % cost identical at ${same}/${n} minutes (replay.ts pushCostInQuote on the same sweep)` });
  }
  // the raw series does not depend on Δ
  let rawSame = true;
  for (const p of res.times) for (const w of cfg.windows) {
    const a = p.configs[cfgKey(cfg.deltas[0], w)], b = p.configs[cfgKey(cfg.deltas[1], w)];
    if ((a === null) !== (b === null) || (a && b && (a.rawTick !== b.rawTick || a.rawAvg !== b.rawAvg))) rawSame = false;
  }
  checks.push({ name: "Raw TWAP identical in the Δ = 10 and Δ = 3 hooks", pass: rawSame, detail: "truncation only touches the truncated accumulator" });
  // the probe's numbers
  const inSqueeze = inp.swaps.filter((s) => s.ts >= 1_788_118_800 && s.ts <= 1_788_137_010);
  const squeezeSeconds = new Set(inSqueeze.map((s) => s.ts)).size;
  const squeezeWrites = res.writes.filter((w) => w.ts >= 1_788_118_800 && w.ts <= 1_788_137_010).length;
  const probeRows = PROBE.rows.map(([ts, d, w, praw, ptrunc, pgap]) => {
    const c = at.get(ts)!.configs[cfgKey(d, w)]!;
    const oursRaw = r2(usdgPerHimsAtTick(c.rawAvg)), oursTrunc = r2(usdgPerHimsAtTick(c.truncAvg)), oursGap = Math.round(Math.abs(c.rawAvg - c.truncAvg));
    return {
      time: iso(ts), delta: d, windowMin: w / 60,
      probe: { raw: praw, trunc: ptrunc, gapTicks: pgap },
      ours: { raw: oursRaw, trunc: oursTrunc, gapTicks: oursGap },
      oursContract: { rawTick: c.rawTick, truncTick: c.truncTick, gapTicks: c.rawTick - c.truncTick, raw: r2(usdgPerHimsAtTick(c.rawTick)), trunc: r2(usdgPerHimsAtTick(c.truncTick)) },
      identical: oursRaw === praw && oursTrunc === ptrunc && oursGap === pgap,
    };
  });
  const spotRows = Object.entries(PROBE.spot).map(([ts, v]) => ({ time: iso(Number(ts)), probe: v, ours: r2(usdgPerHimsAtTick(at.get(Number(ts))!.tick)) }));
  checks.push({
    name: "Audit probe hims_sim.py reproduced",
    pass: inSqueeze.length === PROBE.swaps1940to004330 && squeezeSeconds === PROBE.seconds1940to004330 && probeRows.every((r) => r.identical) && spotRows.every((r) => r.ours === r.probe),
    detail: `19:40-00:43:30: ${inSqueeze.length} swaps in ${squeezeSeconds} seconds (${squeezeWrites} observations; probe ${PROBE.swaps1940to004330} / ${PROBE.seconds1940to004330}); ${probeRows.filter((r) => r.identical).length}/${probeRows.length} TWAP rows identical to 2 decimals and 1 tick`,
  });

  // ── assumptions measured ──
  const obsTimes = [res.init.ts, ...res.writes.map((w) => w.ts)];
  const cardinality = Object.fromEntries(cfg.windows.map((w) => [w, minCardinality(obsTimes, w)]));
  // the buffer: re-read every TWAP from the recorded observations with exactly the slots the longest window needs at
  // its worst second, and with one fewer
  const need = Math.max(...Object.values(cardinality));
  const readsAt = res.times.map((p) => ({ time: p.time, tick: p.tick }));
  let sameAtNeed = 0, readsTotal = 0, lostBelow = 0;
  for (const d of cfg.deltas) {
    const atNeed = rereadAtCardinality(res.init, res.writes, readsAt, d, cfg.windows, need);
    const below = rereadAtCardinality(res.init, res.writes, readsAt, d, cfg.windows, need - 1);
    res.times.forEach((p, k) => cfg.windows.forEach((w, i) => {
      const c = p.configs[cfgKey(d, w)], a = atNeed[k][i];
      readsTotal++;
      if (c === null ? a === null : a !== null && a.raw === c.rawTick && a.trunc === c.truncTick) sameAtNeed++;
      if (c !== null && below[k][i] === null) lostBelow++;
    }));
  }
  checks.push({
    name: "Every TWAP read is the same with the buffer at oracle.minCardinality",
    pass: need <= cfg.cardinality && sameAtNeed === readsTotal,
    detail: `replayed with ${cfg.cardinality} slots; re-read from the recorded observations with ${need} slots (the most any window needs at its worst second): ${sameAtNeed}/${readsTotal} reads identical; with ${need - 1} slots, ${lostBelow} of these reads would revert`,
  });
  const forgotten: Record<string, string | null> = {};
  let forgetMinutes = 0;
  for (const d of cfg.deltas) for (const off of [-500, 500]) {
    const f = truncatedStartForgottenAt(res.init, res.writes, d, off);
    forgotten[`d${d}${off > 0 ? "+" : ""}${off}`] = f === null ? null : iso(f);
    forgetMinutes = f === null ? Infinity : Math.max(forgetMinutes, Math.ceil((f - res.init.ts) / 60));
  }

  // ── per-minute arrays ──
  const col = <T,>(f: (p: PointRead) => T) => gridReads.map(f);
  const perCfg = <T,>(f: (c: ConfigRead) => T) => {
    const o: Record<string, Record<string, (T | null)[]>> = {};
    for (const d of cfg.deltas) {
      o[`d${d}`] = {};
      for (const w of cfg.windows) o[`d${d}`][`w${w}`] = col((p) => { const c = p.configs[cfgKey(d, w)]; return c ? f(c) : null; });
    }
    return o;
  };
  const rawByW = (f: (c: ConfigRead) => number) => Object.fromEntries(cfg.windows.map((w) => [`w${w}`, col((p) => { const c = p.configs[cfgKey(cfg.deltas[0], w)]; return c ? f(c) : null; })]));
  const obsBars = new Array<number>(n).fill(0);
  for (const w of res.writes) { const k = Math.ceil((w.ts - WINDOW_START_TS) / 60); if (k >= 1 && k < n) obsBars[k]++; }
  const decisions: Record<string, Record<string, Record<string, (number | null)[]>>> = {};
  const v0picks: typeof decisions = {};
  for (const d of cfg.deltas) {
    decisions[`d${d}`] = {}; v0picks[`d${d}`] = {};
    for (const w of cfg.windows) {
      decisions[`d${d}`][`w${w}`] = Object.fromEntries(cfg.exposures.map((e, i) => [`e${e}`, col((p) => { const c = p.configs[cfgKey(d, w)]; return c?.trusted ? (c.trusted[i] ? 1 : 0) : null; })]));
      v0picks[`d${d}`][`w${w}`] = Object.fromEntries(cfg.exposures.map((e, i) => [`e${e}`, col((p) => { const c = p.configs[cfgKey(d, w)]; return c?.v0Picks ? c.v0Picks[i] : null; })]));
    }
  }
  const perMinute = {
    meta: {
      what: "HAKARI's own rules replayed on the HIMS/USDG weekend at every minute, as if HakariOracleHook had been attached to the pool. It was not: HIMS/USDG has no hook (hooks = 0x0), so no HAKARI contract ever read this pool; this is a counterfactual computed from the pool's real swaps and positions.",
      pool: { name: "HIMS/USDG", ...inp.pool, quote: "USDG (currency0)", quoteIsCurrency0: true },
      grid: { start: WINDOW_START_TS, end: WINDOW_END_TS, step: 60, n, startIso: iso(WINDOW_START_TS), endIso: iso(WINDOW_END_TS), note: "the grid of web/squeeze/data.json" },
      parameters: { deltas: cfg.deltas, windowsSec: cfg.windows, exposuresUsdg: cfg.exposures, toleranceTicks: TOLERANCE_TICKS, ladderTicks: LADDER, arbReversionSeconds: 0, primary: { delta: 10, windowSec: 1800 } },
      assumptions: [
        "Counterfactual: HIMS/USDG never had HakariOracleHook, and a v4 hook is part of the PoolKey, so it never could have. The replay assumes the same swaps and positions in a pool that had it. The hook only records (no fee, no delta), so it would not by itself have changed any swap.",
        `The hook's record starts at the last swap before the window (block ${res.init.block}, ${iso(res.init.ts)}), initialized at the tick that swap left, with the truncated series equal to the raw one. Windows reaching before it are null (the contract reverts with TargetPredatesOldestObservation). A truncated start 500 ticks off either way is forgotten within ${forgetMinutes} minutes (oracle.truncatedStartForgottenAt), two days before the squeeze.`,
        `Observation buffer grown to ${cfg.cardinality} slots right after initialization (increaseObservationCardinalityNext: one first-time storage write per slot, about ${(((cfg.cardinality - 1) * 22_100) / 1e6).toFixed(1)}M gas, which several calls can split). Every read here needs at most oracle.minCardinality slots (${need} for ${Math.max(...cfg.windows) / 60}-minute reads) and is identical at any cardinality at or above that (see checks).`,
        "Reads at t_k: every ModifyLiquidity and Swap with block timestamp <= t_k applied, and the hook read as a view call at the end of that second (observe with the current slot0 tick) — the convention of web/squeeze/data.json.",
        "Nobody pushes back (arbReversionSeconds = 0) at every minute. That holds between the mint rule's close (Sat 00:00 UTC) and the first Monday mint (00:43:30 UTC); before and after, arbitrage was possible, so there the bound is a lower bound and a refusal is conservative. weekend.v1RefusalsPrimary counts both: minutesRefusedWhileMintClosed and longestRunWhileMintClosed where the assumption holds, minutesRefused and longestRun over the whole window.",
        "Max safe exposure: replay.ts maxSafeExposure (the gauge's mirror of CostModel.maxSafeExposure, pinned by test/max-safe-exposure.test.ts) on the pool rebuilt from positions at the last swap's price, fee = that swap's fee (9,991 pips). Its walk is capped at 1,024 segments, not the contract's MAX_WALK_STEPS bitmap steps (64 in the SafeSettle deployed from 98bc7d7, 256 from 20e7d87); every walk here completed. With nobody pushing back, 20e7d87's push-width search prices each move at its own width, as 98bc7d7 does.",
        "SafeSettle v1 also prices the gap between the two TWAPs as one more move when it exceeds 10 ticks (CostModel's extraTicks). v1.gapBoundUsdg is that bound where it binds, else null; the effective bound is gapBoundUsdg ?? maxSafeExposureUsdg.",
        "SafeSettle v0 is the rule at fced71c: within 10 ticks, raw with no check; otherwise the round trip from the truncated price to the raw one through the liquidity present now (PushCostLens.roundTripCostBetween, mirrored with v4math), against the gain on the exposure. It never refuses.",
        "TWAP ticks are HakariOracleHook.twaps' int24 results (rounded toward negative infinity); prices are 1e12 / 1.0001^tick USDG per HIMS.",
      ],
      encoding: {
        numbers: "6 significant digits; null where undefined (window before the hook's first observation)",
        twap: "USDG per HIMS from the int24 TWAP tick; raw is the same for both Δ; trunc.d10 / trunc.d3",
        twapTick: "the int24 ticks themselves; gap = raw - trunc, and since USDG is currency0 a negative gap means the raw price is above the truncated one",
        observations: "observations the hook writes in (t_{k-1}, t_k] (= distinct seconds with a swap); 0 at k = 0",
        v1: "maxSafeExposureUsdg / binding*: the ladder bound (independent of Δ and window with nobody pushing back); gapBoundUsdg[d][w]: the gap rung where it binds; decision[d][w][e]: 1 = trust raw, 0 = refuse, null = no TWAP yet",
        v0: "pick[d][w][e]: 0 = raw, gap <= 10 ticks (no cost check); 1 = raw, faking costs more than it earns; 2 = truncated. thresholdUsdg[d][w]: v0 settles on raw below this exposure and on truncated above (null when unchecked)",
      },
      oracle: {
        firstObservation: { block: res.init.block, ts: res.init.ts, iso: iso(res.init.ts), tick: res.init.tick },
        observationsWritten: res.writes.length,
        swaps: inp.swaps.length,
        minCardinality: cardinality,
        truncatedStartForgottenAt: forgotten,
      },
      checks,
      sources: { ...inp.sources, himsReplay: "gauge/data/hims-replay.json", auditProbe: "hims_sim.py, the internal review's float replay of the same swaps (2026-09-26, run outside this repo; its printed numbers are compared here, none of its code is used)" },
      generatedAt: new Date().toISOString(),
    },
    t: grid,
    spotTick: col((p) => p.tick),
    observations: obsBars,
    twap: { raw: rawByW((c) => sig(usdgPerHimsAtTick(c.rawTick))!), trunc: perCfg((c) => sig(usdgPerHimsAtTick(c.truncTick))) },
    twapTick: { raw: rawByW((c) => c.rawTick), trunc: perCfg((c) => c.truncTick) },
    v1: {
      maxSafeExposureUsdg: col((p) => (p.ladder ? sig(p.ladder.exposure / 1e6) : null)),
      bindingTicks: col((p) => p.ladder?.ticks ?? null),
      bindingStockUp: col((p) => (p.ladder ? (p.ladder.stockUp ? 1 : 0) : null)),
      bindingCostUsdg: col((p) => (p.ladder ? sig(Number(p.ladder.cost) / 1e6) : null)),
      complete: col((p) => (p.ladder ? (p.ladder.complete ? 1 : 0) : null)),
      gapBoundUsdg: perCfg((c) => (c.v1?.gapBinds ? sig(c.v1.exposure / 1e6) : null)),
      decision: decisions,
    },
    v0: { thresholdUsdg: perCfg((c) => (c.v0?.checked ? sig(c.v0.thresholdUsdg!) : null)), pick: v0picks },
  };
  writeJson(`${outDir}hakari-1m.json`, perMinute);

  // ── summary ──
  const closedFrom = REF.mintRuleClose, closedTo = FIRST_MINT.ts; // the mint rule's close to the first Monday mint
  const primary = cfgKey(10, 1800);
  const ladderMin = gridReads.reduce<{ k: number; v: number } | null>((m, p, k) => (p.ladder && (m === null || p.ladder.exposure < m.v) ? { k, v: p.ladder.exposure } : m), null)!;
  const refusals = Object.fromEntries(cfg.exposures.map((e, i) => {
    const refusedAt = gridReads.map((p, k) => ({ k, c: p.configs[primary] })).filter((x) => x.c?.trusted && !x.c.trusted[i]);
    const inClosed = refusedAt.filter((x) => grid[x.k] >= closedFrom && grid[x.k] <= closedTo);
    // the longest run of consecutive refused minutes
    const longest = (xs: { k: number }[]) => {
      let best = { from: -1, to: -1 }, cur = { from: -1, to: -1 };
      for (const x of xs) { if (x.k === cur.to + 1) cur.to = x.k; else cur = { from: x.k, to: x.k }; if (cur.to - cur.from > best.to - best.from) best = { ...cur }; }
      return best.from >= 0 ? { from: iso(grid[best.from]), to: iso(grid[best.to]), minutes: best.to - best.from + 1 } : null;
    };
    // what v0 settled on in the minutes v1 refused
    const v0Prices = refusedAt.map((x) => usdgPerHimsAtTick(x.c!.v0Picks![i] === 2 ? x.c!.truncTick : x.c!.rawTick));
    return [e, {
      minutesRefused: refusedAt.length,
      minutesRefusedWhileMintClosed: inClosed.length,
      minutesRefusedAfterFirstMint: refusedAt.filter((x) => grid[x.k] > closedTo).length,
      firstRefused: refusedAt.length ? iso(grid[refusedAt[0].k]) : null,
      lastRefused: refusedAt.length ? iso(grid[refusedAt[refusedAt.length - 1].k]) : null,
      longestRun: longest(refusedAt),
      longestRunWhileMintClosed: longest(inClosed),
      v0SettledMeanwhileUsdgPerHims: v0Prices.length ? { min: r2(Math.min(...v0Prices)), max: r2(Math.max(...v0Prices)) } : null,
    }];
  }));
  const gapMax = Object.fromEntries(cfg.deltas.flatMap((d) => cfg.windows.map((w) => {
    let best = { k: -1, g: 0 };
    gridReads.forEach((p, k) => { const c = p.configs[cfgKey(d, w)]; if (c && Math.abs(c.rawTick - c.truncTick) > Math.abs(best.g)) best = { k, g: c.rawTick - c.truncTick }; });
    return [cfgKey(d, w), { ticks: best.g, at: best.k >= 0 ? iso(grid[best.k]) : null }];
  })));
  const gapBinds = Object.fromEntries(cfg.deltas.flatMap((d) => cfg.windows.map((w) => [cfgKey(d, w), gridReads.filter((p) => p.configs[cfgKey(d, w)]?.v1?.gapBinds).length])));
  const peak = (f: (c: ConfigRead) => number, key: string) => {
    let best = { k: -1, v: -Infinity };
    gridReads.forEach((p, k) => { const c = p.configs[key]; if (c) { const v = usdgPerHimsAtTick(f(c)); if (v > best.v) best = { k, v }; } });
    return { usdgPerHims: r2(best.v), at: iso(grid[best.k]) };
  };
  const moment = at.get(FIRST_MINT.ts)!;
  const v0At004330 = cfg.deltas.flatMap((d) => cfg.windows.flatMap((w) => { const c = moment.configs[cfgKey(d, w)]!; return c.v0Picks!.map((pk) => usdgPerHimsAtTick(pk === 2 ? c.truncTick : c.rawTick)); }));
  // every stretch of minutes in which v1 (primary) refuses 1,000 USDG, and which move set the bound
  const runs: { from: string; to: string; minutes: number; lowestBoundUsdg: number | null; setBy: string }[] = [];
  {
    let cur: { from: number; to: number; low: number; gap: number } | null = null;
    const flush = () => cur && runs.push({ from: iso(grid[cur.from]), to: iso(grid[cur.to]), minutes: cur.to - cur.from + 1, lowestBoundUsdg: sig(cur.low / 1e6), setBy: cur.gap === 0 ? "the ladder" : cur.gap === cur.to - cur.from + 1 ? "the TWAP gap" : `the TWAP gap in ${cur.gap} of the minutes` });
    gridReads.forEach((p, k) => {
      const c = p.configs[primary];
      if (!c?.trusted || c.trusted[0]) return;
      const gapOnly = c.v1!.gapBinds && p.ladder!.exposure > cfg.exposures[0] * 1e6 ? 1 : 0;
      if (cur && cur.to === k - 1) { cur.to = k; cur.low = Math.min(cur.low, c.v1!.exposure); cur.gap += gapOnly; }
      else { flush(); cur = { from: k, to: k, low: c.v1!.exposure, gap: gapOnly }; }
    });
    flush();
  }
  // after the first Monday mint the move was real; truncation lags it, and v0 can settle on the lagging series
  const afterMint = gridReads.map((p, k) => ({ p, k })).filter(({ k }) => grid[k] > FIRST_MINT.ts);
  const stale = Object.fromEntries(cfg.exposures.map((e, i) => {
    let n = 0, worst = { k: -1, prem: 0, settle: 0, spot: 0 };
    for (const { p, k } of afterMint) {
      const c = p.configs[primary];
      if (!c?.v0Picks || c.v0Picks[i] !== 2) continue;
      const settle = usdgPerHimsAtTick(c.truncTick), spot = usdgPerHimsAtTick(p.tick), prem = settle / spot - 1;
      if (prem > 0.1) n++;
      if (prem > worst.prem) worst = { k, prem, settle, spot };
    }
    return [e, { minutesOnTruncatedOver10PctAboveSpot: n, worst: worst.k >= 0 ? { at: iso(grid[worst.k]), settlesUsdgPerHims: r2(worst.settle), spotUsdgPerHims: r2(worst.spot), premiumPct: r2(worst.prem * 100) } : null }];
  }));
  // layer 1 on the real tape: the swap that hit the tick limit at 23:24:59 and what the hook recorded around it
  const limitSwap = inp.swaps.find((s) => s.tick <= MIN_TICK + 1 || s.tick >= MAX_TICK - 1);
  const limitWrites = limitSwap ? res.writes.filter((w) => w.ts >= limitSwap.ts - 2 && w.ts <= limitSwap.ts + 1) : [];

  const summary = {
    what: perMinute.meta.what,
    pool: perMinute.meta.pool,
    produce: "cd gauge && npm run squeeze:hakari (alias npm run hims:hook); inputs are the squeeze collectors' caches (npm run squeeze). Per-minute arrays: gauge/cache/squeeze/out/hakari-1m.json (git-ignored, rebuilt by the command).",
    parameters: perMinute.meta.parameters,
    assumptions: perMinute.meta.assumptions,
    oracle: {
      ...perMinute.meta.oracle,
      squeeze1940to004330: { swaps: inSqueeze.length, distinctSeconds: squeezeSeconds, observations: squeezeWrites },
      layer1TickLimit: limitSwap && {
        swap: { block: limitSwap.block, logIndex: limitSwap.logIndex, time: iso(limitSwap.ts), tickAfter: limitSwap.tick, note: "bought the last HIMS in range; slot0 sat at the tick limit (USDG per HIMS ~1e50) until a sale later in the same block" },
        observationsAround: limitWrites.map((w) => ({ time: iso(w.ts), tickWritten: w.tick, trunc: w.trunc })),
        recorded: limitWrites.some((w) => w.tick === limitSwap.tick) ? "the tick limit was recorded" : "never recorded: the hook writes once per second, before that second's first swap, and the pool was back by the next second",
      },
    },
    auditProbe: {
      source: "hims_sim.py / hims_sim.out.txt, 2026-09-26 (float replay of the same swaps, outside the repo)",
      swaps1940to004330: { probe: PROBE.swaps1940to004330, ours: inSqueeze.length },
      distinctSeconds1940to004330: { probe: PROBE.seconds1940to004330, ours: squeezeSeconds },
      spot: spotRows,
      twaps: probeRows,
      note: "`ours` uses the exact average tick (as the probe does) for prices to 2 decimals and the gap to 1 tick; `oursContract` is what HakariOracleHook.twaps returns (int24, floored), off by less than one tick",
    },
    keyMoments: MOMENTS.map((m) => ({ id: m.id, label: m.label, ts: m.ts, time: iso(m.ts), gridIndex: (m.ts - WINDOW_START_TS) % 60 === 0 ? (m.ts - WINDOW_START_TS) / 60 : null, ...describe(at.get(m.ts)!, cfg) })),
    replayBlocks: replayCheck.map((r, i) => ({ ...r, hookPrimary: describe(res.blocks[i], cfg, primary).configs[primary] })),
    weekend: {
      minMaxSafeExposure: { usdg: sig(ladderMin.v / 1e6), at: iso(grid[ladderMin.k]) },
      maxSafeExposureAt: Object.fromEntries(MOMENTS.map((m) => [m.id, sig(at.get(m.ts)!.ladder!.exposure / 1e6)])),
      v1RefusalsPrimary: { config: "Δ = 10, 30-minute window, nobody pushing back", byExposureUsdg: refusals, runsRefusing1000Usdg: runs },
      v0At004330: {
        min: r2(Math.min(...v0At004330)), max: r2(Math.max(...v0At004330)),
        seriesSpan: (() => { const xs = Object.values(moment.configs).flatMap((c) => [c!.rawTick, c!.truncTick]).map(usdgPerHimsAtTick); return { min: r2(Math.min(...xs)), max: r2(Math.max(...xs)) }; })(),
        note: "over every Δ (10, 3), window (10/30/60 min) and exposure (1k/10k/100k) v0 settles and never refuses; seriesSpan is where the raw and truncated TWAPs lie, min/max where v0's picks lie",
      },
      v0StaleAfterFirstMint: { config: "Δ = 10, 30-minute window", note: "minutes after 00:43:30 in which v0 settles on the truncated TWAP more than 10 % above the pool's own price, while the move down was real (mints had reopened)", byExposureUsdg: stale },
      rawTwapPeak: Object.fromEntries(cfg.windows.map((w) => [`w${w}`, peak((c) => c.rawTick, cfgKey(10, w))])),
      truncTwapPeak: Object.fromEntries(cfg.deltas.flatMap((d) => cfg.windows.map((w) => [cfgKey(d, w), peak((c) => c.truncTick, cfgKey(d, w))]))),
      largestGap: gapMax,
      minutesTheGapBinds: gapBinds,
    },
    checks,
    sources: perMinute.meta.sources,
    generatedAt: perMinute.meta.generatedAt,
  };
  writeJson(new URL("../../data/hims-hook-replay.json", import.meta.url).pathname, summary, true);

  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  console.log(`min cardinality ${JSON.stringify(cardinality)}; truncated start forgotten ${JSON.stringify(forgotten)}`);
  console.log(`max safe exposure min ${summary.weekend.minMaxSafeExposure.usdg} USDG at ${summary.weekend.minMaxSafeExposure.at}; v0 at 00:43:30 settles ${summary.weekend.v0At004330.min}-${summary.weekend.v0At004330.max}`);
  for (const [e, r] of Object.entries(refusals)) console.log(`  ${e} USDG: refused ${r.minutesRefused} min (${r.minutesRefusedWhileMintClosed} while the mint was closed, ${r.minutesRefusedAfterFirstMint} after the first mint), first ${r.firstRefused}, longest ${JSON.stringify(r.longestRun)} (while closed ${JSON.stringify(r.longestRunWhileMintClosed)}), v0 meanwhile ${JSON.stringify(r.v0SettledMeanwhileUsdgPerHims)}`);
  console.log(`wrote ${outDir}hakari-1m.json and gauge/data/hims-hook-replay.json`);
  if (checks.some((c) => !c.pass)) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) run(main);
