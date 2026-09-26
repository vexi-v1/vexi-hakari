// Read-only access to Robinhood Chain. Mainnet 4663 is never written to from this package.
//
// RPCs come from the repo's .env (loaded here; tsx does not load it on its own). RH_MAINNET_RPC may hold several
// comma-separated URLs; requests rotate across them, a failing endpoint hands the request to the next, and the
// public endpoint is always last in the ring. Every URL must answer chain id 4663 or it is dropped: a variable's
// name is not its chain (this repo's .env once had mainnet and testnet swapped). URLs can carry API keys, so no
// URL is ever printed: errors name endpoints as <rpc#N>. Testnet 46630 gets the same ring through RH_TESTNET_RPC
// (`testnet()`): its public endpoint keeps every log since genesis but serves state only for recent blocks.
import { createPublicClient, custom, http, type Log, type PublicClient } from "viem";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

try {
  process.loadEnvFile(new URL("../../.env", import.meta.url).pathname);
} catch {
  // no .env: public endpoints only
}

export const PUBLIC_MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const PUBLIC_TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com/rpc";

function urlsFrom(value: string | undefined, fallback: string): string[] {
  const list = (value ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  if (!list.includes(fallback)) list.push(fallback);
  return list;
}

export const MAINNET_RPCS = urlsFrom(process.env.RH_MAINNET_RPC, PUBLIC_MAINNET_RPC);
export const TESTNET_RPCS = urlsFrom(process.env.RH_TESTNET_RPC, PUBLIC_TESTNET_RPC);
const KNOWN_URLS = [...MAINNET_RPCS, ...TESTNET_RPCS];

/** Replace every configured RPC URL (and anything that looks like one) in a message with <rpc#N>. */
export function redact(message: string): string {
  let out = message;
  KNOWN_URLS.forEach((u, i) => {
    out = out.split(u).join(`<rpc#${i + 1}>`);
  });
  return out.replace(/https?:\/\/[^\s"')]+/g, (m) => (m.startsWith("https://api.robinhood.com") ? m : "<url>"));
}

export const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as const;
export const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as const;

export const robinhood = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_MAINNET_RPC] } },
} as const;

/** Testnet 46630: the PoolManager and StateView sit at the same addresses as on 4663. */
export const robinhoodTestnet = {
  ...robinhood,
  id: 46630,
  name: "Robinhood Chain testnet",
  rpcUrls: { default: { http: [PUBLIC_TESTNET_RPC] } },
} as const;

/** A transport that rotates requests across `urls`, fails over on error, and first drops any URL not on `chainId`. */
export function rotating(urls: string[], chainId: number) {
  const endpoints = urls.map((u, i) => ({ label: `<rpc#${i + 1}>`, t: http(u, { timeout: 60_000, retryCount: 0 })({ chain: robinhood as any, retryCount: 0 }) }));
  let live = endpoints;
  let next = 0;
  let checked: Promise<void> | undefined;
  const check = () =>
    (checked ??= (async () => {
      const ok = [] as typeof endpoints;
      for (const e of endpoints) {
        try {
          const id = Number(await e.t.request({ method: "eth_chainId" }));
          if (id === chainId) ok.push(e);
          else console.warn(`${e.label} answers chain ${id}, not ${chainId}: dropped`);
        } catch (err: any) {
          console.warn(`${e.label} unreachable: dropped (${redact(String(err?.shortMessage ?? err?.message ?? err))})`);
        }
      }
      if (!ok.length) throw new Error(`no RPC answers chain ${chainId}`);
      live = ok;
    })());
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      await check();
      let last: any;
      for (let k = 0; k < live.length; k++) {
        const e = live[(next + k) % live.length];
        try {
          const r = await e.t.request({ method, params } as any);
          next = (next + k + 1) % live.length;
          return r;
        } catch (err) {
          last = err;
        }
      }
      throw new Error(redact(String(last?.details ?? last?.shortMessage ?? last?.message ?? last)));
    },
  });
}

export function mainnet(): PublicClient {
  return createPublicClient({ chain: robinhood, transport: rotating(MAINNET_RPCS, 4663) });
}

