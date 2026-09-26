import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, encodeAbiParameters, encodeEventTopics, pad, toHex } from "viem";
import { getLogsHalving, isLogCap, redact, robinhood, robinhoodTestnet, rotating } from "../src/chain.ts";
import { vexiVenueEvents } from "../src/vexi-abi.ts";

/** A fake JSON-RPC endpoint: answers eth_chainId with `chainId`, eth_blockNumber with `block`, or fails. */
function fakeRpc(chainId: number, block: number, fail = false): Promise<{ url: string; hits: () => number; close: () => void }> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method } = JSON.parse(body);
      if (method !== "eth_chainId") hits++;
      if (fail && method !== "eth_chainId") {
        res.writeHead(500).end("boom");
        return;
      }
      const result = method === "eth_chainId" ? `0x${chainId.toString(16)}` : `0x${block.toString(16)}`;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as any;
      resolve({ url: `http://127.0.0.1:${port}/secret-key-abc`, hits: () => hits, close: () => server.close() });
    }),
  );
}

test("requests rotate across endpoints on the right chain, a wrong-chain endpoint is dropped", async () => {
  const a = await fakeRpc(4663, 100);
  const b = await fakeRpc(4663, 100);
  const wrong = await fakeRpc(46630, 999);
  const client = createPublicClient({ chain: robinhood, transport: rotating([a.url, wrong.url, b.url], 4663) });
  for (let i = 0; i < 6; i++) assert.equal(await client.getBlockNumber({ cacheTime: 0 }), 100n);
  assert.equal(wrong.hits(), 0, "the testnet endpoint never served a mainnet request");
  assert.equal(a.hits(), 3);
  assert.equal(b.hits(), 3);
  [a, b, wrong].forEach((s) => s.close());
});

test("a failing endpoint hands the request to the next one", async () => {
  const bad = await fakeRpc(4663, 1, true);
  const good = await fakeRpc(4663, 7);
  const client = createPublicClient({ chain: robinhood, transport: rotating([bad.url, good.url], 4663) });
  for (let i = 0; i < 4; i++) assert.equal(await client.getBlockNumber({ cacheTime: 0 }), 7n);
  [bad, good].forEach((s) => s.close());
});

test("when every endpoint fails, the error names no URL", async () => {
  const bad = await fakeRpc(4663, 1, true);
  const client = createPublicClient({ chain: robinhood, transport: rotating([bad.url], 4663) });
  await assert.rejects(client.getBlockNumber({ cacheTime: 0 }), (e: any) => {
    const text = `${e?.message} ${e?.shortMessage} ${e?.details}`;
    assert.ok(!text.includes("secret-key-abc"), text);
    return true;
  });
  bad.close();
});

test("redact removes URLs from free text", () => {
  assert.equal(redact("failed: https://x.example/v2/abcdef123 timed out"), "failed: <url> timed out");
});

test("a URL that answers 4663 is dropped from the 46630 ring", async () => {
  const mainnetUrl = await fakeRpc(4663, 1);
  const testnetUrl = await fakeRpc(46630, 5);
  const client = createPublicClient({ chain: robinhoodTestnet, transport: rotating([mainnetUrl.url, testnetUrl.url], 46630) });
  for (let i = 0; i < 3; i++) assert.equal(await client.getBlockNumber({ cacheTime: 0 }), 5n);
  assert.equal(mainnetUrl.hits(), 0, "the mainnet endpoint never served a testnet request");
  assert.equal(testnetUrl.hits(), 3);
  [mainnetUrl, testnetUrl].forEach((s) => s.close());
});

const CAP_MESSAGE = "logs matched by query exceeds limit of 10000";

/**
 * A fake eth_getLogs endpoint: one Fixed-shaped log per block (id = block number), refusing any range wider than `cap`
 * blocks the way the public endpoint refuses more than 10,000 logs, or with a bare HTTP 500 when `how` is "http".
 */
