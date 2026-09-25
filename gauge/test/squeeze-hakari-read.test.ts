import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  avgTick, DEFAULT_CONFIG, HookReplay, loadInputs, minCardinality, REPLAY_BLOCKS, replay, TargetPredatesOldestObservation, TOLERANCE_TICKS,
  transform, truncatedStartForgottenAt, TruncatedOracle, usdgPerHimsAtTick, v0Decision, v0Pick, v1Bound, v1Trusts, cfgKey,
} from "../src/squeeze/hakari-read.ts";
import { gainPerUnit, maxSafeExposure, pushCostInQuote } from "../src/replay.ts";
import { getSqrtPriceAtTick, poolStateFromPositions, type Position } from "../src/v4math.ts";
import { cacheDir } from "../src/squeeze/common.ts";

// deterministic pseudo-random numbers (xorshift32)
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), (x >>> 0) / 2 ** 32);
}

test("transform: the truncated tick moves at most Δ from the previous truncated tick; cumulatives add tick × seconds", () => {
  const last = { blockTimestamp: 100, prevTruncatedTick: 1000, tickCumulative: 5n, tickCumulativeTruncated: 7n, initialized: true };
  const up = transform(last, 104, 1025, 10);
  assert.equal(up.prevTruncatedTick, 1010);
  assert.equal(up.tickCumulative, 5n + 1025n * 4n);
  assert.equal(up.tickCumulativeTruncated, 7n + 1010n * 4n);
  assert.equal(transform(last, 101, 990, 10).prevTruncatedTick, 990); // exactly Δ away: not clipped
  assert.equal(transform(last, 101, 989, 10).prevTruncatedTick, 990); // one past: clipped to -Δ
  assert.equal(transform(last, 101, -887272, 3).prevTruncatedTick, 997);
});

test("hand-computed: a push held with one swap a second, read over three windows", () => {
  // t=0 initialize at tick 0; t=10 a swap moves the pool to 100 (written at 0); swaps at t=20 and t=30 hold it there
  const h = new HookReplay(10);
  h.afterInitialize(0, 0);
  h.increaseObservationCardinalityNext(10);
  assert.equal(h.beforeSwap(10, 0), true);
  assert.equal(h.beforeSwap(20, 100), true); // raw cum 1000; trunc 10, cum 100
  assert.equal(h.beforeSwap(30, 100), true); // raw cum 2000; trunc 20, cum 300
  // at t=40 (pool still at 100): raw cum 3000; the counterfactual observation truncates once more, to 30: cum 600
  assert.deepEqual(h.twaps(40, 40, 100), { rawTick: 75, truncTick: 15, rawAvg: 75, truncAvg: 15 });
  // window 15: the left edge t=25 is interpolated between the observations at 20 and 30
  const w15 = h.twaps(40, 15, 100);
  assert.equal(w15.rawTick, 100);
  assert.equal(w15.truncTick, 26); // (600 - 200) / 15 = 26.67, rounded down
  assert.equal(w15.truncAvg, 400 / 15);
  assert.deepEqual(h.twaps(40, 10, 100), { rawTick: 100, truncTick: 30, rawAvg: 100, truncAvg: 30 });
  assert.throws(() => h.twaps(40, 0, 100), /WindowZero/);
});

test("a push and retrace inside one second is never observed (layer 1)", () => {
  const h = new HookReplay(10);
  h.afterInitialize(0, 0);
  h.increaseObservationCardinalityNext(10);
  assert.equal(h.beforeSwap(5, 0), true); // first swap of second 5: pushes to the tick limit
  assert.equal(h.beforeSwap(5, -887272), false); // second swap of that second (the retrace): no write
  assert.equal(h.beforeSwap(8, 0), true); // the next second sees the pool back at 0
  assert.deepEqual(h.twaps(10, 10, 0), { rawTick: 0, truncTick: 0, rawAvg: 0, truncAvg: 0 });
});

test("a held push: the truncated series catches up in x/Δ observations, then both agree on it", () => {
  const h = new HookReplay(10);
  h.afterInitialize(0, 0);
  h.increaseObservationCardinalityNext(100);
  h.beforeSwap(1, 0); // the push happens in this second: the pool sits at 100 from here on
  const truncs: number[] = [];
  for (let t = 2; t <= 12; t++) {
    h.beforeSwap(t, 100);
    truncs.push(h.oracle.slot(h.oracle.index).prevTruncatedTick);
  }
  assert.deepEqual(truncs, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 100]);
  // one window after the catch-up both series read the fake
  const r = h.twaps(40, 20, 100);
  assert.equal(r.rawTick, 100);
  assert.equal(r.truncTick, 100);
});

