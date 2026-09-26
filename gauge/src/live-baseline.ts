// The live board's baseline (web/live/): every stock pool's max safe exposure at the latest US close, Friday 20:00 UTC,
// and on the hour since, rebuilt from logs (the public RPC keeps logs, not old state: replay.ts). The board measures
// "now" in the browser with PushCostLens.roundTripCosts by state override; to show that the two methods agree, this
// script also runs that exact call (web/lens-artifact.json, web/live/core.js) at one recent block, next to the
// rebuild at the same block, and writes both.
//   npm run live:baseline                 (the latest Friday 20:00 UTC at or before now)
//   npm run live:baseline -- 2026-09-25
// Reads data/stock-pools.json (npm run discover) plus the extra pools below. Writes web/live/baseline.json.
// Read-only against 4663.
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData } from "viem";
import { poolManagerEvents } from "./abi.ts";
import { mainnet, POOL_MANAGER, readCache, run, serializeLog, STATE_VIEW, withRetry, writeCache, writeData } from "./chain.ts";
import { stateViewAbi } from "./abi.ts";
import { mintWindowClosedAt } from "./mint-window.ts";
import { byOrder, lastSwapBefore, maxSafeExposure, modifyLiquidityLogs, rebuild, type RawLog } from "./replay.ts";
import { LADDER, MAX_WALK_STEPS, latestFriday, maxSafeFromQuotes, priceInQuote } from "../../web/live/core.js";

type Client = ReturnType<typeof mainnet>;
const cacheDir = new URL("../cache/live/", import.meta.url).pathname;
const LENS_AT = "0x4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a" as const;
const BLOCKS_PER_SECOND = 9.89; // Robinhood Chain, measured over 27.9 days (48,555,213 → 72,388,167)

export interface LivePool {
  symbol: string;
  id: `0x${string}`;
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
  initBlock: string;
  quoteIsCurrency0: boolean;
  decimals0: number;
  decimals1: number;
}

/**
 * Pools the discovery list (data/stock-pools.json, 30 symbols) does not carry. AMC: the other stock token paired with
 * memecoins over the HIMS weekend (npm run amc); its deepest of 359 USDG pools by discover.ts's own ranking, 2026-09-26.
 */
export const EXTRA_POOLS: LivePool[] = [
  {
    symbol: "AMC",
    id: "0x7499938c352d5b5b8f0c648722aca5ee964ef9b85c3a3041f1ec379726291d9d",
    currency0: "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b",
    currency1: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    fee: 1000,
    tickSpacing: 10,
    hooks: "0x0000000000000000000000000000000000000000",
    initBlock: "53983886",
    quoteIsCurrency0: false,
    decimals0: 18,
    decimals1: 6,
  },
];

/** Friday 20:00 UTC, then every hour up to `untilTs`. */
export function hourlyPoints(friday: string, untilTs: number): Date[] {
  const f = new Date(`${friday}T20:00:00Z`);
  if (f.getUTCDay() !== 5) throw new Error(`${friday} is not a Friday`);
  const out: Date[] = [];
  for (let t = f.getTime(); t / 1000 <= untilTs; t += 3600_000) out.push(new Date(t));
  return out;
}

/** First block with timestamp >= ts: a guess from the head at the chain's block rate, a bracket around it, bisection. */
async function blockAtOrAfter(client: Client, ts: number, head: { number: bigint; timestamp: number }, memo: Map<string, number>) {
  const tsOf = async (n: bigint) => {
    const k = n.toString();
    if (!memo.has(k)) memo.set(k, Number((await withRetry(`block ${n}`, () => client.getBlock({ blockNumber: n }))).timestamp));
    return memo.get(k)!;
  };
  if (ts > head.timestamp) throw new Error(`${ts} is after the head`);
  const guess = head.number - BigInt(Math.floor((head.timestamp - ts) * BLOCKS_PER_SECOND));
  let span = 1200n;
  let lo = guess - span, hi = guess + span > head.number ? head.number : guess + span;
  while ((await tsOf(lo)) >= ts) { lo -= span; span *= 2n; }
  span = 1200n;
  while ((await tsOf(hi)) < ts) { hi = hi + span > head.number ? head.number : hi + span; span *= 2n; }
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    if ((await tsOf(mid)) >= ts) hi = mid;
    else lo = mid;
  }
  return { number: hi, timestamp: await tsOf(hi) };
}

