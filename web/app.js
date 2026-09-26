// HAKARI gauge page. Static: reads gauge/data/*.json, and talks to Robinhood Chain 4663 read-only
// through viem (eth_call with a state override carrying PushCostLens's runtime code).
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, encodeAbiParameters, formatUnits, parseAbi } from "https://esm.sh/viem@2.56.9";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const LENS_AT = "0x4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a";
const PCTS = [1, 5, 10];
const ticksForPct = (pct) => Math.round(Math.log(1 + pct / 100) / Math.log(1.0001));
const $ = (id) => document.getElementById(id);
const fmt = (x, d = 2) => Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const erc20Abi = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

// batch: requests issued together (a pool's reads, the two push ladders) go out as one JSON-RPC batch; the public RPC
// rate-limits bursts, so a 429 is retried with backoff (0.4, 0.8, 1.6, 3.2 s) before the page reports it
const client = createPublicClient({ transport: http(RPC, { batch: true, retryCount: 4, retryDelay: 400 }) });
const load = (p) => fetch(p).then((r) => (r.ok ? r.json() : null)).catch(() => null);

const WEEKEND = "2026-09-18";
const [ladder, hims, delta, mint, lensArtifact, weekend] = await Promise.all([
  load("../gauge/data/ladder.json"),
  load("../gauge/data/hims-replay.json"),
  load("../gauge/data/delta.json"),
  load("../gauge/data/mint-window.json"),
  load("lens-artifact.json"),
  load(`../gauge/data/weekend-${WEEKEND}.json`),
]);
const decisionFiles = [
  "tsla-shaped-weekend", "tsla-shaped-weekday-60s", "tsla-shaped-weekday-12s", "tsla-shaped-weekend-held-push",
  "thin-pool-held-push", "thin-pool-held-until-converged", "deep-pool-genuine-surge", "thin-pool-genuine-surge",
];
const decisions = (await Promise.all(decisionFiles.map((f) => load(`decisions/${f}.json`)))).filter(Boolean);

// the snapshot's block and time are shown with §4's table (renderLadder), not in the hero
if (!ladder) $("ladder-meta").textContent = "no snapshot found (run npm run ladder in gauge/)";

// ───────── 1. cost ladder ─────────
function renderLadder(data) {
  const t = $("ladder");
  const head = `<tr><th>pool</th><th>price (USDG)</th>${PCTS.map((p) => `<th>+${p}% cost</th><th>+${p}% capital</th>`).join("")}${PCTS.map((p) => `<th>−${p}% cost</th>`).join("")}</tr>`;
  const rows = data.pools.map((p) => {
    const cell = (pct, dir, key) => {
      const e = p.entries.find((x) => x.pct === pct && x.direction === dir);
      if (!e) return "<td>—</td>";
      if (key === "cost") return `<td title="${e.ticks} ticks">${fmt(e.costQuoteHuman)}</td>`;
      return `<td>${e.inputToken === "quote" ? fmt(e.amountInHuman, 0) : fmt(e.amountInHuman, 2) + " stock"}</td>`;
    };
    return `<tr><td>${p.name}${p.stockSymbol ? ` <span class="meta">stock</span>` : ""}</td><td>${fmt(p.priceQuote, 4)}</td>${PCTS.map((pct) => cell(pct, "up", "cost") + cell(pct, "up", "cap")).join("")}${PCTS.map((pct) => cell(pct, "down", "cost")).join("")}</tr>`;
  });
  t.innerHTML = head + rows.join("");
  $("ladder-meta").textContent = `block ${Number(data.block).toLocaleString()} · ${new Date(data.timestamp * 1000).toUTCString()}`;
}
if (ladder) renderLadder(ladder);

