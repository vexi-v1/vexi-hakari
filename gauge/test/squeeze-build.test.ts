import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  argExt, badLengths, derive, floatSplitProblems, gridProblems, hakariSeries, HK, matchLevel, mintClusters, nonFinite, ohlcProblems, packPicks, serialize, seriesArrays, settledAt, sig6,
  spikeProblems, unpackPick, usdgPerHimsAtTick, worst,
} from "../src/squeeze/build.ts";

const near = (a: number | null, b: number, rel = 1e-12) => assert.ok(a !== null && Math.abs(a - b) <= Math.abs(b) * rel, `${a} vs ${b}`);

test("sig6 keeps 6 significant digits, drops trailing zeros, and maps non-finite to null", () => {
  assert.equal(sig6(28.84), 28.84);
  assert.equal(sig6(1_234_567), 1_234_570);
  assert.equal(sig6(0.000123456789), 0.000123457);
  assert.equal(sig6(16_126.813), 16_126.8);
  assert.equal(sig6(0.1 + 0.2), 0.3);
  assert.equal(JSON.stringify(sig6(1351.27991)), "1351.28");
  assert.equal(JSON.stringify(sig6(8.336506876706168e23)), "8.33651e+23");
  assert.equal(Object.is(sig6(-0), -0), false);
  for (const x of [NaN, Infinity, -Infinity, null, undefined]) assert.equal(sig6(x as any), null);
});

test("derived cross-prices: via HIMS, at NAV, premium and route gap, with nulls carried", () => {
  const himsUsdg = [28.84, 57.68, null, 30];
  const bonerHims = [0.0001, 0.0002, 0.0003, null];
  const bonerUsdg = [0.002884, 0.01, 0.01, 0.01];
  const d = derive(himsUsdg, bonerHims, bonerUsdg, 28.84);
  near(d.bonerUsdgViaHims[0], 0.002884);
  near(d.bonerUsdgViaHims[1], 0.011536);
  assert.equal(d.bonerUsdgViaHims[2], null);
  assert.equal(d.bonerUsdgViaHims[3], null);
  near(d.bonerUsdAtNav[1], 0.005768);
  assert.equal(d.bonerUsdAtNav[3], null);
  near(d.himsPremiumPct[1]!, 100); // twice the NYSE close
  assert.equal(Math.abs(d.himsPremiumPct[0]!) < 1e-12, true);
  assert.equal(d.himsPremiumPct[2], null);
  assert.equal(Math.abs(d.routeGapPct[0]!) < 1e-9, true); // both routes agree
  near(d.routeGapPct[1]!, 15.36, 1e-9); // BONER dearer through HIMS than in the direct pool
  assert.equal(derive([30], [0.001], [0], 28.84).routeGapPct[0], null); // no division by a zero quote
});

test("anchor verdicts follow the reference's own precision", () => {
  assert.equal(matchLevel(28.171735, 28.17, { decimals: 2 }), "exact");
  assert.equal(matchLevel(16_126.813, 16_126.8, { decimals: 1 }), "exact");
  assert.equal(matchLevel(12_689.0517, 12_689.1, { decimals: 1 }), "exact");
  assert.equal(matchLevel(28.2, 28.17, { decimals: 2 }), "close");
  assert.equal(matchLevel(30, 28.17, { decimals: 2 }), "differs");
  assert.equal(matchLevel(0.00356171, 0.0036, { sig: 2 }), "exact");
  assert.equal(matchLevel(0.0146577, 0.0147, { sig: 3 }), "exact");
  assert.equal(matchLevel(12_877.3, 13_100, { sig: 3, closeRel: 0.05 }), "close");
  assert.equal(matchLevel(null, 1), "differs");
  assert.equal(matchLevel(NaN, 1), "differs");
  assert.equal(worst(["exact", "close", "exact"]), "close");
  assert.equal(worst(["exact", "differs", "close"]), "differs");
  assert.equal(worst(["exact"]), "exact");
});

