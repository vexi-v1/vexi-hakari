// HAKARI live board. Static: reads baseline.json (npm run live:baseline) and ../lens-artifact.json, then measures every
// pool against Robinhood Chain 4663, read-only, through viem: PushCostLens.roundTripCosts by eth_call state override.
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, encodeAbiParameters, parseAbi } from "https://esm.sh/viem@2.56.9";
import { LADDER, MAX_WALK_STEPS, maxSafeFromQuotes, priceInQuote, mintWindowClosed, nextMintChange, latestFriday, standing } from "./core.js";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const LENS_AT = "0x4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a";
const CYCLE_MS = 60_000;
const PAUSE_BETWEEN_POOLS_MS = 900; // the public RPC rate-limits bursts: one pool (one batch of three calls) at a time
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (x, d = 0) => Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const usd = (x) => (x == null ? "—" : x >= 100 ? fmt(Math.floor(x)) : x >= 0.01 ? fmt(Math.floor(x * 100) / 100, 2) : x.toExponential(1));
const ratioText = (r) => (r == null ? "—" : `${r < 0.1 ? fmt(r, 3) : fmt(r, 2)}×`);
const hhmm = (d) => d.toISOString().slice(11, 16) + " UTC";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (p) => fetch(p, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

const stateViewAbi = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"]);
const client = createPublicClient({ transport: http(RPC, { batch: true, retryCount: 4, retryDelay: 500 }) });

const [baseline, artifact] = await Promise.all([load("baseline.json"), load("../lens-artifact.json")]);
if (!baseline || !artifact) {
  $("progress").innerHTML = `<span class="err">${!baseline ? "baseline.json is missing: run npm run live:baseline in gauge/" : "../lens-artifact.json is missing: run npm run export-lens in gauge/"}</span>`;
  throw new Error("missing data");
}
const fridayMs = Date.parse(baseline.fridayClose.time);
// a dynamic-fee pool's stored fee is 0 (its hook sets each swap's fee), so the view walk prices it at 0: not comparable
const pools = baseline.pools.map((p) => ({ ...p, dynamicFee: p.key.fee === 0x800000, samples: [] }));

// ───────── this viewer's minute readings, kept across reloads (a convenience: the page works without it) ─────────
const STORE = `hakari-live-v1-${baseline.friday}`;
try {
  const saved = JSON.parse(localStorage.getItem(STORE) ?? "{}");
  for (const p of pools) p.samples = (saved[p.id] ?? []).filter((s) => s.t > fridayMs);
} catch {}
function persist() {
  try {
    localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(pools.map((p) => [p.id, p.samples.slice(-720)]))));
  } catch {}
}

// ───────── the lens, once ─────────
let lensCode;
async function lens(blockNumber) {
  if (lensCode) return lensCode;
  const args = encodeAbiParameters([{ type: "address" }], [POOL_MANAGER]);
  const { data } = await client.call({ data: artifact.creationBytecode + args.slice(2), blockNumber });
  if (!data || data === "0x") throw new Error("could not simulate the lens deployment");
  return (lensCode = data);
}
async function walk(key, up, blockNumber) {
  const data = encodeFunctionData({ abi: artifact.abi, functionName: "roundTripCosts", args: [key, LADDER, up, BigInt(MAX_WALK_STEPS)] });
  const { data: out } = await client.call({ to: LENS_AT, data, blockNumber, stateOverride: [{ address: LENS_AT, code: lensCode }] });
  return decodeFunctionResult({ abi: artifact.abi, functionName: "roundTripCosts", data: out });
}
/** One pool at one block: its price and the bound, from one JSON-RPC batch of three calls. */
async function measure(p, blockNumber) {
  const [[sqrtPriceX96], up, down] = await Promise.all([
    client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [p.id], blockNumber }),
    walk(p.key, true, blockNumber),
    walk(p.key, false, blockNumber),
  ]);
  const b = maxSafeFromQuotes(up, down, LADDER, p.quoteIsCurrency0);
  const quoteDec = p.quoteIsCurrency0 ? p.decimals0 : p.decimals1;
  return { price: priceInQuote(sqrtPriceX96, p.decimals0, p.decimals1, p.quoteIsCurrency0), maxSafe: b.exposure / 10 ** quoteDec, complete: b.binding.complete, binding: b.binding };
}