// ───────── max safe exposure (pure: no DOM, no network; gauge/test/web-max-safe.test.ts runs this block in node) ─────────
// CostModel.maxSafeExposure with nobody pushing back (arbReversionSeconds = 0: a stock token while the mint window is
// closed), from the same view walk the contract runs: PushCostLens.roundTripCosts(key, LADDER, up, MAX_WALK_STEPS), once
// per tick direction. For every ladder move x, both tick directions: the round trip of pushing the price x ticks and
// selling straight back, in the quote, ÷ what that move earns per unit of exposure. The smallest ratio is the bound, in
// the quote's raw units; `complete` false means the walk hit its step cap, so the bound is "at least this". Same as
// gauge/src/replay.ts maxSafeExposure, which is pinned to the Solidity.
const LADDER = [50, 100, 200, 488, 953, 1823]; // CostModel.ladder(): 50 to 1,823 ticks, +0.5 to +20 % up, −0.5 to −16.7 % down
const MAX_WALK_STEPS = 256; // SafeSettle.MAX_WALK_STEPS, shared by the six widths of one walk
const gainPerUnit = (x, assetUp) => (assetUp ? Math.pow(1.0001, x) - 1 : 1 - Math.pow(1.0001, -x));
// walkUp / walkDown: roundTripCosts(key, ticks, up, …) as decoded, [costInCurrency0[], costInCurrency1[], complete[]]
function maxSafeFromQuotes(walkUp, walkDown, ticks, quoteIsCurrency0) {
  let binding;
  const rungs = [];
  ticks.forEach((x, i) => {
    for (const up of [true, false]) {
      const [in0, in1, ok] = up ? walkUp : walkDown;
      // the payout follows the asset; with the quote as currency0 the asset moves against the tick
      const assetUp = quoteIsCurrency0 ? !up : up;
      const cost = BigInt(quoteIsCurrency0 ? in0[i] : in1[i]);
      const gain = gainPerUnit(x, assetUp);
      const r = { ticks: x, up, assetUp, cost, gain, exposure: Number(cost) / gain, complete: Boolean(ok[i]) };
      rungs.push(r);
      if (!binding || r.exposure < binding.exposure) binding = r;
    }
  });
  return { exposure: binding.exposure, binding, rungs };
}

