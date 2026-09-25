// One weekend, every stock pool: what it cost to push each Robinhood stock token's deepest USDG pool ±10 %
// from Friday's close through Monday, rebuilt from logs. Answers "was HIMS a one-off?".
//   npm run weekend -- 2026-09-18        (the Friday that starts the weekend; points after `now` are skipped)
// Reads data/stock-pools.json (npm run discover). Writes data/weekend-<friday>.json.
import { formatUnits } from "viem";
import { mainnet, withRetry, writeData, run } from "./chain.ts";
import { blockAtOrAfter, lastSwapBefore, maxSafeExposure, modifyLiquidityLogs, pushCostInQuote, rebuild } from "./replay.ts";
import { readCache, writeCache } from "./chain.ts";
import { mintWindowClosedAt } from "./mint-window.ts";
import { ticksForPct } from "./pools.ts";
import { readFileSync } from "node:fs";

const TOP_N = Number(process.env.WEEKEND_TOP_N ?? 10);
const cacheDir = new URL("../cache/weekend/", import.meta.url).pathname;

/** Friday 20:00 UTC (US close) to Monday 20:00 UTC, every 6 hours, plus the minutes around the mint reopen. */
export function weekendPoints(friday: string): Date[] {
  const f = new Date(`${friday}T20:00:00Z`);
  if (f.getUTCDay() !== 5) throw new Error(`${friday} is not a Friday`);
  const out: Date[] = [];
  for (let h = 0; h <= 72; h += 6) out.push(new Date(f.getTime() + h * 3600_000));
  // Monday 00:00 UTC is 02:00 Berlin in summer time: the mint window reopens; look just before and after
  const monday = new Date(f.getTime() + 52 * 3600_000); // Sun 24:00 UTC
  out.push(new Date(monday.getTime() - 15 * 60_000), new Date(monday.getTime() + 60 * 60_000));
  return out.sort((a, b) => a.getTime() - b.getTime());
}

