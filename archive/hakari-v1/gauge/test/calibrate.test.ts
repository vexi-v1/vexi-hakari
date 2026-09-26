import { test } from "node:test";
import assert from "node:assert/strict";
import { percentile, tickMoves } from "../src/calibrate.ts";

test("percentile picks the nearest-rank element", () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(s, 50), 5);
  assert.equal(percentile(s, 99), 10);
  assert.equal(percentile(s, 90), 9);
  assert.equal(percentile([], 99), 0);
});

test("tick moves use the last swap of each block and skip nothing", () => {
  const log = (block: number, logIndex: number, tick: number) => ({ blockNumber: String(block), logIndex, args: { tick: String(tick) } });
  const { blocks, moves } = tickMoves([log(5, 1, 100), log(5, 0, 90), log(7, 0, 130), log(6, 0, 95)]);
  assert.deepEqual(blocks, [5n, 6n, 7n]);
  assert.deepEqual(moves, [5, 35]);
});
