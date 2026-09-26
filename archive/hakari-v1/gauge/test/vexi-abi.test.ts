// The Vexi ABI of src/vexi-abi.ts against what the chain shows. Each event's topic0 is the hash the live 46630 logs
// carry, the indexed layout is the live topic count, and the tuples decode the words the deployed contracts returned by
// eth_call on 2026-09-26 (recorded here; the one word that is not an allow-listed address, a series opener, is zeroed).
// The market file carries only allow-listed addresses, and each pool id is keccak256(abi.encode(key)) of its own key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeEventTopics, keccak256, toEventSelector, zeroAddress } from "viem";
import { SERIES_KIND, vexiMarkets, vexiSpotLeafAbi, vexiVenueAbi, vexiVenueEvents } from "../src/vexi-abi.ts";

/** topic0 of each event as the live logs carry it (venue logs pulled 2026-09-26; Burned and FixedLate from the deployed signatures). */
const LIVE_TOPIC0 = {
  SeriesOpened: "0xee88bb48af1a7c8ed2b5fff2cf908f31d4c92c793f09435ed41d82ef3ebdac04",
  Minted: "0xeea463cdf54761f30159ac8e70945d6f7b091f6ad1b4ee6ef3fa3770f7667559",
  Burned: "0x8abc079b05f6edad56d2fd89bf20147caf385a3a180078b58089a4d4f08030c6",
  Fixed: "0x2dafb9d537c1392ab2f2a33aeb581a62b8da58324c4d0b7e24c6289cca3b425b",
  FixedLate: "0x921ed8f04d9d97e622fc736cc3a18bfc2b6c4b278fd0dc591485a193631ba0d8",
} as const;

/** Topic counts seen live: Minted and SeriesOpened four, Fixed two. Burned and FixedLate have no log yet. */
const LIVE_TOPIC_COUNT = { SeriesOpened: 4, Minted: 4, Fixed: 2 } as const;

const markets = vexiMarkets();
const AI = markets.markets.find((m) => m.symbol === "AI")!;
const PONS = markets.markets.find((m) => m.symbol === "PONS")!;
const USDG = markets.quote.address;

/** One live Fixed log (block 124141742): the first fix the venue made. */
const FIXED_LOG = {
  topics: [LIVE_TOPIC0.Fixed, "0xb60b8e67f079e8d393dc9b908d323eb866c76d34b35b66ba5b6bc354e0d2a198"] as [`0x${string}`, ...`0x${string}`[]],
  data:
    "0x00000000000000000000000000000000000000000000000000cf58638e17f627000000000000000000000000000000000000000000000000000000006ab68b3c000000000000000000000000000000000000000000000000000000006ab68c6a0000000000000000000000000000000000000000000000000000000000000005" as const,
};

/** `series(<the same id>)` as the venue returned it (thirteen words; the opener word zeroed). */
const SERIES_WORDS =
  "0x" +
  [
    "0000000000000000000000007ec15f39d9c307edbd07c730e87fb914e178b7b9",
    "00000000000000000000000009bb68fe50f37e02e6bba45bfe4d204ad479581a",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "00000000000000000000000000000000000000000000000000ced6c812d2c000",
    "000000000000000000000000000000000000000000000000000000006ab68c70",
    "000000000000000000000000000000000000000000000000000000006ab68ff4",
    "000000000000000000000000000000000000000000000000000000006ab687b1",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    "00000000000000000000000000000000000000000000000000000000000f4240",
    "00000000000000000000000000000000000000000000000000cf58638e17f627",
  ].join("");

/** `terms()` as the venue returned it. */
const TERMS_WORDS =
  "0x" +
  [
    "0000000000000000000000000000000000000000000000000000000000000384",
    "0000000000000000000000000000000000000000000000000000000000000384",
    "0000000000000000000000000000000000000000000000000000000000278d00",
    "000000000000000000000000000000000000000000000000000000000000012c",
  ].join("");

