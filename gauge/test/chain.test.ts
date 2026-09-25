import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createPublicClient } from "viem";
import { redact, robinhood, rotating } from "../src/chain.ts";

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
