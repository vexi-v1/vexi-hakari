// Run PushCostLens against live mainnet pools without deploying it: the RPC accepts an eth_call state
// override, so the lens's runtime bytecode is injected at a throwaway address for the duration of one call
// (FEEDBACK.md § 2). Mainnet stays read-only.
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, type PublicClient } from "viem";
import { lensAbi } from "./abi.ts";
import { POOL_MANAGER } from "./chain.ts";
import { poolKeyOf, type PoolInfo } from "./pools.ts";

/** Any address with no code; the override puts the lens there for one call. */
export const LENS_OVERRIDE_ADDRESS = "0x4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a" as const;

export interface PushQuote {
  sqrtPriceStart: bigint;
  tickStart: number;
  sqrtPriceTarget: bigint;
  sqrtPriceReached: bigint;
  tickReached: number;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOut: bigint;
  amountBackOut: bigint;
  cost: bigint;
  costInCurrency0: bigint;
  costInCurrency1: bigint;
}

/** The lens's runtime bytecode with `poolManager` baked in, obtained by simulating its deployment. */
export async function lensRuntimeCode(client: PublicClient): Promise<`0x${string}`> {
  const artifact = JSON.parse(readFileSync(new URL("../../out/PushCostLens.sol/PushCostLens.json", import.meta.url), "utf8"));
  const creation: `0x${string}` = artifact.bytecode.object;
  const args = encodeAbiParameters([{ type: "address" }], [POOL_MANAGER]);
  const { data } = await client.call({ data: (creation + args.slice(2)) as `0x${string}` });
  if (!data || data === "0x") throw new Error("deployment simulation returned no code");
  return data;
}

export async function quotePushLadder(
  client: PublicClient,
  code: `0x${string}`,
  pool: PoolInfo,
  ticks: number[],
  up: boolean,
  blockNumber?: bigint,
): Promise<PushQuote[]> {
  const data = encodeFunctionData({ abi: lensAbi, functionName: "quotePushLadder", args: [poolKeyOf(pool), ticks, up] });
  const { data: out } = await client.call({
    to: LENS_OVERRIDE_ADDRESS,
    data,
    blockNumber,
    stateOverride: [{ address: LENS_OVERRIDE_ADDRESS, code }],
  });
  if (!out) throw new Error("empty quote");
  const decoded = decodeFunctionResult({ abi: lensAbi, functionName: "quotePushLadder", data: out }) as readonly any[];
  return decoded.map((q) => ({ ...q }));
}
