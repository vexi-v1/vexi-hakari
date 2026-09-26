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

## 2026-09-26 02:30 — replace the settlement rule

After reading the review (`e581e23`), Eric chose to change the rule rather than only document its limits:

> 不會，你直接做2
> ("No — just do option 2.")

Output: `CostModel` v1 and `SafeSettle` v1 (`98bc7d7`): instead of choosing between the raw and truncated TWAP by
their gap, price the largest exposure the pool can carry now (moves of 0.5–20 % and the gap, both ways, held over
the window) and settle on raw only below it, refusing otherwise. The review's probes became tests; the liquidity
wall across transactions stays as a known-limit test. Redeployed on 46630 and verified; the HIMS replay and the
2026-09-18 weekend are priced as max safe exposure; `script/record-fork-tests.sh` records fork output on the public
RPC with URLs masked.

Follow-up commits under the same instruction: `dc4fc59` pins the gauge's max-safe-exposure mirror to
`CostModel.maxSafeExposure` with a forge fixture; `05866c0` flags hooked pools in the gauge and the chart;
`df1216e` records the gas of one settlement on the TSLA book and the fork figures, but its message also claims the
README text, which the commit did not contain (the edit script failed and the commit ran anyway); `7b2331c` is
that README text, committed a minute later. The history is left as it is.


## 2026-09-25 23:30 — Abner: the float squeeze, as a page to show people