/** `poolOf(PONS, USDG)` as the leaf returned it: a PoolKey and a flag. */
const POOL_OF_WORDS =
  "0x" +
  [
    "00000000000000000000000009bb68fe50f37e02e6bba45bfe4d204ad479581a",
    "0000000000000000000000009eda6980d539bcaaf03c4c953265894ceddc07e7",
    "0000000000000000000000000000000000000000000000000000000000000bb8",
    "000000000000000000000000000000000000000000000000000000000000003c",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000001",
  ].join("");

test("each re-declared event hashes to the topic0 the live logs carry", () => {
  for (const [name, hash] of Object.entries(LIVE_TOPIC0)) {
    assert.equal(toEventSelector(vexiVenueEvents[name as keyof typeof vexiVenueEvents]), hash, name);
  }
});

test("the indexed layout gives the topic counts seen live", () => {
  const topics = (name: keyof typeof vexiVenueEvents) => 1 + vexiVenueEvents[name].inputs.filter((i) => i.indexed).length;
  for (const [name, n] of Object.entries(LIVE_TOPIC_COUNT)) assert.equal(topics(name as keyof typeof LIVE_TOPIC_COUNT), n, name);
  assert.equal(topics("Burned"), topics("Minted"), "Burned mirrors Minted until a live log says otherwise");
  assert.equal(topics("FixedLate"), 2);
});

test("a live Fixed log decodes to sStar, the observation span and nObs", () => {
  const { eventName, args } = decodeEventLog({ abi: [vexiVenueEvents.Fixed], topics: FIXED_LOG.topics, data: FIXED_LOG.data });
  assert.equal(eventName, "Fixed");
  assert.equal(args.id, 0xb60b8e67f079e8d393dc9b908d323eb866c76d34b35b66ba5b6bc354e0d2a198n);
  assert.equal(args.sStarWad, 0xcf58638e17f627n);
  assert.equal(args.obsFrom, 0x6ab68b3c);
  assert.equal(args.obsTo, 0x6ab68c6a);
  assert.equal(args.obsTo - args.obsFrom, 302, "a 300 s window plus block granularity");
  assert.equal(args.nObs, 5);
});

test("a Minted log has the live shape: four topics and one data word; SeriesOpened four topics and four words", () => {
  const minted = encodeEventTopics({ abi: [vexiVenueEvents.Minted], eventName: "Minted", args: { id: 7n, minter: markets.venue, to: markets.venue } });
  assert.equal(minted.length, 4);
  assert.equal(minted[0], LIVE_TOPIC0.Minted);
  const nonIndexed = (e: { inputs: readonly { indexed?: boolean }[] }) => e.inputs.filter((i) => !i.indexed).length;
  assert.equal(nonIndexed(vexiVenueEvents.Minted), 1, "one word of data (66 hex chars live)");
  assert.equal(nonIndexed(vexiVenueEvents.SeriesOpened), 4, "four words of data (258 hex chars live)");
  assert.equal(nonIndexed(vexiVenueEvents.Fixed), 4);
  const opened = encodeEventTopics({ abi: [vexiVenueEvents.SeriesOpened], eventName: "SeriesOpened", args: { id: 7n, base: AI.base, quote: USDG } });
  assert.equal(opened.length, 4);
  assert.equal(opened[0], LIVE_TOPIC0.SeriesOpened);
  const data = encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }, { type: "uint64" }, { type: "address" }], [SERIES_KIND.put, 10n ** 18n, 1790353800n, zeroAddress]);
  const { args } = decodeEventLog({ abi: [vexiVenueEvents.SeriesOpened], topics: opened, data });
  assert.equal(args.kind, SERIES_KIND.put);
  assert.equal(args.strikeWad, 10n ** 18n);
  assert.equal(args.expiry, 1790353800n);
  assert.equal(args.base.toLowerCase(), AI.base);
});

