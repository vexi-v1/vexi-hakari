// The vexi board's pure pieces: no DOM, no network. The page (web/vexi/app.js) imports this file and
// gauge/test/vexi-core.test.ts pins it. The bound itself is web/live/core.js's maxSafeFromQuotes (the gauge's mirror
// of CostModel.maxSafeExposure, pinned to the Solidity by test/fixtures/walk.json); this file adds the venue-side
// arithmetic: how a settlement compares with the bound, the reserve a full-range pool holds on its quote side, the
// 15-minute expiry grid and the PoolManager's packed slot0.

/** SafeSettle refuses at ratio ≥ 1 (exposure not below the bound); the board flags the upper half as "watch". */
export const REFUSED_AT = 1;
export const WATCH_AT = 0.5;

/** How an exposure ÷ bound reads: "trusted" below 0.5, "watch" up to 1, "refused" from 1; "unknown" when not a number. */
export function band(ratio) {
  if (ratio == null || Number.isNaN(ratio) || ratio < 0) return "unknown";
  if (ratio >= REFUSED_AT) return "refused";
  if (ratio >= WATCH_AT) return "watch";
  return "trusted";
}

/**
 * exposure ÷ bound, and the band it falls in. A bound of 0 (an empty pool, or the stub baseline) refuses any positive
 * exposure and says nothing about zero. `headroom` is what could still settle before the line, never negative.
 */
export function whatIf(exposure, bound) {
  const e = Number(exposure), b = Number(bound);
  if (!Number.isFinite(e) || !Number.isFinite(b) || e < 0 || b < 0) return { ratio: null, band: "unknown", headroom: null };
  const ratio = b > 0 ? e / b : e > 0 ? Infinity : null;
  return { ratio, band: band(ratio), headroom: Math.max(0, b - e) };
}

/** fee × quote-side reserve: on a single full-range position the bound is about this at every rung. `fee` in pips (3000 = 0.3 %). */
export function capacityLine(feePips, quoteReserve) {
  return (Number(feePips) / 1e6) * Number(quoteReserve);
}

/**
 * The quote-side reserve of one full-range position, in whole quote units: L ÷ √P when the quote is currency0,
 * L × √P when it is currency1 (√P = sqrtPriceX96 ÷ 2^96, in raw currency1 per raw currency0).
 */
export function quoteReserve(liquidity, sqrtPriceX96, quoteIsCurrency0, quoteDecimals) {
  const L = Number(liquidity), s = Number(sqrtPriceX96) / 2 ** 96;
  if (!(L > 0) || !(s > 0)) return 0;
  return (quoteIsCurrency0 ? L / s : L * s) / 10 ** quoteDecimals;
}

/** PoolManager slot0 as extsload returns it: sqrtPriceX96 in the low 160 bits, then the signed 24-bit tick. */
export function unpackSlot0(word) {
  const v = BigInt(word);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  return { sqrtPriceX96, tick };
}

/** The bound at one ladder width from maxSafeFromQuotes's rungs: the cheaper of the two directions. */
export function boundAtRung(rungs, ticks) {
  let best = null;
  for (const r of rungs) if (r.ticks === ticks && (best == null || r.exposure < best)) best = r.exposure;
  return best;
}

/** The venue's expiries sit on a `step`-second grid: the first grid point strictly after `nowSec`. */
export function nextExpiry(nowSec, step = 900) {
  const n = Math.floor(Number(nowSec));
  return (Math.floor(n / step) + 1) * step;
}

/** USDG for a table cell: whole units from 100 up, two decimals from 0.01 up, otherwise one significant digit; "—" for nothing. */
export function fmtUsdg(x) {
  if (x == null || !Number.isFinite(Number(x))) return "—";
  const v = Number(x);
  if (v === 0) return "0";
  if (v < 0) return "−" + fmtUsdg(-v);
  if (v >= 100) return Math.floor(v).toLocaleString("en-US");
  if (v >= 0.01) return (Math.floor(v * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v.toExponential(1);
}

/** A ratio for the board: "0.38×", three decimals under 0.1, "∞" when the bound is 0. */
export function fmtRatio(r) {
  if (r == null || Number.isNaN(r)) return "—";
  if (!Number.isFinite(r)) return "∞";
  return `${r.toLocaleString("en-US", { minimumFractionDigits: r < 0.1 ? 3 : 2, maximumFractionDigits: r < 0.1 ? 3 : 2 })}×`;
}