> 針對 https://defiprime.com/tokenized-stock-float-squeeze 能不能做個網頁版的視覺化互動。能夠調整時間軸，列出
> HIMS, BONER, USDG 彼此的流動性/價格變化與對照，並且有解釋發生什麼事情，方便向別人展示與快速說明。把相關檔案與內容
> 都放在 vexi-hakari（作為展示內容）。等到 Vexi 相關實作完成後，可以再做更進一步比較，視覺化展示解決的問題
> ("Make an interactive web visualisation of the DeFiPrime float-squeeze article: a timeline you can scrub, HIMS,
> BONER and USDG liquidity and prices against each other, with explanations, so it is easy to show and explain.
> Put it in vexi-hakari. Once the Vexi side is done we can compare further and show the problem it solves.")

Follow-ups during the work: use the private RPC in `.env` (never read by the AI) instead of waiting on the public
endpoint's 429s; cache everything already fetched and never fetch it twice; search X through twitterapi.io for
posts that corroborate or add to the story; commit and push as each stage lands.

Output: `gauge/src/squeeze/` (new collectors: every HIMS/BONER pool's swaps with exact block timestamps, LP
positions rebuilt from `ModifyLiquidity` and checked against every `Swap` event's liquidity and against archive
`StateView` reads, HIMS supply and PoolManager balance folded from `Transfer` logs and checked to the wei against
archive `totalSupply`/`balanceOf`, HAKARI's cost to push +10 % on a one-minute grid), `web/squeeze/` (the page:
bilingual EN/繁中 chapters, a scrubbable timeline, the HIMS–BONER–USDG flow triangle, an "on X" lane from
paraphrased posts with their claims checked against the chain). Built with Claude Code workflows; the data went
through three adversarial verification passes and the page through four critique lenses.

## 2026-09-26 03:10 — Abner: finish everything, commit as it lands

> 這些內容完成，自動 commit and push，並且繼續審查與驗收。完成所有 Abner 該做的事情。讓整個故事合理有數據佐證，相關
> demo 都夠引人入勝了解情況。參考過往得獎隊伍，優化各種展示以及說明。完成所有事
> ("As things finish, commit and push automatically, and keep reviewing and accepting them. Do everything Abner
> owns. Make the whole story reasonable and backed by data, and the demos engaging enough to understand what
> happened. Look at past winning teams to improve every presentation and explanation. Finish everything.")

Output so far: the squeeze dataset, page, X lane and their verification rounds landed as separate commits
(`db5dd20` … `a5ac3a7`); todo A2, the HIMS weekend replayed through HakariOracleHook and SafeSettle v1/v0 per
minute (`957a333`, `npm run hims:hook`). Items that need a person or both of us (repo visibility, Pages, the
Uniswap feedback form, the video, the ETHGlobal submission) are prepared, not done.

## 2026-09-26 03:48 — Eric: a new session takes over from the hand-off

> (The hand-off prompt, in Chinese. It is kept out of the repo because it carries the submission runbook; in
> short: a second review measured the real TSLA/USDG book with the lens and found that `CostModel` stopped
> widening the push at 4× the move, so the README's two weekday "settle on raw" rows were wrong. Fix that first
> with a failing test, re-measure, redeploy and verify; then the documentation defects the review listed. Do not
> stop to ask unless something is wrong.)

Output: `20e7d87` (every push width until no wider one can be cheaper; `PushCostLens.roundTripCosts` prices them
all from one walk each way, which took gas from 23.8M to 1.9M on the TSLA book) and `44521a9` (each move's
one-interval width exactly). On the TSLA book at block 72,481,549 the weekday bound is 25,269 USDG at 60 s and
58,044 at 12 s: 100,000 is refused on a weekday too. The TSLA shadow pool now mirrors the whole book. Lens and
`SafeSettle` redeployed from `44521a9` on 46630 and verified; the demo settlement was re-run against them. README,
FEEDBACK (§ 7 rewritten for v1, § 10 new) and this log corrected as listed.


## 2026-09-26 11:20 — Abner: a live board, a measured reversion time, and a second case

> 1. 「現在就被圍住的池子」即時看板：評審多半在週末、而且是鑄造窗口關閉時看 demo。看板每分鐘更新每個股票池目前的安全額度，
> 並和週五收盤時比較，能當場看到問題正在發生，而不只是看八月的重播，對 Finalist 現場最有說服力。約 2 小時，都在 gauge 和
> web 範圍內，屬於我這邊。
> 2. 實測套利拉回時間：從平日的 swap 資料量出每個池子價格被推開後多快被拉回，取代 README 裡「呼叫者自己填」的假設。這是
> 評審最可能追問的弱點（檢查清單 A6）。約 1.5 小時。
> 3. 第二個案例：同週末的 AMC：X 研究裡看到 AMC 代幣曾印出約 $166（正股約 $2.59），造市商在勞動節週末前預先鑄造了約 $1M
> 的 AMC 代幣。用現成的收集器和 skill 就能重建，可以正面回答「HIMS 是不是特例」。約 2 小時。
>
> ("1. A live board of the pools boxed in right now: judges mostly watch the demo at the weekend, while the mint window is
> closed. Every minute, each stock pool's current safe amount against Friday's close, so the problem can be seen happening,
> not only replayed from August. 2. Measure the arbitrage pull-back time: from weekday swaps, how fast each pool's price is
> pulled back after being pushed, replacing the README's 'the caller fills it in'. The weakness judges are most likely to
> press on (checklist A6). 3. A second case, AMC on the same weekend: X posts say the AMC token printed about $166 against
> a ~$2.59 stock, and that the market maker pre-minted about $1M of AMC tokens before the Labor Day weekend. Rebuild it with
> the existing collectors and skill, to answer 'was HIMS a one-off?' head on.")

Output: (1) `web/live/`, every stock pool's max safe exposure measured each minute in the browser against Friday's
close, and `npm run live:baseline`, which rebuilds Friday's close and every hour since from logs and checks the page's
own lens call against the rebuild at one block (equal on every fixed-fee pool; GLD and AMZN, dynamic-fee, are labelled,
FEEDBACK § 11). (2) `npm run reversion`: over 2026-09-19..26, 18 % of weekday pushes of 10+ ticks were undone within a
minute and 53 % within an hour; the slow-side rule gives `arbReversionSeconds = 0` for all 28 stock pools, so the
README's weekday rows became assumptions, and pushes were undone as often on the closed weekend (pool-to-pool
arbitrage). (3) `npm run amc`: AMC's ETH/AMC pool printed 166.77 USD against 2.66 at Friday's close on 2026-08-30,
its bound falling to 0.14×; over Labor Day one address minted 2.99M AMC on the Friday, the AMC/USDG price held, and
its bound fell to 0.07× with the cheapest fake a push down. Minting stayed shut through Labor Day Monday, which the
calendar rule does not know (README § Limitations).

## 2026-09-26 11:10 — Abner: a plain-language, all-English demo (keep Chinese)

> 要有全英文版，且易讀好懂說人話版本的 Demo website（保留中文版）
> ("There should be a fully English, easy-to-read, plain-language version of the demo website — keep the Chinese one.")

Follow-ups: commit and push when done; share the Artifacts with Eric (done by Abner from the Share menu — the AI
cannot change sharing).

Output: `web/plain/` (`20d8229`, `b4f5e01`, `87d1b16`): eight short sections, one idea and one visual each, English by
default and 繁中 via `#zh`, written separately (not translated); every number computed from `web/squeeze/data.js` at
load and checked at build time (`build-plain.mjs`). Read by a lay English reader, a lay Taiwanese reader, an accuracy
check and a design pass before the fixes; English at Flesch–Kincaid grade ≤ 8. The detailed replay's English mode was
swept for Chinese text (none but the 繁中 switch) and both pages take `#en` / `#zh` links (`a310e51`).

## 2026-09-26 18:30 — Abner: add Vexi so the result is more useful

> hakari 現在有點單薄 / 成果有點不足 / 能不能加上 Vexi 做出更有用的方案
> ("HAKARI feels a bit thin right now, the result is a bit short. Can we add Vexi and make something more useful?")

Context given with the prompt: Vexi is our own options venue (pre-hackathon, BUSL-1.1, none of its code may be
pasted); it fixes a settlement price from six hookless v4 pools on the official PoolManager on testnet 46630 every
15 minutes, so for that one consumer the exposure settling on a pool's price is readable from its ERC-6909 supply
and HAKARI's bound can be checked against every fix the venue has made. Planned as three parallel lanes: the gauge
collector (`npm run vexi`), a hook-free on-chain consumer (`ExposureGuard`) with a 46630 fork test, and a static
board under `web/vexi/` plus the README section; the video stays Vexi-free.

Output: three lanes in parallel from one plan, nothing deployed and nothing broadcast. (1) Gauge: `gauge/src/chain.ts`
(a 46630 client, `getLogsHalving` for the public RPC's 10,000-log cap), `gauge/src/vexi-abi.ts` and
`gauge/data/vexi-markets.json` (`5138b83`); `npm run vexi` (`gauge/src/vexi.ts`, `3aec076`) writes
`gauge/data/vexi-fixes.json`, `web/vexi/baseline.json` and `test/fixtures/vexi-series.json`: 8,873 fixes since the
venue's deploy block, 39 of 460 cells with exposure (1,806 USDG), every one below the bound, closest 0.37 (PONS
2026-09-25 16:30 UTC); the 0.5 % rung's bound 7.6–9.2 % above the 20 % rung's and 0.274 % of the quote-side reserve on all
six pools. (2) Contract: `src/ExposureGuard.sol`, `src/interfaces/IVexi.sol`, `test/ExposureGuard.t.sol` and
`test/utils/MockVexi.sol` (`a11de1b`, 9 tests); `test/fork/ExposureGuard.fork.t.sol` with `script/VexiSeries.sol`,
transcript `docs/demo-outputs/vexi-guard-46630.txt` (`bdd5bf9`, run alone: `RH_TESTNET_RPC= forge test --match-path
'test/fork/ExposureGuard*' -vv`, 2 pass, block 124,542,896); `script/DeployExposureGuard.s.sol` and
`script/DemoVexiCheck.s.sol` (`f8478c4`), rehearsed with `forge script … --rpc-url robinhood_testnet` and
`--sig 'rehearse()'`, no `--broadcast`, so `deployments/46630-vexi.json` does not exist. (3) Web and docs: the stub
baseline (`f75fc5e`), `web/vexi/` with `gauge/test/vexi-core.test.ts` and the entry card in `web/index.html`
(`5eac81a`), this entry (`4bd1be6`), then the README's "A second consumer: our own venue, on testnet" section, its
`ExposureGuard` rows, Limitations, Run it (`forge test --no-match-path 'test/fork/*'` 53, `cd gauge && npm test` 118),
Provenance, Next and AI disclosure, every figure typed from `gauge/data/vexi-fixes.json` and the fork transcript (the
docs commit that closes this entry). Addresses called, not deployed: the venue `0xF91B7277…` and its spot registry
`0xCEde7e1E…` on 46630. Cut: the writable-by-mandate column, the `Poked` observation weights, the deploy and demo
transactions (left for a human with the key), and the board screenshot.

## 2026-09-26 23:20 — Abner: the vexi board's framing, a hook-optional line in the README, the video's Vexi segment

> https://developers.uniswap.org/llms-full.txt
> 3、4、5 項動手
>
> ("Do items 3, 4 and 5." The items came from a review asked as "the whole story, what it has to do with Uniswap, how to make
> the Uniswap and the other judges think we deserve to win", against the prize page's own yardstick, "integration quality and
> ecosystem impact". Item 3: the vexi board's lead opens with why a venue, the what-if shows the bound itself as a second
> line, and the page names `ExposureGuard`. Item 4: one README sentence, the hook is optional. Item 5: the 25-second Vexi
> segment of the video, drafted. Items 1 and 2, the Uniswap Developer Feedback Form and an `ExposureGuard` broadcast on
> 46630, stay with a human; the board's `ExposureGuard` line says "not deployed" until then.)

Output: `web/vexi/index.html` (the lead: the exposure settling on a price is the one input the bound cannot read for
itself, and an ERC-6909 venue is where it is readable; a second what-if line; the finding's bullet says a full-range
position is the calibration case, HIMS at 0.006× and TSLA's +100 % push the counter-examples; a new bullet on
`ExposureGuard` with the fork test and its transcript), `web/vexi/app.js` (the second line is `whatIf(bound, bound)` and
`whatIf(bound × 0.5, bound)` from `core.js`, so the tests that pin `core.js` still cover it), `README.md` (first paragraph:
`SafeSettle` needs a hooked pool, `ExposureGuard` reads the same bound on any existing pool, 26 of the 28 deepest
stock-token pools have none, FEEDBACK § 10). The video segment was handed over in the session, not committed. Checked
locally on `python3 -m http.server` before the commit.

## 2026-09-26 23:45 — Abner: what a refusal does, in plain words, with enough background

> 安全線本身放上去，它就拒絕。拒絕會發生什麼事？能不能講仔細一點，要有充足的背景，讓大家好懂。如果很難插入進去解釋，就用 FAQ
> 把可能的問題列出來並回答。
>
> ("'Put the bound itself on it and it refuses.' What happens on a refusal? Explain it in more detail, with enough background,
> so that everyone can follow. If it is hard to work into the text, use a FAQ: list the likely questions and answer them.")

Output: `web/vexi/index.html`, a section "Refused: what it means, and what happens next" after the what-if card: a background
paragraph (fix, exposure, bound, and what refused means), then eight questions as `<details>`, the first open: what a refusal
does (`trusted = false`, `tickUsed` 0, the `Settled` reason), why refuse, what happens next and who decides (wait and retry,
a slower or other source, a cap before expiry; the fallback is the next target), what happens on this venue today (nothing:
the fix does not read the bound), why the line itself refuses and what "watch" is (the board's label, not a rule), who is
worse off, whether a refusal can be forced, and the on-chain refusal tx. Every figure is the README's. The what-if's second
line and the disclosure bullet link to it. The video segment keeps its four-second line; a longer variant went into the
draft's "+5 s" list.

## 2026-09-26 23:30 — Abner: can any third-party protocol on mainnet use HAKARI, and can it go into the story

> 如果我希望真實的創造出實際案例，例如把 Vexi + vexi-hakari 部署到 Mainnet，有意義嗎，能夠創造出真實可用的案例？
>
> 還是能不能找到其他主網 第三方協議 能夠適用 hakari，加入到故事中補充
>
> ("If I want a real, usable case, for example deploying Vexi + vexi-hakari to mainnet, does that make sense? Could it
> create a real case?" Then: "Or can we find other third-party protocols on mainnet that HAKARI applies to, and add them
> to the story as a supplement?")

The first question was answered in the session, not in the repo: deploying does not create a case (a case needs
third-party money, third-party trades and a price somebody else reads), AGENTS.md rule 1 keeps 4663 read-only, and
Vexi's own gates (its RDR-0006: stability period, v1.0, audit, the owner's written word; its RDR-0061: no stock
market on mainnet) close its mainnet in any form. The second question was taken as work.

Output: `gauge/src/consumers.ts` (`npm run consumers`), a read-only survey of who settles on a v4 pool's price on
4663 today: every Morpho Blue market's oracle classified from its runtime code (Chainlink, Uniswap v3 `observe`, or
the v4 PoolManager's `extsload`), every Panoptic V2 pool from both factories with its risk engine's parameters and
live oracle ticks, and the bound from `PushCostLens.roundTripCosts` by state override for each v4 pool one of them
reads, next to what that consumer has riding on it; `gauge/data/consumers.json`; a README section "Who else settles
on a pool's price on 4663 today"; a card on `web/plain/` pointing at it. Candidates came from DefiLlama's Robinhood
Chain listing and its adapters (secondary, addresses only); every number in the section is read from the chain.

## 2026-09-27 00:20 — Abner: the safety line is far-fetched; change the topic to a Vexi-side Uniswap integration

> HAKARI 安全線這件事有點牽強，因為只是設了一個無法約束大家的 bound，沒有有效得行為限制。那 protocol 自己靠規則去保護，反而更容易。
> 所以要直接改變主題。在 Vexi protocol (vexi-v1) 下，目前 Vault 已經串了 v4-hooks，ref developers.uniswap.org/llms-full.txt，
> 找出更好可以整合 Uniswap 滿足 EthGlobal tokyo 2026 的方案
>
> ("HAKARI's safety line is a stretch: a bound that constrains nobody is not a behavioural rule; a protocol protecting
> itself by its own rules is easier. So change the topic. Under Vexi, whose vault already runs v4 hooks, and with
> the Uniswap docs index as reference, find a better Uniswap integration for ETHGlobal Tokyo 2026.")

Then, at 00:50: "開一個新的 session 當反方，你當正方不斷想方案，反方不斷質疑找漏洞，要接地氣" ("open a second
session as the opposing side; you propose, it attacks, and it must stay concrete"). The proposing session drafted
the opposing session's brief; the two exchanged rounds by session message.

What the proposing session put forward: a rule the pool itself would carry, clamping the fix window's recorded
price to a trailing 30-minute TWAP ± 3 % (the old rate limiter's cap), first as a new hook, then as a stateless
reader over any OpenZeppelin `BaseOracleHook` record. What the opposing session found, in two rounds of five: a
clamp applied where the hook writes is skipped by not swapping inside the window (`Oracle.write` credits one tick
to the whole span); a new hook is a new codehash, which Vexi's own decision record pins to one hook; the on-chain
demo could not land before the cut line; and, decisive, with the reversion this chain showed (0 everywhere
measured) holding is free, so the reference costs exactly what the window costs to fake (1.00×), and a push released
before the window makes the clamp read an honest window as the fake. The proposing session conceded all ten.

Outcome: no pivot. Three additions, each its own commit: `test_observe_aPushBeforeAQuietWindow_isWhatTheWindowReads`
and `FEEDBACK.md` § 12; a row in README § "What the review found" and two Limitations paragraphs (a time rule adds
no cost where nobody pulls back; a venue's behavioural limit lives in its sizing); this entry. Wording rule adopted:
"enforced", "guarded", "protected" only where they point at a call that refuses. The answer to the opening
objection, as the opposing session put it: the line is not the rule; the rule can only live where money is at
risk and refuses, and what HAKARI supplies is the input that rule needs and only it measures, depth at settlement.

## 2026-09-27 03:30 — Abner: bring the Aqua seam and the Uniswap band here; archive the study

> 決定把 Eric 新加入的部分：1inch aqua 與 hakari pivot 的 "uniswap band" 相關內容抽出來，放入到 vexi-hakari 中。
> vexi-hakari 已經是 public repo …… 為了 EthGlobal Tokyo 2026 比賽需求，所以得為了 1inch, Uniswap 需要審查的部分，抽出獨立的部分。
> 1. 無關文件與說明都放進 archive 並標注這些內容用途 2. 說明文件解釋需求與主題改變的歷史脈絡
> 3. 盤點如何抽出來只把比賽 1inch, Uniswap 需要的部分
>
> ("Take what Eric added, the 1inch Aqua work and the Uniswap band HAKARI pivoted into, and put it in vexi-hakari,
> which is already public. The other repositories stay private, so for ETHGlobal extract only what 1inch and Uniswap
> review. 1. Archive what no longer applies and say what each part was for. 2. Explain how the requirements and the
> topic changed. 3. Inventory what to extract.") A fourth item set the band's width: a percentage for the
> tokenized-stock demo, chosen by the AI with its reason. The parts of the instruction about what stays private are
> not reproduced here.

Asked back, Abner chose: only the integration seam (the Aqua writer, a small book, the SwapVM guard, the band and the
settlement), a fixed-premium pricer in place of the product's pricer, no pointers to deployments of code that is not
in this repository (a redeploy script instead), and an archive of everything from the study but the hook.

Outcome: the study moved to `archive/hakari-v1/` with `archive/README.md`; `aqua/` holds the seam and the band as a
Foundry project of its own; the band's half-width is 5 %, the Limit Up-Limit Down band of a Tier 1 US stock
(`docs/band.md`); `docs/history.md`, `docs/extraction.md` and `docs/submission.md` are new; `FEEDBACK.md` gained
items 13 to 21. Each step is its own commit.

## 2026-09-27 — Abner: implement public-version review items 1–4

> execute 1 ~ 4

Context (public scope): add fixed-quote validity and an optional original-reference-price anchor; describe the taper
formula as a conditional, single-call size-times-deviation bound; present the fixed 5% band as an illustrative
parameter rather than equivalent LULD protection; make settlement a separate experimental feature with its state
flow and economic outcomes explicit. Keep the public extraction boundary intact.

Implemented with Codex (OpenAI): mandatory quote deadlines, optional captured anchors through a small public price
interface, tests for refusal and renewal, and revised README, band, settlement and submission documentation. No new
settlement fallback, cumulative fill budget or chain deployment is part of this change.

Validation for these changes (Foundry, 2026-09-27 JST):

- Root `forge test`: `5 tests passed, 0 failed, 0 skipped (5 total tests)`.
- In `aqua/`, `forge test --match-path 'test/{FixedPremium,GuardProperties,BookRefund,StabilityBand,StabilityTwapSettle}.t.sol'`:
  `50 tests passed, 0 failed, 0 skipped (50 total tests)`.
- In `aqua/`, `RH_MAINNET_RPC=https://rpc.ordofi.network RH_MAINNET_FORK_BLOCK=72248228 forge test --match-contract 'CanonicalAquaTest|LifecycleTest|StabilityBandForkTest|ExposureGuardCanonicalTest|ExposureGuardTest'`:
  `42 tests passed, 0 failed, 0 skipped (42 total tests)`. The first full-suite attempt lacked the RPC environment
  variable; the explicit public archive endpoint above resolved the five fork-suite setup failures.
- The macOS sandbox's Foundry system-proxy initialization crashed after compilation; the same tests completed
  outside the sandbox. No transactions were broadcast. Existing uncommitted edits were preserved.

## 2026-09-27 — Abner: lead with band feedback

> Put band-related content first in FEEDBACK.md; move the archived version after it, or advise whether to retain it.

Outcome (Codex): current integration entries 13–20 come first; the archived study's entries 1–12 remain in a
clearly marked historical section; research entry 21 is separate and still explicitly not re-checked. Entry
numbers and bodies are preserved for traceability. Added navigation and clarified historical README references;
no new upstream or deployment claims, no archive edits.

## 2026-09-27 — Abner: audit the 1inch and Uniswap submission and fill missing materials

> Vexi-hakari is the project we will submit to ETHGlobal Tokyo 2026, for 1inch and Uniswap. Review what is
> insufficient and whether all required material is present; help fill the gaps.

English translation of the user instruction. The user supplied the ETHGlobal project-dashboard URL and later
authorized inspecting that site's signed-in submission page. No submission or feedback form was sent by this
review. Codex (OpenAI) checked the official prize/event pages, compared the public default branch with the local
working tree, ran the existing suites, and added a readiness review, executable demo runner, presentation guide,
source-line map and Uniswap feedback draft. It preserved the concurrent quote-validity changes, private-product
boundary and licenses. External completion, publication and license eligibility remain explicitly tracked.

## 2026-09-27 — Abner: move historical feedback out of the current document

> Move the historical material out of FEEDBACK.md; it seems unrelated to the current version.

Outcome (Codex): moved entries 1–12 and the unrechecked research note 21 into `archive/feedback-history.md`,
preserving their content and original identifiers while adjusting relative links. The root feedback now contains
only current band entries 13–20 and one historical link. Updated the archive index's feedback pointer.

## 2026-09-27 — Abner: refactor feedback as standalone documents

> Refactor it and update the numbering; the current numbering looks strange.

Outcome (Codex): the current feedback has a concise introduction, eight top-level entries numbered 1–8 and a
single historical link at the end. The historical document numbers its entries 1–13. Updated the extraction
inventory and prepared feedback-form references; earlier prompt entries remain chronological records.

## 2026-09-27 — Abner: how do projects with tokenized stocks handle the same problem, and file it as a reference

> SafeSettle: Panoptic has this too. How do they do it? Search other projects that hit the same problem and their
> solutions. Focus on projects that support tokenized stocks. What are the Aave Equities Hub rules? Put the
> report into vexi-hakari as a reference file.

English translation of the user's instructions, given in Traditional Chinese over several turns. Outcome (Claude
Code): `docs/prior-art-tokenized-stocks.md`, a survey of Chainlink's equity feeds, Aave's V4 Equities Hub, Kamino,
Hyperliquid/trade.xyz, Kraken, Ostium, Ondo, Panoptic v2 and GapGuard, from pages actually opened, with what could
not be confirmed listed; one link added at the end of `docs/band.md`. No code changed.

## 2026-09-27 — Abner: refine the English Uniswap feedback-form draft

> Please improve the English draft.

English translation of the user instruction. Outcome (Codex): rewrote the form answers around the concrete
quote-staleness problem, the enforced v4-to-Aqua purchase path, and observed integration friction. Matched the
current form questions, replaced stale feedback numbering with descriptive references, credited the upstream
oracle, and kept testnet deployments distinct from local-fork demonstrations. Personal ratings, contact details
and consent remain for the participant. No form was filled or submitted, and no contract behavior changed.
