# Vexi Hakari — six-minute demo

## 1. Vexi Hakari (0:00–0:15)

Vexi Hakari connects options and spot trading to one maker wallet. Aqua handles shared strategy accounting and token transfers. A Uniswap v4 reference controls option quotes. We will follow the funds, examine refusals and finish in the working demo.

**Action:** Keep the public replay open before starting. Total planned duration is six minutes.

**Source:** docs/website.md; website/vexi-logo.svg

## 2. Covered calls and cash-secured puts (0:15–0:40)

Our example is a TSLA token priced in USDG. A covered call gives the buyer the right to buy one token at a four-hundred strike. Five USDG buys that right. At three-fifty the buyer walks away; at four-fifty they can pay four hundred and receive the token. A put reverses the delivery, so the writer reserves four hundred USDG.

**Action:** Illustrative contract with a five-USDG premium. This is a teaching example, not the recorded eight-USDG base-premium lifecycle.

**Source:** User-supplied HAKARI Pitch Deck.html, slides 2–3; aqua/src/book/OptionBook.sol

## 3. Idle collateral and stale quotes (0:40–1:05)

Two problems motivate the integration. A deposit-first writer locks all ten tokens even if only two calls sell. Keeping unfilled collateral at home avoids that early transfer. Separately, a token pool can move while the underlying stock market is closed. A fixed option quote can become stale. Aqua addresses when collateral moves; the band controls whether a new quote remains available.

**Action:** The deposit-first comparison is an illustrative design, not a claim about every options protocol. Price path is schematic and is not market data.

**Source:** User-supplied HAKARI Pitch Deck.html, slides 4–6; docs/history.md; docs/band.md

## 4. The public integration (1:05–1:30)

The maker keeps the assets in one wallet. Aqua registers two strategies against it: an option writer connected to the book, and a guarded canonical SwapVM router for spot. The hook records the Uniswap reference. The band wraps the public fixed premium. These are separate responsibilities: liquidity access, order accounting and quote checks.

**Action:** Follow the solid token-access path and the pink reference-policy path separately.

**Source:** docs/website.md; aqua/src/swapvm/ExposureGuard.sol; aqua/src/band/StabilityBandPricer.sol

## 5. Promises stay in the maker wallet (1:30–1:50)

The initial wallet holds thirty TSLA and twenty thousand USDG. Posting ten calls promises ten TSLA. Posting ten puts at a four-hundred strike promises four thousand USDG. Nothing enters the book yet. The rest is unpromised inventory. Aqua virtual allocations refer to these same assets and must not be summed as additional deposits.

**Action:** Point to the promised and free segments, then the zero book balance. No tokens moved in ship/post.

**Source:** website/evidence/demo.json: lifecycle initial, ship, post

## 6. The spot guard protects unfilled promises (1:50–2:15)

The guard computes the outgoing token’s free inventory as wallet balance minus the writer’s promises. It scales both SwapVM reserves before the curve executes. In the guarded test, a four-hundred USDG spot trade leaves about twenty-nine TSLA. In a separate unguarded fixture, selling twenty-one leaves only nine against a ten-TSLA promise. A later call fill refuses. The guard only constrains participating strategies.

**Action:** Compare wallet balance with the ten-TSLA promise. The two trade fixtures have different inputs and are independent, not a performance comparison.

**Source:** website/evidence/demo.json: lifecycle spot; unguarded unguarded; aqua/src/swapvm/ExposureGuard.sol

## 7. A fill moves exact collateral (2:15–2:40)

Now a buyer fills five calls and three puts. Through Aqua.pull, the writer supplies five TSLA and twelve hundred USDG directly to the book. The buyer separately pays 64.0064 USDG in premiums and receives the long positions. The book therefore holds five TSLA and 1264.0064 USDG. Remaining unfilled promises are five TSLA and twenty-eight hundred USDG.

**Action:** Follow green collateral and pink premium paths. Aqua.pull is a transfer mechanism, not an intermediate custody account.

**Source:** website/evidence/demo.json: lifecycle spot, buy; aqua/test/WebsiteEvidence.t.sol

## 8. What the hook records (2:40–3:05)

The center comes from a one-hour tick TWAP. OpenZeppelin’s oracle records before the first swap of each second. A push and undo in one transaction does not enter that observation. A second, truncated series limits each recorded move to two hundred fifty ticks. The band checks both averages. This improves the reference behavior, but a sustained move can still become the center.

