import { test } from "node:test";
import assert from "node:assert/strict";
import { brackets, buildGrid, compareExact, decodeTransfer, dedupe, deltas, lastBlocksAtOrBefore, mintCluster, PM, stateAt, ZERO, type Timed } from "../src/squeeze/supply.ts";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const E = (n: number) => (BigInt(n) * 10n ** 18n).toString();
const x = (b: number, i: number, from: string, to: string, v: number, ts = 0, tx = `0x${b}${i}`): Timed => ({ b, i, tx, from, to, v: E(v), ts });

test("decodeTransfer reads indexed from/to out of the topics and the value out of data", () => {
  const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
  const l = decodeTransfer({
    blockNumber: "0x2e3b0e0",
    logIndex: "0x1f",
    transactionHash: "0xabc",
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad(ZERO), pad(PM)],
    data: `0x${(10n ** 21n).toString(16).padStart(64, "0")}`,
  });
  assert.deepEqual(l, { b: 48_476_384, i: 31, tx: "0xabc", from: ZERO, to: PM, v: (10n ** 21n).toString() });
  assert.throws(() => decodeTransfer({ blockNumber: "0x1", logIndex: "0x0", transactionHash: "0x", topics: ["0x00"], data: "0x" }));
});

test("dedupe keeps one copy of a log seen by both OR-filters and sorts by block then logIndex", () => {
  const mintToPm = x(5, 2, ZERO, PM, 3);
  const out = dedupe([x(7, 0, PM, A, 1), mintToPm, x(5, 1, A, PM, 2), { ...mintToPm }]);
  assert.deepEqual(out.map((l) => `${l.b}:${l.i}`), ["5:1", "5:2", "7:0"]);
});

test("deltas: mints and burns move supply, transfers in/out of the PoolManager move its balance", () => {
  assert.equal(deltas(x(1, 0, ZERO, A, 10)).supply, BigInt(E(10)));
  assert.equal(deltas(x(1, 0, A, ZERO, 4)).supply, -BigInt(E(4)));
  const toPm = deltas(x(1, 0, A, PM, 3));
  assert.equal(toPm.supply, 0n);
  assert.equal(toPm.pm, BigInt(E(3)));
  assert.equal(deltas(x(1, 0, PM, B, 2)).pm, -BigInt(E(2)));
  const mintToPm = deltas(x(1, 0, ZERO, PM, 5)); // counted once for supply and once for the PoolManager
  assert.equal(mintToPm.supply, BigInt(E(5)));
  assert.equal(mintToPm.pm, BigInt(E(5)));
  assert.equal(deltas(x(1, 0, PM, PM, 9)).pm, 0n);
});

test("stateAt folds every log up to and including the block", () => {
  const xs = [x(1, 0, ZERO, A, 100), x(2, 0, A, PM, 60), x(2, 1, PM, B, 10), x(3, 0, B, ZERO, 10)];
  assert.deepEqual(stateAt(xs, 0), { supply: 0n, pm: 0n });
  assert.deepEqual(stateAt(xs, 2), { supply: BigInt(E(100)), pm: BigInt(E(50)) });
  assert.deepEqual(stateAt(xs, 3), { supply: BigInt(E(90)), pm: BigInt(E(50)) });
});

