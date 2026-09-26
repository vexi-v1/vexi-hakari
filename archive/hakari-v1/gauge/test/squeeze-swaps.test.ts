import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { barIndex, buildSeries, checkPoint, DISCOVERY, GRID, himsPerBoner, isQuote, lastAtOrBefore, OVERSHOOT, PRICE, rawPrice, usdgPerBoner, usdgPerHims, type SwapRow } from "../src/squeeze/pools-swaps.ts";
import { getSqrtPriceAtTick } from "../src/v4math.ts";
import { cacheDir, WINDOW_END_BLOCK } from "../src/squeeze/common.ts";

const Q96 = 2n ** 96n;
const close = (a: number, b: number, rel = 1e-9) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel, `${a} vs ${b}`);

test("price orientation and decimals", () => {
  // sqrtPriceX96 = 2^96 is raw price 1: one base unit of currency1 per base unit of currency0
  assert.equal(rawPrice(Q96), 1);
  assert.equal(himsPerBoner(Q96), 1);
  // USDG (6 dec) is currency0 and HIMS (18 dec) currency1: raw = 1e12 / (USDG per HIMS)
  // 29.38 USDG per HIMS -> raw = 1e12 / 29.38 HIMS-wei per USDG-unit
  const raw = 1e12 / 29.38;
  const sqrt = BigInt(Math.round(Math.sqrt(raw) * 2 ** 48)) * 2n ** 48n;
  close(usdgPerHims(sqrt), 29.38, 1e-12);
  close(usdgPerBoner(sqrt), 29.38, 1e-12); // same orientation, USDG is also currency0 against BONER
  // a higher tick means more currency1 per currency0: HIMS gets cheaper in USDG, BONER dearer in HIMS
  const a = getSqrtPriceAtTick(250_000), b = getSqrtPriceAtTick(250_090);
  assert.ok(usdgPerHims(b) < usdgPerHims(a));
  assert.ok(himsPerBoner(b) > himsPerBoner(a));
  close(himsPerBoner(b) / himsPerBoner(a), 1.0001 ** 90, 1e-9);
  // BONER at ~0.0001 HIMS: tick ln(1e-4)/ln(1.0001) = -92108
  close(himsPerBoner(getSqrtPriceAtTick(-92_108)), 1e-4, 1e-4);
});

test("bars are (t_{k-1}, t_k]", () => {
  const s = GRID.start, st = GRID.step;
  assert.equal(barIndex(s, s, st), 0);
  assert.equal(barIndex(s + 1, s, st), 1);
  assert.equal(barIndex(s + 60, s, st), 1);
  assert.equal(barIndex(s + 61, s, st), 2);
  assert.ok(barIndex(s - 1, s, st) <= 0);
  assert.equal(GRID.n, 4081);
  assert.equal(GRID.start + GRID.step * (GRID.n - 1), 1_788_184_800);
});

const row = (ts: number, block: number, logIndex: number, sqrt: bigint, amount1 = 0n, liquidity = 1n, fee = 9991): SwapRow =>
  ({ ts, block, logIndex, tx: `0x${block}${logIndex}`, sender: "0x", amount0: -amount1, amount1, sqrtPriceX96: sqrt, liquidity, tick: 0, fee });

