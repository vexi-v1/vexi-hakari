# How this repository got here

HAKARI changed what it is during ETHGlobal Tokyo 2026. This page is the order of events and the reason for each turn,
so that a reader who finds the first study's pages, or the partner prizes this entry names, can see how they connect.
Times are JST.

## Before the event: Vexi

Vexi is the team's options venue on Robinhood Chain: vaults that write covered calls and cash-secured puts on
tokenized stocks and quote a board of strikes and expiries, settled by delivery. Its code is private and none of it is
in this repository. It is the reason for both questions below: a venue that writes options on tokens whose market
closes every night and every weekend needs to know when an on-chain price can be trusted, and it wants its writers'
collateral to stay productive until someone actually buys.

## 2026-09-25 to 09-27 01:20: HAKARI, "what it costs to fake a price"

HAKARI started as a Uniswap-only entry (first commit `c65549c`, 09-25 21:29). It asked how much it costs to push a
Uniswap v4 pool's price, and how much value can safely settle on that price. It built
`PushCostLens` (the cost of a push, for any v4 pool), `HakariOracleHook` (OpenZeppelin's truncated-oracle hook, both
TWAPs in one call, deployed on testnet 46630), `CostModel` and `SafeSettle` (settle only below what faking costs), and
a gauge that replays real Robinhood Chain weekends. Its headline finding: on Sunday 2026-08-30, with stock-token
minting closed, a 10 % push of the HIMS/USDG pool cost 12 USDG, and the pool stood at 54.50 against a Friday close of
28.84. A later measurement over 28 stock pools found about half of weekday pushes pulled back within the hour, some
never, and on a closed market nobody who can pull them back at all.

That work is complete and archived as it was: [`archive/hakari-v1/`](../archive/hakari-v1/), with a guide in
[`archive/README.md`](../archive/README.md).

## 2026-09-25 21:46 to 09-27: the 1inch Aqua entry, in a private repository

In parallel the team built its 1inch entry in a separate, private repository, because it grew out of Vexi's product
design. The parts that are now here were written there during the event:

| When | What |
|---|---|
| 09-25 22:21 | Foundry project with pinned 1inch `aqua`, `swap-vm` v1.0.2, `solidity-utils`, OpenZeppelin, forge-std |
| 09-25 22:26–23:48 | `AquaWriter` and the book on a 4663 fork: collateral pulled through Aqua only at a fill; `ExposureGuard` as a SwapVM instruction and as an `Extruction` on the canonical router |
| 09-26 02:23–03:18 | Settlement that cannot be moved or locked: a grace after expiry, refunds that depend on time alone |
| 09-27 02:32 | The band and the hook-TWAP settlement, reading `HakariOracleHook` on 46630 |

## 2026-09-27 early morning: one entry, two partners

The owners merged the two into one entry in the Continuity Track, for two partner prizes: 1inch **Build an Aqua
App** and Uniswap **Best Uniswap Stack Contribution**. HAKARI's question became narrower and more useful: not "what
does faking this pool cost?" but "when should an option writer that relies on this pool stop quoting, and when may it
settle?" The study's measurements are why the answer is a band around a hook TWAP rather than a cost bound.

## 2026-09-27 03:30: the public slice

The Aqua repository stays private: it is product code, including Vexi's pricing and vault accounting. The owners
decided to put here, in the already-public HAKARI repository, only what the two partners review, written so it stands
on its own:

- the Aqua seam: `AquaWriter`, a small `OptionBook`, `ExposureGuard` (instruction, `Extruction`, router);
- the Uniswap band and settlement: `StabilityBandPricer`, `HookTwapExpiryPrice`, over `HakariOracleHook`;
- a `FixedPremium` pricer, so the band has something to guard, and a fixed 5 % band ([why 5 %](band.md)).

What was taken, what was left out and why: [`extraction.md`](extraction.md). The code arrives here in a few commits
on 09-27; its step-by-step history is the private repository's, summarised in the table above.
