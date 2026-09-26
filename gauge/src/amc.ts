// A second case: AMC's stock token over two weekends, rebuilt from Robinhood Chain's logs, to answer "was HIMS a
// one-off?" with the chain rather than with the X posts that raised it.
//
//  1. 2026-08-28..31, the HIMS weekend. X posts said AMC's token "printed $166 against a $2.59 stock". AMC had no USDG
//     pool until Sunday afternoon; its deepest pool was ETH/AMC (5 % fee, no hook). Prices are converted to USD through
//     an ETH/USDG pool's own swaps.
//  2. 2026-09-04..08, Labor Day weekend (NYSE shut Monday). An X post (Fri 2026-09-04 22:27 UTC) said the market maker
//     had minted about $1M of AMC as "buffer supply for the long weekend". AMC's main venue by then was a 0.1 % AMC/USDG
//     pool.
//
// For each weekend, on a 10-minute grid from Friday 18:00 UTC to the Monday or Tuesday NYSE open: each pool rebuilt from
// its ModifyLiquidity logs at the last Swap at or before the grid block (replay.ts; the rebuilt active liquidity is
// checked against that Swap's own), its price, the AMC it holds (curve principal) and HAKARI's max safe exposure with
// nobody pushing back (replay.ts maxSafeExposure, pinned to CostModel). AMC's supply comes from mint/burn Transfers,
// seeded and checked to the wei against totalSupply() on the archive node.
//   npm run amc
// Writes data/amc-weekends.json. Read-only against 4663.
import { decodeFunctionResult, encodeFunctionData, parseAbi, parseAbiItem } from "viem";
import { run, readCache, writeCache, writeData } from "./chain.ts";
import { mintWindowClosedAt } from "./mint-window.ts";
import { lastSwapBefore, maxSafeExposure, modifyLiquidityLogs, rebuild, type RawLog } from "./replay.ts";
import { swapLogs } from "./reversion.ts";
import { archiveCalls, blockTimestamps, logsClient } from "./squeeze/common.ts";
import { amount0Of, amount1Of } from "./v4math.ts";

const cacheDir = new URL("../cache/amc/", import.meta.url).pathname;
export const AMC = "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b" as const; // 18 decimals (decimals(), symbol() = "AMC")
const ZERO = "0x0000000000000000000000000000000000000000";

interface Pool { name: string; id: `0x${string}`; initBlock: bigint; amcIs0: boolean; quote: "ETH" | "USDG"; quoteIsCurrency0: boolean; quoteDecimals: number; note: string }
/**
 * Found from every Initialize with AMC as currency0 or currency1 (2,152 pools by 2026-09-26, most of them launchpad
 * pairs), ranked by swaps inside each weekend. Keys: ETH/AMC (ETH, AMC, 50000, 500, no hook); AMC/USDG 0.1 % (AMC, USDG,
 * 1000, 10, no hook).
 */
export const POOLS: Record<string, Pool> = {
  ethAmc: { name: "ETH/AMC", id: "0x0b0d11e649641178fdc29a69af6161e6194c24b99cd62a164062be1e8e348d4f", initBlock: 35_470_675n, amcIs0: false, quote: "ETH", quoteIsCurrency0: true, quoteDecimals: 18, note: "the most-traded AMC pool of 2026-08-28..31 (22,482 swaps); 5 % fee, no hook" },
  amcUsdg: { name: "AMC/USDG 0.1 %", id: "0x7499938c352d5b5b8f0c648722aca5ee964ef9b85c3a3041f1ec379726291d9d", initBlock: 53_983_886n, amcIs0: true, quote: "USDG", quoteIsCurrency0: false, quoteDecimals: 6, note: "the most-traded AMC/USDG pool of 2026-09-04..08 (81,280 swaps); 0.1 % fee, no hook" },
};
/** ETH/USDG price reference: the two busiest ETH/USDG v4 pools in 2026-08-30 (hooked, dynamic fee; used for price only). */
export const ETH_USDG = [
  "0xa56fb19320d83308654e2ae5aa19bc2b6f8890e4fb1c7ef3082a645ea4924eab",
  "0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551",
] as const;

