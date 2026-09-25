# Prompt log

Times are JST. Each entry: the prompt as given (or a faithful summary when it was long),
and what the AI produced from it.

## 2026-09-25 21:20 — H0, the spec

Prompt: the full spec in `2026-09-25-spec-zh.md`, followed by the Uniswap Foundation and
1inch prize pages pasted from ETHGlobal, and:

> 中間除非遇到問題，不然不要停下來問我，直接幫我做完，不用分Eric or Abner
> ("Unless you hit a problem, don't stop to ask me — do the whole thing; don't split it
> between Eric and Abner.")

Decisions recorded in the prompt: name is HAKARI; Curvegrid is skipped; mentioning our own
protocol (Vexi) as the source of the atomic-push measurement is fine.

Output: repo skeleton (LICENSE, AGENTS.md, FEEDBACK.md, SPEC.md, this log), pinned
libraries, then the contracts in the order of SPEC.md § 7.

## 2026-09-25 21:50 — .env

> 幫我新建.env and .env.example, 然後我把 RH_TESTNET_RPC / RH_MAINNET_RPC 貼進去
> ("Create .env and .env.example; I'll paste RH_TESTNET_RPC / RH_MAINNET_RPC in.")

Output: `.env.example` (public RPC defaults, `HAKARI_DEPLOYER_KEY` empty), `.env` git-ignored and
never read by the AI.

## 2026-09-25 22:21 — deploy the public demo

> 這個gas已經有了吧，你直接接手即可啊
> ("The gas is already there; just take it over yourself.")

Output: `script/DemoPool.s.sol` and `script/DemoSettle.s.sol`, run on testnet 46630 from the project wallet.

## 2026-09-25 22:24 — Abner joins: plan the remaining work

Prompt (Abner, separate Claude Code session):

> 準備開始執行 vexi-hakari，先計劃該做哪些事
> ("Getting ready to work on vexi-hakari; first plan what needs doing.")

Output: a read-only audit of the repo at `641a750` (contracts, tests, gauge data, web page,
submission rules, the 46630 deployment, spec coverage, judging) in which a second agent tried to
refute each finding, then a timed plan to submission. The audit's probe tests reproduced two v0
limits of `SafeSettle`: the cost walk starts at the (possibly pushed) current price, and
just-in-time liquidity can flip the decision. Nothing in the repo was changed by this step.

## 2026-09-25 22:26 — hand-off material

> 把相關東西先記錄下來然後開ticket or docs 然後我讓Abner接手
> ("Write it down, open a ticket or docs, and I'll have Abner take over.")

Output: a demo runbook and a hand-off note. Both were later moved out of this repo into the team's private
tracker; they were about who does what next, not about the build.

## 2026-09-25 23:00 — fix what an internal review found

> 那你幫我修好這些，然後推上去後發ticket at Abner讓他做最後review
> ("Fix these, push, then open a ticket for Abner's final review.")

An internal review of this repo (two AI reviewers) listed defects; this batch fixes them: the cost model
priced a fake from the wrong starting price, `SafeSettle` could be fooled from inside an unlock, the open-
arbitrage holding cost was an upper estimate labelled a lower bound, hour stamps in the docs were invented,
the README quoted simulation numbers instead of the on-chain event, `.env.example` was git-ignored, and the
testnet contracts were deployed from an older commit by a shared wallet. Contracts were redeployed from the
fixed commit by the project wallet and verified on the explorer.

> 環境檔案有專用的RPC啊為何會打爆？以及你應該寫成幾組然後輪用？
> ("The .env has dedicated RPCs — why are we hitting limits? Make it several and rotate.")

Output: the gauge loads `.env`, rotates across every configured mainnet RPC with failover, checks each
answers chain 4663, and never prints a URL (`gauge/src/chain.ts`, tested against local fake RPCs).

> 這個你可以查個30 隻即可，但是拿來講故事的HIMS一定要有
> ("Thirty tokens is enough, but HIMS — the story — must be in.")

Output: `gauge/src/discover.ts` (30 symbols, HIMS always) and `gauge/src/weekend.ts`.

## 2026-09-25 23:45 — docs accuracy pass

> git pull and update docs

Output: README, `docs/DEMO.md`, `docs/HANDOFF.md`, `FEEDBACK.md` corrected against the chain and the
committed data:
- the public `Settled` figures now come from the mined log (truncated 1250, not the simulated 1158);
- the HIMS weekend is told as two moments (12 USDG at 23:53 UTC while closed, 54.50 at reopening);
- the first-mint block label is fixed;
- the Δ sample window is stated;
- the "every figure is a lower bound" claim is withdrawn, and a "Known limitations" section is added;
- "Run it" is fixed (26 offline tests, exact fork-test names, `npm ci`, a snapshot-refresh note);
- the local server is bound to 127.0.0.1;
- FEEDBACK hour tags are replaced with commit times.

`.env.example` was written fresh (not from `.env`) and un-ignored.

## 2026-09-26 00:00 — two sessions, one branch

Abner's docs pass (`ce70a28`) and Eric's fixes landed on `main` from two machines at the same time, both
starting from `641a750`. The merge keeps Abner's corrections against the chain (the two HIMS moments,
the last-block-before-first-mint label, the narrowed bytecode claim in FEEDBACK § 8, the limitations he
listed, `127.0.0.1`, `npm ci`) inside the rewritten README and FEEDBACK. His review also found that
`gainIfFaked` used the tick's direction where the quote is currency0; that is fixed in `fced71c` and
`SafeSettle` was redeployed. The limitations his audit reproduced (walk start, same-transaction
liquidity) are fixed in code in `d93a700`; the cross-block one remains and is listed.

