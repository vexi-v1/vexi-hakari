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

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const erc20Abi = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

const client = createPublicClient({ transport: http(RPC) });
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
const decisionFiles = ["thin-pool-sustained-push", "deep-pool-genuine-surge", "tsla-shaped-weekend", "tsla-shaped-weekday"];
const decisions = (await Promise.all(decisionFiles.map((f) => load(`decisions/${f}.json`)))).filter(Boolean);

$("meta").textContent = ladder ? `snapshot at block ${Number(ladder.block).toLocaleString()} · ${new Date(ladder.timestamp * 1000).toUTCString()}` : "no snapshot found (run npm run ladder in gauge/)";

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
async function quoteLadder(key, ticks, up, blockNumber) {
  const code = await lens();
  const data = encodeFunctionData({ abi: lensArtifact.abi, functionName: "quotePushLadder", args: [key, ticks, up] });
  const { data: out } = await client.call({ to: LENS_AT, data, blockNumber, stateOverride: [{ address: LENS_AT, code }] });
  return decodeFunctionResult({ abi: lensArtifact.abi, functionName: "quotePushLadder", data: out });
}
async function measurePool(key, quoteIsCurrency0, blockNumber) {
  const id = keyId(key);
  const [sqrtPriceX96, tick, protocolFee, lpFee] = await client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [id], blockNumber });
  if (sqrtPriceX96 === 0n) throw new Error("pool not initialized: check the key");
  const liquidity = await client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [id], blockNumber });
  const [d0, d1] = await Promise.all([key.currency0, key.currency1].map((a) => (a === "0x0000000000000000000000000000000000000000" ? 18 : client.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }))));
  const ticks = PCTS.map(ticksForPct);
  const entries = [];
  for (const up of [true, false]) {
    const qs = await quoteLadder(key, ticks, up, blockNumber);
    qs.forEach((q, i) => {
      const quoteUp = quoteIsCurrency0 ? !up : up;
      const quoteDec = quoteIsCurrency0 ? d0 : d1;
      const costQuote = quoteIsCurrency0 ? q.costInCurrency0 : q.costInCurrency1;
      const inputIsQuote = quoteIsCurrency0 ? q.zeroForOne : !q.zeroForOne;
      entries.push({ pct: PCTS[i], direction: quoteUp ? "up" : "down", ticks: ticks[i], reached: q.sqrtPriceReached === q.sqrtPriceTarget, inputToken: inputIsQuote ? "quote" : "base", amountInHuman: formatUnits(q.amountIn, inputIsQuote ? quoteDec : quoteIsCurrency0 ? d1 : d0), costQuoteHuman: formatUnits(costQuote, quoteDec) });
    });
  }
  const raw = Number(sqrtPriceX96) / 2 ** 96;
  const p1per0 = raw * raw * 10 ** (Number(d0) - Number(d1));
  return { id, tick, lpFee, protocolFee, liquidity: liquidity.toString(), priceQuote: quoteIsCurrency0 ? 1 / p1per0 : p1per0, entries };
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
function chart(el, { width = 960, height = 260, pad = { l: 56, r: 24, t: 20, b: 44 } }, draw, caption) {
  const svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${caption}" style="width:100%;height:auto">${draw({ width, height, pad, iw: width - pad.l - pad.r, ih: height - pad.t - pad.b })}</svg>`;
  el.innerHTML = svg + `<figcaption>${caption}</figcaption>`;
}
if (hims) {
  const pts = hims.points;
  const x = (i, g) => g.pad.l + (i / (pts.length - 1)) * g.iw;
  const labels = pts.map((p) => new Date(p.timestamp * 1000).toISOString().slice(5, 16).replace("T", " ") + "Z");
  chart($("hims-price"), {}, (g) => {
    const vals = pts.map((p) => p.usdgPerHims);
    const lo = Math.min(hims.nyseCloseFriday, ...vals) * 0.9;
    const hi = Math.max(...vals) * 1.05;
    const y = (v) => g.pad.t + (1 - (v - lo) / (hi - lo)) * g.ih;
    const ticks = [30, 40, 50];
    let s = ticks.map((t) => `<line class="grid" x1="${g.pad.l}" x2="${g.pad.l + g.iw}" y1="${y(t)}" y2="${y(t)}"/><text x="${g.pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("");
    s += `<line class="axis" x1="${g.pad.l}" x2="${g.pad.l + g.iw}" y1="${g.pad.t + g.ih}" y2="${g.pad.t + g.ih}"/>`;
    s += `<line class="nyse" x1="${g.pad.l}" x2="${g.pad.l + g.iw}" y1="${y(hims.nyseCloseFriday)}" y2="${y(hims.nyseCloseFriday)}"/><text x="${g.pad.l + g.iw}" y="${y(hims.nyseCloseFriday) - 6}" text-anchor="end">NYSE close ${hims.nyseCloseFriday}</text>`;
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
  $("hims-table").innerHTML = `<tr><th>block</th><th>time (UTC)</th><th>mint window</th><th>USDG/HIMS</th><th>HIMS in pool</th><th>USDG in pool</th><th>live positions</th><th>+10 % capital (USDG)</th><th>+10 % cost (USDG)</th><th>+85 % capital (USDG)</th><th>rebuilt L = Swap L</th></tr>` + pts.map((p) => `<tr><td>${Number(p.block).toLocaleString()}</td><td>${p.time.slice(0, 19).replace("T", " ")}</td><td><span class="pill ${p.mintWindowClosed ? "closed" : "open"}">${p.mintWindowClosed ? "closed" : "open"}</span></td><td>${fmt(p.usdgPerHims, 4)}</td><td>${fmt(p.himsPrincipal)}</td><td>${fmt(p.usdgPrincipal, 0)}</td><td>${p.livePositions}</td><td>${fmt(p.pushUp10.usdgIn, 0)}</td><td>${fmt(p.pushUp10.roundTripCostUsdg)}</td><td>${fmt(p.pushUp85.usdgIn, 0)}</td><td>${p.liquidityMatches ? "yes" : "NO"}</td></tr>`).join("");
}

// ───────── weekend, every stock pool ─────────
if (weekend) {
  const rows = weekend.series.filter((r) => r.fridayCostUp10 && r.weekendMinCostUp10).sort((a, b) => a.weekendOverFriday - b.weekendOverFriday);
  $("weekend-fig").innerHTML = `<img src="../docs/img/weekend-${WEEKEND}.svg" alt="Friday vs weekend cost to push each stock pool 10 %" style="width:100%;height:auto;border-radius:10px">` +
    `<div class="tablewrap"><table><tr><th>stock</th><th>Friday +10 % cost</th><th>weekend minimum</th><th>weekend ÷ Friday</th><th>rebuild = chain</th></tr>` +
    rows.map((r) => `<tr><td>${r.symbol}</td><td>${fmt(r.fridayCostUp10)}</td><td>${fmt(r.weekendMinCostUp10)}</td><td>×${fmt(r.weekendOverFriday, 2)}</td><td>${r.allLiquidityMatches ? "yes" : "no"}</td></tr>`).join("") + `</table></div>`;
} else {
  $("weekend-lead").textContent += " (run npm run discover and npm run weekend -- " + WEEKEND + " in gauge/)";
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
  out.textContent = "measuring…";
  try {
    const key = { currency0: $("c0").value.trim().toLowerCase(), currency1: $("c1").value.trim().toLowerCase(), fee: Number($("fee").value), tickSpacing: Number($("ts").value), hooks: $("hooks").value.trim().toLowerCase() };
    const quoteIsCurrency0 = $("quote").value === "0";
    const block = await client.getBlock();
    const m = await measurePool(key, quoteIsCurrency0, block.number);
    const preset = presets.find((p) => p.id === m.id);
    const d = delta?.pools.find((p) => p.id === m.id);
    const closed = mintWindowClosed(new Date());
    const fenced = preset?.stock ? closed : false;
    const five = m.entries.find((e) => e.pct === 5 && e.direction === "up");
    out.innerHTML = `
      <p><b>${preset?.name ?? "pool"}</b> <code>${m.id}</code> · block ${Number(block.number).toLocaleString()}</p>
      <p>price <b>${fmt(m.priceQuote, 4)}</b> quote · LP fee ${m.lpFee} pips, protocol fee ${m.protocolFee ? `on (${m.protocolFee & 0xfff}/${m.protocolFee >> 12} pips)` : "off"} · in-range liquidity <code>${m.liquidity}</code></p>
      <p>Push +5 % right now: <b>${fmt(five.costQuoteHuman)}</b> quote of fees, tying up <b>${fmt(five.amountInHuman, 0)}</b> ${five.inputToken}.
      ${preset?.stock ? ` Robinhood mint/redeem window: <span class="pill ${closed ? "closed" : "open"}">${closed ? "closed: nobody can arbitrage, pass arbReversionSeconds = 0" : "open: pass a measured reversion time"}</span>` : " Not a stock token: no mint window; the reversion time follows the market."}</p>
      <p>Suggested Δ for a HakariOracleHook on this pool: <b>${d ? d.suggestedDelta : "not calibrated (run npm run calibrate)"}</b>${d ? ` <span class="meta">(p99 of ${d.swapBlocks} swap blocks; max ${d.perSwapBlock.max})</span>` : ""}</p>
      <div class="tablewrap"><table><tr><th>move</th><th>ticks</th><th>reached</th><th>capital</th><th>cost (quote)</th></tr>${m.entries.map((e) => `<tr><td>${e.direction === "up" ? "+" : "−"}${e.pct} %</td><td>${e.ticks}</td><td>${e.reached ? "yes" : "no"}</td><td>${fmt(e.amountInHuman, e.inputToken === "quote" ? 0 : 4)} ${e.inputToken}</td><td>${fmt(e.costQuoteHuman)}</td></tr>`).join("")}</table></div>`;
  } catch (e) {
    out.innerHTML = `<span class="err">${e.shortMessage ?? e.message}</span>`;
  } finally {
    b.disabled = false;
  }
};

// ───────── 4. decisions ─────────
const decUnit = (d) => (d.scenario.startsWith("tsla") ? { dec: 6, unit: "USDG" } : { dec: 18, unit: "tokens" });
const human = (v, d) => { const { dec, unit } = decUnit(d); const x = Number(BigInt(v)) / 10 ** dec; return `${x < 0.01 ? x.toExponential(2) : fmt(x, 2)} ${unit}`; };
$("decisions").innerHTML = `<tr><th>scenario</th><th>pool</th><th>arbitrage pulls back</th><th>raw tick</th><th>truncated tick</th><th>gap</th><th>cost to fake</th><th>gain if faked</th><th>settled on</th></tr>` +
  (decisions.length ? decisions.map((d) => `<tr><td>${d.scenario}</td><td>${d.pool}</td><td>${Number(d.arbReversionSeconds) > 0 ? `every ${d.arbReversionSeconds} s` : "never (closed)"}</td><td>${d.rawTick}</td><td>${d.truncTick}</td><td>${Math.abs(Number(d.rawTick) - Number(d.truncTick))}</td><td>${human(d.costToFake, d)}${d.costComplete ? "" : " (at least)"}</td><td>${human(d.gainIfFaked, d)}</td><td><span class="pill ${d.usedRaw ? "raw" : "trunc"}">${d.usedRaw ? "raw" : "truncated"}</span></td></tr>`).join("") : `<tr><td colspan="9">run forge test --match-contract ThreeLayers (and ShadowPool on a fork) to fill this</td></tr>`);

// ───────── 5. delta ─────────
if (delta) $("delta").innerHTML = `<tr><th>pool</th><th>swaps in window</th><th>swap blocks</th><th>p50 move</th><th>p90</th><th>p99</th><th>max</th><th>suggested Δ</th></tr>` + delta.pools.map((p) => `<tr><td>${p.name}</td><td>${p.swaps}</td><td>${p.swapBlocks}</td><td>${p.perSwapBlock.p50}</td><td>${p.perSwapBlock.p90}</td><td>${p.perSwapBlock.p99}</td><td>${p.perSwapBlock.max}</td><td><b>${p.suggestedDelta}</b></td></tr>`).join("");
