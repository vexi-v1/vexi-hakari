// Static SVG charts for the README, drawn from gauge/data. Light card with fixed colours so it reads the same in
// GitHub's light and dark themes.   npm run charts [-- <friday>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const C = {
  card: "#ffffff", band: "#f1f0ec", grid: "#e4e2dc", ink: "#0b0b0b", ink2: "#52514e", muted: "#8a887f",
  price: "#2a78d6", cost: "#eb6834", weekend: "#e34948", friday: "#2a78d6",
};
const FONT = `font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif"`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const fmt = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const out = (name: string, svg: string) => {
  const dir = new URL("../../docs/img/", import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + name, svg);
  console.log("wrote docs/img/" + name);
};

export function himsChart(d: any): string {
  const W = 900, H = 470, L = 64, R = 24;
  const pts = d.points;
  const n = pts.length;
  const x = (i: number) => L + 40 + (i * (W - L - R - 80)) / (n - 1);
  const labels = pts.map((p: any) => {
    const t = new Date(p.timestamp * 1000);
    return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][t.getUTCDay()]} ${t.toISOString().slice(11, 16)}Z`;
  });
  // the closed stretch: from the left edge to halfway between the last closed point and the first open one
  const lastClosed = pts.map((p: any) => p.mintWindowClosed).lastIndexOf(true);
  const bandRight = lastClosed < 0 ? L : lastClosed === n - 1 ? W - R : (x(lastClosed) + x(lastClosed + 1)) / 2;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${FONT}>`;
  s += `<rect width="${W}" height="${H}" rx="12" fill="${C.card}"/>`;
  s += `<text x="${L - 40}" y="32" font-size="18" font-weight="700" fill="${C.ink}">HIMS/USDG on Uniswap v4 (Robinhood Chain), Sunday 2026-08-30</text>`;
  s += `<text x="${L - 40}" y="54" font-size="13" fill="${C.ink2}">Rebuilt from ${fmt(d.modifyLiquidityLogs)} ModifyLiquidity logs; at every point the rebuild matches the chain's own Swap liquidity.</text>`;
  // top panel: price
  const t0 = 78, t1 = 250;
  const vals = pts.map((p: any) => p.usdgPerHims);
  const lo = 20, hi = 60;
  const y = (v: number) => t1 - ((v - lo) / (hi - lo)) * (t1 - t0);
  s += `<rect x="${L}" y="${t0 - 6}" width="${bandRight - L}" height="${H - t0 - 60}" fill="${C.band}"/>`;
  s += `<text x="${L + 8}" y="${t0 + 10}" font-size="12" fill="${C.ink2}">mint / redeem closed: nobody can arbitrage</text>`;
  for (const g of [30, 40, 50]) s += `<line x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}" stroke="${C.grid}"/><text x="${L - 8}" y="${y(g) + 4}" font-size="12" text-anchor="end" fill="${C.ink2}">${g}</text>`;
  s += `<line x1="${L}" x2="${W - R}" y1="${y(d.nyseCloseFriday)}" y2="${y(d.nyseCloseFriday)}" stroke="${C.muted}" stroke-width="1.5" stroke-dasharray="6 4"/>`;
  s += `<text x="${W - R - 4}" y="${y(d.nyseCloseFriday) + 16}" font-size="12" text-anchor="end" fill="${C.ink2}">NYSE close ${d.nyseCloseFriday}</text>`;
  s += `<polyline fill="none" stroke="${C.price}" stroke-width="2.5" points="${vals.map((v: number, i: number) => `${x(i)},${y(v)}`).join(" ")}"/>`;
  vals.forEach((v: number, i: number) => {
    s += `<circle cx="${x(i)}" cy="${y(v)}" r="5" fill="${C.price}" stroke="${C.card}" stroke-width="2"/>`;
    s += `<text x="${x(i)}" y="${y(v) - 12}" font-size="13" font-weight="700" text-anchor="middle" fill="${C.ink}">${fmt(v, 2)}</text>`;
  });
  s += `<text x="${W - R}" y="${t0 + 10}" font-size="12" text-anchor="end" fill="${C.price}" font-weight="600">pool price (USDG)</text>`;
  // bottom panel: cost to push +10 %
  const b0 = 290, b1 = 400;
  const costs = pts.map((p: any) => Number(p.pushUp10.roundTripCostUsdg));
  const cmax = Math.max(...costs) * 1.15;
  const yb = (v: number) => b1 - (v / cmax) * (b1 - b0);
  s += `<text x="${L - 40}" y="${b0 - 12}" font-size="13" font-weight="600" fill="${C.cost}">what it costs to push HIMS 10 % higher and sell back (USDG of fees)</text>`;
  s += `<line x1="${L}" x2="${W - R}" y1="${b1}" y2="${b1}" stroke="${C.grid}"/>`;
  costs.forEach((v: number, i: number) => {
    const top = Math.min(yb(v), b1 - 2);
    s += `<rect x="${x(i) - 26}" y="${top}" width="52" height="${b1 - top}" rx="4" fill="${C.cost}"/>`;
    s += `<text x="${x(i)}" y="${top - 6}" font-size="14" font-weight="700" text-anchor="middle" fill="${C.ink}">${fmt(v)}</text>`;
    s += `<text x="${x(i)}" y="${b1 + 20}" font-size="12" text-anchor="middle" fill="${C.ink2}">${esc(labels[i])}</text>`;
  });
  s += `<text x="${L - 40}" y="${H - 16}" font-size="11" fill="${C.muted}">Points are not evenly spaced in time. Cost = swap fees on an exact push and retrace through the rebuilt liquidity (lower bound). Data: gauge/data/hims-replay.json</text>`;
  return s + "</svg>";
}