/** Every Swap of one pool in [from, to]: one topic-filtered query, halved whenever the RPC refuses it (10,000-log cap). */
async function swapLogs(client: Client, poolId: `0x${string}`, from: bigint, to: bigint, cacheFile: string): Promise<RawLog[]> {
  const cached = readCache(cacheFile) as RawLog[] | undefined;
  if (cached) return cached;
  const out: RawLog[] = [];
  const range = async (a: bigint, b: bigint, depth: number): Promise<void> => {
    try {
      const logs = await withRetry(`Swap ${a}-${b}`, () => client.getLogs({ address: POOL_MANAGER, event: poolManagerEvents.Swap, args: { id: poolId }, fromBlock: a, toBlock: b }), 2);
      for (const l of logs as any[]) out.push(serializeLog(l) as RawLog);
    } catch (e) {
      if (b <= a || depth > 20) throw e;
      const mid = a + (b - a) / 2n;
      await range(a, mid, depth + 1);
      await range(mid + 1n, b, depth + 1);
    }
  };
  await range(from, to, 0);
  out.sort(byOrder);
  writeCache(cacheFile, out);
  return out;
}

/** The page's own measurement at one block: PushCostLens.roundTripCosts both ways, injected by state override. */
async function lensBound(client: Client, artifact: any, code: `0x${string}`, p: LivePool, block: bigint) {
  const key = { currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks };
  const walk = async (up: boolean) => {
    const data = encodeFunctionData({ abi: artifact.abi, functionName: "roundTripCosts", args: [key, LADDER, up, BigInt(MAX_WALK_STEPS)] });
    const { data: out } = await withRetry(`${p.symbol} roundTripCosts`, () => client.call({ to: LENS_AT, data, blockNumber: block, stateOverride: [{ address: LENS_AT, code }] }));
    return decodeFunctionResult({ abi: artifact.abi, functionName: "roundTripCosts", data: out! }) as any;
  };
  const [up, down] = [await walk(true), await walk(false)];
  const b = maxSafeFromQuotes(up, down, LADDER, p.quoteIsCurrency0);
  const quoteDec = p.quoteIsCurrency0 ? p.decimals0 : p.decimals1;
  return { usdg: b.exposure / 10 ** quoteDec, bindingTicks: b.binding.ticks, bindingAssetUp: b.binding.assetUp, complete: b.binding.complete };
}