export const WEEKENDS = [
  { key: "hims-weekend", label: "2026-08-28..31 (the HIMS weekend)", start: "2026-08-28T18:00:00Z", fridayClose: "2026-08-28T20:00:00Z", end: "2026-08-31T14:00:00Z", pools: ["ethAmc"] },
  { key: "labor-day", label: "2026-09-04..08 (Labor Day, NYSE shut Monday)", start: "2026-09-04T18:00:00Z", fridayClose: "2026-09-04T20:00:00Z", end: "2026-09-08T14:00:00Z", pools: ["amcUsdg", "ethAmc"] },
] as const;
const STEP = 600;

const usdgPerEth = (sqrtPriceX96: bigint) => { const r = Number(sqrtPriceX96) / 2 ** 96; return r * r * 1e12; }; // ETH (18) / USDG (6)
/** Price of AMC in the pool's quote, from sqrtPriceX96 (both AMC pools have 18-decimal AMC). */
function amcInQuote(p: Pool, sqrtPriceX96: bigint) {
  const r = Number(sqrtPriceX96) / 2 ** 96, raw = r * r;
  // raw = currency1 per currency0 in base units
  return p.amcIs0 ? raw * 10 ** (18 - p.quoteDecimals) : 1 / (raw * 10 ** (p.quoteDecimals - 18));
}

/**
 * The last block whose timestamp is <= t, for each t in ascending order: a guess from the previous answer at ~9.89
 * blocks/s, then one batch of 61 headers around it, re-centred until the block and the next one bracket t.
 */
export async function lastBlocksAtOrBefore(targets: number[], anchor: { block: number; ts: number }) {
  const out = new Map<number, number>();
  let prev = anchor;
  for (const t of targets) {
    let g = prev.block + Math.round((t - prev.ts) * 9.89);
    for (let k = 0; ; k++) {
      if (k > 12) throw new Error(`no bracket for ${t}`);
      const around = Array.from({ length: 61 }, (_, i) => g - 30 + i);
      const ts = await blockTimestamps(around);
      const tsOf = (b: number) => ts.get(String(b))!;
      if (tsOf(around[0]) > t) { g -= 30 + Math.max(0, Math.round((tsOf(around[0]) - t) * 9.89)); continue; }
      if (tsOf(around.at(-1)!) <= t) { g += 30 + Math.max(0, Math.round((t - tsOf(around.at(-1)!)) * 9.89)); continue; }
      const b = around.filter((x) => tsOf(x) <= t).at(-1)!;
      out.set(t, b);
      prev = { block: b, ts: tsOf(b) };
      break;
    }
  }
  return out;
}

const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
/** AMC mints and burns in [from, to], from the public RPC (topic-filtered, so the whole range is a few queries). */
async function mintsAndBurns(from: bigint, to: bigint) {
  const file = `${cacheDir}amc-mint-burn-${from}-${to}.json`;
  const cached = readCache(file) as any[] | undefined;
  if (cached) return cached;
  const c = logsClient();
  const out: any[] = [];
  for (const args of [{ from: ZERO }, { to: ZERO }]) {
    const logs = await c.getLogs({ address: AMC, event: transfer, args: args as any, fromBlock: from, toBlock: to });
    for (const l of logs as any[]) out.push({ block: Number(l.blockNumber), logIndex: l.logIndex, tx: l.transactionHash, from: l.args.from.toLowerCase(), to: l.args.to.toLowerCase(), value: l.args.value.toString() });
  }
  out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  writeCache(file, out);
  return out;
}

const erc20 = parseAbi(["function totalSupply() view returns (uint256)"]);
async function totalSupplyAt(blocks: number[]) {
  const data = encodeFunctionData({ abi: erc20, functionName: "totalSupply" });
  const res = await archiveCalls(blocks.map((b) => ({ to: AMC, data, block: b })));
  return res.map((r) => decodeFunctionResult({ abi: erc20, functionName: "totalSupply", data: r as `0x${string}` }) as bigint);
}