// ───────── drawing ─────────
const W = 180, H = 36, LO = Math.log10(0.004), HI = Math.log10(4);
function sparkline(p, nowMs) {
  const fri = p.friday?.maxSafeUsdg;
  if (!fri) return `<span class="meta">no Friday point</span>`;
  const t0 = fridayMs, t1 = Math.max(nowMs, t0 + 3600_000);
  const x = (t) => ((t - t0) / (t1 - t0)) * W;
  const y = (r) => { const v = Math.min(HI, Math.max(LO, Math.log10(Math.max(r, 1e-9)))); return H - ((v - LO) / (HI - LO)) * H; };
  // mint-closed stretches as bands, found hour by hour
  let bands = "";
  for (let t = t0; t < t1; t += 3600_000) if (mintWindowClosed(new Date(t + 1))) bands += `<rect class="closed" x="${x(t)}" y="0" width="${x(Math.min(t + 3600_000, t1)) - x(t)}" height="${H}"/>`;
  const hourly = p.series.filter((r) => r.maxSafeUsdg != null).map((r) => ({ t: Date.parse(r.time), r: r.maxSafeUsdg / fri, v: r.maxSafeUsdg }));
  const live = p.samples.map((s) => ({ t: s.t, r: s.maxSafe / fri, v: s.maxSafe }));
  const path = (pts) => pts.map((q, i) => `${i ? "L" : "M"}${x(q.t).toFixed(1)},${y(q.r).toFixed(1)}`).join("");
  const hit = (q, cls) => `<circle class="hit" cx="${x(q.t).toFixed(1)}" cy="${y(q.r).toFixed(1)}" r="5"><title>${new Date(q.t).toISOString().slice(5, 16).replace("T", " ")} UTC · ${usd(q.v)} USDG · ${ratioText(q.r)} Friday${cls}</title></circle>`;
  const last = live.at(-1) ?? hourly.at(-1);
  return `<svg class="sparkline" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(p.symbol)}: max safe exposure relative to Friday's close since then, log scale from 0.004× to 4×">${bands}<line class="one" x1="0" x2="${W}" y1="${y(1)}" y2="${y(1)}"/><path class="line" d="${path(hourly)}"/>${live.length ? `<path class="live" d="${path(live)}"/>` : ""}${last ? `<circle class="dot" r="3.5" cx="${x(last.t)}" cy="${y(last.r)}"/>` : ""}${hourly.map((q) => hit(q, " (hourly rebuild)")).join("")}${live.map((q) => hit(q, " (measured live)")).join("")}</svg>`;
}