test("carry-forward closes, seeded before the grid; bars only inside (t_{k-1}, t_k]", () => {
  const g = { start: 1000, step: 60, n: 5 }; // t = 1000, 1060, 1120, 1180, 1240
  const p = (x: number) => BigInt(x) * Q96; // raw price x*x
  const rows = [
    row(1120, 30, 1, p(4), 7n, 40n), // exactly t_2: belongs to bar 2
    row(900, 10, 0, p(1), 5n, 10n), // seed, before the grid
    row(1000, 20, 0, p(2), 3n, 20n, 500), // exactly t_0: seeds the close, not a bar
    row(1061, 25, 0, p(3), -2n, 30n), // bar 2
    row(1120, 30, 0, p(5), 1n, 50n), // same block, earlier log: tape order puts it first
    row(1300, 40, 0, p(9), 1n, 90n), // after the grid: ignored
  ];
  const s = buildSeries(rows, g, (r) => rawPrice(r.sqrtPriceX96), (r) => Number(r.amount1 < 0n ? -r.amount1 : r.amount1), (r) => Number(r.amount1));
  assert.deepEqual(s.close, [4, 4, 16, 16, 16]);
  assert.deepEqual(s.high, [null, null, 25, null, null]);
  assert.deepEqual(s.low, [null, null, 9, null, null]);
  assert.deepEqual(s.volume, [0, 0, 10, 0, 0]);
  assert.deepEqual(s.count, [0, 0, 3, 0, 0]);
  assert.deepEqual(s.flow, [0, 0, 6, 0, 0]);
  assert.deepEqual(s.liquidity, [20n, 20n, 40n, 40n, 40n]);
  assert.deepEqual(s.fee, [500, 500, 9991, 9991, 9991]);
  // no seed: closes stay null until the first swap
  const late = buildSeries([row(1100, 1, 0, p(2))], g, (r) => rawPrice(r.sqrtPriceX96), () => 1, () => 0);
  assert.deepEqual(late.close, [null, null, 4, 4, 4]);
  assert.deepEqual(late.count, [0, 0, 1, 0, 0]);
});

test("lastAtOrBefore includes the whole block", () => {
  const tape = [row(1, 10, 0, Q96), row(2, 11, 0, Q96), row(2, 11, 4, Q96), row(3, 12, 0, Q96)];
  assert.equal(lastAtOrBefore(tape, 11)!.logIndex, 4);
  assert.equal(lastAtOrBefore(tape, 9), undefined);
  assert.equal(lastAtOrBefore(tape, 99)!.block, 12);
});

test("archive check point is the last block before the next swap", () => {
  const tape = [row(900, 10, 0, Q96), row(1000, 20, 0, Q96), row(1000, 20, 3, Q96), row(1070, 27, 1, Q96)];
  assert.equal(checkPoint(tape, 899, 99), undefined);
  // the close at t = 1000 is the last swap of block 20; the next swap is in block 27, so state holds through 26
  assert.deepEqual([checkPoint(tape, 1000, 99)!.row.logIndex, checkPoint(tape, 1000, 99)!.block], [3, 26]);
  assert.equal(checkPoint(tape, 1069, 99)!.block, 26);
  // after the last swap: the end of the range
  assert.equal(checkPoint(tape, 5000, 99)!.block, 99);
  // a next swap in the very next block: check the close's own block
  assert.equal(checkPoint([row(1, 5, 0, Q96), row(2, 6, 0, Q96)], 1, 99)!.block, 5);
});

test("a swap that empties the range counts as volume but not as a high", () => {
  const g = { start: 1000, step: 60, n: 3 };
  const rows = [row(990, 1, 0, Q96, 1n, 5n), row(1010, 2, 0, 1n, 4n, 0n), row(1010, 2, 1, 3n * Q96, -1n, 7n), row(1100, 3, 0, 1n, 1n, 0n)];
  const s = buildSeries(rows, g, (r) => rawPrice(r.sqrtPriceX96), (r) => Number(r.amount1 < 0n ? -r.amount1 : r.amount1), (r) => Number(r.amount1));
  assert.deepEqual(s.high, [null, 9, null]);
  assert.deepEqual(s.low, [null, 9, null]);
  assert.deepEqual(s.count, [0, 2, 1]);
  assert.deepEqual(s.unpriced, [0, 1, 1]);
  assert.deepEqual(s.volume, [0, 5, 1]);
  // the close stays the raw state after the last swap, even an unpriced one
  assert.deepEqual(s.liquidity, [5n, 7n, 0n]);
});