test("mint clusters split on gaps and add up", () => {
  const m = (ts: number, amount: number) => ({ ts, amount });
  const c = mintClusters([m(1000, 1), m(1500, 2), m(2400, 3), m(3400, 4), m(3401, 5)], 900);
  assert.deepEqual(c.map((x) => [x.first.ts, x.last.ts, x.count, x.total]), [[1000, 2400, 3, 6], [3400, 3401, 2, 9]]);
  assert.equal(mintClusters([], 900).length, 0);
  assert.equal(mintClusters([m(5, 1), m(1, 1)], 3).length, 2); // sorted by time first
});

test("settledAt: within the band and never above the ceiling afterwards", () => {
  const x = [50, 20, 1, 12, 1.5, 3, 9, 0.5, null, 2];
  assert.equal(settledAt(x, 0, 2, 10), 4); // index 3 (12%) is the last time it tops 10%
  assert.equal(settledAt(x, 5, 2, 10), 7);
  assert.equal(settledAt([5, 4, 3], 0, 2, 10), -1);
  assert.equal(settledAt([1, 11], 0, 2, 10), -1);
});

test("argExt ignores nulls and honours the range", () => {
  const x = [3, null, 1, 7, 1];
  assert.equal(argExt(x, false), 2);
  assert.equal(argExt(x, true), 3);
  assert.equal(argExt(x, true, 0, 3), 0);
  assert.equal(argExt([null, null], true), -1);
});

test("integrity checks catch bad grids, lengths, non-finite numbers, OHLC and float-split violations", () => {
  assert.deepEqual(gridProblems([0, 60, 120], 0, 120, 60), []);
  assert.equal(gridProblems([0, 60, 130], 0, 130, 60).length, 1);
  assert.equal(gridProblems([60, 120], 0, 120, 60).length, 1);
  assert.deepEqual(badLengths({ a: [1, 2], g: { close: [1, 2], high: [null, 1] } }, 2), []);
  assert.deepEqual(badLengths({ a: [1], g: { close: [1, 2], high: 3 } }, 2), ["a (1)", "g.high"]);
  // nested groups (series.hakari) at any depth
  assert.deepEqual(badLengths({ h: { x: [1, 2], g: { d10: { w600: [1] }, d3: { w600: [1, 2] } } } }, 2), ["h.g.d10.w600 (1)"]);
  assert.deepEqual(seriesArrays({ a: [1], h: { g: { w: [2] } } }).map(([k]) => k), ["a", "h.g.w"]);
  assert.deepEqual(nonFinite({ a: [1, NaN], b: { c: Infinity, d: null, e: "x" } }), ["$.a[1]", "$.b.c"]);
  const close = [10, 11, 12, 12], high = [null, 11.5, 12, null], low = [null, 10.5, 11, null];
  assert.deepEqual(ohlcProblems({ close, high, low }, [0, 2, 1, 0]), []);
  assert.deepEqual(ohlcProblems({ close: [10, 13], high: [null, 12], low: [null, 11] }, [0, 1]), [1]);
  assert.deepEqual(ohlcProblems({ close: [10, 11], high: [null, 10], low: [null, 12] }, [0, 1]), [1]);
  assert.deepEqual(floatSplitProblems([1, 5], [2, 6], [3, 10], [4, 10]), [1]);
  assert.deepEqual(floatSplitProblems([1], [2], [5], [4]), [0]);
  assert.deepEqual(floatSplitProblems([1], [2], [3.00001], [3]), []); // rounding slack
});