/** Read-only client on testnet 46630; a URL that answers 4663 is dropped from the ring, whatever its variable is called. */
export function testnet(): PublicClient {
  return createPublicClient({ chain: robinhoodTestnet, transport: rotating(TESTNET_RPCS, 46630) });
}

/** Run a script's main with errors printed redacted and a non-zero exit. */
export function run(main: () => Promise<void>) {
  main().catch((e: any) => {
    console.error(redact(String(e?.shortMessage ?? e?.message ?? e)));
    process.exit(1);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The public RPC rate-limits bursts; retry with backoff and say so on the final failure. */
export async function withRetry<T>(label: string, f: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e: any) {
      if (i + 1 >= attempts) throw new Error(`${label}: ${redact(String(e?.shortMessage ?? e?.message ?? e))}`);
      await sleep(1500 * 2 ** i);
    }
  }
}

/** Default window for eth_getLogs; topic-filtered queries can go wider (the public RPC caps results at 10,000 logs). */
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
        const msg = redact(String(e?.shortMessage ?? e?.message ?? e));
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

export type SerializedLog = ReturnType<typeof serializeLog>;

/** Logs in (block, logIndex) order. */
export const byLogOrder = (a: { blockNumber: string; logIndex: number }, b: { blockNumber: string; logIndex: number }) =>
  BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.logIndex - b.logIndex;

/** The public endpoints' refusal of a query matching more than 10,000 logs; halving the range is the cure, a retry is not. */
export function isLogCap(message: string): boolean {
  return /exceeds limit|exceeds the limit|too many (logs|results)|more than \d+ (logs|results)|query returned more/i.test(message);
}

/**
 * Every log of `filter` in [fromBlock, toBlock]: one query when the RPC accepts it, the range halved whenever it does
 * not. The public endpoints have no block-range cap but refuse a query that matches more than 10,000 logs; that refusal
 * halves at once, any other is retried `attempts` times and then halved too. Cached as a whole once every piece is in,
 * so a cache file is either complete or absent. Use this rather than getLogsChunked for a filter that may exceed the
 * cap inside one window: the chunked fetcher retries the same window five times and then gives up.
 */
export async function getLogsHalving(
  client: PublicClient,
  filter: LogFilter,
  fromBlock: bigint,
  toBlock: bigint,
  cacheFile: string,
  opts: { attempts?: number; pauseMs?: number; maxDepth?: number; onRange?: (from: bigint, to: bigint, n: number) => void } = {},
): Promise<SerializedLog[]> {
  const cached = readCache(cacheFile) as SerializedLog[] | undefined;
  if (cached) return cached;
  const attempts = opts.attempts ?? 2;
  const pauseMs = opts.pauseMs ?? 500;
  const maxDepth = opts.maxDepth ?? 24;
  const label = filter.event?.name ?? "logs";
  const logs: SerializedLog[] = [];
  const query = async (from: bigint, to: bigint): Promise<Log[]> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.getLogs({ address: filter.address, event: filter.event, args: filter.args as any, fromBlock: from, toBlock: to });
      } catch (e: any) {
        const msg = redact(String(e?.details ?? e?.shortMessage ?? e?.message ?? e));
        if (isLogCap(msg) || attempt + 1 >= attempts) throw new Error(`${label} ${from}-${to}: ${msg}`);
        await sleep(1500 * 2 ** attempt);
      }
    }
  };
  const fetchRange = async (from: bigint, to: bigint, depth: number): Promise<void> => {
    let chunk: Log[];
    try {
      chunk = await query(from, to);
    } catch (e) {
      if (to <= from || depth >= maxDepth) throw e;
      const mid = from + (to - from) / 2n;
      await fetchRange(from, mid, depth + 1);
      await fetchRange(mid + 1n, to, depth + 1);
      return;
    }
    for (const l of chunk) logs.push(serializeLog(l as any));
    opts.onRange?.(from, to, chunk.length);
    if (pauseMs) await sleep(pauseMs);
  };
  await fetchRange(fromBlock, toBlock, 0);
  logs.sort(byLogOrder);
  writeCache(cacheFile, logs);
  return logs;
}

export function serializeLog(l: Log & { args?: any; eventName?: string }) {
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
