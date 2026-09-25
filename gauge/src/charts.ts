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

export function weekendChart(d: any): string {
  const rows = d.series.filter((r: any) => r.fridayCostUp10 && r.weekendMinCostUp10).sort((a: any, b: any) => a.weekendOverFriday - b.weekendOverFriday);
  const W = 900, rowH = 30, top = 96, L = 90, R = 150;
  const H = top + rows.length * rowH + 60;
  const all = rows.flatMap((r: any) => [r.fridayCostUp10, r.weekendMinCostUp10]);
  const lo = Math.pow(10, Math.floor(Math.log10(Math.max(0.01, Math.min(...all)))));
  const hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...all))));
  const x = (v: number) => L + ((Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (W - L - R);
  const fri = new Date(`${d.friday}T00:00:00Z`);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${FONT}>`;
  s += `<rect width="${W}" height="${H}" rx="12" fill="${C.card}"/>`;
  s += `<text x="24" y="32" font-size="18" font-weight="700" fill="${C.ink}">Every stock pool, the weekend of ${fri.toISOString().slice(0, 10)}: cost to push +10 %</text>`;
  s += `<text x="24" y="54" font-size="13" fill="${C.ink2}">Deepest USDG pool per Robinhood stock token, rebuilt from logs. Blue: Friday's US close. Red: cheapest point while mint/redeem was closed.</text>`;
  for (let v = lo; v <= hi; v *= 10) s += `<line x1="${x(v)}" x2="${x(v)}" y1="${top - 14}" y2="${H - 48}" stroke="${C.grid}"/><text x="${x(v)}" y="${top - 20}" font-size="11" text-anchor="middle" fill="${C.ink2}">${fmt(v, v < 1 ? 2 : 0)}</text>`;
  s += `<text x="${W - R + 8}" y="${top - 20}" font-size="11" fill="${C.ink2}">USDG (log)</text>`;
  rows.forEach((r: any, i: number) => {
    const cy = top + i * rowH + rowH / 2;
    const hl = r.symbol === "HIMS";
    s += `<text x="${L - 12}" y="${cy + 4}" font-size="13" text-anchor="end" font-weight="${hl ? 700 : 500}" fill="${C.ink}">${esc(r.symbol)}</text>`;
    s += `<line x1="${x(r.fridayCostUp10)}" x2="${x(r.weekendMinCostUp10)}" y1="${cy}" y2="${cy}" stroke="${C.muted}" stroke-width="2"/>`;
    s += `<circle cx="${x(r.fridayCostUp10)}" cy="${cy}" r="6" fill="${C.friday}" stroke="${C.card}" stroke-width="2"/>`;
    s += `<circle cx="${x(r.weekendMinCostUp10)}" cy="${cy}" r="6" fill="${C.weekend}" stroke="${C.card}" stroke-width="2"/>`;
    s += `<text x="${W - R + 8}" y="${cy + 4}" font-size="12" fill="${C.ink2}">×${fmt(r.weekendOverFriday, r.weekendOverFriday < 1 ? 2 : 1)}</text>`;
  });
  s += `<text x="24" y="${H - 18}" font-size="11" fill="${C.muted}">×N = weekend minimum ÷ Friday. Cost = swap fees on an exact push and retrace (lower bound). Data: gauge/data/weekend-${d.friday}.json</text>`;
  return s + "</svg>";
}

export function main() {
  const dataDir = new URL("../data/", import.meta.url).pathname;
  out("hims-weekend.svg", himsChart(JSON.parse(readFileSync(dataDir + "hims-replay.json", "utf8"))));
  const friday = process.argv[2];
  if (friday && existsSync(`${dataDir}weekend-${friday}.json`)) {
    out(`weekend-${friday}.svg`, weekendChart(JSON.parse(readFileSync(`${dataDir}weekend-${friday}.json`, "utf8"))));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