test("spikeProblems flags a high or low far beyond both neighbouring closes", () => {
  const close = [0.0085, 0.0111, 0.012, 0.012];
  // the BONER/USDG bar ending 23:20 before the fix: 14.096 against closes of 0.0085 and 0.0111
  assert.deepEqual(spikeProblems({ close, high: [null, 14.096, 0.013, null], low: [null, 0.0085, 0.011, null] }), [1]);
  assert.deepEqual(spikeProblems({ close, high: [null, 0.012, 0.013, null], low: [null, 0.0085, 0.011, null] }), []);
  // a low far under both closes, and the factor itself
  assert.deepEqual(spikeProblems({ close: [10, 10], high: [null, 10], low: [null, 1.9] }), [1]);
  assert.deepEqual(spikeProblems({ close: [10, 10], high: [null, 10], low: [null, 2.1] }), []);
  assert.deepEqual(spikeProblems({ close: [10, 10], high: [null, 30], low: [null, 10] }, 2), [1]);
  // the bar may reach 5x of the larger close: a real move between the two closes is not a spike
  assert.deepEqual(spikeProblems({ close: [10, 40], high: [null, 45], low: [null, 9] }), []);
  // no closes, no verdict
  assert.deepEqual(spikeProblems({ close: [null, 10], high: [null, 1000], low: [null, 1] }), []);
});

test("v0's three picks pack into one number and back", () => {
  for (const p of [[0, 0, 0], [1, 1, 2], [1, 2, 2], [2, 2, 2], [0, 1, 2]]) {
    const code = packPicks(p)!;
    assert.deepEqual([0, 1, 2].map((e) => unpackPick(code, e)), p);
  }
  assert.equal(packPicks([2, 2, 2]), 26);
  assert.equal(packPicks([1, 1, 2]), 1 + 3 + 18);
  assert.equal(packPicks([1, null, 2]), null);
  assert.equal(unpackPick(null, 1), null);
  assert.throws(() => packPicks([3, 0, 0]));
});

test("tick -> USDG per HIMS (USDG is currency0: the price falls as the tick rises)", () => {
  near(usdgPerHimsAtTick(0), 1e12);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  // the 30-minute TWAPs at 00:43:30 (gauge/data/hims-hook-replay.json): raw tick 237,566 = 48.21, truncated 237,572 = 48.18
  assert.equal(r2(usdgPerHimsAtTick(237_566)), 48.21);
  assert.equal(r2(usdgPerHimsAtTick(237_572)), 48.18);
});

test("hakariSeries reshapes the replay's per-minute file for the page and flags what does not fit", () => {
  const t = [0, 60, 120];
  const cfgs = (f: (d: number, w: number) => unknown) => Object.fromEntries(HK.deltas.map((d) => [`d${d}`, Object.fromEntries(HK.windows.map((w) => [`w${w}`, f(d, w)]))]));
  const exps = (f: (e: number) => unknown) => Object.fromEntries(HK.exposures.map((e) => [`e${e}`, f(e)]));
  const raw = [null, 237_566, 242_518];
  const h = {
    t,
    twap: { raw: Object.fromEntries(HK.windows.map((w) => [`w${w}`, raw.map((x) => (x === null ? null : sig6(usdgPerHimsAtTick(x))))])) },
    twapTick: { raw: Object.fromEntries(HK.windows.map((w) => [`w${w}`, raw])), trunc: cfgs((d) => [null, 237_572, 242_518 - d]) },
    v1: {
      maxSafeExposureUsdg: [7258.815143, 123.86014827, 5310.34], bindingTicks: [1823, 1823, 953], bindingStockUp: [1, 1, 0],
      gapBoundUsdg: cfgs(() => [null, null, 2907.5612]),
      decision: cfgs(() => exps((e) => [null, 0, e === 1000 ? 1 : 0])),
    },
    v0: { pick: cfgs(() => exps((e) => [null, 0, e === 1000 ? 1 : 2])) },
  };
  const r = hakariSeries(h, t);
  assert.deepEqual(r.problems, []);
  const s = r.series;
  assert.deepEqual(s.maxSafeUsdg, [7258.82, 123.86, 5310.34]); // 6 significant digits
  assert.deepEqual(s.gapBoundUsdg, [null, null, 2907.56]);
  assert.deepEqual(s.decision.e1000, [null, 0, 1]);
  assert.deepEqual(s.decision.e100000, [null, 0, 0]);
  assert.deepEqual(s.gapTicks.d10.w1800, [null, -6, 10]); // raw - truncated: the 6 ticks v0 did not check at 00:43:30
  assert.deepEqual(s.gapTicks.d3.w600, [null, -6, 3]);
  assert.deepEqual(s.v0Pick.d10.w1800, [null, 0, 1 + 3 * 2 + 9 * 2]);
  assert.deepEqual(badLengths(s, 3), []);
  // off the grid, wrong lengths, non-integer ticks and prices that do not match their ticks are all reported
  const bad = hakariSeries({ ...h, t: [0, 60, 180], twapTick: { ...h.twapTick, raw: { ...h.twapTick.raw, w600: [null, 1.5, 2] } }, twap: { raw: { ...h.twap.raw, w3600: [null, 1, 2] } } }, t);
  assert.ok(bad.problems.some((p) => /grid/.test(p)), bad.problems.join("; "));
  assert.ok(bad.problems.some((p) => /twapTick\.raw\.w600 holds non-integers/.test(p)), bad.problems.join("; "));
  assert.ok(bad.problems.some((p) => /raw TWAP w3600/.test(p)), bad.problems.join("; "));
  assert.ok(hakariSeries({ t }, t).problems.length > 10);
});