**Action:** Schematic observation timing. The chart is not an oracle simulation. The time-weighted mean tick converts to a geometric price average. Credit the upstream oracle.

**Source:** src/HakariOracleHook.sol; test/HakariOracleHook.t.sol; docs/band.md; OpenZeppelin BaseOracleHook / Panoptic oracle

## 9. The reference defines a fixed band (3:05–3:30)

The chart uses recorded reference snapshots. The rolling TWAP is around 378.23 USDG. The public band extends five percent above and below it. At plus 2.5 percent, a quote remains available. At plus 5.1 percent, the price crosses the upper edge and the buy refuses. Reference availability, liquidity and agreement between raw and truncated observations are additional checks.

**Action:** Point to the plus-5.1% snapshot crossing the upper bound. These are synthetic market observations from the local EVM.

**Source:** website/evidence/demo.json: lifecycle buy, taper, pause, recover; aqua/src/band/StabilityBandPricer.sol

## 10. Size and premium react differently (3:30–3:55)

These are illustrative calculator curves, separate from the recorded fork. The center is four hundred and the base ask is eight USDG. The size cap falls linearly toward the edge, while the premium uplift grows quadratically. At plus 2.5 percent, the cap is twenty-five and the ask is 8.4. At the edge the cap reaches zero, so there is no executable quote. The cap applies per call, not as a cumulative trade budget.

**Action:** Point to 2.5% in both charts. Rounding is toward fewer contracts and a higher ask. At ±5% there is no whole contract left.

**Source:** website/band.mjs calculateBand; fixed example assumes readable reference, enough liquidity and raw/truncated agreement

## 11. An open band does not guarantee a fill (3:55–4:15)

An open band is only one gate. The original quote can expire. A sustained six-percent move can become the new rolling center while the original anchor still refuses. And an unguarded strategy can consume collateral even while a small quote remains readable. A successful buy still needs the deadline, anchor, remaining inventory and actual collateral to pass.

**Action:** Read each row across. A quote read is not a guarantee that a buy will fill. The book runs checks in order and may stop at the first failure.

**Source:** website/evidence/demo.json: lifecycle pause, expired; anchor anchor-refused; unguarded unguarded; website/app.js cases

## 12. Exercise, close and premium return (4:15–4:40)

At the accepted expiry price of about 378.269, the put is in the money against a four-hundred strike. The holder delivers three TSLA and receives twelve hundred USDG. The calls are out of the money. After the exercise window, close returns eight TSLA through Aqua: five unused call collateral and three exercise proceeds. A separate premium claim returns 64.0064 USDG. Book token balances then reach zero.

**Action:** Follow the same lifecycle across both token charts. Close and claim are separate actions. Releasing the remaining promises is step 15.

**Source:** website/evidence/demo.json: lifecycle settle, exercise, close, premium, release; docs/settlement.md

## 13. Four checks in the contract replay (4:40–5:20)

Here is the actual contract replay. Step five shows the collateral and premium split. Step seven attempts a buy outside the band; the buyer keeps the same funds and positions. Step nine has an open band but an expired quote, so the maker must renew. Step fourteen claims the premiums and leaves zero tokens in the book. The page exposes the previous and current balances and recorded EVM logs for each checkpoint.

**Action:** Open the replay before speaking. Select 05, 07, 09, 14, allowing roughly 10 seconds each. The slide is a fallback if the browser is unavailable. Public demo: https://vexi-v1.github.io/vexi-hakari/ . Local fallback: http://127.0.0.1:8787/ .

**Source:** website/evidence/demo.json: lifecycle buy, pause, expired, premium; website/app.js

## 14. What Vexi Hakari contributes (5:20–6:00)

For Aqua, this is an options writer that pulls collateral at a fill, plus a SwapVM guard for shared inventory. For Uniswap, it is an executable consumer: observations change quote size and can refuse a real buy. The public artifacts connect those mechanisms to reproducible tests. The hook and pool have testnet records; the public band stack is demonstrated on a local fork. The repository also explains the fixed five-percent policy, independent quote deadlines and anchors, and experimental settlement. The six backup pages retain the technical details, historical motivation and provenance for questions.

**Action:** End the timed presentation here, at 6:00. Slides 15–20 are optional discussion pages. Source history and reproduction commands follow.

**Source:** README.md; docs/extraction.md; docs/demo.md; FEEDBACK.md

