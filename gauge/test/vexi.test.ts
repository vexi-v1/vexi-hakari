// npm run vexi's pure pieces (src/vexi.ts) on synthetic logs, no RPC: open interest folded from Minted and Burned, the
// join of fixes to series and of series to (market, expiry) cells, the pre-window state (last swap before the fix window,
// the Initialize price when there is none), the bound on either token order against test/fixtures/walk.json's CostModel
// figures, the strike-aware transfer against a hand-computed payoff, the unit conversion on the largest live cell, the
// thin flag, the next open expiry, and the windowed log fetch (complete windows cached, the tail read again, a refused
// range halved).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toHex } from "viem";
import {
  cellExposureRaw,
  cellsOf,
  fixesFromLogs,
  idHex,
  isThin,
  logCacheFile,
  logsInWindows,
  measureCell,
  nextOpenExpiry,
  openInterest,
  payoffWad,
  preWindowState,
  pushedPriceWad,
  seriesFromLogs,
  transferAtRung,
  VENUE_SWAP_ADAPTER,
  windowsOf,
  type Cell,
} from "../src/vexi.ts";
import { SERIES_KIND } from "../src/vexi-abi.ts";
import { poolStateFromPositions } from "../src/v4math.ts";

const WAD = 10n ** 18n;
const USDG = 10n ** 6n;
const AI = "0x7ec15f39d9c307edbd07c730e87fb914e178b7b9";
const PONS = "0x9eda6980d539bcaaf03c4c953265894ceddc07e7";
const SYMBOLS = new Map([[AI, "AI"], [PONS, "PONS"]]);
const FULL_RANGE = { tickLower: -887220, tickUpper: 887220 };

/** A log the way chain.ts serialises viem's decoded logs: block and bigints as strings. */
const log = (eventName: string, block: number, logIndex: number, args: Record<string, string | number | boolean>) => ({
  blockNumber: String(block),
  logIndex,
  transactionHash: toHex(block * 1000 + logIndex, { size: 32 }),
  eventName,
  args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "number" && !Number.isInteger(v) ? String(v) : v])) as Record<string, string | boolean>,
});
const opened = (id: number, base: string, kind: number, strike: bigint, expiry: number, block = 1) =>
  log("SeriesOpened", block, id, { id: String(id), base, quote: "0x09bb68fe50f37e02e6bba45bfe4d204ad479581a", kind, strikeWad: strike.toString(), expiry: String(expiry), opener: "0x0000000000000000000000000000000000000000" });
const minted = (id: number, contracts: bigint, block = 2) => log("Minted", block, id, { id: String(id), minter: VENUE_SWAP_ADAPTER, to: VENUE_SWAP_ADAPTER, contracts: contracts.toString() });
const burned = (id: number, contracts: bigint, block = 3) => log("Burned", block, id, { id: String(id), burner: VENUE_SWAP_ADAPTER, from: VENUE_SWAP_ADAPTER, contracts: contracts.toString() });
const fixed = (id: number, sStar: bigint, from: number, to: number, nObs: number, block = 9) => log("Fixed", block, id, { id: String(id), sStarWad: sStar.toString(), obsFrom: from, obsTo: to, nObs });
const mod = (block: number, liquidity: bigint, sender = VENUE_SWAP_ADAPTER) =>
  log("ModifyLiquidity", block, 0, { sender, tickLower: FULL_RANGE.tickLower, tickUpper: FULL_RANGE.tickUpper, liquidityDelta: liquidity.toString(), salt: toHex(0, { size: 32 }) });
const swap = (block: number, sqrtPriceX96: bigint, liquidity: bigint, sender = VENUE_SWAP_ADAPTER) =>
  log("Swap", block, 0, { sender, amount0: "1", amount1: "-1", sqrtPriceX96: sqrtPriceX96.toString(), liquidity: liquidity.toString(), tick: 0, fee: 3000 });

test("open interest is Σ Minted − Σ Burned by id; an odd (deposit-side) id is not a series", () => {
  const oi = openInterest([minted(10, 10n * WAD), minted(10, 5n * WAD), minted(12, 7n * WAD), minted(13, 99n * WAD)], [burned(10, 3n * WAD)]);
  assert.equal(oi.get(idHex(10n)), 12n * WAD);
  assert.equal(oi.get(idHex(12n)), 7n * WAD);
  assert.equal(oi.has(idHex(13n)), false, "the odd twin is ignored");
  assert.equal(oi.size, 2);
  assert.equal(idHex("10"), "0x000000000000000000000000000000000000000000000000000000000000000a");
});

