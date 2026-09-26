# Vexi Hakari — 3-minute demo

## 1. Vexi Hakari (0:00–0:15)

Vexi Hakari connects options and spot trading to one maker wallet through Aqua. A Uniswap v4 reference controls when new option quotes stay available. I’ll show the fund movement and a real refused buy.

**Action:** Keep the browser open at the local English replay before presenting.

**Source:** docs/website.md; website/app.js; website/vexi-logo.svg

## 2. One wallet, two strategies (0:15–0:45)

The maker starts with 30 TSLA and 20,000 USDG. Aqua registers an options strategy and a guarded SwapVM spot strategy against that same wallet. Shipping strategies and posting orders move no tokens. The spot guard excludes inventory already promised to options. These virtual balances describe permissions and accounting. They are not extra assets.

**Action:** Point at the single wallet, then follow the two Aqua branches. The oracle connection controls the option quote policy.

**Source:** docs/website.md steps 1–4; website/evidence/demo.json lifecycle initial, ship, post, spot

## 3. Collateral moves at the fill (0:45–1:15)

Here the buyer fills five calls and three puts at a 400 USDG strike. Aqua pulls exactly five TSLA and 1,200 USDG from the maker into the book. The buyer separately pays 64.0064 USDG in total premiums and receives the long positions. Unfilled promises remain in the wallet. This is the point where a promise becomes funded collateral.

**Action:** Trace the maker-to-Aqua-to-book flow. Keep collateral separate from the buyer’s premium. Aqua.pull is the transfer mechanism, not an additional custody account.

**Source:** website/evidence/demo.json lifecycle spot and buy; aqua/test/WebsiteEvidence.t.sol test_WebsiteLifecycle

## 4. The band reduces size near the edge (1:15–1:55)

The public policy uses a fixed five-percent band around a rolling TWAP. This chart is the website’s illustrative calculator: a 400 USDG center and an 8 USDG base premium. At the center, the cap is 50 contracts per call. Halfway to the edge, the cap becomes 25 and the ask becomes 8.4. At 5.1 percent, the buy is refused. Deadlines, anchors and available collateral still apply.

**Action:** Point from the chart peak to +2.5%, then to the refused example. The cap is per call, not a cumulative risk limit.

**Source:** website/band.mjs calculateBand; website/app.js renderLab; fixed example assumes readable observations, liquidity and raw/truncated agreement

## 5. Three checks in the replay (1:55–2:45)

Let’s use the recorded contract replay. Step five shows collateral entering the book. Step seven attempts another buy outside the band. It reverts, and the buyer’s USDG and positions stay unchanged. Step nine shows why recovery alone is not enough: the band is open, but the original quote has expired. The maker must explicitly renew its terms.

**Action:** Click Open local replay. Select 05 Promises become collateral, then 07 The book actually refuses, then 09 An open band is not enough. Leave about 20 seconds total for switching and clicks. If the browser is unavailable, present the three checkpoints on this slide. Return to the deck for the close.

**Source:** website/evidence/demo.json lifecycle buy, pause, expired; recorded balances and EVM refusal assertions. Local URL http://127.0.0.1:8787/?lang=en#replay

## 6. Reproducible contract evidence (2:45–3:00)

The evidence covers 15 lifecycle steps and five tested scenarios on a pinned local fork. No mainnet transactions are broadcast. The repository includes the source and instructions to reproduce it.

**Action:** Finish on the repository link. Do not extend into settlement or adverse-case detail during the three-minute version.

**Source:** docs/website.md; website/evidence/demo.json; scripts/website-evidence.py; scripts/build-website.py. Scope: local EVM integration, synthetic pool history, experimental settlement, no claim of fair expiry value or production readiness. Aqua © Degensoft Ltd 2025. Powered by SwapVM © Degensoft Ltd 2025.
