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

## 2026-09-25 — deploy the public demo

> 這個gas已經有了吧，你直接接手即可啊
> ("The gas is already there; just take it over yourself.")

Output: `script/DemoPool.s.sol` and `script/DemoSettle.s.sol`, run on testnet 46630 from the project wallet.

## 2026-09-25 — hand-off material

> 把相關東西先記錄下來然後開ticket or docs 然後我讓Abner接手
> ("Write it down, open a ticket or docs, and I'll have Abner take over.")

Output: a demo runbook and a hand-off note. Both were later moved out of this repo into the team's private
tracker; they were about who does what next, not about the build.

## 2026-09-25 — fix what an internal review found

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
