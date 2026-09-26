# The band: stop selling at a fixed price when the price moves

A fixed option premium can become stale as the market or time changes. A buyer can take the old quote before
the writer replaces it. When the price is *pushed*
(a pool anyone can trade is a price anyone can move) the buyer and the pusher can be the same person. HAKARI's band
is the rule for when to keep quoting, when to quote less, and when to stop.

## The rule

`StabilityBandPricer` sits in front of any pricer (here `FixedPremium`) and reads one Uniswap v4 pool, the
*reference*, that was created with HAKARI's oracle hook:

```
center     = the reference pool's TWAP over bandWindow           (the hook's observe, one hour by default)
halfWidth  = 5 % of the center                                   (halfWidthBps = 500)
current    = the reference pool's slot0 price                     (or a TWAP over nowWindow)
u          = |current − center| / halfWidth                      (0 at the center, 1 at the edge)
ask        = inner ask × (1 + maxExtra × u²)                     (maxExtra 20 %)
contracts  ≤ maxContracts × (1 − u)  per call                     (maxContracts 50)
```

Past the edge (u > 1) both quoting and buying revert `Paused(OutsideBand)` until the price comes back. It also stops
when the hook cannot answer over the window (a pool younger than the window, or a ring of observations that has
wrapped), when the reference's in-range liquidity is below a floor, and when the hook's raw and truncated TWAPs are
more than a half-width apart (a jump bigger than the truncation absorbs).

Why a TWAP for the center and `slot0` for `current`: the hook records its observation *before* the first swap in each
second, so a price pushed and undone inside one transaction never reaches the center, while `slot0` sees the push at
once and shrinks the book in the same block. Setting `nowWindow` makes `current` a short TWAP instead, which ignores
a same-transaction push but lags a genuine move by that window.

## Quote validity is separate from the rolling band

Every nonzero `FixedPremium` quote now has an explicit, exclusive `validUntil`. `ask` refuses at or after that
instant, even if the rolling band has recovered. Only the owner can renew it. Setting the premium to zero disables
it. This is a breaking API change: `setPremium(seriesId, premium, validUntil)` replaces the two-argument setter.

For a price anchor as well, the owner calls
`setAnchoredPremium(seriesId, premium, validUntil, priceSource, maxDeviationBps)`. The source implements
`IQuoteReference.referencePriceWad()`: the contract captures its price at quote creation and refuses subsequent
asks outside that fixed anchor's tolerance. Pass the band's address to use its pool's live `slot0` price, even when
`nowWindow` makes the band itself use a short TWAP. Renewing with `setPremium` explicitly removes any old anchor;
renew with `setAnchoredPremium` to retain price protection. The tolerance is configurable from 1 to 5,000 bps.

The owner must choose a trusted source for the series' pair. Neither interface nor contract proves a price is
fair, checks the pair of an arbitrary source, or detects a manipulated price at quote creation. Zero or reverting
source reads refuse anchored quotes. Existing positions still settle and exercise when a quote expires.

`band.status().quoting` describes the band alone, not a particular series' premium or available collateral. A UI
must also call the book's quote for that order; an expired or off-anchor inner quote can refuse while the band is
healthy. Tests: `FixedPremium.t.sol` and `StabilityBandTest.test_AnchorRefusesAfterRollingBandRecovers`.

## Why 5 %

The public demonstration uses a **configurable fixed 5% half-width**. Market price bands inspired the example;
it is not a calibrated safety threshold, a loss guarantee, or an implementation of US Limit Up-Limit Down (LULD).
A narrower band pauses sooner; a wider one admits larger deviations from the rolling reference.