// two real swaps from the tape (swaps-raw-main.json): [ts, block, logIndex, amount0, amount1, sqrtPriceX96, liquidity]
const real = (x: [number, number, number, string, string, string, string]): SwapRow =>
  ({ ts: x[0], block: x[1], logIndex: x[2], tx: "0x", sender: "0x", amount0: BigInt(x[3]), amount1: BigInt(x[4]), sqrtPriceX96: BigInt(x[5]), liquidity: BigInt(x[6]), tick: 0, fee: 0 });
// BONER/USDG, 2026-08-30T23:19:54Z, tx 0x7888...d231: ran out of its range into a far, thin position
const overshoot = real([1788131994, 50395381, 137, "-3655294459", "139211188759817159094230", "21102379510707466198308757407377018", "432756357494991"]);
// HIMS/USDG, 2026-08-30T23:28:42Z, tx 0x0a43...4551: the 124.70 peak, a thin but real quote
const peak = real([1788132522, 50400562, 5, "-904411681", "12693748535939420837", "7094772503027599615101444472257839", "30568117172897"]);

test("a post-swap price is a quote only within OVERSHOOT of what the swap paid", () => {
  close(PRICE.bonerUsdg.price(overshoot.sqrtPriceX96), 14.096013565, 1e-9);
  close(PRICE.bonerUsdg.avg(overshoot)!, 3655.294459 / 139211.18875981716, 1e-12); // 0.0263 USDG per BONER paid
  assert.equal(isQuote(overshoot, PRICE.bonerUsdg), false);
  close(PRICE.himsUsdg.price(peak.sqrtPriceX96), 124.7045, 1e-5);
  close(PRICE.himsUsdg.avg(peak)!, 71.2486, 1e-5); // 904.41 USDG for 12.69 HIMS
  assert.equal(isQuote(peak, PRICE.himsUsdg), true);
  assert.equal(OVERSHOOT, 10);
  // both directions: 1 USDG paid per HIMS against a post-swap price of 1e12 (sqrtPriceX96 = 2^96), or of 1e-12
  const cheap = { ...peak, amount0: -(10n ** 6n), amount1: 10n ** 18n };
  assert.equal(isQuote({ ...cheap, sqrtPriceX96: Q96 }, PRICE.himsUsdg), false);
  assert.equal(isQuote({ ...cheap, sqrtPriceX96: Q96 * 10n ** 12n }, PRICE.himsUsdg), false);
  assert.equal(isQuote({ ...cheap, sqrtPriceX96: Q96 * 10n ** 6n }, PRICE.himsUsdg), true); // exactly 1 USDG per HIMS
  // a drained range is never a quote, whatever it paid
  assert.equal(isQuote({ ...peak, liquidity: 0n }, PRICE.himsUsdg), false);
  // dust: under 1,000 base units on a side the average is rounding, so only the liquidity test applies
  const dust = { ...overshoot, amount0: -2n, amount1: 71758953149550n };
  assert.equal(PRICE.bonerUsdg.avg(dust), null);
  assert.equal(isQuote(dust, PRICE.bonerUsdg), true);
  // BONER/HIMS: HIMS (currency1) per BONER (currency0)
  const bh = { ...overshoot, amount0: 10n ** 21n, amount1: -(10n ** 17n), sqrtPriceX96: Q96 / 100n }; // 1,000 BONER for 0.1 HIMS, price 1e-4
  close(PRICE.bonerHims.avg(bh)!, 1e-4, 1e-12);
  assert.equal(isQuote(bh, PRICE.bonerHims), true);
});

