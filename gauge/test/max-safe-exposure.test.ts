import { test } from "node:test";
import assert from "node:assert/strict";
import { gainPerUnit, LADDER, maxSafeExposure, pushCostInQuote } from "../src/replay.ts";
import { getSqrtPriceAtTick, poolStateFromPositions } from "../src/v4math.ts";

const book = (l: bigint) => poolStateFromPositions([{ tickLower: -6000, tickUpper: 6000, liquidity: l }], getSqrtPriceAtTick(0));

test("the bound is the smallest cost ÷ gain over the ladder, both ways", () => {
  const s = book(10n ** 18n);
  const b = maxSafeExposure(s, false, 3000);
  let min = Infinity;
  for (const x of LADDER) for (const up of [true, false]) min = Math.min(min, Number(pushCostInQuote(s, x, up, false, 3000).costQuote) / gainPerUnit(x, up));
  assert.equal(b.exposure, min);
  assert.ok(LADDER.includes(b.ticks));
});

test("ten times the liquidity carries ten times the exposure", () => {
  const thin = maxSafeExposure(book(10n ** 18n), false, 3000).exposure;
  const deep = maxSafeExposure(book(10n ** 19n), false, 3000).exposure;
  assert.ok(Math.abs(deep / thin - 10) < 0.05, `${deep / thin}`);
});

test("gain per unit: up is 1.0001^x − 1, down is 1 − 1.0001^−x", () => {
  assert.ok(Math.abs(gainPerUnit(953, true) - 0.1) < 0.001);
  assert.ok(Math.abs(gainPerUnit(953, false) - 0.0909) < 0.001);
});

// Written by `forge test --match-contract WalkFixture`: CostModel.maxSafeExposure (nobody pushing back) on the
// fixture pool, both quote sides. The gauge's mirror must agree with the contract, not just with itself.
import { readFileSync } from "node:fs";
import { poolStateFromPositions as fromPositions } from "../src/v4math.ts";

test("the gauge's bound equals CostModel.maxSafeExposure on the same pool", () => {
  const fx = JSON.parse(readFileSync(new URL("../../test/fixtures/walk.json", import.meta.url), "utf8"));
  assert.ok(fx.maxSafe, "fixture carries the contract's bound (run forge test --match-contract WalkFixture)");
  const positions = Object.values(fx.positions as Record<string, any>).map((p) => ({
    tickLower: Number(p.tickLower),
    tickUpper: Number(p.tickUpper),
    liquidity: BigInt(p.liquidity),
  }));
  const state = fromPositions(positions, BigInt(fx.sqrtPriceX96));
  for (const [side, quote0] of [["quote0", true], ["quote1", false]] as const) {
    const sol = fx.maxSafe[side];
    const ts = maxSafeExposure(state, quote0, Number(fx.fee));
    const solExposure = Number(BigInt(sol.exposure));
    assert.ok(Math.abs(ts.exposure / solExposure - 1) < 1e-6, `${side}: ${ts.exposure} vs ${solExposure}`);
    assert.equal(ts.ticks, Number(sol.ticks), `${side}: binding move`);
    // Solidity reports the tick direction; the gauge the asset's. With the quote as currency0 they are opposite.
    const solAssetUp = quote0 ? !sol.up : sol.up;
    assert.equal(ts.stockUp, solAssetUp, `${side}: binding direction`);
  }
});
