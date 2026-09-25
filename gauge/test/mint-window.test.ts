import { test } from "node:test";
import assert from "node:assert/strict";
import { mintWindowClosedAt } from "../src/mint-window.ts";

test("the HIMS weekend: Sunday 2026-08-30 19:40 UTC is inside the closed window", () => {
  assert.equal(mintWindowClosedAt(new Date("2026-08-30T19:40:00Z")), true);
});

test("the first Monday mint at 2026-08-31 00:43:30 UTC (02:43 CEST) is after the window reopens", () => {
  assert.equal(mintWindowClosedAt(new Date("2026-08-31T00:43:30Z")), false);
  assert.equal(mintWindowClosedAt(new Date("2026-08-30T23:59:00Z")), true, "one minute before 02:00 CEST is still closed");
});

test("Saturday 01:59 Berlin is open, 02:00 is closed", () => {
  // 2026-08-29 is a Saturday; CEST = UTC+2
  assert.equal(mintWindowClosedAt(new Date("2026-08-28T23:59:00Z")), false);
  assert.equal(mintWindowClosedAt(new Date("2026-08-29T00:00:00Z")), true);
});

test("a weekday is open", () => {
  assert.equal(mintWindowClosedAt(new Date("2026-09-25T12:00:00Z")), false);
});