test("buildGrid carries the close forward and puts bars in (t_{k-1}, t_k], nothing at k = 0", () => {
  const seed = { supply: BigInt(E(1000)), pm: BigInt(E(400)) };
  const xs = [
    x(10, 0, ZERO, A, 5, 100), // ts == t0: in the k=0 close, not in any bar
    x(11, 0, A, PM, 7, 101), // bucket k=1 (100, 160]
    x(12, 0, ZERO, A, 3, 160), // still k=1: the right edge is inclusive
    x(13, 0, A, ZERO, 2, 161), // k=2
    x(14, 0, PM, B, 1, 280), // k=3
    x(15, 0, ZERO, A, 50, 281), // after the last grid point: ignored
  ];
  const g = buildGrid(seed, xs, 100, 60, 4);
  assert.deepEqual(g.t, [100, 160, 220, 280]);
  assert.deepEqual(g.supply.map(String), [E(1005), E(1008), E(1006), E(1006)]);
  assert.deepEqual(g.pm.map(String), [E(400), E(407), E(407), E(406)]);
  assert.deepEqual(g.minted.map(String), ["0", E(3), "0", "0"]);
  assert.deepEqual(g.burned.map(String), ["0", "0", E(2), "0"]);
  assert.deepEqual(g.mints, [0, 1, 0, 0]);
  assert.deepEqual(g.burns, [0, 0, 1, 0]);
  assert.deepEqual(g.pmIn.map(String), ["0", E(7), "0", "0"]);
  assert.deepEqual(g.pmOut.map(String), ["0", "0", "0", E(1)]);
  assert.throws(() => buildGrid(seed, [x(2, 0, ZERO, A, 1, 150), x(1, 0, ZERO, A, 1, 150)], 100, 60, 3));
});

test("mintCluster counts a block range and finds the mint at which half the total had arrived", () => {
  const mints = [x(1, 0, ZERO, A, 1000, 10), x(2, 0, ZERO, A, 10, 20), x(3, 0, ZERO, A, 500, 30), x(4, 0, ZERO, A, 600, 40), x(5, 0, ZERO, A, 900, 50), x(9, 0, ZERO, A, 7, 90)];
  const c = mintCluster(mints, 2, 5); // 10 + 500 + 600 + 900 = 2010, half = 1005
  assert.equal(c.count, 4);
  assert.equal(c.total, BigInt(E(2010)));
  assert.equal(c.first!.b, 2);
  assert.equal(c.last!.b, 5);
  assert.equal(c.half!.b, 4); // 10 + 500 + 600 = 1110 >= 1005, 510 was not
  assert.equal(c.halfCum, BigInt(E(1110)));
  assert.equal(mintCluster(mints, 6, 8).count, 0);
});

// A toy chain: 10 blocks per second, so ts(b) = floor(b / 10) and several blocks share each second.
const tsOf = (b: number) => Math.floor(b / 10);

test("brackets finds the known blocks on both sides of each target and rejects out-of-range or backwards input", () => {
  const known = new Map([0, 95, 200, 305, 1000].map((b) => [b, tsOf(b)]));
  assert.deepEqual(brackets(known, [9, 20, 30]), [{ t: 9, lo: 95, hi: 200 }, { t: 20, lo: 200, hi: 305 }, { t: 30, lo: 305, hi: 1000 }]);
  assert.throws(() => brackets(known, [100])); // nothing known after it
  assert.throws(() => brackets(new Map([[5, 3], [6, 2], [9, 9]]), [4]));
});

test("lastBlocksAtOrBefore bisects to the last block of each second, fetching only midpoints", async () => {
  const known = new Map([0, 5_000].map((b) => [b, tsOf(b)]));
  const asked: number[] = [];
  const timeOf = async (bs: number[]) => {
    asked.push(...bs);
    return new Map(bs.map((b) => [b, tsOf(b)]));
  };
  const targets = [0, 1, 123, 499];
  const { blocks, rounds } = await lastBlocksAtOrBefore(targets, known, timeOf);
  assert.deepEqual([...blocks], [[0, 9], [1, 19], [123, 1239], [499, 4999]]);
  assert.ok(rounds <= 13 && asked.length <= targets.length * 13);
  await assert.rejects(lastBlocksAtOrBefore([1], known, async () => new Map()));
});

test("compareExact counts mismatches and keeps the largest absolute difference in wei", () => {
  assert.deepEqual(compareExact([{ onchain: 5n, reconstructed: 5n }, { onchain: 7n, reconstructed: 10n }, { onchain: 9n, reconstructed: 8n }]), { n: 3, mismatches: 2, maxAbsDiffWei: "3" });
  assert.deepEqual(compareExact([]), { n: 0, mismatches: 0, maxAbsDiffWei: "0" });
});