/** The swap tape of one pool over a window, with the last swap before it as a seed. */
async function tape(poolId: `0x${string}`, from: bigint, to: bigint) {
  const swaps = await swapLogs(poolId, from, to, `${cacheDir}swaps-${poolId.slice(0, 10)}-${from}-${to}.json`);
  const client = (await import("./chain.ts")).mainnet();
  const seed = await lastSwapBefore(client, poolId, from - 1n, cacheDir);
  return seed ? [seed, ...swaps] : swaps;
}
const lastAtOrBefore = (t: RawLog[], block: number) => {
  let lo = 0, hi = t.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (Number(t[mid].blockNumber) <= block) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans < 0 ? undefined : t[ans];
};

export async function main() {
  const client = (await import("./chain.ts")).mainnet();
  const out: any = { generatedAt: new Date().toISOString(), token: AMC, pools: POOLS, ethUsdgReference: ETH_USDG, weekends: [] as any[] };
  // anchor for the block search: the squeeze's pinned grid start, 2026-08-28 18:00 UTC = block 48,495,768 or earlier
  const anchor = { block: 48_495_759, ts: 1_787_940_000 };
  for (const w of WEEKENDS) {
    const t0 = Date.parse(w.start) / 1000, t1 = Date.parse(w.end) / 1000;
    const times: number[] = [];
    for (let t = t0; t <= t1; t += STEP) times.push(t);
    const blocksFile = `${cacheDir}grid-${w.key}.json`;
    let grid = readCache(blocksFile) as Record<string, number> | undefined;
    // the HIMS weekend's 10-minute grid is the squeeze dataset's, already pinned and checked (npm run squeeze)
    const squeezeGrid = readCache(new URL("../cache/squeeze/grid-blocks.json", import.meta.url).pathname) as Record<string, number> | undefined;
    if (!grid && squeezeGrid && times.every((t) => squeezeGrid[String(t)] !== undefined)) grid = Object.fromEntries(times.map((t) => [String(t), squeezeGrid[String(t)]]));
    if (!grid) {
      const m = await lastBlocksAtOrBefore(times, anchor);
      grid = Object.fromEntries([...m].map(([t, b]) => [String(t), b]));
      writeCache(blocksFile, grid);
    }
    const blocks = times.map((t) => grid![String(t)]);
    const [fromB, toB] = [BigInt(blocks[0]), BigInt(blocks.at(-1)!)];
    console.log(`${w.label}: ${times.length} grid points, blocks ${fromB}–${toB}`);

    // ETH/USD from the two reference pools' own swaps
    const ethTapes = await Promise.all(ETH_USDG.map((id) => tape(id, fromB, toB)));
    const ethUsd = (block: number) => {
      const quotes = ethTapes.map((t) => lastAtOrBefore(t, block)).filter(Boolean).map((s) => usdgPerEth(BigInt(s!.args.sqrtPriceX96)));
      return { usd: quotes[0], spread: quotes.length > 1 ? Math.abs(quotes[0] / quotes[1] - 1) : null };
    };

    const series: Record<string, any[]> = {};
    const peaks: Record<string, any> = {};
    for (const key of w.pools) {
      const p = POOLS[key];
      const mods = await modifyLiquidityLogs(client, p.id, p.initBlock, toB, `${cacheDir}mods-${p.id.slice(0, 10)}-${toB}.json`);
      const swaps = await tape(p.id, fromB, toB);
      const rows = [] as any[];
      times.forEach((t, k) => {
        const block = blocks[k];
        const last = lastAtOrBefore(swaps, block);
        if (!last || BigInt(last.blockNumber) < p.initBlock) return rows.push({ t: new Date(t * 1000).toISOString(), block, missing: "no swap yet" });
        const { state, positions, liquidityMatches } = rebuild(mods, last, BigInt(block));
        const fee = Number(last.args.fee);
        const b = maxSafeExposure(state, p.quoteIsCurrency0, fee);
        const amc = positions.reduce((s, q) => s + (p.amcIs0 ? amount0Of(q, state.sqrtPriceX96) : amount1Of(q, state.sqrtPriceX96)), 0n);
        const e = ethUsd(block);
        const usdPerQuote = p.quote === "USDG" ? 1 : e.usd;
        const px = amcInQuote(p, state.sqrtPriceX96);
        rows.push({
          t: new Date(t * 1000).toISOString(), block, mintWindowClosed: mintWindowClosedAt(new Date(t * 1000)),
          priceQuote: px, priceUsd: px * usdPerQuote, ethUsd: e.usd, ethRefSpread: e.spread,
          maxSafeQuote: b.exposure / 10 ** p.quoteDecimals, maxSafeUsd: (b.exposure / 10 ** p.quoteDecimals) * usdPerQuote, bindingTicks: b.ticks, bindingStockUp: b.stockUp,
          amcInPool: Number(amc) / 1e18, livePositions: positions.length, liquidityMatches, swapFeePips: fee,
        });
      });
      series[key] = rows;
      // the highest price any swap in the window left the pool at, while liquidity stayed in range
      let top: RawLog | undefined;
      for (const s of swaps) {
        const b = Number(s.blockNumber);
        if (b < blocks[0] || b > blocks.at(-1)! || BigInt(s.args.liquidity) === 0n) continue;
        if (!top || amcInQuote(p, BigInt(s.args.sqrtPriceX96)) > amcInQuote(p, BigInt(top.args.sqrtPriceX96))) top = s;
      }
      if (top) {
        const tb = Number(top.blockNumber);
        const ts = (await blockTimestamps([tb])).get(String(tb))!;
        const e = ethUsd(tb);
        const px = amcInQuote(p, BigInt(top.args.sqrtPriceX96));
        // what the swap itself paid on average, to tell a traded price from a one-swap run into an empty range
        const a0 = BigInt(top.args.amount0), a1 = BigInt(top.args.amount1);
        const abs = (x: bigint) => (x < 0n ? -x : x);
        const amcAmt = Number(abs(p.amcIs0 ? a0 : a1)) / 1e18, quoteAmt = Number(abs(p.amcIs0 ? a1 : a0)) / 10 ** p.quoteDecimals;
        peaks[key] = { block: tb, time: new Date(ts * 1000).toISOString(), tx: top.transactionHash, priceQuote: px, priceUsd: px * (p.quote === "USDG" ? 1 : e.usd), ethUsd: e.usd, ethRefSpread: e.spread, swapAvgPriceQuote: amcAmt ? quoteAmt / amcAmt : null, swapAmc: amcAmt, swapQuote: quoteAmt };
      }
      const ok = rows.filter((r) => !r.missing);
      const fri = ok.find((r) => r.t === new Date(w.fridayClose).toISOString());
      const closed = ok.filter((r) => r.mintWindowClosed);
      const low = closed.reduce((m: any, r: any) => (!m || r.maxSafeUsd < m.maxSafeUsd ? r : m), undefined);
      const hi = ok.reduce((m: any, r: any) => (!m || r.priceUsd > m.priceUsd ? r : m), undefined);
      console.log(`  ${p.name.padEnd(15)} ${mods.length} ModifyLiquidity, ${swaps.length} swaps; Fri ${fri?.priceUsd?.toFixed(3)} USD, max safe ${fri?.maxSafeUsd?.toFixed(0)} USD → closed-window low ${low?.maxSafeUsd?.toFixed(0)} USD at ${low?.t}; grid high ${hi?.priceUsd?.toFixed(2)} USD at ${hi?.t}; peak swap ${peaks[key]?.priceUsd?.toFixed(2)} USD at ${peaks[key]?.time}; rebuild = chain ${ok.every((r) => r.liquidityMatches) ? "yes" : "NO"}`);
    }

    // AMC supply: seeded at the grid start, folded from mints and burns, checked against totalSupply() at 12 grid points
    const moves = await mintsAndBurns(fromB, toB);
    const [seed] = await totalSupplyAt([blocks[0]]);
    let supply = seed;
    let j = 0;
    const supplyRows = blocks.map((b, k) => {
      while (j < moves.length && moves[j].block <= b) {
        if (moves[j].block > blocks[0]) supply += moves[j].from === ZERO ? BigInt(moves[j].value) : -BigInt(moves[j].value);
        j++;
      }
      return { t: new Date(times[k] * 1000).toISOString(), block: b, supply: supply.toString() };
    });
    const checkIdx = Array.from({ length: 12 }, (_, i) => Math.round((i * (blocks.length - 1)) / 11));
    const onchain = await totalSupplyAt(checkIdx.map((i) => blocks[i]));
    const supplyCheck = checkIdx.map((i, n) => ({ block: blocks[i], onchain: onchain[n].toString(), rebuilt: supplyRows[i].supply, equal: onchain[n].toString() === supplyRows[i].supply }));
    const mintTs = await blockTimestamps(moves.map((m) => m.block));
    const events = moves.filter((m) => m.block > blocks[0]).map((m) => ({ ...m, time: new Date(mintTs.get(String(m.block))! * 1000).toISOString(), amc: Number(BigInt(m.value)) / 1e18, kind: m.from === ZERO ? "mint" : "burn" }));
    console.log(`  supply ${Number(seed) / 1e18} → ${Number(supply) / 1e18} AMC; ${events.filter((e) => e.kind === "mint").length} mints, ${events.filter((e) => e.kind === "burn").length} burns; totalSupply check ${supplyCheck.filter((c) => c.equal).length}/${supplyCheck.length} exact`);
    // The calendar rule (mint-window.ts) is secondary data and knows no holidays. What the chain shows: the first mint or
    // burn after the rule closes the window (Saturday 00:00 UTC). Lows are taken over that observed gap too.
    const ruleCloses = Date.parse(w.fridayClose) / 1000 + 4 * 3600;
    const firstAfter = events.find((e) => Date.parse(e.time) / 1000 >= ruleCloses);
    const gapEnd = firstAfter ? Date.parse(firstAfter.time) : Date.parse(w.end);
    const summary: Record<string, any> = {};
    for (const [key, rows] of Object.entries(series)) {
      const ok = rows.filter((r: any) => !r.missing);
      const fri = ok.find((r: any) => r.t === new Date(w.fridayClose).toISOString());
      const inGap = ok.filter((r: any) => Date.parse(r.t) >= ruleCloses * 1000 && Date.parse(r.t) < gapEnd);
      const low = inGap.reduce((m: any, r: any) => (!m || r.maxSafeUsd < m.maxSafeUsd ? r : m), undefined);
      const high = inGap.reduce((m: any, r: any) => (!m || r.priceUsd > m.priceUsd ? r : m), undefined);
      const up = inGap.filter((r: any) => r.bindingStockUp).length;
      summary[key] = {
        friday: fri && { t: fri.t, priceUsd: fri.priceUsd, maxSafeUsd: fri.maxSafeUsd, amcInPool: fri.amcInPool },
        gapLow: low && { t: low.t, maxSafeUsd: low.maxSafeUsd, overFriday: fri ? low.maxSafeUsd / fri.maxSafeUsd : null, priceUsd: low.priceUsd, bindingTicks: low.bindingTicks, bindingStockUp: low.bindingStockUp },
        gapPriceHigh: high && { t: high.t, priceUsd: high.priceUsd, overFriday: fri ? high.priceUsd / fri.priceUsd : null },
        gapBindingUpShare: inGap.length ? up / inGap.length : null,
        gapPoints: inGap.length,
        allLiquidityMatches: ok.every((r: any) => r.liquidityMatches),
      };
      console.log(`  ${POOLS[key].name}: over the observed gap (to ${new Date(gapEnd).toISOString()}), max safe ${fri?.maxSafeUsd.toFixed(0)} → ${low?.maxSafeUsd.toFixed(0)} USD (×${(low.maxSafeUsd / fri.maxSafeUsd).toFixed(3)}), binding up in ${(100 * up / inGap.length).toFixed(0)} % of points`);
    }
    out.weekends.push({
      ...w, stepSeconds: STEP, observedMintGap: { from: new Date(ruleCloses * 1000).toISOString(), firstMintOrBurnAfter: firstAfter ?? null }, summary,
      series, peaks, supply: supplyRows.map((r) => ({ ...r, supplyAmc: Number(BigInt(r.supply)) / 1e18 })), supplyCheck, mintBurnEvents: events,
    });
  }

  // The two X claims about the Labor Day weekend, against the chain: AMC's supply at 0xSammy's snapshot (Fri 2026-09-04
  // 04:12 ET: "547k AMC ... 51.2 % of the 1.1M currently minted"), and every mint and burn of that Friday up to Kyle's
  // post (22:27:28 UTC: "the market maker minted $1 million AMC stock tokens as buffer supply for the long weekend").
  const claimTimes = [Date.parse("2026-09-04T00:00:00Z") / 1000, Date.parse("2026-09-04T08:12:00Z") / 1000, Date.parse("2026-09-04T22:27:28Z") / 1000];
  const claimFile = `${cacheDir}claim-blocks.json`;
  let cb = readCache(claimFile) as number[] | undefined;
  if (!cb) {
    const m = await lastBlocksAtOrBefore(claimTimes, anchor);
    cb = claimTimes.map((t) => m.get(t)!);
    writeCache(claimFile, cb);
  }
  const [midnight, sammy, kyle] = cb;
  const [supplyMidnight, supplySammy, supplyKyle] = await totalSupplyAt([midnight, sammy, kyle]);
  const friday = (await mintsAndBurns(BigInt(midnight) + 1n, BigInt(kyle))).map((m: any) => ({ ...m, amc: Number(BigInt(m.value)) / 1e18, kind: m.from === ZERO ? "mint" : "burn" }));
  const fridayTs = await blockTimestamps(friday.map((m: any) => m.block));
  const byAddress: Record<string, { minted: number; burned: number }> = {};
  for (const m of friday) {
    const who = m.kind === "mint" ? m.to : m.from;
    byAddress[who] ??= { minted: 0, burned: 0 };
    byAddress[who][m.kind === "mint" ? "minted" : "burned"] += m.amc;
  }
  const amcUsdgFri = out.weekends[1].summary.amcUsdg?.friday?.priceUsd;
  out.claims = {
    sammy: { block: sammy, time: "2026-09-04T08:12:00Z", totalSupplyAmc: Number(supplySammy) / 1e18, claim: "547k AMC in MEME/AMC, 51.2 % of the 1.1M currently minted" },
    kyle: {
      fromBlock: midnight + 1, toBlock: kyle, from: "2026-09-04T00:00:00Z", to: "2026-09-04T22:27:28Z",
      supplyAtMidnight: Number(supplyMidnight) / 1e18, supplyAtPost: Number(supplyKyle) / 1e18,
      byAddress, usdAtFridayClose: amcUsdgFri ?? null,
      events: friday.map((m: any) => ({ ...m, time: new Date(fridayTs.get(String(m.block))! * 1000).toISOString() })),
      claim: "the market maker minted $1 million AMC stock tokens as buffer supply for the long weekend",
    },
  };
  console.log(`claims: supply at 08:12 UTC ${Number(supplySammy) / 1e18} AMC; Friday 00:00 → 22:27 UTC:`, JSON.stringify(byAddress));
  writeData(new URL("../data/amc-weekends.json", import.meta.url).pathname, out);
  console.log("wrote data/amc-weekends.json");
}

if (import.meta.url === `file://${process.argv[1]}`) run(main);