test("avgTick rounds toward negative infinity, as HakariOracleHook._avg", () => {
  assert.equal(avgTick(7n, 2), 3);
  assert.equal(avgTick(-7n, 2), -4);
  assert.equal(avgTick(-6n, 2), -3);
  assert.equal(avgTick(0n, 5), 0);
});

test("the ring buffer keeps the last `cardinality` observations; older windows revert", () => {
  const h = new HookReplay(10);
  h.afterInitialize(0, 50);
  h.increaseObservationCardinalityNext(3);
  for (const t of [10, 20, 30, 40]) h.beforeSwap(t, 50 + t);
  assert.equal(h.oracle.cardinality, 3);
  // stored: 20, 30, 40. A window starting at 20 works, one starting at 19 does not.
  assert.doesNotThrow(() => h.twaps(45, 25, 90));
  assert.throws(() => h.twaps(45, 26, 90), (e: unknown) => e instanceof TargetPredatesOldestObservation && e.oldestTimestamp === 20 && e.targetTimestamp === 19);
  // without growing, only the newest observation is kept
  const g = new HookReplay(10);
  g.afterInitialize(0, 0);
  g.beforeSwap(10, 0);
  g.beforeSwap(20, 5);
  assert.equal(g.oracle.cardinality, 1);
  assert.throws(() => g.twaps(25, 10, 5), TargetPredatesOldestObservation);
  assert.doesNotThrow(() => g.twaps(25, 5, 5));
});

test("minCardinality is the least cardinality that serves every read, per window", () => {
  const times = [0, 1, 2, 10, 11];
  // at t=11 the window starts at 6: observations 10 and 11 after it, 2 at or before it. (A read at t=2 over 5 s starts
  // before the first observation and reverts whatever the cardinality.)
  assert.equal(minCardinality(times, 5), 3);
  assert.equal(minCardinality(times, 1), 2);
  const run = (cardinality: number) => {
    const h = new HookReplay(3);
    h.afterInitialize(0, 0);
    h.increaseObservationCardinalityNext(cardinality);
    for (const t of times.slice(1)) h.beforeSwap(t, t);
    return () => h.twaps(11, 5, 11);
  };
  // the read at t=11 over 5 s needs the observation at 2 (at or before 6) plus the two after it
  assert.doesNotThrow(run(3));
  assert.throws(run(2), TargetPredatesOldestObservation);
});

test("random swaps: twaps equal a second-by-second sum of the ticks the hook saw, for Δ = 10 and 3", () => {
  for (const delta of [10, 3]) {
    const r = rng(11 + delta);
    const T0 = 1_000, TICK0 = 240_000;
    // the tape: same-second bursts, long gaps, and now and then a jump far larger than Δ
    const swaps: { ts: number; after: number }[] = [];
    let ts = T0, tick = TICK0;
    for (let i = 0; i < 600; i++) {
      ts += r() < 0.3 ? 0 : 1 + Math.floor(r() * (r() < 0.1 ? 300 : 20));
      tick += Math.round((r() - 0.5) * (r() < 0.05 ? 4000 : 60));
      swaps.push({ ts, after: tick });
    }
    const reads = [...new Set(Array.from({ length: 60 }, () => T0 + 700 + Math.floor(r() * (ts - T0 - 700))))].sort((a, b) => a - b);
    // reference, second by second: the tick in force during second s is the one the last swap at or before s left;
    // the truncated tick in force is the one written by the first observation after s (or the pending one at t)
    const tickDuring = (s: number) => { let t = TICK0; for (const w of swaps) { if (w.ts > s) break; t = w.after; } return t; };
    const obs: { ts: number; trunc: number }[] = [];
    {
      let prev = TICK0, cur = TICK0, lastTs = T0;
      for (const w of swaps) {
        if (w.ts !== lastTs) {
          const d = cur - prev;
          prev = d > delta ? prev + delta : d < -delta ? prev - delta : cur;
          obs.push({ ts: w.ts, trunc: prev });
          lastTs = w.ts;
        }
        cur = w.after;
      }
    }
    const reference = (t: number, W: number) => {
      const now = tickDuring(t);
      const lastObs = [...obs].reverse().find((o) => o.ts <= t);
      const prev = lastObs ? lastObs.trunc : TICK0;
      const pending = now - prev > delta ? prev + delta : now - prev < -delta ? prev - delta : now;
      let raw = 0, trunc = 0;
      for (let s = t - W; s < t; s++) {
        raw += tickDuring(s);
        const next = obs.find((o) => o.ts > s && o.ts <= t);
        trunc += next ? next.trunc : pending;
      }
      return { raw, trunc, now };
    };
    // the hook, fed swap by swap, read at each read time once every swap at or before it is in
    const h = new HookReplay(delta);
    h.afterInitialize(T0, TICK0);
    h.increaseObservationCardinalityNext(65535);
    let cur = TICK0, q = 0, checked = 0;
    const readUpTo = (limit: number) => {
      for (; q < reads.length && reads[q] < limit; q++) {
        for (const W of [60, 300, 600]) {
          const want = reference(reads[q], W);
          assert.equal(want.now, cur);
          const got = h.twaps(reads[q], W, cur);
          assert.equal(got.rawAvg, want.raw / W, `Δ ${delta} t ${reads[q]} W ${W} raw`);
          assert.equal(got.truncAvg, want.trunc / W, `Δ ${delta} t ${reads[q]} W ${W} trunc`);
          assert.equal(got.rawTick, Math.floor(want.raw / W));
          assert.equal(got.truncTick, Math.floor(want.trunc / W));
          checked++;
        }
      }
    };
    for (const w of swaps) {
      readUpTo(w.ts);
      h.beforeSwap(w.ts, cur);
      cur = w.after;
    }
    readUpTo(Infinity);
    assert.ok(checked >= 150, `${checked} reads`);
  }
});

