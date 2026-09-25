import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getSqrtPriceAtTick, getTickAtSqrtPrice, poolStateFromPositions, walk } from "../src/v4math.ts";

// Written by `forge test --match-contract WalkFixture`.
const fx = JSON.parse(readFileSync(new URL("../../test/fixtures/walk.json", import.meta.url), "utf8"));

test("getSqrtPriceAtTick matches TickMath bit for bit", () => {
  for (const [tick, sqrt] of Object.entries(fx.sqrtPrices)) {
    assert.equal(getSqrtPriceAtTick(Number(tick)), BigInt(sqrt as string), `tick ${tick}`);
  }
});

test("getTickAtSqrtPrice inverts getSqrtPriceAtTick", () => {
  for (const tick of [-887272, -216886, -1234, -1, 0, 1, 242527, 887271]) {
    const s = getSqrtPriceAtTick(tick);
    assert.equal(getTickAtSqrtPrice(s), tick);
    assert.equal(getTickAtSqrtPrice(s + 1n), tick);
  }
});

test("the walk over positions matches PushCostLens.depthToMove on the same pool", () => {
  const positions = Object.values(fx.positions as Record<string, any>).map((p) => ({
    tickLower: Number(p.tickLower),
    tickUpper: Number(p.tickUpper),
    liquidity: BigInt(p.liquidity),
  }));
  const state = poolStateFromPositions(positions, BigInt(fx.sqrtPriceX96));
  assert.equal(state.tick, Number(fx.tick));
  assert.equal(state.liquidity, BigInt(fx.liquidity));
  for (const q of Object.values(fx.pushes as Record<string, any>)) {
    const w = walk(state, Number(q.ticks), q.up, Number(fx.fee));
    const label = `${q.up ? "up" : "down"} ${q.ticks}`;
    assert.equal(w.complete, q.complete, label);
    // the Solidity walk rounds the fee per step; allow a handful of wei
    const close = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= 64n;
    assert.ok(close(w.amountIn, BigInt(q.amountIn)), `${label} amountIn ${w.amountIn} vs ${q.amountIn}`);
    assert.ok(close(w.amountOut, BigInt(q.amountOut)), `${label} amountOut ${w.amountOut} vs ${q.amountOut}`);
    assert.ok(close(w.feePaid, BigInt(q.feePaid)), `${label} feePaid ${w.feePaid} vs ${q.feePaid}`);
  }
});