test("an overshooting swap counts as volume but not in high/low, and its close is flagged", () => {
  const g = { start: 1788131940, step: 60, n: 3 }; // bar 1 = (23:19:00, 23:20:00]
  const before = { ...overshoot, ts: 1788131930, block: 50395325, logIndex: 77, sqrtPriceX96: 763803261265185304530590856328607392n, liquidity: 89555240560983889n };
  const after = { ...overshoot, logIndex: 185, amount0: 3027523709n, amount1: -97036480315319888856312n, sqrtPriceX96: 723628617624132157356399824528825956n, liquidity: 40254304971280991n };
  const f = (rows: SwapRow[]) => buildSeries(rows, g, (r) => usdgPerBoner(r.sqrtPriceX96), (r) => Number(r.amount0 < 0n ? -r.amount0 : r.amount0) / 1e6, () => 0, (r) => isQuote(r, PRICE.bonerUsdg));
  const s = f([before, overshoot, after]);
  close(s.high[1]!, usdgPerBoner(after.sqrtPriceX96), 1e-12); // 0.0120, not 14.1
  close(s.low[1]!, usdgPerBoner(after.sqrtPriceX96), 1e-12);
  assert.deepEqual(s.count, [0, 2, 0]);
  assert.deepEqual(s.unpriced, [0, 1, 0]);
  close(s.volume[1], 3655.294459 + 3027.523709, 1e-12);
  assert.deepEqual(s.closeIsQuote, [true, true, true]);
  // had nothing followed it, the close would sit on the overshoot, flagged as no quote
  assert.deepEqual(f([before, overshoot]).closeIsQuote, [true, false, false]);
  assert.deepEqual(f([]).closeIsQuote, [null, null, null]);
});

test("pool discovery runs without a gap from HIMS's deployment to the window end, one cache per segment", () => {
  assert.equal(DISCOVERY[0].from, 20_950_062n); // HIMS's code first appears here (supply.ts bisection over eth_getCode)
  for (let i = 1; i < DISCOVERY.length; i++) assert.equal(DISCOVERY[i].from, DISCOVERY[i - 1].to + 1n);
  assert.equal(DISCOVERY.at(-1)!.to, WINDOW_END_BLOCK);
  assert.equal(new Set(DISCOVERY.map((s) => s.cache)).size, DISCOVERY.length);
  assert.equal(DISCOVERY.find((s) => s.from === 41_500_000n)?.cache, ""); // the first search's caches keep their names
  const deploy = existsSync(`${cacheDir}hims-deploy.json`) ? JSON.parse(readFileSync(`${cacheDir}hims-deploy.json`, "utf8")) : undefined;
  if (deploy?.block !== undefined) assert.equal(BigInt(deploy.block), DISCOVERY[0].from);
});

const poolsFile = `${cacheDir}out/pools.json`;
test("the pool registry reaches back to HIMS's deployment and explains every PoolManager HIMS transfer", { skip: !existsSync(poolsFile) && "not collected yet (npm run squeeze)" }, () => {
  const p = JSON.parse(readFileSync(poolsFile, "utf8"));
  assert.equal(p.meta.discovery.fromBlock, "20950062");
  // HIMS/ETH (fee 50000) was initialized before 41.5M and traded through the weekend
  const eth = p.all.find((x: any) => x.id === "0xddd0fbfc0958aee6e002104c719019275e69cac540583ad8b24533c1d3e78641");
  assert.ok(eth && eth.pair === "ETH/HIMS" && eth.initBlock < 41_500_000 && eth.window.swaps > 1_000, JSON.stringify(eth?.window));
  assert.ok(p.otherHimsPools.active.some((x: any) => x.id === eth.id));
  const cov = p.meta.discovery.coverage;
  assert.equal(cov.undiscoveredPool.txs, 0);
  assert.equal(cov.tapeGap.txs, 0);
  assert.equal(cov.complete, true);
  assert.equal(cov.swap.txs + cov.liquidityOrDonate.txs + cov.protocolFees.txs + cov.noHimsPoolEvent.txs, cov.txs);
  // HIMS leaving in protocol fee sweeps (the fee controller's FeesCollected for HIMS = the tx's HIMS outflow)
  assert.equal(cov.protocolFees.txs, 3);
  assert.ok(cov.protocolFeeController.includes("0x6d0009504d129cf5002dba61d9ae8575aa79314c"));
  // others are ranked within their volume unit, USDG pools first
  const units = p.otherHimsPools.active.map((x: any) => ["USDG", "HIMS", "BONER"].indexOf(x.volumeUnit));
  assert.deepEqual(units, [...units].sort((a: number, b: number) => a - b));
});
