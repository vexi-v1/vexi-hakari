// Is arbitrage open for a Robinhood stock token right now? Two signals:
//  1. the mint/redeem window: closed from Saturday 02:00 to Monday 02:00 Europe/Berlin time (secondary
//     data; consistent with the first HIMS mint after the 2026-08-30 weekend at 2026-08-31 00:43:30 UTC,
//     i.e. 02:43 CEST);
//  2. the official asset API's tradingCapabilities (market / extended / overnight).
// Writes data/mint-window.json when run directly.
import { writeData } from "./chain.ts";

const ASSETS_URL = "https://api.robinhood.com/rhj/assets";

/** Weekday and hour in Europe/Berlin for a Date. */
function berlin(at: Date): { day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", weekday: "short", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { day: days.indexOf(get("weekday")), hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

/** true while Robinhood's stock-token mint/redeem window is closed (Sat 02:00 → Mon 02:00 Berlin). */
export function mintWindowClosedAt(at: Date): boolean {
  const { day, hour } = berlin(at);
  if (day === 6) return hour >= 2; // Saturday from 02:00
  if (day === 0) return true; // all Sunday
  if (day === 1) return hour < 2; // Monday until 02:00
  return false;
}

export interface Capabilities { symbol: string; tradingCapabilities: unknown; raw: unknown }

export async function assetCapabilities(symbol: string): Promise<Capabilities | null> {
  const res = await fetch(ASSETS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`assets API ${res.status}`);
  const body: any = await res.json();
  const list: any[] = body.assets ?? body.results ?? (Array.isArray(body) ? body : []);
  const a = list.find((x) => (x.tokenSymbol ?? x.symbol) === symbol);
  return a ? { symbol, tradingCapabilities: a.tradingCapabilities ?? null, raw: a } : null;
}

/** The gauge's one-word answer for SafeSettle's `arbOpen`, with the two signals it came from. */
export async function arbOpenNow(symbol: string, at = new Date()) {
  const closed = mintWindowClosedAt(at);
  let capabilities: Capabilities | null = null;
  let apiError: string | null = null;
  try {
    capabilities = await assetCapabilities(symbol);
  } catch (e: any) {
    apiError = String(e?.message ?? e);
  }
  return { symbol, at: at.toISOString(), mintWindowClosed: closed, arbOpen: !closed, capabilities: capabilities?.tradingCapabilities ?? null, apiError };
}

export async function main() {
  const symbols = ["TSLA", "NVDA", "HIMS"];
  const out = [] as any[];
  for (const s of symbols) {
    const r = await arbOpenNow(s);
    out.push(r);
    console.log(s, r.mintWindowClosed ? "mint window CLOSED → arbOpen=false" : "mint window open → arbOpen=true", r.apiError ? `(api: ${r.apiError})` : "");
  }
  writeData(new URL("../data/mint-window.json", import.meta.url).pathname, { generatedAt: new Date().toISOString(), rule: "closed Sat 02:00 → Mon 02:00 Europe/Berlin", symbols: out });
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
