import { test } from "node:test";
import assert from "node:assert/strict";
import { positionsAt, positionsBefore } from "../src/hims-replay.ts";

const log = (block: number, logIndex: number, sender: string, lower: number, upper: number, delta: string, salt = "0x0") => ({
  blockNumber: String(block),
  logIndex,
  transactionHash: "0x",
  args: { sender, tickLower: String(lower), tickUpper: String(upper), liquidityDelta: delta, salt },
});

test("positions are keyed by sender, range and salt, and folded in block/log order", () => {
  const logs = [
    log(10, 0, "0xa", -100, 100, "1000"),
    log(12, 3, "0xa", -100, 100, "-400"),
    log(11, 0, "0xb", -100, 100, "7"),
    log(11, 1, "0xa", -100, 100, "5", "0x1"), // different salt, different position
    log(13, 0, "0xb", -100, 100, "-7"), // fully removed
  ];
  const at12 = positionsAt(logs, 12n);
  assert.deepEqual(
    at12.map((p) => p.liquidity).sort((a, b) => (a < b ? -1 : 1)),
    [5n, 7n, 600n],
  );
  const at13 = positionsAt(logs, 13n);
  assert.deepEqual(at13.map((p) => p.liquidity).sort((a, b) => (a < b ? -1 : 1)), [5n, 600n]);
  assert.equal(positionsAt(logs, 9n).length, 0);
});

test("positionsBefore stops at the given log, so a swap can be checked against the state it saw", () => {
  const logs = [log(10, 0, "0xa", -100, 100, "1000"), log(10, 2, "0xa", -100, 100, "-1000"), log(11, 0, "0xa", -100, 100, "3")];
  assert.deepEqual(positionsBefore(logs, 10n, 1).map((p) => p.liquidity), [1000n]);
  assert.deepEqual(positionsBefore(logs, 10n, 3).map((p) => p.liquidity), []);
  assert.deepEqual(positionsBefore(logs, 11n, 0).map((p) => p.liquidity), []);
  assert.deepEqual(positionsAt(logs, 11n).map((p) => p.liquidity), [3n]);
});
