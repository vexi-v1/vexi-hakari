import { test } from "node:test";
import assert from "node:assert/strict";
import { modAmounts, principal, sqrtAt, sweep, TickBook, type Mod, type Swp } from "../src/squeeze/inventory.ts";
import { positionsBefore } from "../src/replay.ts";
import { amount0Of, amount1Of, getSqrtPriceAtTick, type Position } from "../src/v4math.ts";

// deterministic pseudo-random numbers (xorshift32)
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), (x >>> 0) / 2 ** 32);
}

const mod = (block: number, logIndex: number, lower: number, upper: number, delta: bigint, owner = "a", ts = block): Mod & { sender: string } =>
  ({ block, logIndex, ts, key: `${owner}|${lower}|${upper}|0`, tickLower: lower, tickUpper: upper, delta, sender: owner });
const swap = (block: number, logIndex: number, tick: number, liquidity: bigint, ts = block, fee = 9991): Swp =>
  ({ block, logIndex, ts, sqrtPriceX96: getSqrtPriceAtTick(tick), tick, liquidity, fee });

test("TickBook in-range liquidity equals a brute-force fold at every tick", () => {
  const r = rng(7);
  const ticks = [-900, -450, -90, 0, 90, 180, 900, 1800];
  const mods: Mod[] = [];
  const live = new Map<string, bigint>();
  for (let i = 0; i < 400; i++) {
    const a = ticks[Math.floor(r() * ticks.length)], b = ticks[Math.floor(r() * ticks.length)];
    if (a === b) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${Math.floor(r() * 3)}|${lo}|${hi}|0`;
    const have = live.get(key) ?? 0n;
    // adds, partial and full removes, and zero-delta pokes
    const delta = r() < 0.1 ? 0n : r() < 0.6 || have === 0n ? BigInt(1 + Math.floor(r() * 1e6)) : -(r() < 0.5 ? have : have / 2n);
    live.set(key, have + delta);
    mods.push({ block: i, logIndex: 0, ts: i, key, tickLower: lo, tickUpper: hi, delta });
  }
  const book = new TickBook(mods.flatMap((m) => [m.tickLower, m.tickUpper]));
  const raw = mods.map((m) => ({ blockNumber: String(m.block), logIndex: 0, transactionHash: "0x", args: { sender: m.key.split("|")[0], tickLower: String(m.tickLower), tickUpper: String(m.tickUpper), liquidityDelta: m.delta.toString(), salt: "0" } }));
  for (let i = 0; i < mods.length; i++) {
    book.apply(mods[i].key, mods[i].tickLower, mods[i].tickUpper, mods[i].delta);
    if (i % 37 !== 0) continue;
    const ref = positionsBefore(raw, BigInt(mods[i].block) + 1n, 0);
    for (const t of [-1000, -900, -451, -450, -1, 0, 89, 90, 179, 180, 899, 900, 1799, 1800, 5000]) {
      const want = ref.filter((p) => p.tickLower <= t && t < p.tickUpper).reduce((s, p) => s + p.liquidity, 0n);
      assert.equal(book.activeAt(t), want, `after mod ${i}, tick ${t}`);
    }
    assert.equal(book.positions.size, ref.length);
  }
});

test("TickBook refuses a position going below zero (a missing log)", () => {
  const book = new TickBook([0, 60]);
  book.apply("k", 0, 60, 5n);
  assert.throws(() => book.apply("k", 0, 60, -6n), /below zero/);
});

test("principal is amount0Of / amount1Of summed, including prices on the range edges", () => {
  const positions: Position[] = [
    { tickLower: -600, tickUpper: 600, liquidity: 10n ** 18n },
    { tickLower: 240_000, tickUpper: 243_000, liquidity: 123_456_789_012_345_678n },
    { tickLower: 60, tickUpper: 120, liquidity: 7n },
  ];
  for (const tick of [-1000, -600, -1, 0, 60, 100, 120, 599, 600, 239_999, 240_000, 241_234, 243_000, 250_000]) {
    for (const sqrt of [sqrtAt(tick), sqrtAt(tick) + 1n]) {
      const got = principal(positions, sqrt);
      assert.equal(got.amount0, positions.reduce((s, p) => s + amount0Of(p, sqrt), 0n), `amount0 at ${tick}`);
      assert.equal(got.amount1, positions.reduce((s, p) => s + amount1Of(p, sqrt), 0n), `amount1 at ${tick}`);
    }
  }
  assert.equal(sqrtAt(242_518), getSqrtPriceAtTick(242_518));
});

test("modAmounts: an add brings tokens in, the same remove takes them out", () => {
  const s = sqrtAt(30);
  const add = modAmounts({ tickLower: -60, tickUpper: 120, delta: 10n ** 15n }, s);
  const rem = modAmounts({ tickLower: -60, tickUpper: 120, delta: -(10n ** 15n) }, s);
  assert.ok(add.amount0 > 0n && add.amount1 > 0n);
  assert.deepEqual(rem, { amount0: -add.amount0, amount1: -add.amount1 });
  // out of range above: only token1
  assert.equal(modAmounts({ tickLower: -60, tickUpper: 0, delta: 10n ** 15n }, s).amount0, 0n);
});

test("sweep: swaps see only earlier logs, grid points see ts <= t_k, checkpoints see whole blocks", () => {
  const L = 1000n;
  const mods = [
    mod(5, 0, -60, 60, L, "a", -Infinity), // before the window: no timestamp needed
    mod(10, 2, -60, 60, 500n, "b", 100), // same block as a swap, later log: after it
    mod(12, 0, 60, 120, 300n, "a", 130),
    mod(13, 1, -60, 60, -L, "a", 160), // after the grid point at 150
  ];
  const swaps = [
    swap(6, 0, 0, L, 40), // seed
    swap(10, 1, 0, L, 100), // before mod(10,2): the event reports L
    swap(11, 0, 70, 300n, 120), // in range [60, 120) only... but mod(12) not yet: rebuilt 0
    swap(14, 0, 0, 500n, 170),
  ];
  const seen: [number, bigint, bigint][] = [];
  const grid: [number, bigint, number, number][] = [];
  const blocks: [number, bigint, number][] = [];
  sweep(mods, swaps, [50, 100, 150, 200], [9, 10, 12, 20], {
    swap: (r, s) => seen.push([r.block, s.book.activeAt(r.tick), r.liquidity]),
    grid: (k, s) => grid.push([k, s.book.activeAt(s.tick!), s.tick!, s.book.positions.size]),
    block: (b, s) => blocks.push([b, s.book.activeAt(s.tick!), s.swapBlock!]),
  });
  assert.deepEqual(seen, [[6, L, L], [10, L, L], [11, 0n, 300n], [14, 500n, 500n]]);
  // t=50: seed applied; t=100: swap(10,1) and mod(10,2) both at ts 100; t=150: + swap(11) at tick 70, mod(12); t=200: + mod(13), swap(14)
  assert.deepEqual(grid, [[0, L, 0, 1], [1, L + 500n, 0, 2], [2, 300n, 70, 3], [3, 500n, 0, 2]]);
  assert.deepEqual(blocks, [[9, L, 6], [10, L + 500n, 10], [12, 300n, 11], [20, 500n, 14]]);
});

test("sweep refuses timestamps that go backwards", () => {
  assert.throws(() => sweep([mod(2, 0, -60, 60, 1n, "a", 50)], [swap(1, 0, 0, 0n, 60)], [], [], {}), /backwards/);
});
