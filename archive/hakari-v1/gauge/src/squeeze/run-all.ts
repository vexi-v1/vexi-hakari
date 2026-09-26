// The whole float-squeeze dataset in one command: the three collectors, then the builder, in that order. Each
// collector keeps everything it fetched under gauge/cache/squeeze/ (resumable cursors and segment files), so a rerun
// reads disk. To make that visible, every HTTP request the steps make is counted (fetch is wrapped for the run;
// nothing about a request, least of all its URL, is printed). Read-only against 4663.
import { run } from "../chain.ts";

const STEPS = ["pools-swaps", "inventory", "supply", "build"] as const;

export async function main() {
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => (requests++, realFetch(...args))) as typeof fetch;
  const t0 = Date.now();
  const lines: string[] = [];
  try {
    for (const step of STEPS) {
      const s = Date.now(), r0 = requests;
      console.log(`\n== squeeze/${step}.ts`);
      const mod = await import(`./${step}.ts`);
      await mod.main();
      lines.push(`  ${step.padEnd(12)} ${((Date.now() - s) / 1000).toFixed(1).padStart(6)} s  ${requests - r0} HTTP requests`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n${lines.join("\n")}\n  all          ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${requests} HTTP requests`);
}

if (import.meta.url === `file://${process.argv[1]}`) run(main);