## 2026-09-26 00:25 — Abner: review the fixes, keep going

> 繼續近一步的更新
> ("Carry on with the next round of updates.")

Output: a review of the fixes merged at `a36f2d4`. The offline suites were re-run (33 forge, 17 gauge), and
the 46630 addresses, explorer verification and the new `Settled` tx were checked against the chain. The
README gets back three caveats the merge dropped: the per-point liquidity check, the ladder snapshot, and
the Δ sample window. It also gains one new limitation: the walk cap is shared with the leg back to the
truncated price, and when that leg exhausts it, the rule settles truncated. The AI disclosure now says two
people directed the work, as `log.md` shows.

## 2026-09-26 01:00 — Abner: does it actually solve the problem?

> 真的有解決到問題嗎　詳細解釋
> ("Does it really solve the problem? Explain in detail.")

Output: an adversarial check of the settlement rule, run outside the repo against `src/` at `c508ed2`.

Three probe tests use the `ThreeLayers` setup:
- a push held until the two series converge settles on raw with no cost check;
- a liquidity wall added and removed in separate transactions flips truncated to raw and is withdrawn minus 1 wei;
- a genuine surge on a thin pool settles truncated.

A replay of the real HIMS/USDG swaps of 2026-08-30/31 through the hook's observation rule settles at 43–52 USDG
at the peak. Arithmetic on the committed TSLA-shaped decisions shows the weekday/weekend contrast depends on
the notional and on the asserted 5-second reversion.

## 2026-09-26 01:20 — Abner: record the conclusions as work to do

> 這些結論要列為需要做的事項，更新相關文件　commit and push
> ("List these conclusions as things to do, update the related docs, commit and push.")

Output:
- README: the headline now says HAKARI measured the HIMS weekend but its demo rule would not have stopped the
  payout, and the TSLA table states what it depends on.
- Limitations adds convergence, the HIMS replay, the wall across transactions, per-call gain and thin-pool lag.
- Next lists the fixes: fence-aware settlement, pricing agreement from an anchor, gain from open interest,
  time-weighted liquidity, tests for each limit.