// ───────── lens over state override ─────────
let lensCode;
async function lens() {
  if (lensCode) return lensCode;
  if (!lensArtifact) throw new Error("web/lens-artifact.json missing: run npm run export-lens in gauge/");
  const args = encodeAbiParameters([{ type: "address" }], [POOL_MANAGER]);
  const { data } = await client.call({ data: lensArtifact.creationBytecode + args.slice(2) });
  if (!data || data === "0x") throw new Error("could not simulate the lens deployment");
  lensCode = data;
  return data;
}
async function lensCall(functionName, args, blockNumber) {
  const code = await lens();
  const data = encodeFunctionData({ abi: lensArtifact.abi, functionName, args });
  const { data: out } = await client.call({ to: LENS_AT, data, blockNumber, stateOverride: [{ address: LENS_AT, code }] });
  return decodeFunctionResult({ abi: lensArtifact.abi, functionName, data: out });
}
const quoteLadder = (key, ticks, up, blockNumber) => lensCall("quotePushLadder", [key, ticks, up], blockNumber);
const walkLadder = (key, ticks, up, blockNumber) => lensCall("roundTripCosts", [key, ticks, up, BigInt(MAX_WALK_STEPS)], blockNumber);
// Moves past SafeSettle's ladder, asset up (+30, +50, +100 %): priced for the page only, never part of the bound.
const BEYOND = [2624, 4055, 6932];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// Three round trips, each one JSON-RPC batch: (the caller's block), the pool + its tokens + the lens code, then the
// ladder both ways, twice: exact swaps (two quotePushLadder eth_calls: the +1/5/10 % rows) and the view walk SafeSettle
// runs (two roundTripCosts eth_calls: the bound). With `beyond`, one more exact quotePushLadder past the ladder.
async function measurePool(key, quoteIsCurrency0, blockNumber, progress = () => {}, { beyond = false } = {}) {
  const id = keyId(key);
  const quoteToken = quoteIsCurrency0 ? key.currency0 : key.currency1;
  const decimalsOf = (a) => (a === ZERO_ADDRESS ? 18 : client.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }));
  progress("reading the pool, its tokens and the lens bytecode");
  const [[sqrtPriceX96, tick, protocolFee, lpFee], liquidity, d0, d1, quoteSymbol] = await Promise.all([
    client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [id], blockNumber }),
    client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [id], blockNumber }),
    decimalsOf(key.currency0),
    decimalsOf(key.currency1),
    quoteToken === ZERO_ADDRESS ? "ETH" : client.readContract({ address: quoteToken, abi: erc20Abi, functionName: "symbol" }).catch(() => "quote"),
    lens(),
  ]);
  if (sqrtPriceX96 === 0n) throw new Error("pool not initialized: check the key");
  progress(`pushing the price ${LADDER.length} distances each way through the lens and straight back, and walking the same ${LADDER.length} as SafeSettle does (${beyond ? 5 : 4} eth_calls)`);
  // asset up is tick up when the quote is currency1, tick down when it is currency0
  const [qsUp, qsDown, walkUp, walkDown, past] = await Promise.all([
    quoteLadder(key, LADDER, true, blockNumber),
    quoteLadder(key, LADDER, false, blockNumber),
    walkLadder(key, LADDER, true, blockNumber),
    walkLadder(key, LADDER, false, blockNumber),
    beyond ? quoteLadder(key, BEYOND, !quoteIsCurrency0, blockNumber).catch(() => null) : null,
  ]);
  const quoteDec = Number(quoteIsCurrency0 ? d0 : d1);
  const baseDec = Number(quoteIsCurrency0 ? d1 : d0);
  const entries = [];
  for (const [up, qs] of [[true, qsUp], [false, qsDown]]) {
    PCTS.forEach((pct) => {
      const i = LADDER.indexOf(ticksForPct(pct));
      if (i < 0) return;
      const q = qs[i];
      const quoteUp = quoteIsCurrency0 ? !up : up;
      const costQuote = quoteIsCurrency0 ? q.costInCurrency0 : q.costInCurrency1;
      const inputIsQuote = quoteIsCurrency0 ? q.zeroForOne : !q.zeroForOne;
      // move: the asset's actual move for these ticks (−5 % nominal is 488 ticks down, −4.8 %), as the bound's table labels it
      const move = `${quoteUp ? "+" : "−"}${fmt(gainPerUnit(LADDER[i], quoteUp) * 100, 1)} %`;
      entries.push({ pct, direction: quoteUp ? "up" : "down", move, ticks: LADDER[i], reached: q.sqrtPriceReached === q.sqrtPriceTarget, inputToken: inputIsQuote ? "quote" : "base", amountInHuman: formatUnits(q.amountIn, inputIsQuote ? quoteDec : baseDec), costQuoteHuman: formatUnits(costQuote, quoteDec) });
    });
  }
  entries.sort((a, b) => (a.direction === b.direction ? a.pct - b.pct : a.direction === "up" ? -1 : 1));
  const bound = maxSafeFromQuotes(walkUp, walkDown, LADDER, quoteIsCurrency0);
  const pastLadder = past?.map((q, i) => {
    const cost = BigInt(quoteIsCurrency0 ? q.costInCurrency0 : q.costInCurrency1);
    const gain = gainPerUnit(BEYOND[i], true);
    return { ticks: BEYOND[i], gain, cost, exposure: Number(cost) / gain, reached: q.sqrtPriceReached === q.sqrtPriceTarget };
  });
  const raw = Number(sqrtPriceX96) / 2 ** 96;
  const p1per0 = raw * raw * 10 ** (Number(d0) - Number(d1));
  return { id, tick, lpFee, protocolFee, liquidity: liquidity.toString(), priceQuote: quoteIsCurrency0 ? 1 / p1per0 : p1per0, entries, bound, pastLadder, quoteDec, quoteSymbol };
}
function keyId(key) {
  const enc = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]);
  return keccak(enc);
}
// keccak256 via viem's export would be cleaner; esm.sh exposes it too
import { keccak256 } from "https://esm.sh/viem@2.56.9";
function keccak(hex) { return keccak256(hex); }

$("refresh").onclick = async () => {
  const b = $("refresh");
  b.disabled = true;
  try {
    const block = await client.getBlock();
    const pools = [];
    for (const p of ladder.pools) {
      const key = presets.find((x) => x.id === p.id);
      const m = await measurePool(key, key.quoteIsCurrency0, block.number);
      pools.push({ ...p, ...m });
    }
    renderLadder({ block: block.number.toString(), timestamp: Number(block.timestamp), pools });
  } catch (e) {
    $("ladder-meta").innerHTML = `<span class="err">${e.shortMessage ?? e.message}</span>`;
  } finally {
    b.disabled = false;
  }
};

