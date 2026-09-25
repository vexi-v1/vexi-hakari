// The web page's live bound (web/app.js, the "max safe exposure" block) is the same math as the gauge's mirror of
// CostModel.maxSafeExposure: fed the round-trip costs the lens reports on the fixture pool, valued in both currencies
// the way PushCostLens does, it lands on the gauge's bound and on the contract's (test/fixtures/walk.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LADDER, maxSafeExposure } from "../src/replay.ts";
import { mulDiv, poolStateFromPositions, Q96, roundTripCost } from "../src/v4math.ts";

function webBlock() {
  const app = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  const start = app.indexOf("// ───────── max safe exposure (pure");
  const end = app.indexOf("\n// ─────────", start + 1);
  assert.ok(start >= 0 && end > start, "web/app.js carries the pure max-safe-exposure block");
  return new Function(`${app.slice(start, end)}\nreturn { LADDER, maxSafeFromQuotes };`)();
}

test("the web page's max safe exposure equals the gauge's and CostModel's on the fixture pool", () => {
  const web = webBlock();
  assert.deepEqual(web.LADDER, LADDER);
  const fx = JSON.parse(readFileSync(new URL("../../test/fixtures/walk.json", import.meta.url), "utf8"));
  const positions = Object.values(fx.positions as Record<string, any>).map((p) => ({
    tickLower: Number(p.tickLower),
    tickUpper: Number(p.tickUpper),
    liquidity: BigInt(p.liquidity),
  }));
  const state = poolStateFromPositions(positions, BigInt(fx.sqrtPriceX96));
  const fee = Number(fx.fee);
  const s = state.sqrtPriceX96;
  // PushCostLens._valueAt: the cost is in the input token (token1 pushing up, token0 pushing down), valued at the start
  const quotes = (up: boolean) =>
    LADDER.map((x) => {
      const r = roundTripCost(state, x, up, fee, fee);
      const costInCurrency1 = up ? r.cost : mulDiv(mulDiv(r.cost, s, Q96), s, Q96);
      const costInCurrency0 = up ? mulDiv(mulDiv(r.cost, Q96, s), Q96, s) : r.cost;
      return { costInCurrency0, costInCurrency1, sqrtPriceReached: r.sqrtPriceReached, sqrtPriceTarget: r.complete ? r.sqrtPriceReached : -1n };
    });
  for (const [side, quote0] of [["quote0", true], ["quote1", false]] as const) {
    const w = web.maxSafeFromQuotes(quotes(true), quotes(false), LADDER, quote0);
    const g = maxSafeExposure(state, quote0, fee);
    assert.ok(Math.abs(w.exposure / g.exposure - 1) < 1e-12, `${side}: web ${w.exposure} vs gauge ${g.exposure}`);
    assert.equal(w.binding.ticks, g.ticks, `${side}: binding move`);
    assert.equal(w.binding.assetUp, g.stockUp, `${side}: binding direction`);
    const sol = fx.maxSafe[side];
    assert.ok(Math.abs(w.exposure / Number(BigInt(sol.exposure)) - 1) < 1e-6, `${side}: web ${w.exposure} vs CostModel ${sol.exposure}`);
    assert.equal(w.binding.up, sol.up, `${side}: tick direction, as Settled reports it`);
    assert.equal(w.rungs.length, 2 * LADDER.length);
  }
});