## 15. Settlement has two experimental branches (Backup / 備用)

Settlement is a separate experiment. One test rejects the expiry-ending window, then accepts the next five-minute window after a caller retries. Another rejects all six candidates. After the one-hour book grace, collateral can return and holders can claim pooled premiums by contract count. A later price or an unwind changes the economics. These rules do not establish fair expiry value.

**Action:** Top and bottom rows are independent fixtures. A revert does not schedule a retry. Refunds are pooled per series by count, not each buyer’s original premium.

**Source:** docs/settlement.md; website/evidence/demo.json: delayed and refund scenarios

## 16. The v4 integration in detail (Backup / 備用)

A hook is part of a v4 pool key. An existing pool cannot acquire this hook, so the reference needs its own hooked pool and liquidity. Address permission bits require CREATE2 salt mining. The fork uses the deployed testnet hook runtime at its own address with the real PoolManager. The canonical Aqua and SwapVM router remain unmodified. Our contribution is the consumer and integration around these interfaces.

**Action:** Explain the three integration seams. The fork creates a new reference pool, not a hook attached to the existing TSLA pool. FEEDBACK.md documents current integration findings; historical feedback is separate.

**Source:** README.md; FEEDBACK.md; src/HakariOracleHook.sol; aqua/test/StabilityBandFork.t.sol

## 17. Questions and operating limits (Backup / 備用)

A maker can withdraw or revoke approval, so availability is checked at a fill. The guard constrains only participating strategies. A sustained move becomes the rolling center, and the live slot0 can be moved temporarily. Quote deadlines and original anchors are separate controls. Repeated calls can exceed the per-call cap. An undersized observation ring can lose history and pause quotes. None of these controls attests an external fair price.

**Action:** Use the table for Q&A. Docking can also block returns until a compatible strategy is shipped and rebound; consult the tests. Observation capacity must cover actual swap-seconds with margin, not a blanket guarantee from one number.

**Source:** docs/band.md; docs/demo.md; docs/settlement.md; aqua/src/aqua/AquaWriter.sol

## 18. Vexi and the hackathon contribution (Backup / 備用)

Vexi existed before the event as an options venue. Its product code remains private. During the event the team wrote the Aqua seam, inventory guard, hook, band and settlement adapter. The public extraction uses a small book and FixedPremium to make those integrations reviewable. No earlier private product code is imported. The next deployment step is the public band over the recorded testnet hooked pool.

**Action:** Times are JST. These are milestones, not all commits. Do not describe the public fixed premium as Vexi’s production pricing model.

**Source:** docs/history.md; docs/extraction.md; docs/ai-usage.md; README.md

## 19. Historical motivation: HIMS (Backup / 備用)

The original study examined HIMS during the August thirtieth weekend. Its archived record compares a Friday stock close of 28.84 with a later pool observation of 54.50. A separate late-Sunday measurement estimated twelve USDG for a ten-percent round trip. These are different observations, not a synchronized comparison. They motivate skepticism about pool references. They do not demonstrate that today’s band would have prevented the event.

**Action:** Historical appendix only. Stock close is a secondary-source value in the archived research. Do not read the chart as a return, a synchronized spread, or proof of protection. Omit the reference’s unverified aggregate volume and peak.

**Source:** docs/history.md; archive/hakari-v1/; user-supplied HAKARI Pitch Deck.html, slide 5

## 20. Evidence you can reproduce (Backup / 備用)

The deliverable is one continuous fifteen-step lifecycle plus four independent adverse scenarios. Five tests generate the JSON and call trace. The website and this deck trace back to those artifacts and their source fingerprints. Execution uses a pinned local fork and synthetic accounts, with no mainnet broadcasts. The public repo contains the reproduction command and the full scope of the experiment.

**Action:** Close with the repo link. Treat this as integration evidence, not organic market history or production readiness.

Reproduce the website evidence:
python3 scripts/website-evidence.py

Focused sponsor traces:
bash scripts/judge-demo.sh 1inch
bash scripts/judge-demo.sh uniswap
bash scripts/judge-demo.sh limits

Current integration feedback: FEEDBACK.md. Fixed fork block: 72248228. No wallet key required.

**Source:** docs/website.md; website/evidence/demo.json; scripts/website-evidence.py; scripts/build-website.py. Aqua © Degensoft Ltd 2025. Powered by SwapVM © Degensoft Ltd 2025.