export async function main() {
  const friday = process.argv[2];
  if (!friday) throw new Error("usage: npm run weekend -- <YYYY-MM-DD of the Friday>");
  const client = mainnet();
  const head = await client.getBlock();
  const all = JSON.parse(readFileSync(new URL("../data/stock-pools.json", import.meta.url), "utf8")).pools;
  // the deepest TOP_N, plus HIMS wherever it ranks: it is the case the story starts from
  const pools = all.slice(0, TOP_N);
  const hims = all.find((p: any) => p.symbol === "HIMS");
  if (hims && !pools.includes(hims)) pools.push(hims);
  const points = weekendPoints(friday).filter((d) => d.getTime() / 1000 <= Number(head.timestamp));
  console.log(`${points.length} points, ${pools.length} pools`);

  // one block lookup per point, shared by every pool
  const blockCache = `${cacheDir}blocks-${friday}.json`;
  const cachedBlocks = (readCache(blockCache) as { at: string; number: string; timestamp: number }[] | undefined) ?? [];
  const blocks: { at: Date; number: bigint; timestamp: number }[] = [];
  let lo = 1n;
  for (const at of points) {
    const hit = cachedBlocks.find((c) => c.at === at.toISOString());
    const b = hit ? { number: BigInt(hit.number), timestamp: hit.timestamp } : await blockAtOrAfter(client, Math.floor(at.getTime() / 1000), lo, head.number);
    blocks.push({ at, ...b });
    lo = b.number;
  }
  writeCache(blockCache, blocks.map((b) => ({ at: b.at.toISOString(), number: b.number.toString(), timestamp: b.timestamp })));
  const ticks10 = ticksForPct(10);
  const series = [] as any[];
  for (const p of pools) {
    const mods = await withRetry(`${p.symbol} ModifyLiquidity`, () =>
      modifyLiquidityLogs(client, p.id, BigInt(p.initBlock), blocks.at(-1)!.number, `${cacheDir}mods-${p.id.slice(0, 10)}-${blocks.at(-1)!.number}.json`),
    );
    const rows = [] as any[];
    for (const b of blocks) {
      const swap = await lastSwapBefore(client, p.id, b.number, cacheDir);
      if (!swap) {
        rows.push({ time: b.at.toISOString(), block: b.number.toString(), missing: "no swap yet" });
        continue;
      }
      const { state, positions, liquidityMatches } = rebuild(mods, swap, b.number);
      const fee = Number(swap.args.fee);
      const up = pushCostInQuote(state, ticks10, true, p.quoteIsCurrency0, fee);
      const down = pushCostInQuote(state, ticks10, false, p.quoteIsCurrency0, fee);
      const raw = Number(state.sqrtPriceX96) / 2 ** 96;
      const p1per0 = raw * raw * (p.quoteIsCurrency0 ? 1e-12 : 1e12);
      rows.push({
        time: b.at.toISOString(),
        block: b.number.toString(),
        mintWindowClosed: mintWindowClosedAt(b.at),
        priceUsdg: p.quoteIsCurrency0 ? 1 / p1per0 : p1per0,
        livePositions: positions.length,
        liquidityMatches,
        swapFeePips: fee,
        up10: { costUsdg: Number(formatUnits(up.costQuote, 6)), capitalUsdg: Number(formatUnits(up.capitalQuote, 6)), complete: up.complete },
        down10: { costUsdg: Number(formatUnits(down.costQuote, 6)), capitalUsdg: Number(formatUnits(down.capitalQuote, 6)), complete: down.complete },
        maxSafeExposureUsdg: maxSafeExposure(state, p.quoteIsCurrency0, fee).exposure / 1e6,
      });
    }
    const ok = rows.filter((r) => !r.missing);
    const fri = rows[0]?.missing ? undefined : rows[0]; // Friday's close only: a pool born mid-weekend has none
    const minClosed = ok.filter((r) => r.mintWindowClosed).reduce((m: any, r: any) => (!m || r.up10.costUsdg < m.up10.costUsdg ? r : m), undefined);
    const ratio = fri && minClosed ? minClosed.up10.costUsdg / fri.up10.costUsdg : null;
    const minSafeClosed = ok.filter((r) => r.mintWindowClosed).reduce((m: number, r: any) => Math.min(m, r.maxSafeExposureUsdg), Infinity);
    series.push({ symbol: p.symbol, id: p.id, fee: p.fee, modifyLiquidityLogs: mods.length, allLiquidityMatches: ok.every((r) => r.liquidityMatches), rows, fridayCostUp10: fri?.up10.costUsdg ?? null, weekendMinCostUp10: minClosed?.up10.costUsdg ?? null, weekendOverFriday: ratio, fridayMaxSafeExposure: fri?.maxSafeExposureUsdg ?? null, weekendMinMaxSafeExposure: Number.isFinite(minSafeClosed) ? minSafeClosed : null });
    console.log(p.symbol.padEnd(6), "Fri +10% cost", fri?.up10.costUsdg.toFixed(2), "→ weekend min", minClosed?.up10.costUsdg.toFixed(2), ratio !== null ? `(×${ratio.toFixed(3)})` : "", ok.every((r) => r.liquidityMatches) ? "" : "(LIQUIDITY MISMATCH)");
  }
  writeData(new URL(`../data/weekend-${friday}.json`, import.meta.url).pathname, {
    friday,
    generatedAt: new Date().toISOString(),
    method: "each pool rebuilt from its ModifyLiquidity logs at each point; price and reported liquidity from the last Swap at or before it; cost = fees on pushing the stock ±10 % and selling straight back",
    points: blocks.map((b) => ({ time: b.at.toISOString(), block: b.number.toString(), mintWindowClosed: mintWindowClosedAt(b.at) })),
    series,
  });
  console.log(`wrote data/weekend-${friday}.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) run(main);