test("a wrong truncated start is forgotten once both copies meet", () => {
  const writes = [{ ts: 1, tick: 0 }, { ts: 2, tick: 0 }, { ts: 3, tick: 0 }, { ts: 4, tick: 0 }];
  assert.equal(truncatedStartForgottenAt({ ts: 0, tick: 0 }, writes, 10, 25), 3); // 25 → 15 → 5 → 0
  assert.equal(truncatedStartForgottenAt({ ts: 0, tick: 0 }, writes, 10, 100), null);
});

// a thin synthetic HIMS/USDG-like book: USDG currency0 (quote), HIMS currency1, price near 29 USDG per HIMS
const book: Position[] = [
  { tickLower: 240_300, tickUpper: 244_800, liquidity: 10n ** 17n },
  { tickLower: 238_500, tickUpper: 246_600, liquidity: 3n * 10n ** 16n },
];
const state = poolStateFromPositions(book, getSqrtPriceAtTick(242_500));

test("v1: within 10 ticks the bound is the ladder's; a larger gap is priced as one more move and can only lower it", () => {
  const ladder = maxSafeExposure(state, true, 9991);
  for (const gap of [0, TOLERANCE_TICKS, -TOLERANCE_TICKS]) {
    const b = v1Bound(state, 9991, gap);
    assert.equal(b.exposure, ladder.exposure);
    assert.equal(b.gapBinds, false);
  }
  const gap = 3000;
  let rung = Infinity;
  for (const up of [true, false]) rung = Math.min(rung, Number(pushCostInQuote(state, gap, up, true, 9991).costQuote) / gainPerUnit(gap, up));
  const b = v1Bound(state, 9991, -gap);
  assert.equal(b.exposure, Math.min(ladder.exposure, rung));
  assert.equal(b.gapBinds, rung < ladder.exposure);
  // the decision: trust strictly below the bound
  const usdg = b.exposure / 1e6;
  assert.equal(v1Trusts(b, usdg * 0.999), true);
  assert.equal(v1Trusts(b, usdg * 1.001), false);
});

test("v0: raw with no check within 10 ticks; otherwise raw below cost ÷ gain per unit and truncated above it", () => {
  assert.equal(v0Pick(v0Decision(book, 242_500, 242_490, 9991), 1e12), 0);
  const d = v0Decision(book, 242_000, 242_500, 9991); // raw 500 ticks lower = HIMS dearer on the raw series
  assert.equal(d.checked, true);
  const s = poolStateFromPositions(book, getSqrtPriceAtTick(242_500)); // the walk starts from the truncated price
  const cost = pushCostInQuote(s, 500, true, true, 9991).costQuote;
  assert.equal(d.costQuote, cost);
  assert.equal(d.thresholdUsdg, Number(cost) / 1e6 / gainPerUnit(500, true));
  assert.equal(v0Pick(d, d.thresholdUsdg! * 0.99), 1);
  assert.equal(v0Pick(d, d.thresholdUsdg! * 1.01), 2);
});