test("serialize puts plain arrays on one line and round-trips", () => {
  const v = { t: [1, 2, 3], s: { a: [null, 0.5] }, e: [{ id: "x", label: { en: "a [b]", zh: "c" } }] };
  const text = serialize(v);
  assert.ok(text.includes('"t": [1,2,3]'));
  assert.ok(text.includes('"a": [null,0.5]'));
  assert.deepEqual(JSON.parse(text), v);
});

// the published file, when it has been built: shape per the page contract
const dataFile = new URL("../../web/squeeze/data.json", import.meta.url).pathname;
test("web/squeeze/data.json follows the contract", { skip: !existsSync(dataFile) && "not built yet (npm run squeeze:build)" }, () => {
  const text = readFileSync(dataFile, "utf8");
  const d = JSON.parse(text);
  assert.equal(d.version, 1);
  assert.equal(d.chain.id, 4663);
  assert.equal(d.t.length, 4081);
  assert.deepEqual(gridProblems(d.t, d.window.fromTs, d.window.toTs, d.window.stepSec), []);
  assert.deepEqual(badLengths(d.series, 4081), []);
  for (const k of ["himsUsdg", "bonerHims", "bonerUsdgDirect"]) assert.deepEqual(Object.keys(d.series[k]), ["close", "high", "low"]);
  for (const k of ["bonerUsdgViaHims", "bonerUsdAtNav", "himsPremiumPct", "routeGapPct", "himsSupply", "himsInPoolManager", "himsInHimsUsdg", "usdgInHimsUsdg", "himsInBonerHims", "bonerInBonerHims", "usdgInBonerUsdg", "bonerInBonerUsdg", "liqHimsUsdg", "liqBonerHims", "pushUp10CostUsdg", "pushUp10CapitalUsdg", "pushDown10CostUsdg", "volUsdgHimsUsdg", "volHimsBonerHims", "volUsdgBonerUsdg", "swapsHimsUsdg", "swapsBonerHims", "swapsBonerUsdg", "netHimsOutOfHimsUsdg", "netHimsIntoBonerHims", "himsMinted", "himsBurned"]) {
    assert.ok(Array.isArray(d.series[k]), k);
  }
  for (const k of ["swapsHimsUsdg", "swapsBonerHims", "swapsBonerUsdg"]) assert.ok(d.series[k].every((x: number) => Number.isInteger(x)), k);
  for (const k of ["himsUsdg", "bonerHims", "bonerUsdgDirect"]) assert.deepEqual(spikeProblems(d.series[k]), [], `${k}: high/low beyond 5x of the neighbouring closes`);
  // post-swap pool prices are not called trades or prices paid; each notable swap carries what it paid on average
  const peak = d.events.find((e: any) => e.id === "peak-swap");
  assert.ok(/post-swap pool price/.test(peak.label.en) && /成交後池價/.test(peak.label.zh) && !/Highest trade|最高成交價/.test(peak.label.en + peak.label.zh), peak.label.en);
  for (const n of d.notableSwaps) assert.ok("avgUsdgPerHims" in n || "avgPrice" in n, n.tx);
  for (const [, a] of seriesArrays(d.series)) for (const x of a) {
    if (typeof x === "number" && !Number.isInteger(x)) assert.equal(x, Number(x.toPrecision(6)));
  }
  // HAKARI's read: a counterfactual, and it says so; ticks are integers; decisions are 0/1/null
  const h = d.series.hakari, hk = d.hakari;
  assert.ok(h && hk, "series.hakari and the hakari block (npm run hims:hook, then npm run squeeze:build)");
  assert.equal(hk.counterfactual, true);
  assert.ok(/no hook|without a hook/.test(hk.what.en) && /沒有 hook/.test(hk.what.zh), hk.what.en);
  assert.ok(hk.caveats.length >= 4 && hk.caveats.every((c: any) => c.en && c.zh));
  assert.ok(hk.caveats.some((c: any) => /normal depth, not the squeeze/.test(c.en)));
  assert.ok(/hims-hook-replay\.json/.test(hk.summaryFile) && /hims:hook/.test(hk.command));
  for (const k of ["maxSafeUsdg", "bindingTicks", "bindingUp", "gapBoundUsdg", "decision.e1000", "decision.e10000", "decision.e100000", "rawTick.w600", "rawTick.w1800", "rawTick.w3600", "gapTicks.d10.w1800", "gapTicks.d3.w3600", "v0Pick.d10.w1800", "v0Pick.d3.w600"]) {
    const a = k.split(".").reduce((o: any, p) => o?.[p], h);
    assert.ok(Array.isArray(a) && a.length === 4081, k);
  }
  for (const [k, a] of seriesArrays({ rawTick: h.rawTick, gapTicks: h.gapTicks, v0Pick: h.v0Pick, bindingTicks: h.bindingTicks })) assert.ok(a.every((x) => x === null || Number.isInteger(x)), k);
  for (const [k, a] of seriesArrays(h.decision)) assert.ok(a.every((x) => x === null || x === 0 || x === 1), k);
  // the replay's published figures, read back from the arrays (Sun 19:40 is grid index 2980, Sun 23:25 is 3205)
  assert.equal(h.maxSafeUsdg[2980], 7258.82);
  assert.equal(h.maxSafeUsdg[3205], 20.3787);
  assert.equal(h.decision.e1000.filter((x: number | null) => x === 0).length, hk.weekend.v1RefusalsPrimary.byExposureUsdg["1000"].minutesRefused);
  assert.ok(d.checks.filter((c: any) => /^HAKARI/.test(c.name)).length >= 5);
  for (const e of d.events) {
    assert.ok(["burn", "mint", "mintCluster", "reopen", "nyse", "peak", "arb", "note"].includes(e.kind), e.kind);
    assert.ok(e.label.en && e.label.zh, e.id);
  }
  assert.equal(new Set(d.events.map((e: any) => e.id)).size, d.events.length);
  for (const a of d.anchors) assert.ok(["exact", "close", "differs"].includes(a.match) && a.reference.source && a.note, a.label);
  for (const c of d.caveats) assert.ok(c.en && c.zh);
  assert.ok(d.checks.length > 0 && d.checks.every((c: any) => typeof c.pass === "boolean" && c.name && c.detail));
  assert.ok(Buffer.byteLength(text) <= 2_000_000);
  const urls = text.match(/https?:\/\/[^\s"',)]+/g) ?? [];
  assert.ok(urls.every((u) => u.startsWith("https://robinhoodchain.blockscout.com") || u.startsWith("https://defiprime.com/")), urls.join(" "));
  const js = readFileSync(dataFile.replace(/\.json$/, ".js"), "utf8");
  assert.equal(js, `window.SQUEEZE_DATA = ${text.trimEnd()};\n`);
});