// ───────── 2. HIMS replay ─────────
// On a phone the chart keeps a 560-unit canvas at 1:1 and scrolls sideways (.chartwrap) instead of shrinking its text.
function chart(el, { width = el.clientWidth && el.clientWidth < 720 ? 560 : 960, height = 260, pad = { l: 56, r: 24, t: 20, b: 44 } }, draw, caption) {
  const svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${caption}" style="width:100%;height:auto;min-width:${width < 960 ? width : 0}px">${draw({ width, height, pad, iw: width - pad.l - pad.r, ih: height - pad.t - pad.b })}</svg>`;
  el.innerHTML = `<div class="chartwrap">${svg}</div><figcaption>${caption}</figcaption>`;
}
if (hims) {
  const pts = hims.points;
  // band layout: each point sits mid-band, so the first and last labels and bars stay inside the plot
  const x = (i, g) => g.pad.l + ((i + 0.5) / pts.length) * g.iw;
  const labels = pts.map((p) => new Date(p.timestamp * 1000).toISOString().slice(5, 16).replace("T", " ") + "Z");
  chart($("hims-price"), {}, (g) => {
    const vals = pts.map((p) => p.usdgPerHims);
    const lo = Math.min(hims.nyseCloseFriday, ...vals) * 0.85;
    const hi = Math.max(...vals) * 1.05;
    const y = (v) => g.pad.t + (1 - (v - lo) / (hi - lo)) * g.ih;
    const ticks = [30, 40, 50];
    let s = ticks.map((t) => `<line class="grid" x1="${g.pad.l}" x2="${g.pad.l + g.iw}" y1="${y(t)}" y2="${y(t)}"/><text x="${g.pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("");
    s += `<line class="axis" x1="${g.pad.l}" x2="${g.pad.l + g.iw}" y1="${g.pad.t + g.ih}" y2="${g.pad.t + g.ih}"/>`;
    s += `<line class="nyse" x1="${g.pad.l}" x2="${g.pad.l + g.iw}" y1="${y(hims.nyseCloseFriday)}" y2="${y(hims.nyseCloseFriday)}"/><text x="${g.pad.l + 6}" y="${y(hims.nyseCloseFriday) + 16}" text-anchor="start">NYSE close ${hims.nyseCloseFriday}</text>`;
    s += `<polyline class="price" points="${pts.map((p, i) => `${x(i, g)},${y(p.usdgPerHims)}`).join(" ")}"/>`;
    pts.forEach((p, i) => {
      s += `<circle class="price-dot" r="5" cx="${x(i, g)}" cy="${y(p.usdgPerHims)}"><title>${labels[i]} · ${fmt(p.usdgPerHims, 4)} USDG · mint window ${p.mintWindowClosed ? "closed" : "open"}</title></circle>`;
      s += `<text class="label" x="${x(i, g)}" y="${y(p.usdgPerHims) - 12}" text-anchor="middle">${fmt(p.usdgPerHims, 2)}</text>`;
      s += `<text x="${x(i, g)}" y="${g.pad.t + g.ih + 18}" text-anchor="middle">${labels[i]}</text>`;
      s += `<text x="${x(i, g)}" y="${g.pad.t + g.ih + 34}" text-anchor="middle" style="font-size:11px">${p.mintWindowClosed ? "mint closed" : "mint open"}</text>`;
    });
    return s;
  }, "HIMS/USDG pool price in USDG at the five observation points (time axis not to scale). Dashed: Friday NYSE close.");
  chart($("hims-cost"), {}, (g) => {
    const vals = pts.map((p) => Number(p.pushUp10.roundTripCostUsdg));
    const hi = Math.max(...vals) * 1.15;
    const y = (v) => g.pad.t + (1 - v / hi) * g.ih;
    const bw = Math.min(64, g.iw / pts.length / 2);
    let s = [0, 500, 1000].map((t) => `<line class="grid" x1="${g.pad.l}" x2="${g.pad.l + g.iw}" y1="${y(t)}" y2="${y(t)}"/><text x="${g.pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("");
    s += `<line class="axis" x1="${g.pad.l}" x2="${g.pad.l + g.iw}" y1="${g.pad.t + g.ih}" y2="${g.pad.t + g.ih}"/>`;
    pts.forEach((p, i) => {
      const v = vals[i];
      const top = y(v);
      const h = Math.max(2, g.pad.t + g.ih - top);
      s += `<rect class="cost" x="${x(i, g) - bw / 2}" y="${top}" width="${bw}" height="${h}" rx="4" ry="4"><title>${labels[i]} · push +10 % costs ${fmt(v)} USDG (capital ${fmt(p.pushUp10.usdgIn, 0)} USDG)</title></rect>`;
      s += `<text class="label" x="${x(i, g)}" y="${top - 6}" text-anchor="middle">${fmt(v, 0)}</text>`;
      s += `<text x="${x(i, g)}" y="${g.pad.t + g.ih + 18}" text-anchor="middle">${labels[i]}</text>`;
    });
    return s;
  }, "Round-trip cost of pushing HIMS +10 %, in USDG, from the rebuilt pool at each point. It collapses ~100× while the mint window is shut and nobody can arbitrage.");
  // the headline column (max safe exposure) and the price come first, so they stay in view without scrolling the table
  $("hims-table").innerHTML = `<tr><th>block</th><th>time (UTC)</th><th>mint window</th><th>max safe exposure (USDG)</th><th>USDG/HIMS</th><th>+10 % cost (USDG)</th><th>+10 % capital (USDG)</th><th>HIMS in pool</th><th>USDG in pool</th><th>live positions</th><th>+85 % capital (USDG)</th><th>rebuilt L = Swap L</th></tr>` + pts.map((p) => `<tr><td>${Number(p.block).toLocaleString()}</td><td>${p.time.slice(0, 19).replace("T", " ")}</td><td><span class="pill ${p.mintWindowClosed ? "closed" : "open"}">${p.mintWindowClosed ? "closed" : "open"}</span></td><td><b>${fmt(p.maxSafeExposureUsdg.usdg, 0)}</b></td><td>${fmt(p.usdgPerHims, 4)}</td><td>${fmt(p.pushUp10.roundTripCostUsdg)}</td><td>${fmt(p.pushUp10.usdgIn, 0)}</td><td>${fmt(p.himsPrincipal)}</td><td>${fmt(p.usdgPrincipal, 0)}</td><td>${p.livePositions}</td><td>${fmt(p.pushUp85.usdgIn, 0)}</td><td>${p.liquidityMatches ? "yes" : "NO"}</td></tr>`).join("");
}

// ───────── weekend, 13 stock pools ─────────
if (weekend) {
  const rows = weekend.series.filter((r) => r.fridayMaxSafeExposure && r.weekendMinMaxSafeExposure)
    .map((r) => ({ ...r, ratio: r.weekendMinMaxSafeExposure / r.fridayMaxSafeExposure })).sort((a, b) => a.ratio - b.ratio);
  $("weekend-fig").innerHTML = `<div class="chartwrap"><img src="../docs/img/weekend-${WEEKEND}.svg" alt="Friday vs weekend: the largest settlement each stock pool could carry" style="width:100%;height:auto;border-radius:10px"></div>` +
    `<div class="tablewrap"><table><tr><th>stock</th><th>Friday max safe exposure</th><th>weekend minimum</th><th>weekend ÷ Friday</th><th>Friday +10 % cost</th><th>rebuild = chain</th></tr>` +
    rows.map((r) => `<tr><td>${r.symbol}${r.hooked ? " †" : ""}</td><td>${fmt(r.fridayMaxSafeExposure, 0)}</td><td>${fmt(r.weekendMinMaxSafeExposure, 0)}</td><td>×${fmt(r.ratio, 2)}</td><td>${fmt(r.fridayCostUp10)}</td><td>${r.allLiquidityMatches ? "yes" : "no"}</td></tr>`).join("") + `</table></div>` +
    (rows.some((r) => r.hooked) ? `<p class="meta">† Hooked pool: the hook's own charges are not in the bound, so it may read low (conservative).</p>` : "");
} else {
  $("weekend-lead").append(" (run npm run discover and npm run weekend -- " + WEEKEND + " in gauge/)");
}

// ───────── 3. paste a pool ─────────
const presets = [
  { name: "TSLA/USDG", id: "0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e", currency0: "0x322f0929c4625ed5bad873c95208d54e1c003b2d", currency1: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000", quoteIsCurrency0: false, stock: "TSLA" },
  { name: "NVDA/USDG", id: "0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1", currency0: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", currency1: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000", quoteIsCurrency0: true, stock: "NVDA" },
  { name: "HIMS/USDG", id: "0x68d4f28f1432e0ad714658853edb2e6b0b1ac4060355ff3d169fea656b1d1c52", currency0: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", currency1: "0xccee82fe024c36fa15e1005ede3e9e4787e23d09", fee: 9000, tickSpacing: 90, hooks: "0x0000000000000000000000000000000000000000", quoteIsCurrency0: true, stock: "HIMS" },
  { name: "AI/USDG (memecoin)", id: "0x508ab5b7a7b447598017eba58530c2a2a5d647b8074a2dc85aa533dfbed4d543", currency0: "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18", currency1: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", fee: 25000, tickSpacing: 500, hooks: "0x0000000000000000000000000000000000000000", quoteIsCurrency0: false },
];
$("preset").innerHTML = presets.map((p, i) => `<option value="${i}">${p.name}</option>`).join("") + `<option value="-1">custom</option>`;
function fillPreset(i) {
  const p = presets[i];
  if (!p) return;
  $("c0").value = p.currency0; $("c1").value = p.currency1; $("fee").value = p.fee; $("ts").value = p.tickSpacing; $("hooks").value = p.hooks; $("quote").value = p.quoteIsCurrency0 ? "0" : "1";
}
$("preset").onchange = (e) => fillPreset(Number(e.target.value));
fillPreset(0);

function mintWindowClosed(at) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", weekday: "short", hour: "numeric", hour12: false }).formatToParts(at);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday").value);
  const hour = Number(parts.find((p) => p.type === "hour").value) % 24;
  return (day === 6 && hour >= 2) || day === 0 || (day === 1 && hour < 2);
}

$("measure").onclick = async () => {
  const b = $("measure");
  const out = $("measure-out");
  b.disabled = true;
  const t0 = performance.now();
  const say = (step) => { out.innerHTML = `<p class="meta">Measuring · ${step}…</p>`; };
  say("reading the latest block");
  try {
    const key = { currency0: $("c0").value.trim().toLowerCase(), currency1: $("c1").value.trim().toLowerCase(), fee: Number($("fee").value), tickSpacing: Number($("ts").value), hooks: $("hooks").value.trim().toLowerCase() };
    const quoteIsCurrency0 = $("quote").value === "0";
    const block = await client.getBlock();
    const m = await measurePool(key, quoteIsCurrency0, block.number, (s) => say(`${s} at block ${Number(block.number).toLocaleString()}`), { beyond: true });
    const preset = presets.find((p) => p.id === m.id);
    const d = delta?.pools.find((p) => p.id === m.id);
    const closed = mintWindowClosed(new Date());
    const five = m.entries.find((e) => e.pct === 5 && e.direction === "up");
    const unit = esc(m.quoteSymbol); // a pasted pool's token picks its own symbol: never raw HTML
    const asset = preset?.stock ?? "the other token";
    const baseLabel = preset?.stock ?? "base";
    const toHuman = (raw) => Number(raw) / 10 ** m.quoteDec;
    const amount = (x) => (x !== 0 && Math.abs(x) < 0.01 ? x.toExponential(2) : fmt(x, x < 100 ? 2 : 0));
    // a bound is shown rounded down, at the precision `amount` uses, so the page never shows a number SafeSettle refuses
    const amountDown = (x) => {
      if (x >= 100) return fmt(Math.floor(x), 0);
      if (x >= 0.01) return fmt(Math.floor(x * 100) / 100, 2);
      if (x <= 0) return fmt(0, 2);
      const e = Math.floor(Math.log10(x));
      return `${(Math.floor((x / 10 ** e) * 100) / 100).toFixed(2)}e${e}`;
    };
    const moveOf = (r) => `${r.assetUp ? "+" : "−"}${fmt(r.gain * 100, 1)} %`;
    const bnd = m.bound.binding;
    const safe = toHuman(m.bound.exposure);
    const atLeast = bnd.complete ? "" : " (at least)";
    const hooked = key.hooks !== ZERO_ADDRESS;
    const rungs = [...m.bound.rungs].sort((a, b) => a.ticks - b.ticks || Number(b.assetUp) - Number(a.assetUp));
    // SafeSettle's ladder stops at 1,823 ticks (+20 %). Past it a thin book can be cheaper to fake per unit earned: the
    // exact pushes past the ladder say whether this pool is one (README § Limitations). They never change the bound.
    const top = bnd.ticks === LADDER[LADDER.length - 1];
    const past = (m.pastLadder ?? []).filter((r) => r.reached).reduce((a, r) => (!a || r.exposure < a.exposure ? r : a), null);
    const pastLower = past && past.exposure < m.bound.exposure;
    const limits = `<a href="https://github.com/vexi-v1/vexi-hakari#limitations">README § Limitations</a>`;
    // When a push past the ladder breaks even lower, the headline is that lower figure and SafeSettle v1's line is shown
    // next to it, labelled: the page never leads with a number its own next paragraph calls too high.
    const pastNote = pastLower
      ? `<p>SafeSettle v1 decides on <b>${amountDown(safe)} ${unit}</b>${atLeast} <span class="nowrap">(binding move: ${moveOf(bnd)})</span>, ${top ? "the top of its ladder, which stops there" : "from a ladder that stops at +20 %"}. Past it this pool's liquidity thins, so a bigger fake costs less per ${unit} it earns: pushing ${asset} +${fmt(past.gain * 100, 0)} % costs <b>${amount(toHuman(past.cost))} ${unit}</b> here (exact swaps, outside SafeSettle's rule), so it pays for itself once about ${amountDown(toHuman(past.exposure))} ${unit} settles on this price. SafeSettle v1 would still settle an exposure between the two figures (${limits}).</p>`
      : top
        ? `<p class="meta">SafeSettle's largest move (${moveOf(bnd)}) sets this line, and its ladder stops there. ${m.pastLadder ? `On this pool a bigger fake (+30, +50, +100 %) is not cheaper per ${unit} it earns.` : `A bigger fake could be cheaper per ${unit} it earns if this pool's liquidity thins past it, and the true bound lower`} (${limits}).</p>`
        : "";
    out.innerHTML = `
      <p><b>${preset?.name ?? "pool"}</b> <code>${m.id}</code> · block ${Number(block.number).toLocaleString()} · <span class="meta">measured in ${fmt((performance.now() - t0) / 1000, 1)} s</span></p>
      <div class="safe">
        ${pastLower
          ? `<p class="safe-line">Largest settlement this pool can safely carry right now, if nobody pushes back: at most <b>${amountDown(toHuman(past.exposure))} ${unit}</b> <span class="nowrap">(pushing ${asset} +${fmt(past.gain * 100, 0)} %, past SafeSettle's ladder)</span></p>`
          : `<p class="safe-line">Largest settlement this pool can safely carry right now, if nobody pushes back: <b>${amountDown(safe)} ${unit}</b>${atLeast} <span class="nowrap">(binding move: ${moveOf(bnd)})</span></p>`}
        ${pastNote}
        <p>Why: of SafeSettle's twelve moves (50 to 1,823 ticks: +0.5 to +20 % up, −0.5 to −16.7 % down), the cheapest to fake per ${unit} it earns is ${asset} ${moveOf(bnd)}: <b>${amount(toHuman(bnd.cost))} ${unit}</b> in fees there and straight back, shifting every payout on this price by ${fmt(bnd.gain * 100, 1)} % of its size, so from about ${amountDown(safe)} ${unit} settling on it the fake pays for itself.</p>
        <p class="meta">On a pool carrying HAKARI's hook, SafeSettle refuses any settlement whose total exposure on this price is at or above ${amountDown(safe)} ${unit} (lower still if the hook's two TWAPs disagree by more than 10 ticks). “Nobody pushes back” is <code>arbReversionSeconds = 0</code>, the case while the mint window is closed; with arbitrage open the attacker must re-push after every pull-back and the bound is higher. Computed as <code>CostModel.maxSafeExposure</code> computes it, from the same view walk (<code>PushCostLens.roundTripCosts</code>, ${MAX_WALK_STEPS} steps each way), rounded down; the exact swaps in the push costs below read slightly higher${hooked ? ". On a hooked pool the view walk does not see the hook’s own charges, so the bound may read low (conservative)" : ""}.</p>
      </div>
      <p>price <b>${fmt(m.priceQuote, 4)}</b> ${unit} · LP fee ${m.lpFee} pips, protocol fee ${m.protocolFee ? `on (${m.protocolFee & 0xfff}/${m.protocolFee >> 12} pips)` : "off"} · in-range liquidity <code>${m.liquidity}</code></p>
      <p>Push +5 % right now: <b>${fmt(five.costQuoteHuman)}</b> ${unit} of fees, tying up <b>${fmt(five.amountInHuman, 0)}</b> ${five.inputToken === "quote" ? unit : baseLabel}.
      ${preset?.stock ? ` Robinhood mint/redeem window: <span class="pill ${closed ? "closed" : "open"}">${closed ? "closed: nobody can arbitrage, pass arbReversionSeconds = 0" : "open: pass a measured reversion time"}</span>` : " Not a stock token: no mint window; the reversion time follows the market."}</p>
      <details><summary>Push costs both ways, from exact swaps (100, 488 and 953 ticks)</summary>
        <div class="tablewrap"><table><tr><th>${asset} move</th><th>ticks</th><th>reached</th><th>capital</th><th>cost (${unit})</th></tr>${m.entries.map((e) => `<tr><td>${e.move}</td><td>${e.ticks}</td><td>${e.reached ? "yes" : "no"}</td><td>${fmt(e.amountInHuman, e.inputToken === "quote" ? 0 : 4)} ${e.inputToken === "quote" ? unit : baseLabel}</td><td>${fmt(e.costQuoteHuman)}</td></tr>`).join("")}</table></div>
      </details>
      <details><summary>All twelve moves: cost to fake ÷ what it earns</summary>
        <div class="tablewrap"><table><tr><th>${asset} move</th><th>ticks</th><th>cost to fake (${unit})</th><th>earns per 1 ${unit} settling</th><th>break-even exposure (${unit})</th></tr>${rungs.map((r) => `<tr${r === bnd ? ' class="binding"' : ""}><td>${moveOf(r)}${r === bnd ? " ◀ binding" : ""}</td><td>${r.ticks}</td><td>${amount(toHuman(r.cost))}</td><td>${fmt(r.gain, 4)}</td><td>${amountDown(toHuman(r.exposure))}${r.complete ? "" : " (at least)"}</td></tr>`).join("")}</table></div>
      </details>
      <details><summary>Δ calibration for a HakariOracleHook on this pool</summary>
        <p>Suggested Δ: <b>${d ? d.suggestedDelta : "not calibrated (run npm run calibrate)"}</b>${d ? ` <span class="meta">(p99 tick move of ${d.swapBlocks} swap blocks; max ${d.perSwapBlock.max})</span>` : ""}. Δ clips each observation of the truncated TWAP that the hook reports alongside the raw one; SafeSettle's decision above does not use it.</p>
      </details>`;
  } catch (e) {
    out.innerHTML = `<p class="err">Could not measure: ${esc(e.shortMessage ?? e.message)}</p><p class="meta">Check the pool key (currency0 sorts below currency1; fee, tickSpacing and hooks exactly as created) and which side is the quote. If the key is right, the public RPC may be busy: press Measure again.</p>`;
  } finally {
    b.disabled = false;
  }
};

// ───────── 4. decisions ─────────
const human = (v, d) => { const x = Number(BigInt(v)) / 10 ** Number(d.quoteDecimals); return `${x !== 0 && x < 0.01 ? x.toExponential(1) : fmt(x, x < 100 ? 2 : 0)} ${d.unit}`; };
// decision, exposure and the bound first, so they stay in view without scrolling; the pool sits under the scenario name
$("decisions").innerHTML = `<tr><th>scenario</th><th>decision</th><th>exposure</th><th>max safe exposure</th><th>binding move</th><th>arbitrage pulls back</th><th>window</th><th>raw / truncated tick</th></tr>` +
  (decisions.length ? decisions.map((d) => `<tr><td><span class="nowrap">${d.scenario}</span><br><span class="meta">${d.pool}</span></td><td><span class="pill ${d.trusted ? "raw" : "trunc"}">${d.trusted ? "settle on raw" : "refuse"}</span></td><td>${human(d.exposure, d)}</td><td>${human(d.maxSafeExposure, d)}${d.costComplete ? "" : " (at least)"}</td><td>${d.bindingUp ? "+" : "−"}${d.bindingTicks} ticks${d.bindingWidth != null && Number(d.bindingWidth) !== Number(d.bindingTicks) ? `, held by a push ${Number(d.bindingWidth).toLocaleString("en-US")} ticks wide` : ""}</td><td>${Number(d.arbReversionSeconds) > 0 ? `every ${d.arbReversionSeconds} s` : "never (closed)"}</td><td>${d.window} s</td><td>${d.rawTick} / ${d.truncTick}</td></tr>`).join("") : `<tr><td colspan="8">run forge test --match-contract ThreeLayers (and script/record-fork-tests.sh) to fill this</td></tr>`);

// ───────── 5. delta ─────────
if (delta) $("delta").innerHTML = `<tr><th>pool</th><th>swaps in window</th><th>swap blocks</th><th>p50 move</th><th>p90</th><th>p99</th><th>max</th><th>suggested Δ</th></tr>` + delta.pools.map((p) => `<tr><td>${p.name}</td><td>${p.swaps}</td><td>${p.swapBlocks}</td><td>${p.perSwapBlock.p50}</td><td>${p.perSwapBlock.p90}</td><td>${p.perSwapBlock.p99}</td><td>${p.perSwapBlock.max}</td><td><b>${p.suggestedDelta}</b></td></tr>`).join("");
