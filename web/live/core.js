// The live board's pure pieces: no DOM, no network. The page (web/live/app.js) and the gauge's baseline script
// (gauge/src/live-baseline.ts) both import this file, and gauge/test/live-core.test.ts pins it to the gauge's mirror of
// CostModel.maxSafeExposure, which test/fixtures/walk.json pins to the Solidity.

/** CostModel.ladder(): 50 to 1,823 ticks, +0.5 to +20 % up, −0.5 to −16.7 % down. */
export const LADDER = [50, 100, 200, 488, 953, 1823];
/** SafeSettle.MAX_WALK_STEPS, shared by the six widths of one walk. */
export const MAX_WALK_STEPS = 256;

/** What a payout moves per unit of exposure when the asset moves x ticks: up 1.0001^x − 1, down 1 − 1.0001^−x. */
export const gainPerUnit = (x, assetUp) => (assetUp ? Math.pow(1.0001, x) - 1 : 1 - Math.pow(1.0001, -x));

/**
 * CostModel.maxSafeExposure with nobody pushing back (arbReversionSeconds = 0: a stock token while the mint window is
 * closed), from PushCostLens.roundTripCosts(key, LADDER, up, MAX_WALK_STEPS) run once per tick direction. walkUp /
 * walkDown are that call's decoded result, [costInCurrency0[], costInCurrency1[], complete[]]. For every ladder move,
 * both ways: the round trip in the quote ÷ what the move earns per unit of exposure; the smallest is the bound, in the
 * quote's raw units. `complete` false means the walk hit its step cap, so the bound is "at least this".
 * Same function as web/app.js's, which gauge/test/web-max-safe.test.ts checks.
 */
export function maxSafeFromQuotes(walkUp, walkDown, ticks, quoteIsCurrency0) {
  let binding;
  const rungs = [];
  ticks.forEach((x, i) => {
    for (const up of [true, false]) {
      const [in0, in1, ok] = up ? walkUp : walkDown;
      // the payout follows the asset; with the quote as currency0 the asset moves against the tick
      const assetUp = quoteIsCurrency0 ? !up : up;
      const cost = BigInt(quoteIsCurrency0 ? in0[i] : in1[i]);
      const gain = gainPerUnit(x, assetUp);
      const r = { ticks: x, up, assetUp, cost, gain, exposure: Number(cost) / gain, complete: Boolean(ok[i]) };
      rungs.push(r);
      if (!binding || r.exposure < binding.exposure) binding = r;
    }
  });
  return { exposure: binding.exposure, binding, rungs };
}

/** v4 price → USDG per stock token, from sqrtPriceX96 and the two decimals. */
export function priceInQuote(sqrtPriceX96, decimals0, decimals1, quoteIsCurrency0) {
  const raw = Number(sqrtPriceX96) / 2 ** 96;
  const p1per0 = raw * raw * 10 ** (decimals0 - decimals1);
  return quoteIsCurrency0 ? 1 / p1per0 : p1per0;
}

/** Robinhood's stock-token mint/redeem window is closed Sat 02:00 → Mon 02:00 Europe/Berlin (gauge/src/mint-window.ts). */
export function mintWindowClosed(at) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", weekday: "short", hour: "numeric", hour12: false }).formatToParts(at);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday").value);
  const hour = Number(parts.find((p) => p.type === "hour").value) % 24;
  return (day === 6 && hour >= 2) || day === 0 || (day === 1 && hour < 2);
}

/** When the window next changes state after `at` (it only changes on the hour, Berlin time): the first such hour. */
export function nextMintChange(at) {
  const closed = mintWindowClosed(at);
  const t = new Date(at);
  t.setUTCMinutes(0, 0, 0);
  for (let h = 1; h <= 24 * 8; h++) {
    const probe = new Date(t.getTime() + h * 3600_000);
    if (mintWindowClosed(probe) !== closed) return { closed, at: probe };
  }
  return { closed, at: null };
}

/** The latest US close (Friday 20:00 UTC, 16:00 ET in summer time) at or before `at`, as YYYY-MM-DD. */
export function latestFriday(at) {
  const d = new Date(at);
  for (let back = 0; back < 8; back++) {
    const f = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back, 20));
    if (f.getUTCDay() === 5 && f.getTime() <= d.getTime()) return f.toISOString().slice(0, 10);
  }
  throw new Error("no Friday in the last week");
}

/**
 * How a pool stands against Friday's close, by the ratio of its max safe exposure now to Friday's. On 2026-08-30 HIMS
 * reached 0.006× by this measure; on the weekend of 2026-09-18 every pool with a Friday point stayed between 0.69× and
 * 2.37×. The thresholds only sort the board: the numbers are the answer.
 */
export function standing(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return "unknown";
  if (ratio < 0.1) return "collapsed";
  if (ratio < 0.5) return "thinning";
  return "holding";
}
