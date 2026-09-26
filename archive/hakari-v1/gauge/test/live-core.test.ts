// The live board's pure core (web/live/core.js), shared by the page and npm run live:baseline: its bound is the gauge's
// mirror of CostModel.maxSafeExposure on the fixture pool (which test/fixtures/walk.json pins to the Solidity), and its
// calendar is the gauge's mint-window rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LADDER as GAUGE_LADDER, maxSafeExposure } from "../src/replay.ts";
import { mintWindowClosedAt } from "../src/mint-window.ts";
import { hourlyPoints } from "../src/live-baseline.ts";
import { mulDiv, poolStateFromPositions, Q96, roundTripCost } from "../src/v4math.ts";
import { LADDER, latestFriday, maxSafeFromQuotes, mintWindowClosed, nextMintChange, priceInQuote, standing } from "../../web/live/core.js";

test("the board's max safe exposure equals the gauge's and CostModel's on the fixture pool", () => {
  assert.deepEqual(LADDER, GAUGE_LADDER);
  const fx = JSON.parse(readFileSync(new URL("../../test/fixtures/walk.json", import.meta.url), "utf8"));
  const positions = Object.values(fx.positions as Record<string, any>).map((p) => ({ tickLower: Number(p.tickLower), tickUpper: Number(p.tickUpper), liquidity: BigInt(p.liquidity) }));
  const state = poolStateFromPositions(positions, BigInt(fx.sqrtPriceX96));
  const fee = Number(fx.fee);
  const s = state.sqrtPriceX96;
  // shaped as PushCostLens.roundTripCosts returns it: [costInCurrency0[], costInCurrency1[], complete[]]
  const quotes = (up: boolean) => {
    const rs = LADDER.map((x: number) => {
      const r = roundTripCost(state, x, up, fee, fee);
      return { c0: up ? mulDiv(mulDiv(r.cost, Q96, s), Q96, s) : r.cost, c1: up ? r.cost : mulDiv(mulDiv(r.cost, s, Q96), s, Q96), ok: r.complete };
    });
    return [rs.map((r: any) => r.c0), rs.map((r: any) => r.c1), rs.map((r: any) => r.ok)];
  };
  for (const [side, quote0] of [["quote0", true], ["quote1", false]] as const) {
    const w = maxSafeFromQuotes(quotes(true), quotes(false), LADDER, quote0);
    const g = maxSafeExposure(state, quote0, fee);
    assert.ok(Math.abs(w.exposure / g.exposure - 1) < 1e-12, `${side}: board ${w.exposure} vs gauge ${g.exposure}`);
    assert.equal(w.binding.ticks, g.ticks);
    assert.equal(w.binding.assetUp, g.stockUp);
    assert.ok(Math.abs(w.exposure / Number(BigInt(fx.maxSafe[side].exposure)) - 1) < 1e-6, `${side}: board vs CostModel`);
  }
});

test("the board's mint window is the gauge's, hour by hour over two weeks", () => {
  const start = Date.parse("2026-09-18T00:30:00Z");
  for (let h = 0; h < 24 * 14; h++) {
    const at = new Date(start + h * 3600_000);
    assert.equal(mintWindowClosed(at), mintWindowClosedAt(at), at.toISOString());
  }
});

test("the next change of the mint window, and the latest US close", () => {
  const sat = nextMintChange(new Date("2026-09-26T02:21:00Z"));
  assert.equal(sat.closed, true);
  assert.equal(sat.at.toISOString(), "2026-09-28T00:00:00.000Z"); // Mon 02:00 Berlin
  const fri = nextMintChange(new Date("2026-09-25T20:00:00Z"));
  assert.equal(fri.closed, false);
  assert.equal(fri.at.toISOString(), "2026-09-26T00:00:00.000Z"); // Sat 02:00 Berlin
  assert.equal(latestFriday(new Date("2026-09-26T02:21:00Z")), "2026-09-25");
  assert.equal(latestFriday(new Date("2026-09-25T20:00:00Z")), "2026-09-25");
  assert.equal(latestFriday(new Date("2026-09-25T19:59:59Z")), "2026-09-18");
  assert.equal(latestFriday(new Date("2026-09-28T12:00:00Z")), "2026-09-25");
});

test("hourly points start at the US close and stop at the given time", () => {
  const pts = hourlyPoints("2026-09-25", Date.parse("2026-09-26T02:30:00Z") / 1000);
  assert.equal(pts[0].toISOString(), "2026-09-25T20:00:00.000Z");
  assert.equal(pts.at(-1)!.toISOString(), "2026-09-26T02:00:00.000Z");
  assert.equal(pts.length, 7);
  assert.throws(() => hourlyPoints("2026-09-26", 2e9), /not a Friday/);
});

test("price from sqrtPriceX96 either way round, and the standing thresholds", () => {
  // USDG (6) as currency0, a stock (18) as currency1 at 25 USDG: raw price = 1e18 / (25e6) = 4e10
  const sqrt = BigInt(Math.round(Math.sqrt(4e10) * 2 ** 96));
  assert.ok(Math.abs(priceInQuote(sqrt, 6, 18, true) / 25 - 1) < 1e-9);
  // the stock (18) as currency0, USDG (6) as currency1 at 400 USDG: raw price = 400e6 / 1e18
  const sqrt1 = BigInt(Math.round(Math.sqrt(4e-10) * 2 ** 96));
  assert.ok(Math.abs(priceInQuote(sqrt1, 18, 6, false) / 400 - 1) < 1e-9);
  assert.equal(standing(0.006), "collapsed");
  assert.equal(standing(0.46), "thinning");
  assert.equal(standing(0.69), "holding");
  assert.equal(standing(null), "unknown");
});
