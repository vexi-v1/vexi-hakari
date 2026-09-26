# Judge demonstration: one wallet, two strategies, a price-dependent refusal

The deliverable is a runnable contract integration with a [static interactive website](website.md). Its primary
replay is one continuous local-fork test, from shipping and a guarded spot fill through physical exercise, close
and premium returns. Generate its evidence with `python3 scripts/website-evidence.py`. The first study is archived.

For a presentation, use the [three- or six-minute PowerPoint decks](presentations/README.md), available in English
and Traditional Chinese with editable diagrams and charts, plus timed speaker notes. The six-minute version
adds the options introduction, full mechanism and six optional discussion pages.

The terminal commands below select the earlier focused tests and show actual ERC-20 calls and Aqua events in
Foundry's local fork EVM. They do not produce mainnet transactions or public explorer transaction hashes.

## Reproduce

Install [Foundry](https://getfoundry.sh), clone the **published submission revision** recursively, and run from
the repository root:

```bash
bash scripts/judge-demo.sh 1inch
bash scripts/judge-demo.sh uniswap
bash scripts/judge-demo.sh limits
```

The runner defaults to the public archive endpoint `https://rpc.ordofi.network` and pins block **72,248,228**
on Robinhood Chain 4663. Set `RH_MAINNET_RPC` in the environment to use another archive endpoint. It needs no
wallet key. First compilation and cold RPC reads may take time; compile and rehearse before recording.
`bash scripts/judge-demo.sh all` runs all three sections. Any failed command stops the runner.

These are existing tests, selected for a presentation; each test starts from its own fixture. They are not one
continuous transaction history. Accounts are synthetic addresses funded with Foundry `deal`; `prank` acts as
those test accounts. Canonical Aqua and SwapVM are read from the fork. In the Uniswap fixture, the deployed
testnet hook runtime is installed with `etch`, a new hooked pool is created on the real PoolManager, and swaps
and time advances build its observation history. This is a synthetic market on real protocol contracts, not a
replay of organic trading. The lifecycle tests use `FixedExpiryPrice`; the separate settlement demonstration
uses `HookTwapExpiryPrice`.

A verified rehearsal is recorded in [the evidence transcript](evidence/2026-09-27-demo.txt): 12 selected tests
passed, with token-transfer call excerpts and v4 band logs. Rerun the commands to reproduce it.

## What to show in the trace

| Scene | Test | Evidence to point at |
|---|---|---|
| Ship and post | `test_Invariant1_ShippingMovesNoTokens` | Wallet balances are unchanged; the book has zero escrow; 10 TSLA is promised |
| Buy calls and puts | `test_Invariant2_FillPullsExactlyTheCollateralInTheBuyTransaction` | `OptionBook.buy → AquaWriter.provide → Aqua.pull`; `Pulled` and ERC-20 transfers: 5 TSLA for 5 calls, 1,200 USDG for 3 puts; buyer long balances increase |
| Close and claim | `test_Invariant4_…` / `test_Invariant5_…` | 5 TSLA returns after an unexercised expiry; 25 USDG premium is pushed to the maker's strategy after settlement; separate transactions are required |
| Shared wallet | `test_CanonicalRouterCapsAtTheUnpromisedBalance` | Canonical router executes a guarded spot swap through `Extruction`; a later 10-call fill still succeeds |
| Why the guard matters | `test_WithoutTheGuardASpotFillTakesWhatTheOptionsPromised` | Unguarded spot trading consumes inventory and a later option fill is refused; this expected refusal passes the test |
| Both sponsors in one buy | `test_ABuyThroughTheBandPullsFromTheMakerThroughAqua` | Quote reads the real v4 PoolManager and hook; a successful buy pulls collateral via canonical Aqua |
| Taper and pause | `test_InsideTheBandTheBookTapers` / `test_APushOfTheReferencePastTheBandPausesTheBook` | A +2.5% move reduces size and widens premium; a +5.1% move produces `Paused(OutsideBand)`; a return inside the band permits fills |
| Optional expiry extension | `test_APushAtExpiryDefersSettlementOnTheRealHook` | Candidate 0 is rejected, candidate 1 is accepted; this chooses a later price, not a guaranteed fair expiry price |
| Stale quote | `limits` commands | An expired quote blocks a buy without moving funds; an original anchor still refuses after a rolling band recovers |

Keep `-vvvv` for visible successful call traces. A green test count alone does not show the token transfers
requested by 1inch. Expected reverts are intentional negative cases, not failed tests.

## Suggested 3-minute recording

| Time | Show | Say |
|---|---|---|
| 0:00–0:20 | README trade diagram | “HAKARI keeps unfilled option collateral in the maker's wallet through Aqua. A Uniswap v4 reference decides when new quotes should shrink or stop.” |
| 0:20–1:10 | Ship, buy and return traces | “Shipping moves no tokens. Buying pulls the exact collateral within the buy call. At close, unused collateral returns through Aqua; premiums are separately claimed.” |
| 1:10–1:40 | Canonical SwapVM guarded fill | “The same wallet also quotes spot. Our instruction caps this strategy at unpromised inventory. Without it, a spot fill can consume an option order's backing.” |
| 1:40–2:25 | Successful integrated buy, taper, refused buy | “The v4 hook supplies observations. The band narrows quote size as the reference deviates, and the book actually refuses past the edge.” |
| 2:25–2:45 | Quote expiry / original-anchor test | “A sustained move can become a rolling TWAP's center. Explicit deadlines and optional original anchors stop that from silently renewing stale fixed quotes.” |
| 2:45–3:00 | Source links and limitations | “This is a local-fork integration demo. Five percent is configurable, the size cap is per call, and settlement remains experimental. The public code includes tests and integration feedback.” |

Use a human narration and a screen recording. The official event page specifies 2–4 minutes and at least 720p;
it rejects AI voiceover. Video is optional for the general submission, but gives remote partner reviewers the
transfer demonstration directly. See the [event submission instructions](https://ethglobal.com/events/tokyo2026/info/details).

## Questions to be ready for

- **What is new beyond OpenZeppelin's oracle?** The upstream oracle is credited. Our hook exposes both TWAPs;
  the main contribution is the executable consumer policy connecting v4 observations to option fills, plus the
  Aqua writer and SwapVM inventory guard. It is not a new oracle security primitive.
- **Can the maker withdraw or revoke approval?** Yes. Aqua is self-custodial before a fill. Live availability
  checks can refuse the buy; the guard only constrains strategies that actually include it.
- **Can someone split a trade to avoid the cap?** The cap is per call. Repeated calls can fill more; posted
  inventory limits remain, but there is no cumulative exposure budget in the band.
- **Does this establish the correct stock price?** No. It reads a selected pool, with liquidity and observation
  assumptions. The demo's 5% parameter and optional anchor are quote policies, not an external price attestation.
- **Is everything live on testnet?** The hook and hooked AAPL/USDG pool have recorded deployments. The public
  Aqua/book/band stack is demonstrated on a local fork; the public band deployment script has not been broadcast.
- **Does a failed settlement just wait safely?** A caller must retry. Later acceptance changes the selected
  time's price; a persistent genuine gap can lead to pooled-premium refunds. See [settlement.md](settlement.md).

---

Aqua — © Degensoft Ltd 2025. SwapVM — © Degensoft Ltd 2025.
