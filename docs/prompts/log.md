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

## 2026-09-25 22:24 — Abner joins: plan the remaining work

Prompt (Abner, separate Claude Code session):

> 準備開始執行 vexi-hakari，先計劃該做哪些事
> ("Getting ready to work on vexi-hakari; first plan what needs doing.")

Output: a read-only audit of the repo at `641a750` (contracts, tests, gauge data, web page,
submission rules, the 46630 deployment, spec coverage, judging) in which a second agent tried to
refute each finding, then a timed plan to submission. The audit's probe tests reproduced two v0
limits of `SafeSettle`: the cost walk starts at the (possibly pushed) current price, and
just-in-time liquidity can flip the decision. Nothing in the repo was changed by this step.

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
