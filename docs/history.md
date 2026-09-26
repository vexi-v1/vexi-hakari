# How this repository got here

This entry is in ETHGlobal's Continuity Track: it continues Vexi, a project that existed before the event, and
everything in it was added at ETHGlobal Tokyo 2026. This page says what existed before, what the team added at the
event and in what order, and how the additions ended up in this repository. Times are JST.

## Before the event: Vexi

Vexi is the team's options venue on Robinhood Chain: vaults that write covered calls and cash-secured puts on
tokenized stocks and quote a board of strikes and expiries, settled by delivery. Its code is private, and nothing
written before the event is in this repository. It is where both questions below come from: a venue that writes options on tokens whose market
closes every night and every weekend needs to know when an on-chain price can be trusted, and its writers want their
collateral to stay in their own hands until someone actually buys.

## At the event: what was added

From the start of the event the team added two things to Vexi, one for each partner prize. Only the steps that
concern 1inch Aqua and Uniswap are listed; the rest of Vexi is out of scope here.

**Uniswap: HAKARI, in this repository.** HAKARI (秤, "the scale") started as a study of what it costs to fake a
Uniswap v4 price, and how much value can safely settle on one. It built `HakariOracleHook` (OpenZeppelin's
truncated-oracle hook with both TWAPs in one call, deployed on testnet 46630), `PushCostLens` (the cost of a push, for
any v4 pool), `CostModel` and `SafeSettle` (settle only below what faking costs), and a gauge that replays real
Robinhood Chain weekends. Its headline finding: on Sunday 2026-08-30, with stock-token minting closed, a 10 % push of
the HIMS/USDG pool cost 12 USDG, and the pool stood at 54.50 against a Friday close of 28.84. A later measurement over
28 stock pools found about half of weekday pushes pulled back within the hour, some never, and on a closed market
nobody who can pull them back at all. Its history is public, commit by commit from `c65549c`. The study is archived
as it was: [`archive/hakari-v1/`](../archive/hakari-v1/), with a guide in [`archive/README.md`](../archive/README.md).

**1inch: the Aqua writer, in Vexi's private codebase.** Written there because it plugs into Vexi's product: a writer
whose collateral stays in its wallet until a fill, pulled and returned through 1inch Aqua, and a SwapVM spot pool on
the same balance that never sells what an option buyer was promised.

In order, the steps that concern 1inch Aqua or Uniswap:

| When | Partner | What |
|---|---|---|
| 09-25 21:29 | Uniswap | HAKARI's first commit in this repository: its spec, `v4-core`, `uniswap-hooks` and forge-std pinned |
| 09-25 21:37 | Uniswap | `HakariOracleHook` (both TWAPs in one call) and the push-cost lens |
| 09-25 21:46 | both | In Vexi's codebase, the spec for the Aqua writer (1inch) and HAKARI (Uniswap) |
| 09-25 22:21 | 1inch | A Foundry project pinned to 1inch `aqua`, `swap-vm` v1.0.2 (the router deployed on 4663) and `solidity-utils` |
| 09-25 22:26–23:48 | 1inch | `AquaWriter` and the book it serves, on a fork of 4663: collateral pulled through Aqua only at a fill and pushed home at close; `AquaWriter` as a pure Aqua caller; `ExposureGuard` as a SwapVM instruction, then as an `Extruction` on the canonical router, shrinking the spot pool at the same price |
| 09-25 23:39 | Uniswap | `HakariOracleHook` deployed on 46630 at `0x3b58…D080`, its address mined for its flag bits |
| 09-26 03:18 | 1inch | A series nobody could settle unwinds on time alone: collateral back through Aqua, premiums refunded to holders |
| 09-26 16:02 | 1inch | The same flow on Robinhood Chain testnet 46630, with a public explorer trail (Aqua and the SwapVM router are not deployed there, so the pinned source was deployed) |
| 09-26 to 09-27 01:20 | Uniswap | The study's review, measurements and pages, in this repository |
| 09-27 01:33 | Uniswap | A first check of the book against Uniswap v4: quotes refused when the writer's own spot is away from a v4 pool's `slot0` |
| 09-27 01:53 | Uniswap | An AAPL/USDG v4 pool on 46630 whose hook is `HakariOracleHook` |
| 09-27 02:32 | Uniswap | The band and the settlement source, reading that hook |

## 2026-09-27 early morning: one entry, two partners

The owners merged the two into one Continuity Track entry, for two partner prizes: 1inch **Build an Aqua App** and
Uniswap **Best Uniswap Stack Contribution**. HAKARI's question became narrower and more useful: not "what does faking
this pool cost?" but "when should an option writer that relies on this pool stop quoting, and when may it settle?"
The study's measurements are why the answer is a band around a hook TWAP rather than a cost bound.

## 2026-09-27 03:30: one public repository

Vexi stays private, including the codebase the Aqua writer was written in: it is product code. The entry's only
public repository is this one. The owners put here only what the two partners review, written so it stands on its
own:

- the Aqua seam: `AquaWriter`, a small `OptionBook`, `ExposureGuard` (instruction, `Extruction`, router);
- the Uniswap band and settlement: `StabilityBandPricer`, `HookTwapExpiryPrice`, over `HakariOracleHook`;
- a `FixedPremium` pricer, so the band has something to guard, and a 5 % band ([why 5 %](band.md)).

What was brought in, what was left out and why: [`extraction.md`](extraction.md). The Aqua and band code arrives here
in a few commits on 09-27; when each part was first written is the table above.
