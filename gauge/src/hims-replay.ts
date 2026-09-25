// The HIMS weekend, replayed from events. The public RPC no longer serves state for 2026-08-30, but it
// serves the logs, so every HIMS/USDG position is rebuilt from ModifyLiquidity, the price and the pool's
// own `liquidity` come from the last Swap before each observation point, and the cost to push the price
// is computed by the same walk PushCostLens does on-chain (gauge/src/v4math.ts, checked against it).
// Writes data/hims-replay.json. Raw logs are cached under gauge/cache/ (git-ignored).
import { formatUnits } from "viem";
import { getLogsChunked, mainnet, POOL_MANAGER, readCache, writeCache, writeData } from "./chain.ts";
import { poolManagerEvents } from "./abi.ts";
import { HIMS_USDG, ticksForPct } from "./pools.ts";
import { amount0Of, amount1Of, poolStateFromPositions, roundTripCost, walk, type Position } from "./v4math.ts";
import { mintWindowClosedAt } from "./mint-window.ts";

const INIT_BLOCK = 41_738_721n; // HIMS/USDG Initialize
const END_BLOCK = 50_772_447n;
/** The five observation points of SPEC.md § 1 (Sunday 2026-08-30 into Monday). */
export const POINTS = [50_265_277n, 50_415_299n, 50_444_948n, 50_490_000n, 50_772_447n];
const cacheDir = new URL("../cache/hims/", import.meta.url).pathname;

interface RawLog { blockNumber: string; logIndex: number; transactionHash: string; args: Record<string, string> }

const byOrder = (a: RawLog, b: RawLog) => (BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.logIndex - b.logIndex);

/** Fold ModifyLiquidity logs up to and including `block` into live positions. Exported for the test. */
export function positionsAt(logs: RawLog[], block: bigint): Position[] {
  const map = new Map<string, Position>();
  for (const l of [...logs].sort(byOrder)) {
    if (BigInt(l.blockNumber) > block) break;
    const key = `${l.args.sender}|${l.args.tickLower}|${l.args.tickUpper}|${l.args.salt}`;
    const p = map.get(key) ?? { tickLower: Number(l.args.tickLower), tickUpper: Number(l.args.tickUpper), liquidity: 0n };
    p.liquidity += BigInt(l.args.liquidityDelta);
    map.set(key, p);
  }
  return [...map.values()].filter((p) => p.liquidity > 0n);
}

async function lastSwapBefore(client: ReturnType<typeof mainnet>, block: bigint): Promise<RawLog> {
  const step = 20_000n;
  for (let i = 0n; i < 12n; i++) {
    const to = block - i * step;
    const from = to - step + 1n;
    const logs = (await getLogsChunked(
      client,
      { address: POOL_MANAGER, event: poolManagerEvents.Swap, args: { id: HIMS_USDG.id } },
      from,
      to,
      `${cacheDir}swaps-${from}-${to}.json`,
      { window: step },
    )) as RawLog[];
    const before = logs.filter((l) => BigInt(l.blockNumber) <= block).sort(byOrder);
    if (before.length) return before[before.length - 1];
  }
  throw new Error(`no Swap found before ${block}`);
}

