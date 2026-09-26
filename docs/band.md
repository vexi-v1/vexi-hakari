# The band: stop selling at a fixed price when the price moves

An option writer that quotes a fixed premium is right only while the underlying stands still. When the price moves,
the premium goes stale, and a buyer who sees the move first buys it at the old price. When the price is *pushed*
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

## Why 5 %

The demo is tokenized US stocks on Robinhood Chain (TSLA, AAPL). Those stocks already have a band, set by the market
they trade in: under the US **Limit Up-Limit Down** plan, a Tier 1 stock (S&P 500 and Russell 1000 names) priced
above $3 may not trade more than **5 %** away from its average price over the preceding five minutes, and trading
pauses if it stays at that limit. TSLA and AAPL are Tier 1.

So 5 % is the width at which the stock's own market stops and asks for a breath. The book stops at the same
distance, measured the same way (from a recent average, not from the last trade):

- **Narrower** and the book would pause on moves the stock's own exchange lets trade, and a writer would stop
  exactly when buyers want protection.
- **Wider** and a fixed premium stays for sale further from where it was set. Inside the band, what a buyer of calls
  whose value moves at most one-for-one with the price can take per call is at most
  `maxContracts × u × (1 − u) × halfWidth × center ≤ maxContracts × halfWidth × center / 4`, because the size shrinks
  as the distance grows. At TSLA ≈ 378 USDG and the defaults, that is at most **236 USDG per call**; at 10 % it would
  be twice that.
- **When the stock's market is closed** (nights, weekends, holidays) the pool is the only price and nobody can mint
  or redeem the token to pull it back. HAKARI's first study measured such a weekend: on 2026-08-30 a 10 % push of
  the HIMS/USDG pool cost 12 USDG in fees, and the pool stood at 54.50 against a Friday close of 28.84
  ([archive](../archive/hakari-v1/README.md)). With a 5 % band the book has stopped long before a move like that, and
  after one that large it reopens only once the pushed price has stood for most of an hour.

5 % is the shipped default, not a constant of nature: the owner of a band can set any half-width up to 50 % with one
`setParams` call, and a market with no such exchange rule (a token with no listed underlying) should choose its own.

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

A quote through the band costs 94,117 gas (storage cold); `priceAt` for settlement 130,190 gas on the first window.

## Settlement uses the same idea

`HookTwapExpiryPrice` settles an expiry on the hook's five-minute TWAP ending at expiry, but only if that TWAP is
within 5 % of the TWAP of the half hour before it. If a push moves the settle window out of the band, settlement waits
for the next five-minute window instead of paying out on the pushed price; after six windows without an accepted one
the series cannot settle here, and the book unwinds it (makers get their collateral back, holders their premiums).
Every attempt is held to the band drawn *before* expiry (`bandFromExpiry`), so a push cannot drag its own reference
along by being held.

## What it does not protect

- **A push that stands becomes the reference.** The center is a TWAP: hold a price for the window and it is the
  center. On the fork, a +6 % push held with nobody trading stops the book at once, reopens it after 660 s at the
  very edge (one contract per call, +19 % spread), and after an hour the center is the pushed price to the tick
  (`test_APushOfTheReferenceThatStandsBecomesTheCenter`). The band makes a push pay for being held (against anyone
  who can trade it back); it does not make it impossible. What limits a push that stands is the size a writer offers
  at all.
- **Inside the band a stale premium still pays, less.** Bounded as above, not zero.
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
