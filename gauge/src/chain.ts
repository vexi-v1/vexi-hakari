// Read-only access to Robinhood Chain. Mainnet 4663 is never written to from this package.
import { createPublicClient, http, type Log, type PublicClient } from "viem";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MAINNET_RPC = process.env.RH_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com";
export const TESTNET_RPC = process.env.RH_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com/rpc";

export const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as const;
export const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as const;

export const robinhood = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [MAINNET_RPC] } },
} as const;

export function mainnet(): PublicClient {
  return createPublicClient({ chain: robinhood, transport: http(MAINNET_RPC, { timeout: 60_000, retryCount: 3 }) });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The public RPC times out on wide `eth_getLogs`; 100k-block windows work (FEEDBACK.md § 3). */
export const LOG_WINDOW = 100_000n;

export interface LogFilter {
  address: `0x${string}`;
  event: any; // viem AbiEvent
  args?: Record<string, unknown>;
}

/** Chunked, cached, gently paced getLogs. Cache key must be unique per (filter, range). */
export async function getLogsChunked(
  client: PublicClient,
  filter: LogFilter,
  fromBlock: bigint,
  toBlock: bigint,
  cacheFile: string,
  opts: { window?: bigint; pauseMs?: number; onChunk?: (from: bigint, to: bigint, n: number) => void } = {},
): Promise<any[]> {
  const window = opts.window ?? LOG_WINDOW;
  const pauseMs = opts.pauseMs ?? 800;
  const cached = readCache(cacheFile) as { done: string[]; logs: any[] } | undefined;
  const done = new Set(cached?.done ?? []);
  const logs: any[] = cached?.logs ?? [];
  for (let from = fromBlock; from <= toBlock; from += window) {
    const to = from + window - 1n > toBlock ? toBlock : from + window - 1n;
    const key = `${from}-${to}`;
    if (done.has(key)) continue;
    let chunk: Log[] | undefined;
    for (let attempt = 0; attempt < 5 && !chunk; attempt++) {
      try {
        chunk = await client.getLogs({ address: filter.address, event: filter.event, args: filter.args as any, fromBlock: from, toBlock: to });
      } catch (e: any) {
        const msg = String(e?.shortMessage ?? e?.message ?? e);
        if (attempt === 4) throw new Error(`getLogs ${key} failed: ${msg}`);
        await sleep(2000 * (attempt + 1));
      }
    }
    for (const l of chunk!) logs.push(serializeLog(l));
    done.add(key);
    opts.onChunk?.(from, to, chunk!.length);
    writeCache(cacheFile, { done: [...done], logs });
    await sleep(pauseMs);
  }
  return logs;
}

function serializeLog(l: Log & { args?: any; eventName?: string }) {
  const args: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(l.args ?? {})) args[k] = typeof v === "bigint" ? v.toString() : (v as any);
  return {
    blockNumber: l.blockNumber!.toString(),
    logIndex: l.logIndex,
    transactionHash: l.transactionHash,
    eventName: l.eventName,
    args,
  };
}

export function readCache(file: string): unknown | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeCache(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

export function writeData(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}
