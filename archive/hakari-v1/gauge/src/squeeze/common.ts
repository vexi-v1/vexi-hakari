// Shared constants and block/time helpers for the float-squeeze dataset (web/squeeze/). Read-only against
// Robinhood Chain 4663. Logs come from the public endpoint (it serves 100k-block getLogs windows); block headers and
// historical eth_calls go to the private RPC in .env when there is one (RH_MAINNET_RPC, loaded by ../chain.ts): it
// keeps archive state for 2026-08-28..31 and takes 100-header batches without the public endpoint's 429s. No URL is
// ever printed or written to a file: they can carry API keys (errors go through redact()).
import { createPublicClient, http, type PublicClient } from "viem";
import { MAINNET_RPCS, PUBLIC_MAINNET_RPC, readCache, redact, robinhood, sleep, writeCache } from "../chain.ts";

export const HIMS = "0xccee82fe024c36fa15e1005ede3e9e4787e23d09" as const; // 18 decimals
export const BONER = "0x98096d17e191b3da1d5f99a6d7b3584351b11e18" as const; // 18 decimals
export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as const; // 6 decimals
export const AI_MEME = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18" as const; // "Artificial Inu", 18 decimals

/** PoolIds verified against their Initialize logs (see squeeze/pools.ts for the full keys). */
export const POOL_HIMS_USDG = "0x68d4f28f1432e0ad714658853edb2e6b0b1ac4060355ff3d169fea656b1d1c52" as const;
export const POOL_BONER_HIMS = "0x9c89b04303dfa76f3f6fb02c2b77be0e8a00ab8fa00d507119acd54ab3e8640d" as const;
export const INIT_BONER_HIMS = 41_726_520n;
export const INIT_HIMS_USDG = 41_738_721n;

/** The replay window: Fri 2026-08-28 18:00 UTC (two hours before the NYSE close) to Mon 2026-08-31 14:00 UTC (NYSE open + 30 min). */
export const WINDOW_START_TS = 1_787_940_000;
export const WINDOW_END_TS = 1_788_184_800;
/** First blocks at or after WINDOW_START_TS / WINDOW_END_TS (binary search over headers, 2026-09-25). */
export const WINDOW_START_BLOCK = 48_495_759n;
export const WINDOW_END_BLOCK = 50_919_068n;

/** Reference moments (unix seconds, UTC). */
export const REF = {
  nyseCloseFri: 1_787_947_200, // Fri 2026-08-28 20:00 UTC (16:00 ET)
  nyseCloseFriPrice: 28.84, // HIMS NYSE close, Fri 2026-08-28 (DeFiPrime, 2026-08-31)
  mintRuleClose: 1_787_961_600, // Sat 2026-08-29 00:00 UTC = Sat 02:00 Berlin (gauge/src/mint-window.ts)
  session24x5Reopen: 1_788_134_400, // Mon 2026-08-31 00:00 UTC = Sun 20:00 ET (also Mon 02:00 Berlin)
  nyseOpenMon: 1_788_183_000, // Mon 2026-08-31 13:30 UTC (09:30 ET)
} as const;

export const cacheDir = new URL("../../cache/squeeze/", import.meta.url).pathname;

/** Headers and eth_call: the first non-public RPC from .env, else the public one. */
export const STATE_RPC = MAINNET_RPCS.find((u) => u !== PUBLIC_MAINNET_RPC) ?? PUBLIC_MAINNET_RPC;
export const STATE_RPC_IS_PUBLIC = STATE_RPC === PUBLIC_MAINNET_RPC;
/** Printable name of the state endpoint (hostname only, never the path that holds the key). */
export const STATE_RPC_LABEL = STATE_RPC_IS_PUBLIC ? "public RPC" : `private RPC (${new URL(STATE_RPC).hostname})`;

/** getLogs client pinned to the public endpoint: private endpoints cap the block range (Chainstack: 10k). */
export function logsClient(): PublicClient {
  return createPublicClient({ chain: robinhood as any, transport: http(PUBLIC_MAINNET_RPC, { timeout: 60_000, retryCount: 3 }) });
}

let chainChecked: Promise<void> | undefined;

/** One JSON-RPC batch against STATE_RPC (chain id checked once), retried with backoff. Errors are redacted. */
export async function rpcBatch(calls: { method: string; params: unknown[] }[]): Promise<any[]> {
  chainChecked ??= (async () => {
    const [id] = await post([{ method: "eth_chainId", params: [] }]);
    if (Number(id) !== 4663) throw new Error(`${STATE_RPC_LABEL} answers chain ${Number(id)}, not 4663`);
  })();
  await chainChecked;
  return post(calls);
}

