// Cost ladder: for each pool, what a 1 % / 5 % / 10 % push (each way) costs right now on mainnet 4663.
// Writes data/ladder.json. Read-only (eth_call with a state override, see lens.ts).
import { formatUnits } from "viem";
import { mainnet, STATE_VIEW, writeData } from "./chain.ts";
import { stateViewAbi } from "./abi.ts";
import { lensRuntimeCode, quotePushLadder } from "./lens.ts";
import { POOLS, ticksForPct, type PoolInfo } from "./pools.ts";

const PCTS = [1, 5, 10];

function priceInQuote(sqrtPriceX96: bigint, p: PoolInfo): number {
  // v4 price = currency1 / currency0 in raw units
  const raw = Number(sqrtPriceX96) / 2 ** 96;
  const price1per0 = raw * raw * 10 ** (p.decimals0 - p.decimals1);
  return p.quoteIsCurrency0 ? 1 / price1per0 : price1per0;
}

export async function main() {
  const client = mainnet();
  const block = await client.getBlock();
  const code = await lensRuntimeCode(client);
  const ticks = PCTS.map(ticksForPct);
  const pools = [] as any[];
  for (const p of POOLS) {
    const [sqrtPriceX96, tick, protocolFee, lpFee] = await client.readContract({
      address: STATE_VIEW,
      abi: stateViewAbi,
      functionName: "getSlot0",
      args: [p.id],
      blockNumber: block.number,
    });
    const liquidity = await client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [p.id], blockNumber: block.number });
    const entries = [] as any[];
    for (const up of [true, false]) {
      const quotes = await quotePushLadder(client, code, p, ticks, up, block.number);
      quotes.forEach((q, i) => {
        // "up" is the v4 price (currency1 per currency0); translate to the quote's point of view
        const quoteUp = p.quoteIsCurrency0 ? !up : up;
        const quoteDec = p.quoteIsCurrency0 ? p.decimals0 : p.decimals1;
        const costQuote = p.quoteIsCurrency0 ? q.costInCurrency0 : q.costInCurrency1;
        const inputIsQuote = p.quoteIsCurrency0 ? q.zeroForOne : !q.zeroForOne;
        entries.push({
          pct: PCTS[i],
          direction: quoteUp ? "up" : "down",
          ticks: ticks[i],
          reached: q.sqrtPriceReached === q.sqrtPriceTarget,
          inputToken: inputIsQuote ? "quote" : "base",
          amountIn: q.amountIn.toString(),
          amountInHuman: formatUnits(q.amountIn, inputIsQuote ? quoteDec : p.quoteIsCurrency0 ? p.decimals1 : p.decimals0),
          costQuote: costQuote.toString(),
          costQuoteHuman: formatUnits(costQuote, quoteDec),
        });
      });
    }
    pools.push({
      name: p.name,
      id: p.id,
      stockSymbol: p.stockSymbol ?? null,
      priceQuote: priceInQuote(sqrtPriceX96, p),
      tick,
      lpFee,
      protocolFee,
      liquidity: liquidity.toString(),
      entries,
    });
    console.log(p.name, "price", priceInQuote(sqrtPriceX96, p).toFixed(4), "5% up costs", entries.find((e) => e.pct === 5 && e.direction === "up")?.costQuoteHuman, "quote");
  }
  const out = { chainId: 4663, block: block.number.toString(), timestamp: Number(block.timestamp), generatedAt: new Date().toISOString(), pcts: PCTS, pools };
  writeData(new URL("../data/ladder.json", import.meta.url).pathname, out);
  console.log("wrote data/ladder.json at block", block.number.toString());
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
