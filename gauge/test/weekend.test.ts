import { test } from "node:test";
import assert from "node:assert/strict";
import { weekendPoints } from "../src/weekend.ts";
import { mintWindowClosedAt } from "../src/mint-window.ts";
import { pushCostInQuote } from "../src/replay.ts";
import { getSqrtPriceAtTick, poolStateFromPositions } from "../src/v4math.ts";

test("weekend points run Friday's US close to Monday and straddle the mint reopen", () => {
  const pts = weekendPoints("2026-09-18");
  assert.equal(pts[0].toISOString(), "2026-09-18T20:00:00.000Z");
  assert.equal(pts.at(-1)!.toISOString(), "2026-09-21T20:00:00.000Z");
  assert.ok(pts.some((d) => mintWindowClosedAt(d)), "some points fall in the closed window");
  assert.ok(pts.some((d) => d.toISOString() === "2026-09-20T23:45:00.000Z"), "15 min before the reopen");
  assert.throws(() => weekendPoints("2026-09-19"), /not a Friday/);
});

test("pushing the stock up costs the same whichever side of the pool USDG is on", () => {
  // the same book, mirrored: stock/USDG with the stock as currency0, and USDG/stock with USDG as currency0
  const positions = [{ tickLower: -6000, tickUpper: 6000, liquidity: 10n ** 18n }];
  const a = poolStateFromPositions(positions, getSqrtPriceAtTick(0));
  const b = poolStateFromPositions(positions.map((p) => ({ tickLower: -p.tickUpper, tickUpper: -p.tickLower, liquidity: p.liquidity })), getSqrtPriceAtTick(0));
  const up0 = pushCostInQuote(a, 953, true, false, 3000); // quote is currency1: stock up = v4 price up
  const up1 = pushCostInQuote(b, 953, true, true, 3000); // quote is currency0: stock up = v4 price down
  const close = (x: bigint, y: bigint) => (x > y ? x - y : y - x) <= 4n;
  assert.ok(close(up0.costQuote, up1.costQuote), `${up0.costQuote} vs ${up1.costQuote}`);
  assert.ok(close(up0.capitalQuote, up1.capitalQuote));
});