export async function main() {
  const client = mainnet();
  // 1. the pool's Initialize log pins the key we are replaying
  const init = (await getLogsChunked(
    client,
    { address: POOL_MANAGER, event: poolManagerEvents.Initialize, args: { id: HIMS_USDG.id } },
    INIT_BLOCK - 1000n,
    INIT_BLOCK + 1000n,
    `${cacheDir}initialize.json`,
    { window: 2001n },
  )) as RawLog[];
  if (init.length !== 1) throw new Error(`expected one Initialize, got ${init.length}`);
  const key = init[0].args;
  if (key.currency0.toLowerCase() !== HIMS_USDG.currency0.toLowerCase() || Number(key.fee) !== HIMS_USDG.fee || Number(key.tickSpacing) !== HIMS_USDG.tickSpacing) {
    throw new Error("Initialize log does not match the expected HIMS/USDG key");
  }
  console.log("Initialize at block", init[0].blockNumber, "tick", key.tick);

  // 2. every ModifyLiquidity from birth to the end of the replay
  let fetched = 0;
  const mods = (await getLogsChunked(
    client,
    { address: POOL_MANAGER, event: poolManagerEvents.ModifyLiquidity, args: { id: HIMS_USDG.id } },
    INIT_BLOCK,
    END_BLOCK,
    `${cacheDir}modify-liquidity.json`,
    { onChunk: (f, t, n) => { fetched += n; console.log(`ModifyLiquidity ${f}-${t}: ${n} (total ${fetched})`); } },
  )) as RawLog[];
  console.log("ModifyLiquidity logs:", mods.length);

  // 3. each observation point
  const ticks10 = ticksForPct(10);
  const ticks85 = ticksForPct(85); // the weekend's actual move, 29.38 -> 54.50
  const points = [] as any[];
  for (const block of POINTS) {
    const swap = await lastSwapBefore(client, block);
    const header = await client.getBlock({ blockNumber: block });
    const positions = positionsAt(mods, block);
    const sqrtP = BigInt(swap.args.sqrtPriceX96);
    const state = poolStateFromPositions(positions, sqrtP);
    const liquidityMatches = state.liquidity === BigInt(swap.args.liquidity);
    const fee = Number(swap.args.fee); // what the pool charged at the time (LP + protocol)
    // v4 price = HIMS per USDG (raw). USDG per HIMS = 1/price scaled by decimals.
    const raw = Number(sqrtP) / 2 ** 96;
    const usdgPerHims = (1 / (raw * raw)) * 1e12;
    const himsPrincipal = positions.reduce((s, p) => s + amount1Of(p, sqrtP), 0n);
    const usdgPrincipal = positions.reduce((s, p) => s + amount0Of(p, sqrtP), 0n);
    // HIMS dearer in USDG = fewer HIMS per USDG = v4 price DOWN = sell USDG (zeroForOne). Cost lands in USDG.
    const up10 = roundTripCost(state, ticks10, false, fee, fee);
    const down10 = roundTripCost(state, ticks10, true, fee, fee);
    const up85 = walk(state, ticks85, false, fee);
    points.push({
      block: block.toString(),
      timestamp: Number(header.timestamp),
      time: new Date(Number(header.timestamp) * 1000).toISOString(),
      mintWindowClosed: mintWindowClosedAt(new Date(Number(header.timestamp) * 1000)),
      lastSwapBlock: swap.blockNumber,
      lastSwapTx: swap.transactionHash,
      sqrtPriceX96: sqrtP.toString(),
      tick: state.tick,
      usdgPerHims,
      swapFeePips: fee,
      livePositions: positions.length,
      activeLiquidity: state.liquidity.toString(),
      swapEventLiquidity: swap.args.liquidity,
      liquidityMatches,
      himsPrincipal: formatUnits(himsPrincipal, 18),
      usdgPrincipal: formatUnits(usdgPrincipal, 6),
      pushUp10: { ticks: ticks10, usdgIn: formatUnits(up10.amountIn, 6), himsOut: formatUnits(up10.amountOut, 18), roundTripCostUsdg: formatUnits(up10.cost, 6), complete: up10.complete },
      pushDown10: { ticks: ticks10, himsIn: formatUnits(down10.amountIn, 18), usdgOut: formatUnits(down10.amountOut, 6), roundTripCostHims: formatUnits(down10.cost, 18), complete: down10.complete },
      pushUp85: { ticks: ticks85, usdgIn: formatUnits(up85.amountIn, 6), complete: up85.complete },
    });
    console.log(block.toString(), new Date(Number(header.timestamp) * 1000).toISOString(), "USDG/HIMS", usdgPerHims.toFixed(4), "HIMS principal", formatUnits(himsPrincipal, 18), "push +10% costs USDG", formatUnits(up10.cost, 6), liquidityMatches ? "(liquidity matches Swap)" : "(LIQUIDITY MISMATCH)");
  }
  const out = {
    pool: HIMS_USDG.name,
    poolId: HIMS_USDG.id,
    initializeBlock: init[0].blockNumber,
    replayEndBlock: END_BLOCK.toString(),
    modifyLiquidityLogs: mods.length,
    nyseCloseFriday: 28.84,
    points,
    generatedAt: new Date().toISOString(),
  };
  writeData(new URL("../data/hims-replay.json", import.meta.url).pathname, out);
  console.log("wrote data/hims-replay.json");
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