test("two series at one expiry share the fix's S* and sum: the largest live cell is 1,287.03 contracts × 0.63671 ≈ 819.47 USDG", () => {
  const sStar = 636_712_374_045_976_700n; // PONS, expiry 1790353800: the Fixed log's sStarWad
  const logs = [opened(10, PONS, SERIES_KIND.call, WAD / 2n, 1790353800), opened(12, PONS, SERIES_KIND.put, WAD, 1790353800), opened(14, AI, SERIES_KIND.call, WAD / 10n, 1790353800), opened(16, PONS, SERIES_KIND.call, WAD, 1790354700)];
  const { series, unknownBase } = seriesFromLogs(logs, SYMBOLS);
  assert.equal(series.size, 4);
  assert.equal(unknownBase, 0);
  const oi = openInterest([minted(10, 1000n * WAD), minted(12, 287_030n * WAD / 1000n), minted(16, WAD)], []);
  const { fixes, duplicates } = fixesFromLogs([fixed(10, sStar, 1790353500, 1790353802, 5), fixed(12, sStar, 1790353500, 1790353802, 5), fixed(14, WAD / 10n, 1790353500, 1790353802, 4), fixed(12, 1n, 1, 2, 1, 11)], []);
  assert.equal(duplicates, 1, "a second fix for one id is counted and the first kept");
  assert.equal(fixes.get(idHex(12n))!.sStarWad, sStar);
  const cells = cellsOf(series, fixes, oi);
  assert.deepEqual(cells.map((c) => `${c.symbol}|${c.expiry}`), ["AI|1790353800", "PONS|1790353800"], "the unfixed PONS 1790354700 cell is not a cell yet");
  const pons = cells[1];
  assert.equal(pons.fixes.length, 2);
  assert.equal(pons.series.length, 2);
  const raw = cellExposureRaw(pons.series, sStar, WAD, USDG);
  assert.ok(Math.abs(Number(raw) / 1e6 - 819.47) < 0.01, `${Number(raw) / 1e6} USDG`);
  assert.equal(cellExposureRaw(cells[0].series, WAD / 10n, WAD, USDG), 0n, "no open interest, no exposure");
  // seriesFromLogs drops a base that is not a market, and says so
  const other = seriesFromLogs([opened(18, "0x0000000000000000000000000000000000000001", 0, WAD, 1790353800)], SYMBOLS);
  assert.equal(other.series.size, 0);
  assert.equal(other.unknownBase, 1);
});

test("a FixedLate log is a fix without observations", () => {
  const { fixes } = fixesFromLogs([], [log("FixedLate", 5, 0, { id: "10", sStarWad: WAD.toString(), fixedAt: 1790353900 })]);
  const f = fixes.get(idHex(10n))!;
  assert.equal(f.late, true);
  assert.equal(f.sStarWad, WAD);
  assert.equal(f.nObs, null);
  assert.equal(isThin(f.nObs, null), true);
});

test("the pre-window state takes the last swap before expiry − fixWindow, counts the window's swaps, and falls back to Initialize", () => {
  const L = WAD;
  const ts = new Map([["10", 0], ["20", 100], ["30", 700], ["40", 950]]);
  const tsOf = (b: string) => ts.get(b)!;
  const mods = [mod(10, L)];
  const init = 1n << 96n;
  const p20 = (1n << 96n) * 11n / 10n;
  const p30 = (1n << 96n) * 12n / 10n;
  const swaps = [swap(20, p20, L), swap(30, p30, L), swap(40, (1n << 96n) * 13n / 10n, L, "0x0000000000000000000000000000000000000002")];
  const pre = preWindowState(mods as any, swaps as any, init, tsOf, 1000 - 300, 1000);
  assert.equal(pre.source, "swap");
  assert.equal(pre.block, "20", "the swap at 700 is not before the cutoff");
  assert.equal(pre.state.sqrtPriceX96, p20);
  assert.equal(pre.state.liquidity, L);
  assert.equal(pre.liquidityMatches, true);
  assert.equal(pre.inWindow, 2, "the swaps at 700 and 950");
  assert.equal(pre.inWindowForeign, 1, "one of them from a sender that is not the venue's adapter");
  const later = preWindowState(mods as any, swaps as any, init, tsOf, 2000 - 300, 2000);
  assert.equal(later.block, "40");
  assert.equal(later.inWindow, 0);
  const none = preWindowState(mods as any, [], init, tsOf, 1000 - 300, 1000);
  assert.equal(none.source, "initialize");
  assert.equal(none.block, null);
  assert.equal(none.state.sqrtPriceX96, init);
  assert.equal(none.state.liquidity, L);
  assert.equal(none.liquidityMatches, "n/a (no swap)");
  // a position added after the cutoff is not in the pre-window book
  const late = preWindowState([...mods, mod(40, L)] as any, [swaps[0]], init, tsOf, 1000 - 300, 1000);
  assert.equal(late.state.liquidity, L);
  const mismatch = preWindowState(mods as any, [swap(20, p20, 2n * L)] as any, init, tsOf, 700, 1000);
  assert.equal(mismatch.liquidityMatches, false, "the swap reports a liquidity the rebuild does not");
});

