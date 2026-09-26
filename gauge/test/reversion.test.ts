// The reversion measurement (npm run reversion): what counts as a push, when it counts as pulled back, and the rule that
// turns the pull-back times into SafeSettle's arbReversionSeconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findPushes, quantile, recommend, summarize, swapBlocks } from "../src/reversion.ts";

const swap = (block: number, logIndex: number, tick: number, liquidity = "1") => ({ blockNumber: String(block), logIndex, transactionHash: "0x", args: { tick: String(tick), liquidity } });

test("one tick per swap block, the last swap's; a swap that left no liquidity in range is not a price", () => {
  const tape = swapBlocks([swap(2, 1, 7), swap(1, 0, 5), swap(2, 0, 6), swap(3, 0, 900, "0"), swap(4, 0, 8)] as any);
  assert.deepEqual(tape, [{ block: 1, tick: 5 }, { block: 2, tick: 7 }, { block: 4, tick: 8 }]);
});

test("a push is measured from where the previous swap block left the tick, and pulled back by 50 % and 90 %", () => {
  const tape = [{ block: 10, tick: 0 }, { block: 11, tick: 100 }, { block: 12, tick: 60 }, { block: 13, tick: 40 }, { block: 14, tick: 5 }];
  const [p, ...rest] = findPushes(tape, 50, (b) => b + 100);
  assert.equal(p.block, 11);
  assert.equal(p.ticks, 100);
  assert.equal(p.half, 13); // 40 left of 100: within half
  assert.equal(p.ninety, 14); // 5 left: within 10 %
  assert.equal(rest.length, 0, "moves of 40, 20 and 35 ticks are under the threshold");
  // downward pushes mirror it; a pull-back past the start still counts
  const down = findPushes([{ block: 1, tick: 0 }, { block: 2, tick: -60 }, { block: 3, tick: 10 }], 50, (b) => b + 100);
  assert.equal(down[0].half, 3);
  assert.equal(down[0].ninety, 3);
});

test("no pull-back after the horizon: the push stays open", () => {
  const tape = [{ block: 1, tick: 0 }, { block: 2, tick: 80 }, { block: 50, tick: 0 }];
  const [p] = findPushes(tape, 50, () => 49);
  assert.equal(p.half, undefined);
  assert.equal(p.ninety, undefined);
});

test("quantiles count an open push as longer than any measured one", () => {
  assert.equal(quantile([5, null, 1, 3], 0.5), 3);
  assert.equal(quantile([5, null, 1, 3], 0.9), null);
  assert.equal(quantile([], 0.5), null);
  const s = summarize([5, null, 70, 3]);
  assert.equal(s.n, 4);
  assert.equal(s.within10s, 0.5);
  assert.equal(s.within60s, 0.5);
  assert.equal(s.within3600s, 0.75);
  assert.equal(s.undoneP50, 5);
});

test("arbReversionSeconds: the shortest horizon that 90 % of at least 10 fee-width pushes were undone within, else 0", () => {
  assert.equal(recommend(Array(9).fill(1)).arbReversionSeconds, 0, "fewer than 10 pushes: not measured");
  assert.equal(recommend(Array(10).fill(4)).arbReversionSeconds, 10);
  assert.equal(recommend([...Array(9).fill(4), 50]).arbReversionSeconds, 10, "9 of 10 within 10 s is 90 %");
  assert.equal(recommend([...Array(8).fill(4), 50, 50]).arbReversionSeconds, 60);
  assert.equal(recommend([...Array(8).fill(4), 50, null]).arbReversionSeconds, 60, "one in ten never undone still leaves 90 % within 60 s");
  assert.equal(recommend([...Array(8).fill(4), null, null]).arbReversionSeconds, 0, "two in ten never undone within the hour");
  assert.match(recommend([...Array(8).fill(4), null, null]).why, /only 80 %/);
});