function fakeLogsRpc(chainId: number, cap: number, how: "cap" | "http" = "cap"): Promise<{ url: string; refusals: () => number; close: () => void }> {
  let refusals = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      const reply = (r: Record<string, unknown>) =>
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...r }));
      if (method === "eth_chainId") return reply({ result: `0x${chainId.toString(16)}` });
      if (method !== "eth_getLogs") return reply({ error: { code: -32601, message: "not served here" } });
      const from = BigInt(params[0].fromBlock);
      const to = BigInt(params[0].toBlock);
      if (to - from + 1n > BigInt(cap)) {
        refusals++;
        if (how === "http") return res.writeHead(500).end("boom");
        return reply({ error: { code: -32000, message: CAP_MESSAGE } });
      }
      const logs = [];
      for (let b = from; b <= to; b++) {
        logs.push({
          address: params[0].address,
          topics: encodeEventTopics({ abi: [vexiVenueEvents.Fixed], eventName: "Fixed", args: { id: b } }),
          data: encodeAbiParameters([{ type: "uint256" }, { type: "uint32" }, { type: "uint32" }, { type: "uint16" }], [b * 1000n, 1n, 2n, 5n]),
          blockNumber: toHex(b),
          blockHash: pad("0x1"),
          transactionHash: pad(toHex(b)),
          transactionIndex: "0x0",
          logIndex: "0x0",
          removed: false,
        });
      }
      reply({ result: logs });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as any;
      resolve({ url: `http://127.0.0.1:${port}/secret-key-abc`, refusals: () => refusals, close: () => server.close() });
    }),
  );
}

const VENUE = "0x0000000000000000000000000000000000000abc" as const;

test("getLogsHalving halves on the 10,000-log refusal, keeps order, and caches the whole", async () => {
  const rpc = await fakeLogsRpc(46630, 4);
  const client = createPublicClient({ chain: robinhoodTestnet, transport: rotating([rpc.url], 46630) });
  const cacheFile = join(mkdtempSync(join(tmpdir(), "hakari-halving-")), "fixed.json");
  const ranges: string[] = [];
  const filter = { address: VENUE, event: vexiVenueEvents.Fixed };
  const logs = await getLogsHalving(client, filter, 100n, 115n, cacheFile, { pauseMs: 0, attempts: 1, onRange: (f, t, n) => ranges.push(`${f}-${t}:${n}`) });
  assert.equal(logs.length, 16);
  assert.deepEqual(ranges, ["100-103:4", "104-107:4", "108-111:4", "112-115:4"], "16 refused, both halves of 8 refused, four quarters served");
  assert.ok(rpc.refusals() >= 3, "the full range and both halves were refused");
  assert.deepEqual(logs.map((l) => l.args.id), Array.from({ length: 16 }, (_, i) => String(100 + i)));
  assert.equal(logs[3].args.sStarWad, "103000");
  assert.equal(logs[0].eventName, "Fixed");
  assert.ok(existsSync(cacheFile));
  rpc.close();
  const again = await getLogsHalving(client, filter, 100n, 115n, cacheFile);
  assert.deepEqual(again, logs, "served from the cache with the endpoint gone");
});

test("any other refusal is retried and then halved too", async () => {
  const rpc = await fakeLogsRpc(46630, 8, "http");
  const client = createPublicClient({ chain: robinhoodTestnet, transport: rotating([rpc.url], 46630) });
  const cacheFile = join(mkdtempSync(join(tmpdir(), "hakari-halving-")), "fixed.json");
  const logs = await getLogsHalving(client, { address: VENUE, event: vexiVenueEvents.Fixed }, 0n, 15n, cacheFile, { pauseMs: 0, attempts: 1 });
  assert.equal(logs.length, 16);
  assert.ok(rpc.refusals() >= 1);
  rpc.close();
});

test("a single block that still exceeds the cap is reported, with no URL in the message", async () => {
  const rpc = await fakeLogsRpc(46630, 0);
  const client = createPublicClient({ chain: robinhoodTestnet, transport: rotating([rpc.url], 46630) });
  const cacheFile = join(mkdtempSync(join(tmpdir(), "hakari-halving-")), "fixed.json");
  await assert.rejects(getLogsHalving(client, { address: VENUE, event: vexiVenueEvents.Fixed }, 7n, 7n, cacheFile, { pauseMs: 0, attempts: 1 }), (e: any) => {
    assert.ok(String(e?.message).includes("Fixed 7-7"), e?.message);
    assert.ok(!String(e?.message).includes("secret-key-abc"), e?.message);
    return true;
  });
  assert.ok(!existsSync(cacheFile), "nothing cached after a failure");
  rpc.close();
});

test("isLogCap recognises the public endpoint's refusal and nothing else", () => {
  assert.ok(isLogCap(CAP_MESSAGE));
  assert.ok(isLogCap("query returned more than 10000 results"));
  assert.ok(!isLogCap("request timed out"));
  assert.ok(!isLogCap("HTTP request failed"));
});