test("MU's order: the cell bound with USDG as currency1 is CostModel's quote1 figure on the fixture pool, quote0 with USDG first", () => {
  const fx = JSON.parse(readFileSync(new URL("../../test/fixtures/walk.json", import.meta.url), "utf8"));
  const positions = Object.values(fx.positions as Record<string, any>).map((p) => ({ tickLower: Number(p.tickLower), tickUpper: Number(p.tickUpper), liquidity: BigInt(p.liquidity) }));
  const state = poolStateFromPositions(positions, BigInt(fx.sqrtPriceX96));
  const fee = Number(fx.fee);
  const sStar = WAD;
  const cellOf = (oi: bigint): Cell => ({ symbol: "MU", expiry: 1000, fixes: [{ id: idHex(2n), sStarWad: sStar, obsFrom: 700, obsTo: 1002, nObs: 5, late: false, tx: toHex(1, { size: 32 }), block: "9" }], series: [{ id: idHex(2n), kind: SERIES_KIND.call, strikeWad: WAD / 2n, oi }] });
  for (const [side, quote0] of [["quote0", true], ["quote1", false]] as const) {
    const expected = Number(BigInt(fx.maxSafe[side].exposure));
    const m = measureCell(cellOf(0n), state, quote0, fee, WAD, USDG);
    assert.ok(Math.abs((m.bound * 1e6) / expected - 1) < 1e-6, `${side}: ${m.bound * 1e6} vs CostModel ${expected}`);
    assert.equal(m.bindingTicks, fx.maxSafe[side].ticks);
    assert.equal(m.bindingAssetUp, quote0 ? !fx.maxSafe[side].up : fx.maxSafe[side].up, "the asset moves with the tick when it is currency0, against it when the quote is");
    assert.equal(m.exposure, 0);
    assert.equal(m.ratio, 0);
    assert.equal(m.trusted, true);
    // exposure = contracts × S*: half the bound is trusted, twice the bound is not
    const half = BigInt(Math.floor(expected / 2)) * WAD / USDG; // base wei at S* = 1 USDG
    const h = measureCell(cellOf(half), state, quote0, fee, WAD, USDG);
    assert.ok(Math.abs(h.ratio - 0.5) < 1e-6, `${side}: ratio ${h.ratio}`);
    assert.equal(h.trusted, true);
    assert.ok(Math.abs(h.contracts - Number(half) / 1e18) < 1e-9);
    const d = measureCell(cellOf(4n * half), state, quote0, fee, WAD, USDG);
    assert.ok(Math.abs(d.ratio - 2) < 1e-6);
    assert.equal(d.trusted, false);
    assert.equal(d.thin, false);
    assert.equal(d.span, 302);
  }
});

test("the strike-aware transfer is the payout the push would have moved, hand-computed", () => {
  const sStar = 100n * WAD;
  const series = [
    { id: idHex(2n), kind: SERIES_KIND.call, strikeWad: 90n * WAD, oi: 2n * WAD },
    { id: idHex(4n), kind: SERIES_KIND.put, strikeWad: 110n * WAD, oi: WAD },
    { id: idHex(6n), kind: SERIES_KIND.call, strikeWad: 90n * WAD, oi: 0n },
  ];
  assert.equal(payoffWad(SERIES_KIND.call, 90n * WAD, sStar), 10n * WAD);
  assert.equal(payoffWad(SERIES_KIND.put, 110n * WAD, sStar), 10n * WAD);
  assert.equal(payoffWad(SERIES_KIND.put, 90n * WAD, sStar), 0n);
  const f = Math.pow(1.0001, 953);
  assert.ok(Math.abs(Number(pushedPriceWad(sStar, 953, true)) / 1e18 / (100 * f) - 1) < 1e-9);
  assert.ok(Math.abs(Number(pushedPriceWad(sStar, 953, false)) / 1e18 / (100 / f) - 1) < 1e-9);
  // up ≈ +10 %: the two calls gain (100f − 90) − 10 each, the put loses and counts nothing
  const up = Number(transferAtRung(series, sStar, 953, true, WAD, USDG)) / 1e6;
  assert.ok(Math.abs(up - 2 * (100 * f - 100)) < 1e-4, `up ${up}`);
  // down: the put gains (110 − 100/f) − 10, the calls are out of the money by more than they were in
  const down = Number(transferAtRung(series, sStar, 953, false, WAD, USDG)) / 1e6;
  assert.ok(Math.abs(down - (100 - 100 / f)) < 1e-4, `down ${down}`);
  assert.equal(transferAtRung([series[2]], sStar, 953, true, WAD, USDG), 0n, "no open interest, nothing moved");
  // a call already deep out of the money moves nothing on a small push
  assert.equal(transferAtRung([{ id: idHex(8n), kind: SERIES_KIND.call, strikeWad: 200n * WAD, oi: WAD }], sStar, 50, true, WAD, USDG), 0n);
});