const STATUS = {
  collapsed: { icon: "▼▼", label: "collapsed" },
  thinning: { icon: "▼", label: "thinning" },
  holding: { icon: "●", label: "holding" },
  unknown: { icon: "○", label: "no Friday point" },
  thin: { icon: "○", label: "under 1 USDG on Friday" },
  dynamic: { icon: "○", label: "dynamic fee: not compared" },
  pending: { icon: "…", label: "measuring" },
};
// Friday figures under 1 USDG (GME, QQQ on 2026-09-25) are too thin for a ratio to mean anything.
const MIN_FRIDAY_USDG = 1;
/** now ÷ Friday, or null where the two are not the same measurement or Friday's figure is too small to divide by. */
function ratioOf(p) {
  const now = p.samples.at(-1);
  if (!now || !p.friday || p.dynamicFee || p.friday.maxSafeUsdg < MIN_FRIDAY_USDG) return null;
  return now.maxSafe / p.friday.maxSafeUsdg;
}
function row(p, nowMs) {
  const now = p.samples.at(-1);
  const fri = p.friday;
  const ratio = ratioOf(p);
  const move = now && fri ? now.price / fri.price - 1 : null;
  const st = p.dynamicFee ? "dynamic" : fri && fri.maxSafeUsdg < MIN_FRIDAY_USDG ? "thin" : fri && !now ? "pending" : standing(ratio);
  const s = STATUS[st];
  return `<tr data-id="${p.id}"><td><b>${esc(p.symbol)}</b>${p.hooked ? " †" : ""}<br><span class="meta">fee ${fmt(p.key.fee)}${p.key.fee === 8388608 ? " (dynamic)" : ""}</span></td>` +
    `<td><span class="status ${st}"><i aria-hidden="true">${s.icon}</i>${s.label}</span></td>` +
    `<td class="ratio">${ratioText(ratio)}</td>` +
    `<td>${p.dynamicFee ? `<span class="meta" title="The view walk prices the fee stored in slot0, which is 0 on a dynamic-fee pool: the hook sets each swap's fee. SafeSettle's bound reads 0 here and it refuses everything.">0 (fee unseen)</span>` : now ? usd(now.maxSafe) + (now.complete ? "" : " (at least)") : `<span class="meta">measuring…</span>`}</td>` +
    `<td>${fri ? usd(fri.maxSafeUsdg) : "—"}</td>` +
    `<td${fri ? ` title="Friday close: ${fmt(fri.price, fri.price < 10 ? 4 : 2)} USDG"` : ""}>${now ? fmt(now.price, now.price < 10 ? 4 : 2) : "—"}</td>` +
    `<td>${move == null ? "—" : `${move >= 0 ? "+" : "−"}${fmt(Math.abs(move) * 100, 1)} %`}</td>` +
    `<td class="spark">${p.dynamicFee || (fri && fri.maxSafeUsdg < MIN_FRIDAY_USDG) ? `<span class="meta">—</span>` : sparkline(p, nowMs)}</td></tr>`;
}
function renderBoard(fresh) {
  const nowMs = Date.now();
  const order = [...pools].sort((a, b) => (ratioOf(a) ?? Infinity) - (ratioOf(b) ?? Infinity));
  $("board").innerHTML = `<tr><th>stock (USDG pool)</th><th>standing</th><th>now ÷ Friday</th><th>max safe now (USDG)</th><th>at Friday's close</th><th>price now (USDG)</th><th>since Friday</th><th>since Friday's close (log scale)</th></tr>` + order.map((p) => row(p, nowMs)).join("");
  if (fresh) $("board").querySelector(`tr[data-id="${fresh}"]`)?.classList.add("fresh");
  renderHero();
}
function renderHero() {
  const now = new Date();
  const m = nextMintChange(now);
  const span = (ms) => { const h = Math.floor(ms / 3600_000), mi = Math.floor((ms % 3600_000) / 60_000); return h ? `${h} h ${mi} min` : `${mi} min`; };
  $("mint-v").innerHTML = `<span class="pill ${m.closed ? "closed" : "open"}">${m.closed ? "closed" : "open"}</span>`;
  $("mint-s").textContent = m.at ? `${m.closed ? "reopens" : "closes"} ${m.at.toUTCString().slice(0, 22)} UTC, in ${span(m.at - now)}. ${m.closed ? "Nobody can mint or redeem: nothing ties these prices to the stock." : "Arbitrage is open; the board still compares with Friday's close."}` : "";
  const ratios = pools.filter((p) => ratioOf(p) != null).map((p) => ({ p, r: ratioOf(p) }));
  const measured = ratios;
  const below = ratios.filter((x) => x.r < 0.5);
  $("count-v").textContent = measured.length ? `${below.length} of ${measured.length}` : "…";
  $("count-s").textContent = measured.length ? (below.length ? `${below.map((x) => x.p.symbol).join(", ")}. The weekend of 2026-09-18 had none; 2026-08-30 had HIMS at 0.006×.` : "None right now. The weekend of 2026-09-18 had none either; 2026-08-30 had HIMS at 0.006×.") : "measuring…";
  const low = ratios.sort((a, b) => a.r - b.r)[0];
  $("low-v").textContent = low ? `${low.p.symbol} ${ratioText(low.r)}` : "…";
  $("low-s").textContent = low ? `${usd(low.p.samples.at(-1).maxSafe)} USDG now vs ${usd(low.p.friday.maxSafeUsdg)} at Friday's close.` : "";
}
function renderNotes() {
  const stale = latestFriday(new Date()) !== baseline.friday;
  $("board-note").innerHTML = `Friday's close: ${esc(baseline.fridayClose.time.slice(0, 16).replace("T", " "))} UTC, block ${Number(baseline.fridayClose.block).toLocaleString()}; hourly line to ${esc(baseline.points.at(-1).time.slice(0, 16).replace("T", " "))} UTC (baseline generated ${esc(baseline.generatedAt.slice(0, 16).replace("T", " "))} UTC)` +
    (stale ? `. <b>This baseline is from an earlier Friday than the latest US close</b>: run <code>npm run live:baseline</code> in gauge/ to refresh it.` : "") +
    `. Sorted by now ÷ Friday. “Collapsed” is below 0.1×, “thinning” below 0.5×. † Hooked pool. On a dynamic-fee pool (fee 8388608) the view walk sees a stored fee of 0, so SafeSettle's bound reads 0 and it refuses everything; the Friday column there is the rebuild at the fees swaps actually paid, and the two are not compared. (at least): the walk hit its ${MAX_WALK_STEPS}-step cap.`;
  const checks = pools.filter((p) => p.check?.rebuilt);
  $("check").innerHTML = `<tr><th>stock</th><th>block</th><th>lens (USDG)</th><th>rebuild (USDG)</th><th>lens ÷ rebuild</th><th>slot0 = last Swap price</th></tr>` +
    checks.map((p) => `<tr><td>${esc(p.symbol)}</td><td>${Number(p.check.block).toLocaleString()}</td><td>${usd(p.check.lens.usdg)}${p.check.lens.complete ? "" : " (at least)"}</td><td>${usd(p.check.rebuilt.maxSafeUsdg)}</td><td>${fmt(p.check.lensOverRebuilt, 4)}</td><td>${p.check.slot0PriceMatchesLastSwap ? "yes" : "no"}</td></tr>`).join("");
}

