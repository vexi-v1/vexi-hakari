// HAKARI vexi board. Static: reads baseline.json (npm run vexi in gauge/: every fix the venue made, replayed against the
// bound) and, once at load, refreshes each pricing pool's "now" columns from testnet 46630 through the public RPC, read-only:
// the PoolManager's own storage (slot0, liquidity, by extsload) and the deployed PushCostLens.roundTripCosts, by address.
// No wallet, no transaction, no venue API: the venue's open interest is the collector's business, not this page's.
import { createPublicClient, http, keccak256, encodeAbiParameters, encodePacked, parseAbi } from "https://esm.sh/viem@2.56.9";
import { LADDER, MAX_WALK_STEPS, maxSafeFromQuotes, priceInQuote } from "../live/core.js";
import { band, boundAtRung, capacityLine, fmtRatio, fmtUsdg, nextExpiry, quoteReserve, unpackSlot0, whatIf, WATCH_AT } from "./core.js";

const RPC = "https://rpc.testnet.chain.robinhood.com/rpc";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const LENS = "0xe1aa7dd1bd65bc9a88fbe62ce03aa4cbb7bfdca2"; // PushCostLens, deployed and verified on 46630
const EXPLORER_TX = "https://explorer.testnet.chain.robinhood.com/tx/";
const POOLS_SLOT = "0x0000000000000000000000000000000000000000000000000000000000000006"; // StateLibrary.POOLS_SLOT
const LIQUIDITY_OFFSET = 3n; // StateLibrary.LIQUIDITY_OFFSET
const A22_TICKS = 488; // the ladder's 5 % rung
const PAUSE_BETWEEN_POOLS_MS = 900; // the public RPC rate-limits bursts: one pool (one batch of four calls) at a time
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (x, d = 0) => Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const price = (x) => (x == null || !(x > 0) ? "—" : fmt(x, x < 10 ? 4 : 2));
const utc = (sec) => (sec ? new Date(Number(sec) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");
const hhmm = (sec) => new Date(Number(sec) * 1000).toISOString().slice(11, 16) + " UTC";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (p) => fetch(p, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const ZERO_TX = /^0x0+$/;

const pmAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const lensAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function roundTripCosts(PoolKey key, int24[] widths, bool up, uint256 maxSteps) view returns (uint256[] costInCurrency0, uint256[] costInCurrency1, bool[] complete)",
]);
const keyType = [{ type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }];
const client = createPublicClient({ transport: http(RPC, { batch: true, retryCount: 3, retryDelay: 600 }) });

const baseline = await load("baseline.json");
if (!baseline) {
  $("progress").innerHTML = `<span class="err">baseline.json is missing: run npm run vexi in gauge/</span>`;
  throw new Error("missing data");
}
const quoteDec = baseline.quote?.decimals ?? 6;
const step = baseline.terms?.step ?? 900;
const fixWindow = baseline.terms?.fixWindow ?? 300;
const markets = (baseline.markets ?? []).map((m) => ({ ...m, live: null, poolIdMatches: keccak256(encodeAbiParameters(keyType, [m.key])) === m.poolId.toLowerCase() }));
// the stub carries one all-zero cell so the schema is visible; it is not a fix
const cells = (baseline.cells ?? []).filter((c) => !baseline.stub && c.expiry).sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
const summary = baseline.summary ?? {};
const asOf = baseline.generatedAt ? `as of ${esc(baseline.generatedAt.slice(0, 16).replace("T", " "))} UTC` : "placeholder, not yet run";
const bySymbol = (s) => markets.find((m) => m.symbol === s);
const decimalsOf = (m) => (m.quoteIsCurrency0 ? [quoteDec, 18] : [18, quoteDec]);

if (baseline.stub) {
  $("stub-notice").hidden = false;
  $("stub-text").textContent = "This baseline.json is the collector's schema stub, every figure 0. Run npm run vexi in gauge/ to replace it with the replay of every fix since deploy. The \"now\" columns below are still read live.";
}

// ───────── the one live read per pool ─────────
/** One pool at one block, from one JSON-RPC batch of four calls: slot0 and liquidity by extsload, the lens both ways. */
async function measure(m, blockNumber) {
  const stateSlot = keccak256(encodePacked(["bytes32", "bytes32"], [m.poolId, POOLS_SLOT]));
  const liquiditySlot = `0x${(BigInt(stateSlot) + LIQUIDITY_OFFSET).toString(16).padStart(64, "0")}`;
  const walk = (up) => client.readContract({ address: LENS, abi: lensAbi, functionName: "roundTripCosts", args: [m.key, LADDER, up, BigInt(MAX_WALK_STEPS)], blockNumber });
  const [slot0, liq, up, down] = await Promise.all([
    client.readContract({ address: POOL_MANAGER, abi: pmAbi, functionName: "extsload", args: [stateSlot], blockNumber }),
    client.readContract({ address: POOL_MANAGER, abi: pmAbi, functionName: "extsload", args: [liquiditySlot], blockNumber }),
    walk(true),
    walk(false),
  ]);
  const { sqrtPriceX96, tick } = unpackSlot0(slot0);
  if (sqrtPriceX96 === 0n) throw new Error("the RPC returned no state for this pool");
  const liquidity = BigInt(liq) & ((1n << 128n) - 1n);
  const b = maxSafeFromQuotes(up, down, LADDER, m.quoteIsCurrency0);
  const [d0, d1] = decimalsOf(m);
  const unit = 10 ** quoteDec;
  const costAt = (rungs, ticks, dirUp) => { const r = rungs.find((x) => x.ticks === ticks && x.up === dirUp); return r ? Number(r.cost) / unit : null; };
  return {
    tick,
    spot: priceInQuote(sqrtPriceX96, d0, d1, m.quoteIsCurrency0),
    liquidity: liquidity.toString(),
    quoteReserve: quoteReserve(liquidity, sqrtPriceX96, m.quoteIsCurrency0, quoteDec),
    headBound: b.exposure / unit,
    complete: b.binding.complete,
    bindingTicks: b.binding.ticks,
    bindingAssetUp: b.binding.assetUp,
    boundAtRung: { 50: boundAtRung(b.rungs, 50) / unit, 1823: boundAtRung(b.rungs, 1823) / unit },
    a22: { up: costAt(b.rungs, A22_TICKS, true), down: costAt(b.rungs, A22_TICKS, false) },
  };
}

// ───────── drawing ─────────
const BAND = { trusted: { icon: "●", label: "trusted" }, watch: { icon: "▲", label: "watch" }, refused: { icon: "✕", label: "refused" }, unknown: { icon: "○", label: "no bound" } };
function meter(ratio, label) {
  const b = band(ratio);
  const w = ratio == null || Number.isNaN(ratio) ? 0 : Math.min(1, Math.max(0, ratio)) * 100;
  return `<span class="meter ${b}" role="img" aria-label="${esc(label ?? `${fmtRatio(ratio)} of the bound`)}"><i class="fill" style="width:${w.toFixed(1)}%"></i><i class="tick" aria-hidden="true"></i><i class="tick one" aria-hidden="true"></i></span>`;
}
/** The figures a market shows "now": its live read when it landed, else the collector's. */
const nowOf = (m) => m.live ?? m;
const hasWritable = markets.some((m) => m.writable != null);

function renderHero() {
  const n = summary.fixesScanned ?? 0;
  $("fixes-v").textContent = fmt(n);
  $("fixes-s").textContent = `${fmt(summary.expiries ?? 0)} expiries across ${markets.length} pools, one fix per pool every ${step / 60} minutes · ${fmt(summary.fixedLate ?? 0)} fixed late`;
  const withExposure = summary.cellsWithExposure ?? cells.length;
  const above = cells.filter((c) => c.ratio != null && c.ratio >= 1).length;
  $("cells-v").textContent = fmt(withExposure);
  $("cells-s").textContent = n ? `${fmt(summary.seriesWithExposure ?? 0)} series, ${fmtUsdg(summary.totalExposure)} USDG in total · ${above ? `${above} at or above the bound` : "every one below the bound"}` : "nothing to show yet";
  const top = cells[0];
  $("max-v").innerHTML = top && n ? `${fmtRatio(top.ratio)} ${meter(top.ratio)}` : "—";
  $("max-s").textContent = top && n ? `${top.symbol}, expiry ${utc(top.expiry)}: ${fmtUsdg(top.exposure)} USDG settled on a bound of ${fmtUsdg(top.bound)}` : "";
}

function capacityRow(m, wi) {
  const now = nowOf(m);
  const live = Boolean(m.live);
  const lf = m.lastFix ?? {};
  const cls = wi && wi.symbol === m.symbol ? ` wi-${wi.band}` : "";
  return `<tr data-symbol="${esc(m.symbol)}" class="${cls.trim()}"><td><b>${esc(m.symbol)}</b>/USDG<br>${live ? `<span class="pill live">live</span>` : `<span class="pill asof" title="the collector's figure, ${asOf}">collector</span>`}</td>` +
    `<td>${price(now.spot)}</td>` +
    `<td>${now.liquidity && now.liquidity !== "0" ? Number(now.liquidity).toExponential(2) : "—"}</td>` +
    `<td>${fmtUsdg(now.quoteReserve)}</td>` +
    `<td class="ratio">${fmtUsdg(now.headBound)}${live && !now.complete ? " (at least)" : ""}${live ? `<br><span class="meta">${now.bindingTicks} ticks, ${now.bindingAssetUp ? "asset up" : "asset down"}</span>` : ""}</td>` +
    `<td>${fmtUsdg(now.boundAtRung?.[50])}</td>` +
    `<td>${fmtUsdg(capacityLine(m.key.fee, now.quoteReserve))}</td>` +
    `<td>${now.a22 ? `${fmtUsdg(now.a22.up)} / ${fmtUsdg(now.a22.down)}` : "—"}</td>` +
    (hasWritable ? `<td>${m.writable != null ? `${fmtUsdg(m.writable)} (${fmtRatio(now.headBound > 0 ? m.writable / now.headBound : null)})` : "—"}</td>` : "") +
    `<td>${lf.sStar ? `${price(lf.sStar)} · ${lf.nObs} obs · ${lf.span} s` : "—"}</td></tr>`;
}
function renderCapacity(fresh, wi) {
  $("capacity").innerHTML = `<tr><th>pool</th><th>spot (USDG)</th><th>liquidity</th><th>quote-side reserve (USDG)</th><th>max safe now (binding rung)</th><th>at the 0.5 % rung</th><th>≈ fee × reserve</th><th>A22: cost to move 5 % up / down</th>${hasWritable ? "<th>writable by mandate</th>" : ""}<th>last fix: S* · nObs · span</th></tr>` +
    markets.map((m) => capacityRow(m, wi)).join("");
  if (fresh) $("capacity").querySelector(`tr[data-symbol="${fresh}"]`)?.classList.add("fresh");
  $("capacity-note").innerHTML = `Liquidity is the pool's whole book (one full-range position each). Reserve = L ÷ √P (L × √P where USDG is currency1, as on MU). A22 is the round trip of the ${A22_TICKS}-tick (5 %) rung in USDG. Collector figures${baseline.head?.block && baseline.head.block !== "0" ? ` at block ${fmt(baseline.head.block)}` : ""}: ${asOf}.` +
    (hasWritable ? ` Writable by mandate: what the venue's USDG vaults could write at today's mock NAV, ÷ the bound.` : "");
}

// ───────── what-if ─────────
function currentWhatIf() {
  const m = bySymbol($("wi-market").value) ?? markets[0];
  if (!m) return null;
  const exposure = Number($("wi-exposure").value);
  const bound = nowOf(m).headBound;
  return { symbol: m.symbol, exposure, bound, live: Boolean(m.live), ...whatIf(exposure, bound) };
}
function renderWhatIf() {
  const w = currentWhatIf();
  if (!w) return;
  const b = BAND[w.band];
  const next = nextExpiry(Date.now() / 1000, step);
  const bound = w.bound > 0 ? `${fmtUsdg(w.bound)} USDG` : "an unknown bound";
  $("wi-out").innerHTML = `<b>${esc(w.symbol)}</b>: ${fmtUsdg(w.exposure)} USDG settling at the ${hhmm(next)} fix would be <b>${fmtRatio(w.ratio)}</b> of ${bound} the pool can safely carry ${w.live ? "now" : `(collector figure, ${asOf})`} → <span class="status ${w.band}"><i aria-hidden="true">${b.icon}</i>${b.label}</span>. ${w.bound > 0 ? `Refused from ${fmtUsdg(w.bound)} USDG; watch from ${fmtUsdg(w.bound * WATCH_AT)}.` : ""}`;
  renderCapacity(null, w);
}
function initWhatIf() {
  $("wi-market").innerHTML = markets.map((m) => `<option value="${esc(m.symbol)}">${esc(m.symbol)}/USDG</option>`).join("");
  const top = cells[0];
  if (top && bySymbol(top.symbol)) $("wi-market").value = top.symbol;
  $("wi-exposure").value = top && top.exposure > 0 ? Math.round(top.exposure) : 1000;
  $("wi-note").textContent = `Exposure = contracts × the price they settle at, every series on the expiry summed; the default is the largest the venue has fixed so far. This page reads the pool and the lens, not the venue's open interest, so the figure is yours to set.`;
  $("wi-market").addEventListener("change", renderWhatIf);
  $("wi-exposure").addEventListener("input", renderWhatIf);
}

// ───────── history and fix statistics ─────────
function renderHistory() {
  const n = summary.fixesScanned ?? 0;
  $("history-lead").textContent = n ? `${fmt(n)} fixes scanned; these ${fmt(cells.length)} are the ones with anything at stake, sorted by exposure ÷ bound. All open interest to date was written by the venue's own Book; every cell prices the pool as it stood before the ${fixWindow} s fix window opened.` : "No fixes replayed yet: the table fills from the collector's run.";
  $("history").hidden = cells.length === 0;
  $("history-note").hidden = cells.length === 0;
  $("history").innerHTML = `<tr><th>pool</th><th>expiry</th><th>S* (USDG)</th><th>nObs</th><th>span (s)</th><th>contracts</th><th>exposure (USDG)</th><th>bound (USDG)</th><th>exposure ÷ bound</th><th>payout moved by the binding push (USDG)</th><th>÷ that push's cost</th><th>S* vs pre-window</th><th>fix</th></tr>` +
    cells.map((c) => {
      const contracts = c.sStar > 0 ? c.exposure / c.sStar : null;
      const b = band(c.ratio);
      const tx = c.fixTx && !ZERO_TX.test(c.fixTx) ? `<a href="${EXPLORER_TX}${esc(c.fixTx)}?tab=logs" target="_blank" rel="noopener">${esc(c.fixTx.slice(0, 10))}… ↗</a>` : "—";
      return `<tr><td><b>${esc(c.symbol)}</b></td><td>${utc(c.expiry)}</td><td>${price(c.sStar)}</td><td>${c.nObs ?? "—"}${c.thin ? " †" : ""}</td><td>${c.span ?? "—"}</td><td>${contracts == null ? "—" : fmt(contracts, 2)}</td><td>${fmtUsdg(c.exposure)}</td><td>${fmtUsdg(c.bound)}</td>` +
        `<td class="ratio"><span class="status ${b}"><i aria-hidden="true">${BAND[b].icon}</i>${fmtRatio(c.ratio)}</span> ${meter(c.ratio, `${c.symbol} ${utc(c.expiry)}: ${fmtRatio(c.ratio)} of the bound`)}</td>` +
        `<td>${fmtUsdg(c.transferAtBinding)}</td><td>${c.breakEven == null ? "—" : fmtRatio(c.breakEven)}</td><td title="${c.inWindowSwaps ?? 0} swaps inside the fix window">${c.sStarVsPreWindowBps == null ? "—" : `${c.sStarVsPreWindowBps >= 0 ? "+" : "−"}${fmt(Math.abs(c.sStarVsPreWindowBps), 1)} bps`}</td><td>${tx}</td></tr>`;
    }).join("");
  $("history-note").innerHTML = `Exposure is the delta-1 upper bound, contracts × S*, calls and puts alike (they share one S*). The strike-aware column is what the option payouts would actually have moved if the pool had been pushed by the binding rung, and that ÷ the round trip the push costs: above 1× the push would have paid for itself. † nObs ≤ 3 or span under 200 s. Contracts = exposure ÷ S*.`;
}
function renderFixStats() {
  const hist = summary.nObsHistogram ?? {};
  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
  const max = Math.max(1, ...keys.map((k) => hist[k]));
  const total = keys.reduce((s, k) => s + hist[k], 0);
  const bars = keys.length ? `<div class="bars" role="img" aria-label="fixes by number of TWAP observations">${keys.map((k) => `<span class="n">${k} obs</span><span class="bar" style="width:${((hist[k] / max) * 100).toFixed(1)}%"></span><span class="n">${fmt(hist[k])}${total ? ` (${fmt((hist[k] / total) * 100, 1)} %)` : ""}</span>`).join("")}</div>` : `<p class="meta">no histogram yet</p>`;
  const withBps = cells.filter((c) => c.sStarVsPreWindowBps != null && c.expiry);
  const abs = withBps.map((c) => Math.abs(c.sStarVsPreWindowBps));
  const track = abs.length ? `Over the ${fmt(abs.length)} fixes with exposure, S* sat ${fmt(Math.min(...abs), 1)}–${fmt(Math.max(...abs), 1)} bps from the pool's last pre-window price${withBps.some((c) => c.inWindowSwaps) ? `; ${withBps.filter((c) => c.inWindowSwaps).length} of them had swaps inside the window` : ""}.` : "";
  $("fixstats").innerHTML = `<p class="lead">Each fix is the venue's rate-limited ring TWAP over the ${fixWindow} s before expiry: a handful of observations, last value held between them. Fixes by observation count:</p>${bars}<p class="lead">${track} ${fmt(summary.fixedLate ?? 0)} fix${summary.fixedLate === 1 ? "" : "es"} landed after the window (FixedLate).</p>`;
}
function renderChecks() {
  $("check").innerHTML = `<tr><th>pool</th><th>keccak(key) = pool id</th><th>USDG is</th><th>fee · spacing · hooks</th><th>lens ÷ rebuild</th><th>liquidity: collector</th><th>live</th></tr>` +
    markets.map((m) => `<tr><td>${esc(m.symbol)}</td><td>${m.poolIdMatches ? "yes" : `<span class="err">no</span>`}</td><td>${m.quoteIsCurrency0 ? "currency0" : "currency1"}</td><td>${fmt(m.key.fee)} · ${m.key.tickSpacing} · ${/^0x0+$/.test(m.key.hooks) ? "none" : esc(m.key.hooks)}</td><td>${m.lensOverRebuilt ? fmt(m.lensOverRebuilt, 4) : "—"}</td><td>${m.liquidity && m.liquidity !== "0" ? Number(m.liquidity).toExponential(2) : "—"}</td><td>${m.live ? Number(m.live.liquidity).toExponential(2) + (m.liquidity === m.live.liquidity ? " (same)" : "") : "—"}</td></tr>`).join("");
  $("check-note").textContent = `Pool ids are recomputed in this page from the keys in baseline.json (viem keccak256 over the ABI-encoded PoolKey). Lens ÷ rebuild is the collector's check of PushCostLens.roundTripCosts against its own replay of the pool from logs at the head block${summary.allLiquidityMatches === false ? "; at least one rebuilt liquidity did not match a Swap event's" : ""}.`;
}

// ───────── first paint, then the live read ─────────
renderHero();
initWhatIf();
renderHistory();
renderFixStats();
renderChecks();
renderWhatIf();

try {
  const block = await client.getBlock();
  let done = 0, failed = 0;
  // two passes: a pool the busy public RPC refused gets one more try after the others
  for (const pass of [markets, markets]) {
    for (const m of pass) {
      if (m.live) continue;
      $("progress").textContent = `block ${fmt(block.number)} (${hhmm(block.timestamp)}) · reading ${m.symbol} (${done + 1} of ${markets.length})…`;
      try {
        m.live = await measure(m, block.number);
        done++;
        renderCapacity(m.symbol, currentWhatIf());
      } catch (e) {
        failed++;
      }
      await sleep(PAUSE_BETWEEN_POOLS_MS);
    }
    failed = markets.length - done;
    if (!failed) break;
    await sleep(2 * PAUSE_BETWEEN_POOLS_MS);
  }
  renderWhatIf();
  renderChecks();
  $("progress").textContent = `read ${done} of ${markets.length} pools live at block ${fmt(block.number)} (${hhmm(block.timestamp)})${failed ? `; ${failed} kept the collector's figures (the public RPC was busy: reload to retry)` : ""} · collector figures ${asOf}`;
} catch (e) {
  $("progress").innerHTML = `<span class="err">Could not reach Robinhood Chain testnet: ${esc(e.shortMessage ?? e.message)}</span>. Showing the collector's figures, ${asOf}.`;
}
