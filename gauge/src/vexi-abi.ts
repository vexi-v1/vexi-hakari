// The Vexi venue on testnet 46630, in our own words: only the events and functions the gauge reads, re-declared from
// the deployed contracts' signatures. None of the venue's source is in this repo. What the chain confirms
// (test/vexi-abi.test.ts): every event's topic0 below is the hash the live logs carry; Minted and SeriesOpened show four
// topics live (three indexed fields), Fixed shows two; `series` came back as thirteen words by eth_call on 2026-09-26
// with the last one equal to the sStar in that id's Fixed log; `terms` as (900, 900, 2592000, 300); `poolOf` as a
// PoolKey and a flag. Burned has produced no log yet: its types hash to the live topic0, its indexing mirrors Minted's.
// Addresses live in data/vexi-markets.json, never here.
import { parseAbi, parseAbiItem } from "viem";
import { readFileSync } from "node:fs";

/** Events of the venue. Amounts are contracts in base wei (18 decimals); prices and strikes are WAD quote per base. */
export const vexiVenueEvents = {
  SeriesOpened: parseAbiItem(
    "event SeriesOpened(uint256 indexed id, address indexed base, address indexed quote, uint8 kind, uint256 strikeWad, uint64 expiry, address opener)",
  ),
  Minted: parseAbiItem("event Minted(uint256 indexed id, address indexed minter, address indexed to, uint256 contracts)"),
  Burned: parseAbiItem("event Burned(uint256 indexed id, address indexed burner, address indexed from, uint256 contracts)"),
  Fixed: parseAbiItem("event Fixed(uint256 indexed id, uint256 sStarWad, uint32 obsFrom, uint32 obsTo, uint16 nObs)"),
  FixedLate: parseAbiItem("event FixedLate(uint256 indexed id, uint256 sStarWad, uint32 fixedAt)"),
};

/** `kind` in SeriesOpened and `series`: 0 is a call, 1 a put (as the venue's public API labels its rows). */
export const SERIES_KIND = { call: 0, put: 1 } as const;

export const vexiVenueAbi = parseAbi([
  "struct VexiSeries { address base; address quote; uint8 kind; uint256 strikeWad; uint64 expiry; uint64 windowEnd; uint64 openedAt; address opener; uint256 escrowBase; uint256 escrowQuote; uint256 baseUnit; uint256 quoteUnit; uint256 sStarWad; }",
  "function series(uint256 id) view returns (VexiSeries)",
  "function totalSupply(uint256 id) view returns (uint256)",
  "function terms() view returns (uint64 stepSeconds, uint64 windowSeconds, uint64 maxTenorSeconds, uint64 fixWindowSeconds)",
]);

/** The spot leaf: which official-PoolManager pool prices a (base, quote) pair. */
export const vexiSpotLeafAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function poolOf(address base, address quote) view returns (PoolKey key, bool known)",
]);

export interface VexiMarket {
  symbol: string;
  base: `0x${string}`;
  decimals: number;
  pricingPoolId: `0x${string}`;
}

export interface VexiMarkets {
  chainId: number;
  venue: `0x${string}`;
  spotLeaf: `0x${string}`;
  deployBlock: number;
  lens: `0x${string}`;
  quote: { symbol: string; address: `0x${string}`; decimals: number };
  terms: { step: number; window: number; fixWindow: number };
  markets: VexiMarket[];
}

/** The hand-curated market file: the venue, its leaf, our lens, the quote token and the six markets. */
export function vexiMarkets(): VexiMarkets {
  return JSON.parse(readFileSync(new URL("../data/vexi-markets.json", import.meta.url), "utf8"));
}