// ───────── the loop ─────────
let paused = false;
$("toggle").onclick = () => { paused = !paused; $("toggle").textContent = paused ? "Resume" : "Pause"; };
renderNotes();
renderBoard();
setInterval(renderHero, 30_000);

for (;;) {
  const started = Date.now();
  if (!paused) {
    try {
      const block = await client.getBlock();
      await lens(block.number);
      let done = 0, failed = 0;
      const measurable = pools.filter((p) => !p.dynamicFee);
      for (const p of measurable) {
        if (paused) break;
        $("progress").textContent = `block ${Number(block.number).toLocaleString()} (${hhmm(new Date(Number(block.timestamp) * 1000))}) · measuring ${p.symbol} (${done + failed + 1} of ${measurable.length})…`;
        try {
          const m = await measure(p, block.number);
          p.samples.push({ t: Number(block.timestamp) * 1000, block: Number(block.number), ...m, binding: undefined });
          done++;
          renderBoard(p.id);
        } catch (e) {
          failed++;
        }
        await sleep(PAUSE_BETWEEN_POOLS_MS);
      }
      persist();
      $("progress").textContent = `measured ${done} of ${measurable.length} pools at block ${Number(block.number).toLocaleString()} (${hhmm(new Date(Number(block.timestamp) * 1000))})${failed ? `; ${failed} failed (the public RPC was busy), retried next minute` : ""} · next round in ${Math.max(0, Math.round((CYCLE_MS - (Date.now() - started)) / 1000))} s`;
    } catch (e) {
      $("progress").innerHTML = `<span class="err">Could not reach Robinhood Chain: ${esc(e.shortMessage ?? e.message)}</span>. Retrying in a minute.`;
    }
  }
  await sleep(Math.max(5_000, CYCLE_MS - (Date.now() - started)));
}