test("price orientation: a higher tick is a cheaper HIMS", () => {
  assert.ok(Math.abs(usdgPerHimsAtTick(236_340) - 54.497) < 0.01); // hims-replay.json at block 50,444,948
  assert.ok(usdgPerHimsAtTick(242_518) < usdgPerHimsAtTick(242_517));
});

// ── against the real weekend (needs the squeeze caches: npm run squeeze) ──

const haveCaches = existsSync(`${cacheDir}out/swaps-raw-main.json`) && existsSync(`${cacheDir}out/pools.json`) && existsSync(`${cacheDir}timestamps-inventory.json`);
const himsReplay = JSON.parse(readFileSync(new URL("../data/hims-replay.json", import.meta.url), "utf8"));
const blockTs = new Map<number, number>(himsReplay.points.map((p: any) => [Number(p.block), Number(p.timestamp)]));
const PROBE_TIMES = [1_788_118_800, 1_788_133_980, 1_788_137_010];
let cached: Promise<{ inp: Awaited<ReturnType<typeof loadInputs>>; res: ReturnType<typeof replay> }> | undefined;
const weekend = () => (cached ??= loadInputs().then((inp) => ({ inp, res: replay(inp, PROBE_TIMES, REPLAY_BLOCKS, DEFAULT_CONFIG, (b) => blockTs.get(b)!) })));

test("the max safe exposure at the five hims-replay.json blocks is hims-replay.json's, to the last bit", { skip: !haveCaches && "no squeeze caches (npm run squeeze)" }, async () => {
  const { res } = await weekend();
  assert.equal(res.blocks.length, 5);
  for (const p of res.blocks) {
    const theirs = himsReplay.points.find((x: any) => Number(x.block) === p.block).maxSafeExposureUsdg;
    assert.equal(p.ladder!.exposure / 1e6, theirs.usdg, `block ${p.block}`);
    assert.equal(p.ladder!.ticks, theirs.bindingTicks);
    assert.equal(p.ladder!.stockUp, theirs.bindingStockUp);
    assert.equal(Number(p.ladder!.cost) / 1e6, theirs.bindingCostUsdg);
  }
});

test("the audit probe's numbers: 3,220 swaps in 1,687 seconds; at 00:43:30 Δ = 10 truncated 48-50, 6 ticks apart at 30 min", { skip: !haveCaches && "no squeeze caches (npm run squeeze)" }, async () => {
  const { inp, res } = await weekend();
  const squeeze = inp.swaps.filter((s) => s.ts >= 1_788_118_800 && s.ts <= 1_788_137_010);
  assert.equal(squeeze.length, 3220);
  assert.equal(new Set(squeeze.map((s) => s.ts)).size, 1687);
  assert.equal(res.writes.filter((w) => w.ts >= 1_788_118_800 && w.ts <= 1_788_137_010).length, 1687);
  const peak = res.times.find((p) => p.time === 1_788_137_010)!;
  assert.equal(Math.round(usdgPerHimsAtTick(peak.tick) * 100) / 100, 54.5);
  const price = (x: number) => Math.round(usdgPerHimsAtTick(x) * 100) / 100;
  const c = (d: number, w: number) => peak.configs[cfgKey(d, w)]!;
  assert.deepEqual([600, 1800, 3600].map((w) => price(c(10, w).truncAvg)), [50.39, 48.18, 48.69]);
  assert.deepEqual([600, 1800, 3600].map((w) => price(c(10, w).rawAvg)), [51.51, 48.21, 44.92]);
  assert.deepEqual([600, 1800, 3600].map((w) => price(c(3, w).truncAvg)), [44.24, 43.07, 42.78]);
  assert.equal(c(10, 1800).rawTick - c(10, 1800).truncTick, -6);
  // v0 takes the 30-minute raw TWAP unchecked; v1 refuses even 1,000 USDG (the pool carries 123.86)
  assert.deepEqual(c(10, 1800).v0Picks, [0, 0, 0]);
  assert.deepEqual(c(10, 1800).trusted, [false, false, false]);
  assert.equal(Math.round(c(10, 1800).v1!.exposure / 1e4) / 100, 123.86);
});