async function post(calls: { method: string; params: unknown[] }[]): Promise<any[]> {
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, ...c })));
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(STATE_RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = (await res.json()) as any[];
      if (!Array.isArray(out)) throw new Error(`batch answered ${JSON.stringify(out).slice(0, 200)}`);
      const byId = new Map(out.map((r) => [r.id, r]));
      return calls.map((_c, i) => {
        const r = byId.get(i);
        if (!r || r.error) throw new Error(`batch item ${i}: ${JSON.stringify(r?.error ?? "missing")}`);
        return r.result;
      });
    } catch (e: any) {
      if (attempt >= 6) throw new Error(redact(`${STATE_RPC_LABEL}: ${e?.message ?? e}`));
      await sleep((STATE_RPC_IS_PUBLIC ? 5000 : 1000) * (attempt + 1));
    }
  }
}

/** Batch size and pause between batches: the public endpoint sustains ~10 headers/s, the private one far more. */
const BATCH = STATE_RPC_IS_PUBLIC ? 20 : 100;
const PAUSE_MS = STATE_RPC_IS_PUBLIC ? 1000 : 150;

/**
 * Exact timestamps for many blocks, batched, cached in gauge/cache/squeeze/timestamps.json (merged on write, so
 * collectors running side by side do not drop each other's entries). Only blocks missing from the cache are fetched.
 */
export async function blockTimestamps(blocks: Iterable<bigint | number | string>): Promise<Map<string, number>> {
  const file = `${cacheDir}timestamps.json`;
  const cache = (readCache(file) as Record<string, number> | undefined) ?? {};
  const want = [...new Set([...blocks].map((b) => BigInt(b).toString()))].filter((b) => cache[b] === undefined);
  for (let i = 0; i < want.length; i += BATCH) {
    const slice = want.slice(i, i + BATCH);
    const headers = await rpcBatch(slice.map((b) => ({ method: "eth_getBlockByNumber", params: [`0x${BigInt(b).toString(16)}`, false] })));
    headers.forEach((h, j) => (cache[slice[j]] = Number(BigInt(h.timestamp))));
    if ((i / BATCH) % 20 === 19 || i + BATCH >= want.length) writeCache(file, { ...((readCache(file) as Record<string, number> | undefined) ?? {}), ...cache });
    await sleep(PAUSE_MS);
  }
  const out = new Map<string, number>();
  for (const b of blocks) out.set(BigInt(b).toString(), cache[BigInt(b).toString()]);
  return out;
}

/** First block whose timestamp is >= ts (binary search over headers). */
export async function blockAtOrAfter(ts: number, lo = 40_000_000n, hi = 60_000_000n): Promise<bigint> {
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const t = (await blockTimestamps([mid])).get(mid.toString())!;
    if (t >= ts) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/**
 * Historical eth_call results (hex) at given blocks, batched against STATE_RPC and cached in
 * gauge/cache/squeeze/archive-calls.json by (to, data, block): a rerun never asks twice. Needs an archive RPC.
 */
export async function archiveCalls(calls: { to: string; data: string; block: bigint | number }[]): Promise<string[]> {
  const file = `${cacheDir}archive-calls.json`;
  const cache = (readCache(file) as Record<string, string> | undefined) ?? {};
  const key = (c: { to: string; data: string; block: bigint | number }) => `${c.to.toLowerCase()}|${c.data.toLowerCase()}|${BigInt(c.block)}`;
  const want = [...new Map(calls.map((c) => [key(c), c])).values()].filter((c) => cache[key(c)] === undefined);
  for (let i = 0; i < want.length; i += BATCH) {
    const slice = want.slice(i, i + BATCH);
    const out = await rpcBatch(slice.map((c) => ({ method: "eth_call", params: [{ to: c.to, data: c.data }, `0x${BigInt(c.block).toString(16)}`] })));
    out.forEach((r, j) => (cache[key(slice[j])] = r));
    if ((i / BATCH) % 20 === 19 || i + BATCH >= want.length) writeCache(file, { ...((readCache(file) as Record<string, string> | undefined) ?? {}), ...cache });
    await sleep(PAUSE_MS);
  }
  return calls.map((c) => cache[key(c)]);
}