test("thin: nObs ≤ 3 or a span under 200 s", () => {
  assert.equal(isThin(5, 302), false);
  assert.equal(isThin(4, 200), false);
  assert.equal(isThin(3, 302), true);
  assert.equal(isThin(5, 199), true);
  assert.equal(isThin(null, null), true);
});

test("the next open expiry after the head, with its ids per market", () => {
  const { series } = seriesFromLogs([opened(10, PONS, 0, WAD, 900), opened(12, PONS, 1, WAD, 1800), opened(14, AI, 0, WAD, 1800), opened(16, PONS, 0, WAD, 2700)], SYMBOLS);
  const next = nextOpenExpiry(series.values(), 1000)!;
  assert.equal(next.expiry, 1800);
  assert.deepEqual(next.perMarket, { PONS: [idHex(12n)], AI: [idHex(14n)] });
  assert.equal(nextOpenExpiry(series.values(), 1800)!.expiry, 2700, "an expiry at the head is not open");
  assert.equal(nextOpenExpiry(series.values(), 2700), null);
});

test("logs come in fixed windows: complete windows are cached, the tail is read again, a refused range is halved", async () => {
  const CAP = "logs matched by query exceeds limit of 10000";
  const queries: string[] = [];
  const client = {
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      queries.push(`${fromBlock}-${toBlock}`);
      if (toBlock - fromBlock + 1n > 6n) throw new Error(CAP);
      const out = [];
      for (let b = fromBlock; b <= toBlock; b++) out.push({ blockNumber: b, logIndex: 0, transactionHash: toHex(b, { size: 32 }), eventName: "Fixed", args: { id: b, sStarWad: b * 1000n, obsFrom: 1, obsTo: 2, nObs: 5 } });
      return out;
    },
  } as any;
  const cacheDir = `${mkdtempSync(join(tmpdir(), "hakari-vexi-"))}/`;
  assert.deepEqual(windowsOf(0n, 25n, 10n), [{ from: 0n, to: 9n, complete: true }, { from: 10n, to: 19n, complete: true }, { from: 20n, to: 25n, complete: false }]);
  const filter = { address: "0x0000000000000000000000000000000000000abc" as const, event: { name: "Fixed" } };
  const first = await logsInWindows(client, filter, 0n, 25n, "t", { cacheDir, window: 10n, pauseMs: 0, attempts: 1 });
  assert.equal(first.length, 26);
  assert.deepEqual(first.map((l) => l.args.id), Array.from({ length: 26 }, (_, i) => String(i)), "in block order");
  assert.equal(first[7].args.sStarWad, "7000");
  assert.ok(queries.includes("0-9") && queries.includes("0-4") && queries.includes("5-9"), "the 10-block window was refused and halved");
  assert.ok(existsSync(logCacheFile("t", 0n, 9n, true, cacheDir)));
  assert.ok(existsSync(logCacheFile("t", 10n, 19n, true, cacheDir)));
  assert.ok(existsSync(logCacheFile("t", 20n, 25n, false, cacheDir)), "the tail sits apart, to be dropped before the next run");
  queries.length = 0;
  const again = await logsInWindows(client, filter, 0n, 27n, "t", { cacheDir, window: 10n, pauseMs: 0, attempts: 1 });
  assert.equal(again.length, 28);
  assert.ok(queries.length > 0);
  assert.ok(queries.every((q) => BigInt(q.split("-")[0]) >= 20n), `only the tail was read again: ${queries.join(", ")}`);
});
