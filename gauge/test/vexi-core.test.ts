// The vexi board's pure core (web/vexi/core.js): the bands SafeSettle's rule implies, the quote-side reserve of a
// full-range pool on either token order, the PoolManager's packed slot0, the 15-minute expiry grid, and the rung
// lookup on top of web/live/core.js's maxSafeFromQuotes (itself pinned to CostModel by live-core.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { band, boundAtRung, capacityLine, fmtRatio, fmtUsdg, nextExpiry, quoteReserve, unpackSlot0, whatIf } from "../../web/vexi/core.js";
import { LADDER, maxSafeFromQuotes, priceInQuote } from "../../web/live/core.js";

test("bands: refused from 1×, watch from 0.5×, trusted below, unknown otherwise", () => {
  assert.equal(band(0), "trusted");
  assert.equal(band(0.38), "trusted");
  assert.equal(band(0.4999), "trusted");
  assert.equal(band(0.5), "watch");
  assert.equal(band(0.999), "watch");
  assert.equal(band(1), "refused");
  assert.equal(band(Infinity), "refused");
  assert.equal(band(null), "unknown");
  assert.equal(band(NaN), "unknown");
  assert.equal(band(-1), "unknown");
});

test("what-if: the ratio, its band and the headroom; a zero bound refuses anything positive", () => {
  assert.deepEqual(whatIf(819.5, 2183), { ratio: 819.5 / 2183, band: "trusted", headroom: 2183 - 819.5 });
  assert.deepEqual(whatIf(2183, 2183), { ratio: 1, band: "refused", headroom: 0 });
  assert.deepEqual(whatIf(3000, 2183), { ratio: 3000 / 2183, band: "refused", headroom: 0 });
  assert.deepEqual(whatIf(1200, 2183).band, "watch");
  assert.deepEqual(whatIf(1, 0), { ratio: Infinity, band: "refused", headroom: 0 });
  assert.deepEqual(whatIf(0, 0), { ratio: null, band: "unknown", headroom: 0 });
  assert.deepEqual(whatIf("abc", 5), { ratio: null, band: "unknown", headroom: null });
  assert.deepEqual(whatIf(-1, 5), { ratio: null, band: "unknown", headroom: null });
});

test("fee × reserve, in whole USDG", () => {
  assert.ok(Math.abs(capacityLine(3000, 795_600) - 2386.8) < 1e-9);
  assert.equal(capacityLine(3000, 0), 0);
});

test("the quote-side reserve of a full-range position on either token order", () => {
  // PONS-shaped: USDG (6) is currency0, the base (18) currency1, at 0.633 USDG: raw price = 1e18 / 0.633e6
  const rawPons = 1e18 / 0.633e6;
  const sqrtPons = BigInt(Math.round(Math.sqrt(rawPons) * 2 ** 96));
  const L = 10n ** 18n;
  const rPons = quoteReserve(L, sqrtPons, true, 6);
  // L ÷ √P raw, over 1e6: 1e18 ÷ 1.2569e6 ÷ 1e6 ≈ 795,600
  assert.ok(Math.abs(rPons / (1e18 / Math.sqrt(rawPons) / 1e6) - 1) < 1e-9);
  assert.ok(rPons > 790_000 && rPons < 800_000, `${rPons}`);
  // MU-shaped: the base (18) is currency0, USDG (6) currency1, at 120 USDG: raw price = 120e6 / 1e18
  const rawMu = 120e6 / 1e18;
  const sqrtMu = BigInt(Math.round(Math.sqrt(rawMu) * 2 ** 96));
  const rMu = quoteReserve(L, sqrtMu, false, 6);
  assert.ok(Math.abs(rMu / ((1e18 * Math.sqrt(rawMu)) / 1e6) - 1) < 1e-9);
  // and the same reserve means the same fee × reserve on both orders at the same depth-in-quote
  assert.ok(rMu > 0);
  assert.equal(quoteReserve(0n, sqrtMu, false, 6), 0);
  assert.equal(quoteReserve(L, 0n, true, 6), 0);
});

test("slot0 unpacks sqrtPriceX96 and a signed tick from the packed word", () => {
  const sqrt = 99578155167462645643837140562054421n; // PONS at 2026-09-26, tick 280896
  const packed = (word: bigint, tick: number) => "0x" + ((BigInt(tick & 0xffffff) << 160n) | word).toString(16).padStart(64, "0");
  const up = unpackSlot0(packed(sqrt, 280896));
  assert.equal(up.sqrtPriceX96, sqrt);
  assert.equal(up.tick, 280896);
  const down = unpackSlot0(packed(sqrt, -230270));
  assert.equal(down.sqrtPriceX96, sqrt);
  assert.equal(down.tick, -230270);
  // lpFee and protocolFee above the tick must not leak into it
  const withFee = "0x" + ((3000n << 208n) | (BigInt(280896) << 160n) | sqrt).toString(16).padStart(64, "0");
  assert.equal(unpackSlot0(withFee).tick, 280896);
  // and the price the page shows from it: USDG per base with the quote as currency0
  assert.ok(Math.abs(priceInQuote(sqrt, 6, 18, true) - 0.633) < 0.002);
});

test("the bound at one rung is the cheaper direction of that width, on the rungs maxSafeFromQuotes reports", () => {
  // the six PONS round trips the deployed lens returned on 2026-09-26 (cost in currency0 = USDG raw), both ways
  const upC0 = [11838446n, 23790527n, 47695344n, 116550974n, 227784453n, 436286747n];
  const downC0 = [12065480n, 24017563n, 47922391n, 116778083n, 228011760n, 436514754n];
  const ones = LADDER.map(() => 0n), oks = LADDER.map(() => true);
  const b = maxSafeFromQuotes([upC0, ones, oks], [downC0, ones, oks], LADDER, true);
  const at50 = boundAtRung(b.rungs, 50)! / 1e6;
  const at1823 = boundAtRung(b.rungs, 1823)! / 1e6;
  assert.ok(at50 > 2300 && at50 < 2400, `${at50}`);
  assert.ok(at1823 > 2100 && at1823 < 2300, `${at1823}`);
  assert.ok(Math.abs(at50 / at1823 - 1) < 0.1, "flat within 10 % across the ladder on one full-range position");
  assert.equal(b.exposure / 1e6, Math.min(...LADDER.map((x) => boundAtRung(b.rungs, x)! / 1e6)));
  assert.equal(boundAtRung(b.rungs, 7), null);
});

test("the next expiry on the 900 s grid", () => {
  assert.equal(nextExpiry(1790351100, 900), 1790352000);
  assert.equal(nextExpiry(1790351099, 900), 1790351100);
  assert.equal(nextExpiry(1790351100.7), 1790352000);
  assert.equal(nextExpiry(0), 900);
});

test("USDG and ratio formatting for the tables", () => {
  assert.equal(fmtUsdg(2183.9), "2,183");
  assert.equal(fmtUsdg(35.4321), "35.43");
  assert.equal(fmtUsdg(0.0032), "3.2e-3");
  assert.equal(fmtUsdg(0), "0");
  assert.equal(fmtUsdg(null), "—");
  assert.equal(fmtUsdg("x"), "—");
  assert.equal(fmtUsdg(-12.5), "−12.50");
  assert.equal(fmtRatio(0.3754), "0.38×");
  assert.equal(fmtRatio(0.0123), "0.012×");
  assert.equal(fmtRatio(Infinity), "∞");
  assert.equal(fmtRatio(null), "—");
});