export function weekendChart(d: any, himsRef?: { from: number; to: number; ratio: number; label?: string }): string {
  const rows = d.series
    .filter((r: any) => r.fridayMaxSafeExposure && r.weekendMinMaxSafeExposure)
    .map((r: any) => ({ ...r, fri: r.fridayMaxSafeExposure, wk: r.weekendMinMaxSafeExposure, ratio: r.weekendMinMaxSafeExposure / r.fridayMaxSafeExposure }))
    .sort((a: any, b: any) => a.ratio - b.ratio);
  const W = 900, rowH = 30, top = 112, L = 90, R = 150;
  const H = top + rows.length * rowH + (himsRef ? 100 : 80);
  const all = rows.flatMap((r: any) => [r.fri, r.wk]);
  const lo = Math.pow(10, Math.floor(Math.log10(Math.max(0.01, Math.min(...all)))));
  const hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...all))));
  const x = (v: number) => L + ((Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (W - L - R);
  const fri = new Date(`${d.friday}T00:00:00Z`);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${FONT}>`;
  s += `<rect width="${W}" height="${H}" rx="12" fill="${C.card}"/>`;
  s += `<text x="24" y="32" font-size="18" font-weight="700" fill="${C.ink}">13 stock pools, the weekend of ${fri.toISOString().slice(0, 10)}: the largest settlement it could carry</text>`;
  s += `<text x="24" y="54" font-size="13" fill="${C.ink2}">Deepest USDG pool per Robinhood stock token, rebuilt from its logs. USDG, log scale.</text>`;
  s += `<text x="24" y="72" font-size="13" fill="${C.ink2}"><tspan fill="${C.friday}" font-weight="700">●</tspan> Friday's US close   <tspan fill="${C.weekend}" font-weight="700">●</tspan> the lowest while minting was closed</text>`;
  for (let v = lo; v <= hi; v *= 10) s += `<line x1="${x(v)}" x2="${x(v)}" y1="${top - 14}" y2="${H - 48}" stroke="${C.grid}"/><text x="${x(v)}" y="${top - 20}" font-size="11" text-anchor="middle" fill="${C.ink2}">${fmt(v, v < 1 ? 2 : 0)}</text>`;
  rows.forEach((r: any, i: number) => {
    const cy = top + i * rowH + rowH / 2;
    const hl = r.symbol === "HIMS";
    s += `<text x="${L - 12}" y="${cy + 4}" font-size="13" text-anchor="end" font-weight="${hl ? 700 : 500}" fill="${C.ink}">${esc(r.symbol)}${r.hooked ? " †" : ""}</text>`;
    s += `<line x1="${x(r.fri)}" x2="${x(r.wk)}" y1="${cy}" y2="${cy}" stroke="${C.muted}" stroke-width="2"/>`;
    s += `<circle cx="${x(r.fri)}" cy="${cy}" r="6" fill="${C.friday}" stroke="${C.card}" stroke-width="2"/>`;
    s += `<circle cx="${x(r.wk)}" cy="${cy}" r="6" fill="${C.weekend}" stroke="${C.card}" stroke-width="2"/>`;
    s += `<text x="${W - R + 8}" y="${cy + 4}" font-size="12" fill="${C.ink2}">×${fmt(r.ratio, 2)}</text>`;
  });
  if (himsRef) s += `<text x="24" y="${H - 54}" font-size="12" fill="${C.ink}">${himsRef.label ?? `For comparison, HIMS on Sunday 2026-08-30: ${fmt(himsRef.from)} → ${fmt(himsRef.to)} USDG (×${himsRef.ratio.toFixed(3)}).`}</text>`;
  s += `<text x="24" y="${H - 34}" font-size="11" fill="${C.muted}">SafeSettle's bound with nobody pushing back. ×N = weekend minimum ÷ Friday. Data: gauge/data/weekend-${d.friday}.json</text>`;
  if (rows.some((r: any) => r.hooked)) s += `<text x="24" y="${H - 18}" font-size="11" fill="${C.muted}">† Hooked pool: the hook's own charges are not in the bound, so it may read low (conservative).</text>`;
  return s + "</svg>";
}

/**
 * One measure, three weekends: max safe exposure ÷ its value at Friday's US close, hour by hour after that close, log
 * scale. HIMS/USDG 2026-08-28 (the squeeze page's minute replay, every 10th minute), AMC's ETH/AMC pool the same
 * weekend, and AMC/USDG over Labor Day (gauge/data/amc-weekends.json).
 */
export function amcChart(amc: any, sq: any): string {
  const W = 900, H = 420, L = 64, R = 220, T = 76, B = 336;
  // gapEnd: hours after Friday's close until the first mint or burn after Saturday 00:00 UTC, as the chain shows it
  const lines: { label: string; color: string; pts: { h: number; r: number }[]; gapEnd: number }[] = [];
  const fridayOf = (iso: string) => Date.parse(iso) / 1000;
  if (sq) {
    // the minute replay, as the lowest minute of every ten, so the line keeps its lows
    const safe: (number | null)[] = sq.series.hakari.maxSafeUsdg;
    const f = 1_787_947_200;
    const fri = safe[(f - sq.t[0]) / 60]!;
    const pts: { h: number; r: number }[] = [];
    for (let i = (f - sq.t[0]) / 60; i < sq.t.length; i += 10) {
      const bucket = safe.slice(i, i + 10).filter((v): v is number => v !== null);
      if (bucket.length) pts.push({ h: (sq.t[i] - f) / 3600, r: Math.min(...bucket) / fri });
    }
    const firstMint = Date.parse("2026-08-31T00:43:30Z") / 1000; // HIMS's first mint after the weekend (squeeze dataset)
    lines.push({ label: "HIMS/USDG, 08-28", color: C.price, pts, gapEnd: (firstMint - f) / 3600 });
  }
  const add = (w: any, key: string, label: string, color: string) => {
    const f = fridayOf(w.fridayClose);
    const fri = w.summary[key].friday.maxSafeUsd;
    const pts = w.series[key].filter((r: any) => !r.missing && Date.parse(r.t) / 1000 >= f).map((r: any) => ({ h: (Date.parse(r.t) / 1000 - f) / 3600, r: r.maxSafeUsd / fri }));
    const end = w.observedMintGap.firstMintOrBurnAfter ? Date.parse(w.observedMintGap.firstMintOrBurnAfter.time) / 1000 : Date.parse(w.end) / 1000;
    lines.push({ label, color, pts, gapEnd: (end - f) / 3600 });
  };
  add(amc.weekends[0], "ethAmc", "AMC (ETH/AMC), 08-28", C.cost);
  add(amc.weekends[1], "amcUsdg", "AMC/USDG, Labor Day", "#1baf7a");
  const hMax = 66, lo = 0.004, hi = 4;
  const x = (h: number) => L + (Math.min(h, hMax) / hMax) * (W - L - R);
  const y = (r: number) => T + (1 - (Math.log10(Math.min(hi, Math.max(lo, r))) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (B - T);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${FONT}>`;
  s += `<rect width="${W}" height="${H}" rx="12" fill="${C.card}"/>`;
  s += `<text x="24" y="32" font-size="18" font-weight="700" fill="${C.ink}">One measure, three weekends: the largest settlement each price could carry</text>`;
  s += `<text x="24" y="54" font-size="13" fill="${C.ink2}">SafeSettle's bound with nobody pushing back, ÷ its value at Friday's US close; rebuilt from Robinhood Chain's logs. Log scale.</text>`;
  // mint window closed by the calendar rule: Sat 00:00 UTC (4 h after the close) to Mon 00:00 UTC (52 h)
  s += `<rect x="${x(4)}" y="${T}" width="${x(52) - x(4)}" height="${B - T}" fill="${C.band}"/>`;
  s += `<text x="${x(4) + 8}" y="${B - 8}" font-size="12" fill="${C.ink2}">mint / redeem closed, Sat 00:00 → Mon 00:00 UTC by the calendar (Labor Day: to Tue 00:57)</text>`;
  for (const g of [0.01, 0.1, 1]) s += `<line x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}" ${g === 1 ? `stroke="${C.muted}" stroke-dasharray="6 4"` : `stroke="${C.grid}"`}/><text x="${L - 8}" y="${y(g) + 4}" font-size="12" text-anchor="end" fill="${C.ink2}">${g === 1 ? "Friday" : `×${g}`}</text>`;
  for (let h = 0; h <= hMax; h += 12) s += `<text x="${x(h)}" y="${B + 18}" font-size="12" text-anchor="middle" fill="${C.ink2}">${h ? `+${h} h` : "Fri 20:00 UTC"}</text>`;
  const labelY: number[] = [];
  for (const ln of lines) {
    s += `<polyline fill="none" stroke="${ln.color}" stroke-width="2" stroke-linejoin="round" points="${ln.pts.filter((p) => p.h <= hMax).map((p) => `${x(p.h).toFixed(1)},${y(p.r).toFixed(1)}`).join(" ")}"/>`;
    const low = ln.pts.filter((p) => p.h >= 4 && p.h <= Math.min(hMax, ln.gapEnd)).reduce((m, p) => (p.r < m.r ? p : m));
    s += `<circle cx="${x(low.h)}" cy="${y(low.r)}" r="5" fill="${ln.color}" stroke="${C.card}" stroke-width="2"/>`;
    let ly = y(low.r);
    while (labelY.some((v) => Math.abs(v - ly) < 34)) ly += 34;
    labelY.push(ly);
    s += `<text x="${W - R + 12}" y="${ly}" font-size="13" font-weight="700" fill="${ln.color}">${esc(ln.label)}</text>`;
    s += `<text x="${W - R + 12}" y="${ly + 16}" font-size="12" fill="${C.ink2}">×${fmt(low.r, low.r < 0.1 ? 3 : 2)} at +${fmt(low.h, 1)} h, minting shut</text>`;
  }
  s += `<text x="24" y="${H - 34}" font-size="11" fill="${C.muted}">Dots: each price's low before its first mint or burn. HIMS: web/squeeze/data.json, the lowest minute of every ten.</text>`;
  s += `<text x="24" y="${H - 18}" font-size="11" fill="${C.muted}">AMC: gauge/data/amc-weekends.json, 10-minute grid, ETH/AMC in USD through an ETH/USDG pool. The Labor Day low is a push down.</text>`;
  return s + "</svg>";
}

export function main() {
  const dataDir = new URL("../data/", import.meta.url).pathname;
  out("hims-weekend.svg", himsChart(JSON.parse(readFileSync(dataDir + "hims-replay.json", "utf8"))));
  const friday = process.argv[2];
  if (friday && existsSync(`${dataDir}weekend-${friday}.json`)) {
    // HIMS 2026-08-30 by the chart's own measure (weekend minimum ÷ Friday's US close), from the squeeze page's
    // minute replay when it is there (web/squeeze/data.json, npm run hims:hook + squeeze:build); otherwise the
    // five-point hims-replay (19:40 → min), labelled as such.
    const squeeze = new URL("../../web/squeeze/data.json", import.meta.url).pathname;
    let ref: { from: number; to: number; ratio: number; label?: string };
    if (existsSync(squeeze)) {
      const sq = JSON.parse(readFileSync(squeeze, "utf8"));
      const safe: (number | null)[] = sq.series.hakari.maxSafeUsdg;
      const fri = safe[(1_787_947_200 - sq.t[0]) / 60]!; // Fri 2026-08-28 20:00 UTC, the NYSE close
      const lo = Math.min(...safe.filter((x): x is number => x !== null));
      ref = { from: fri, to: lo, ratio: lo / fri };
      ref.label = `For comparison, HIMS on 2026-08-28 → 08-30, same measure: ${fmt(fri)} USDG at Friday's close → ${fmt(lo)} at Sunday 23:25 (×${fmt(lo / fri, 3)}).`;
    } else {
      const hims = JSON.parse(readFileSync(dataDir + "hims-replay.json", "utf8"));
      const safe = hims.points.map((p: any) => Number(p.maxSafeExposureUsdg.usdg));
      ref = { from: safe[0], to: Math.min(...safe), ratio: Math.min(...safe) / safe[0] };
    }
    out(`weekend-${friday}.svg`, weekendChart(JSON.parse(readFileSync(`${dataDir}weekend-${friday}.json`, "utf8")), ref));
  }
  if (existsSync(`${dataDir}amc-weekends.json`)) {
    const squeeze = new URL("../../web/squeeze/data.json", import.meta.url).pathname;
    out("amc-weekends.svg", amcChart(JSON.parse(readFileSync(`${dataDir}amc-weekends.json`, "utf8")), existsSync(squeeze) ? JSON.parse(readFileSync(squeeze, "utf8")) : null));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