export async function main() {
  const client = mainnet();
  const headBlock = await withRetry("head", () => client.getBlock());
  const head = { number: headBlock.number!, timestamp: Number(headBlock.timestamp) };
  const friday = process.argv[2] ?? latestFriday(new Date(head.timestamp * 1000));
  const listed = JSON.parse(readFileSync(new URL("../data/stock-pools.json", import.meta.url), "utf8")).pools as any[];
  const pools: LivePool[] = [
    ...listed.map((p) => ({ ...p, decimals0: p.quoteIsCurrency0 ? 6 : 18, decimals1: p.quoteIsCurrency0 ? 18 : 6 })),
    ...EXTRA_POOLS,
  ];
  // the check block: a minute behind the head, so every endpoint in the ring has it
  const check = head.number - 600n;
  const points = hourlyPoints(friday, head.timestamp - 60);
  console.log(`${friday}: ${points.length} hourly points from the US close, ${pools.length} pools, check at block ${check}`);

  const blocksFile = `${cacheDir}blocks-${friday}.json`;
  const known = (readCache(blocksFile) as Record<string, { number: string; timestamp: number }> | undefined) ?? {};
  const memo = new Map<string, number>();
  const blocks: { at: Date; number: bigint; timestamp: number }[] = [];
  for (const at of points) {
    const k = at.toISOString();
    const b = known[k] ? { number: BigInt(known[k].number), timestamp: known[k].timestamp } : await blockAtOrAfter(client, at.getTime() / 1000, head, memo);
    known[k] = { number: b.number.toString(), timestamp: b.timestamp };
    blocks.push({ at, ...b });
  }
  writeCache(blocksFile, known);
  const fridayBlock = blocks[0];

  // decimals as the chain reports them, at the check block (stock tokens 18, USDG 6 on every pool listed so far)
  const erc20 = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;
  for (const p of pools) {
    const [d0, d1] = await Promise.all([p.currency0, p.currency1].map((a) => withRetry(`${a} decimals`, () => client.readContract({ address: a, abi: erc20, functionName: "decimals", blockNumber: check }))));
    if (Number(d0) !== p.decimals0 || Number(d1) !== p.decimals1) throw new Error(`${p.symbol}: decimals ${d0}/${d1}, expected ${p.decimals0}/${p.decimals1}`);
  }

  const artifact = JSON.parse(readFileSync(new URL("../../web/lens-artifact.json", import.meta.url), "utf8"));
  const args = encodeAbiParameters([{ type: "address" }], [POOL_MANAGER]);
  const { data: code } = await withRetry("lens deployment", () => client.call({ data: (artifact.creationBytecode + args.slice(2)) as `0x${string}`, blockNumber: check }));
  if (!code || code === "0x") throw new Error("could not simulate the lens deployment");

  const out = [] as any[];
  for (const p of pools) {
    const tag = `${p.id.slice(0, 10)}-${check}`;
    const mods = await withRetry(`${p.symbol} ModifyLiquidity`, () => modifyLiquidityLogs(client, p.id, BigInt(p.initBlock), check, `${cacheDir}mods-${tag}.json`));
    const from = fridayBlock.number - 300_000n;
    const swaps = await swapLogs(client, p.id, from, check, `${cacheDir}swaps-${p.id.slice(0, 10)}-${from}-${check}.json`);
    const seed = swaps.find((s) => BigInt(s.blockNumber) <= fridayBlock.number) ? undefined : await lastSwapBefore(client, p.id, from - 1n, cacheDir);
    const tape = seed ? [seed, ...swaps] : swaps;
    const at = (block: bigint) => {
      let last: RawLog | undefined;
      for (const s of tape) {
        if (BigInt(s.blockNumber) > block) break;
        last = s;
      }
      if (!last) return null;
      const { state, positions, liquidityMatches } = rebuild(mods, last, block);
      const fee = Number(last.args.fee);
      const b = maxSafeExposure(state, p.quoteIsCurrency0, fee);
      const quoteDec = p.quoteIsCurrency0 ? p.decimals0 : p.decimals1;
      return {
        price: priceInQuote(state.sqrtPriceX96, p.decimals0, p.decimals1, p.quoteIsCurrency0),
        maxSafeUsdg: b.exposure / 10 ** quoteDec,
        bindingTicks: b.ticks,
        bindingAssetUp: b.stockUp,
        livePositions: positions.length,
        liquidityMatches,
        swapFeePips: fee,
      };
    };
    const series = blocks.map((b) => ({ time: b.at.toISOString(), block: b.number.toString(), mintWindowClosed: mintWindowClosedAt(b.at), ...(at(b.number) ?? { missing: "no swap yet" }) }));
    const rebuiltAtCheck = at(check);
    const lensAtCheck = await lensBound(client, artifact, code, p, check);
    const [sqrtNow] = (await withRetry(`${p.symbol} slot0`, () => client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [p.id], blockNumber: check }))) as readonly [bigint, number, number, number];
    const fri = series[0] as any;
    out.push({
      symbol: p.symbol,
      id: p.id,
      key: { currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks },
      quoteIsCurrency0: p.quoteIsCurrency0,
      decimals0: p.decimals0,
      decimals1: p.decimals1,
      hooked: p.hooks !== "0x0000000000000000000000000000000000000000",
      modifyLiquidityLogs: mods.length,
      swapsSinceLookback: swaps.length,
      friday: fri.missing ? null : { price: fri.price, maxSafeUsdg: fri.maxSafeUsdg, bindingTicks: fri.bindingTicks, bindingAssetUp: fri.bindingAssetUp, liquidityMatches: fri.liquidityMatches },
      series,
      check: {
        block: check.toString(),
        rebuilt: rebuiltAtCheck,
        lens: lensAtCheck,
        slot0PriceMatchesLastSwap: rebuiltAtCheck ? Math.abs(priceInQuote(sqrtNow, p.decimals0, p.decimals1, p.quoteIsCurrency0) / rebuiltAtCheck.price - 1) < 1e-12 : null,
        lensOverRebuilt: rebuiltAtCheck ? lensAtCheck.usdg / rebuiltAtCheck.maxSafeUsdg : null,
      },
    });
    const last = [...series].reverse().find((r: any) => !r.missing) as any;
    console.log(
      p.symbol.padEnd(6),
      "Fri", fri.missing ? "—" : fri.maxSafeUsdg.toFixed(0).padStart(8),
      "→ last", last ? last.maxSafeUsdg.toFixed(0).padStart(8) : "—",
      "| check lens/rebuilt", rebuiltAtCheck ? (lensAtCheck.usdg / rebuiltAtCheck.maxSafeUsdg).toFixed(4) : "—",
      series.every((r: any) => r.missing || r.liquidityMatches) ? "" : "(LIQUIDITY MISMATCH)",
    );
  }

  writeData(new URL("../../web/live/baseline.json", import.meta.url).pathname, {
    friday,
    fridayClose: { time: fridayBlock.at.toISOString(), block: fridayBlock.number.toString(), blockTimestamp: fridayBlock.timestamp },
    generatedAt: new Date().toISOString(),
    head: { block: head.number.toString(), timestamp: head.timestamp },
    method:
      "Friday 20:00 UTC (the US close) and every hour since: each pool rebuilt from its ModifyLiquidity logs, price and fee from the last Swap at or before the point (replay.ts), max safe exposure as CostModel.maxSafeExposure with nobody pushing back (replay.ts, pinned to the Solidity). check: at one recent block, the same bound from PushCostLens.roundTripCosts by eth_call state override (what web/live/ runs every minute) next to the rebuild.",
    ladderTicks: LADDER,
    maxWalkSteps: MAX_WALK_STEPS,
    points: blocks.map((b) => ({ time: b.at.toISOString(), block: b.number.toString(), mintWindowClosed: mintWindowClosedAt(b.at) })),
    pools: out,
  });
  console.log("wrote web/live/baseline.json");
}

if (import.meta.url === `file://${process.argv[1]}`) run(main);
