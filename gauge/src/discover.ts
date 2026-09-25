// Find every Robinhood stock token's USDG pools on the official v4 PoolManager (4663), from the Initialize logs,
// and keep the deepest one per token (in-range liquidity × price, in USDG). Writes data/stock-pools.json.
// Token list: Robinhood's public asset API. Read-only.
import { type Hex } from "viem";
import { mainnet, POOL_MANAGER, sleep, STATE_VIEW, withRetry, writeData, run } from "./chain.ts";
import { poolManagerEvents, stateViewAbi } from "./abi.ts";
import { USDG } from "./pools.ts";

const ASSETS_URL = "https://api.robinhood.com/rhj/assets";

/** 30 symbols to look at by default (large caps, ETFs, the names traders talk about). HIMS is the story, so it is
 *  always included. `npm run discover -- --all` walks every active token instead (≈200, many RPC calls). */
export const DEFAULT_SYMBOLS = [
  "HIMS", "TSLA", "NVDA", "AAPL", "AMZN", "MSFT", "GOOGL", "META", "AMD", "PLTR",
  "MU", "CRCL", "COIN", "HOOD", "MSTR", "NFLX", "SPY", "QQQ", "GLD", "GME",
  "LLY", "SPCX", "AVGO", "ORCL", "INTC", "SMCI", "UBER", "CRM", "BABA", "RDDT",
];

export interface StockPool {
  symbol: string;
  token: `0x${string}`;
  id: `0x${string}`;
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
  initBlock: string;
  quoteIsCurrency0: boolean;
  liquidity: string;
  /** in-range liquidity valued roughly in USDG, for ranking only */
  depthScore: number;
  priceUsdg: number;
}

export async function discover(symbols: string[] = DEFAULT_SYMBOLS, all = false): Promise<StockPool[]> {
  const client = mainnet();
  const res = await fetch(ASSETS_URL);
  if (!res.ok) throw new Error(`assets API ${res.status}`);
  const assets: any[] = (await res.json()).assets;
  const tokens = assets
    .filter((a) => a.status === "ASSET_STATUS_ACTIVE")
    .map((a) => ({ symbol: a.tokenSymbol as string, token: (a.deployments.find((d: any) => d.chainId === 4663)?.contractAddress ?? "").toLowerCase() as `0x${string}` }))
    .filter((t) => t.token.length === 42)
    .filter((t) => all || symbols.includes(t.symbol));
  const missing = all ? [] : symbols.filter((sym) => !tokens.some((t) => t.symbol === sym));
  if (missing.length) console.warn("not in the asset list, skipped:", missing.join(", "));
  if (!all && !tokens.some((t) => t.symbol === "HIMS")) throw new Error("HIMS is not in the asset list");
  const head = await client.getBlockNumber();
  const usdg = USDG.toLowerCase();
  const out: StockPool[] = [];
  for (const t of tokens) {
    const [c0, c1] = t.token < usdg ? [t.token, usdg] : [usdg, t.token];
    let logs: any[];
    try {
      logs = await withRetry(`${t.symbol} Initialize`, () => client.getLogs({ address: POOL_MANAGER, event: poolManagerEvents.Initialize, args: { currency0: c0 as Hex, currency1: c1 as Hex }, fromBlock: 0n, toBlock: head }));
      await sleep(250);
    } catch (e: any) {
      console.warn(t.symbol, "getLogs failed:", e.shortMessage ?? e.message);
      continue;
    }
    let best: StockPool | undefined;
    for (const l of logs) {
      const a = l.args as any;
      const [sqrtPriceX96] = await withRetry(`${t.symbol} slot0`, () => client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [a.id] }));
      if (sqrtPriceX96 === 0n) continue;
      const liquidity = await withRetry(`${t.symbol} liquidity`, () => client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [a.id] }));
      await sleep(250);
      const quoteIsCurrency0 = c0 === usdg;
      const raw = Number(sqrtPriceX96) / 2 ** 96;
      const p1per0 = raw * raw * (quoteIsCurrency0 ? 1e-12 : 1e12); // USDG 6 dec, stock 18 dec
      const priceUsdg = quoteIsCurrency0 ? 1 / p1per0 : p1per0;
      // L ≈ sqrt(x·y): USDG-side depth per unit of sqrt-price move, rough but monotone in real depth
      const depthScore = (Number(liquidity) / 1e12) * Math.sqrt(priceUsdg);
      const p: StockPool = {
        symbol: t.symbol, token: t.token, id: a.id, currency0: c0 as any, currency1: c1 as any, fee: Number(a.fee), tickSpacing: Number(a.tickSpacing),
        hooks: (a.hooks as string).toLowerCase() as any, initBlock: l.blockNumber!.toString(), quoteIsCurrency0, liquidity: liquidity.toString(), depthScore, priceUsdg,
      };
      if (!best || p.depthScore > best.depthScore) best = p;
    }
    if (best) {
      out.push(best);
      console.log(t.symbol.padEnd(6), best.id, "fee", best.fee, "price", best.priceUsdg.toFixed(2), "depth", best.depthScore.toExponential(2), `(${logs.length} pools)`);
    }
  }
  out.sort((a, b) => b.depthScore - a.depthScore);
  return out;
}

export async function main() {
  const pools = await discover(DEFAULT_SYMBOLS, process.argv.includes("--all"));
  writeData(new URL("../data/stock-pools.json", import.meta.url).pathname, { generatedAt: new Date().toISOString(), note: "deepest USDG pool per Robinhood stock token on the official v4 PoolManager; depthScore is for ranking only", pools });
  console.log("wrote data/stock-pools.json:", pools.length, "pools");
}

if (import.meta.url === `file://${process.argv[1]}`) run(main);