LULD uses a reference based on eligible transactions over the preceding five minutes during regular US trading
hours. This example uses a one-hour on-chain tick TWAP (a geometric price average) and runs outside those hours
as well. Matching a percentage does not make the reference, operating hours or protections equivalent. See
[NYSE's description](https://www.nyse.com/trade/trading-information) and the
[Nasdaq LULD FAQ](https://nasdaqtrader.com/content/MarketRegulation/LULD_FAQ.pdf).

The owner may set a nonzero half-width up to 50% with `setParams`. This repository does not prescribe a production
parameter for stocks, weekends, or other tokens.

## What the taper bounds

Let `C` be the current rolling center, `h` the fractional half-width and `M` the maximum contracts per call.
Ignoring integer rounding, `n <= M(1-u)` and `|current-C| = u h C` imply:

```
n × |current − C| <= M × u(1 − u) × h × C <= M × h × C / 4
```

This bounds **single-call size times reference-price deviation**, not observed arbitrage profit or total strategy
loss. At `C = 378 USDG`, `M = 50`, `h = 0.05`, that expression is 236.25 USDG. The fuzz test
`testFuzz_PerCallSizeTimesReferenceDeviationIsBounded` checks the arithmetic with contract rounding.

Interpreting this as an incremental option-value bound additionally assumes a fair premium at that same center,
value changing at most one-for-one with spot, and other pricing inputs unchanged. The public code does not enforce
those economic assumptions. A quote's original anchor can differ from the rolling center. Repeat calls can consume
more than the per-call cap; no per-block or per-quote cumulative budget is implemented here. The remaining order
quantity and deliverable collateral still constrain fills. Added spread does not establish a profit guarantee.

## On a fork of Robinhood Chain mainnet

[`aqua/test/StabilityBandFork.t.sol`](../aqua/test/StabilityBandFork.t.sol) etches HAKARI's hook, byte for byte as
deployed on testnet 46630, at its own address on a fork of 4663, and makes it the hook of a new TSLA/USDG pool on the
real PoolManager, opened at the real pool's price with the real pool's in-range liquidity and two hours of two-way
swaps. A book sells calls at a fixed 8 USDG through the band.

| What happens | What the band does |
|---|---|
| Nothing (price 378.30, center 378.23) | u = 0.003, 49 contracts per call, +1 bp: ten calls cost 80.008 USDG, and Aqua pulls 10 TSLA from the writer's wallet inside the buy |
| The pool is pushed +2.5 % (a 200,752 USDG swap) | u = 0.50, 25 contracts per call, +5 %: ten calls cost 84.00 USDG; 26 revert `SizeCapped` |
| The pool is pushed +5.1 % (a 408,413 USDG swap) and a buy follows in the same transaction | `Paused(OutsideBand)`; pushed back in the same transaction, the buy fills at 80.008 again. The one-hour center never moved |
| A +6 % push is held through the five minutes before expiry | The settle window reads 400.98 against a center of 378.23 (601 bps): refused, `settle` reverts `NotYet`; one window later it settles at 378.27, the hook's own five-minute TWAP |

The extraction measured 94,117 gas for a cold band quote and 130,190 gas for first-window settlement. These are
historical measurements from before quote-validity checks; use the current tests for current costs.

## Experimental settlement adapter

The primary demonstration is **quote protection before a new fill**. `HookTwapExpiryPrice` is a separate,
experimental adapter: it selects the first acceptable settlement window, potentially after expiry. Its trade-off
is between refusing an out-of-band price and completing settlement. It is not a guarantee of a fair expiry price.
See [the settlement state flow and economic outcomes](settlement.md).

## What it does not protect

- **A push that stands becomes the reference.** The center is a TWAP: hold a price for the window and it is the
  center. On the fork, a +6 % push held with nobody trading stops the book at once, reopens it after 660 s at the
  very edge (one contract per call, +19 % spread), and after an hour the center is the pushed price to the tick
  (`test_APushOfTheReferenceThatStandsBecomesTheCenter`). The band makes a push pay for being held (against anyone
  who can trade it back); it does not make it impossible. What limits a push that stands is the size a writer offers
  at all. The quote deadline and optional original-price anchor are independent checks and can still refuse
  a fill after the rolling band resumes.
- **Inside the band an incorrect premium can still be traded.** Validity and optional anchors limit when it is
  offered; the taper arithmetic above is not an unconditional bound on profit or loss.
- **The size cap is per call.** `ask` is a view and cannot count what traded this block, so a buyer can call again.
  Each call pays the widened spread; the cap limits one call, not the block.
- **The ring of observations is finite.** More swap-seconds within the window than the hook's cardinality and the
  band pauses (`ReferenceUnavailable`). That fails closed, but it is a cheap way to stop a book quoting; grow the ring
  with `increaseObservationCardinalityNext`.
- **A refusal at settlement is not free for the other side.** If no window is accepted, the series goes unsettled:
  an out-of-the-money holder gets the premium back, an in-the-money writer keeps its collateral. Whoever loses at
  expiry can buy that outcome by holding the pool outside the band for six windows, at the cost of holding it.

## Parameters

| Parameter | Default | What it does |
|---|---|---|
| `bandWindow` | 3600 s | TWAP window of the center |
| `nowWindow` | 0 (slot0) | 0: `current` is the pool price; > 0: a TWAP over that many seconds |
| `halfWidthBps` | 500 | the band's half-width, fixed, in bps of the center |
| `maxExtraBps` | 2000 | spread added to the ask at the edge (quadratic in u) |
| `maxContracts` | 50 | contracts per call at the center |
| `minLiquidity` | 0 | least in-range liquidity of the reference |

Settlement (`HookTwapExpiryPrice.Params`): `settleWindow` 300 s, `bandWindow` 1800 s, `attempts` 6,
`halfWidthBps` 500, `bandFromExpiry` true. A book's settle grace must exceed `attempts × settleWindow`.