test("series() decodes the thirteen words the venue returned, in this order", () => {
  const s = decodeFunctionResult({ abi: vexiVenueAbi, functionName: "series", data: SERIES_WORDS as `0x${string}` });
  assert.equal(s.base.toLowerCase(), AI.base);
  assert.equal(s.quote.toLowerCase(), USDG);
  assert.equal(s.kind, SERIES_KIND.call);
  assert.equal(s.strikeWad, 58_220_000_000_000_000n, "0.05822 USDG per AI");
  assert.equal(s.expiry, 0x6ab68c70n);
  assert.equal(s.windowEnd - s.expiry, 900n, "the exercise window is terms.window after expiry");
  assert.equal(s.openedAt, 0x6ab687b1n);
  assert.equal(s.opener, zeroAddress, "zeroed in the fixture");
  assert.equal(s.escrowBase, 0n);
  assert.equal(s.escrowQuote, 0n);
  assert.equal(s.baseUnit, 10n ** 18n);
  assert.equal(s.quoteUnit, 10n ** 6n);
  const fixed = decodeEventLog({ abi: [vexiVenueEvents.Fixed], topics: FIXED_LOG.topics, data: FIXED_LOG.data });
  assert.equal(s.sStarWad, fixed.args.sStarWad, "the stored sStar is the one the Fixed log announced for this id");
});

test("terms() decodes to (step, window, maxTenor, fixWindow) and matches the market file", () => {
  const [step, window, maxTenor, fixWindow] = decodeFunctionResult({ abi: vexiVenueAbi, functionName: "terms", data: TERMS_WORDS as `0x${string}` });
  assert.deepEqual([step, window, maxTenor, fixWindow], [900n, 900n, 2_592_000n, 300n]);
  assert.deepEqual(markets.terms, { step: Number(step), window: Number(window), fixWindow: Number(fixWindow) });
});

test("poolOf() decodes the leaf's PoolKey and flag: PONS is priced by a hookless 0.3 % pool with USDG as currency0", () => {
  const [key, known] = decodeFunctionResult({ abi: vexiSpotLeafAbi, functionName: "poolOf", data: POOL_OF_WORDS as `0x${string}` });
  assert.equal(known, true);
  assert.equal(key.currency0.toLowerCase(), USDG);
  assert.equal(key.currency1.toLowerCase(), PONS.base);
  assert.equal(key.fee, 3000);
  assert.equal(key.tickSpacing, 60);
  assert.equal(key.hooks, zeroAddress);
});

test("the market file carries only allow-listed addresses, lower-case, and its pool ids hash from its own keys", () => {
  assert.equal(markets.chainId, 46630);
  assert.deepEqual(
    markets.markets.map((m) => m.symbol),
    ["AI", "PONS", "MEME", "NVDA", "MU", "TSLA"],
  );
  const allowed = new Set<string>([markets.venue, markets.spotLeaf, markets.lens, USDG, ...markets.markets.flatMap((m) => [m.base, m.pricingPoolId])]);
  const hexStrings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/0x[0-9a-fA-F]+/g)) hexStrings.push(m[0]);
    } else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(markets);
  assert.ok(hexStrings.length >= 16, "venue, leaf, lens, quote, six bases, six pool ids");
  for (const h of hexStrings) {
    assert.equal(h, h.toLowerCase(), `${h} is lower-case`);
    assert.ok(allowed.has(h), `${h} is on the allow-list`);
  }
  for (const m of markets.markets) {
    assert.equal(m.decimals, 18);
    const quoteIsCurrency0 = BigInt(USDG) < BigInt(m.base);
    assert.equal(quoteIsCurrency0, m.symbol !== "MU", `${m.symbol}: only MU has its base as currency0`);
    const [c0, c1] = quoteIsCurrency0 ? [USDG, m.base] : [m.base, USDG];
    const id = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [c0, c1, 3000, 60, zeroAddress]),
    );
    assert.equal(id, m.pricingPoolId, `${m.symbol}: pricingPoolId is keccak256(abi.encode(key))`);
  }
});
