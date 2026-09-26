# HAKARI (秤)

**Options written from a wallet through 1inch Aqua, and a Uniswap v4 price band that tells the writer when to stop.**

An option writer should not have to lock its collateral in a protocol before anyone buys. Here it does not: the
writer's tokens stay in its own wallet, and **1inch Aqua** pulls exactly the collateral of the contracts sold, inside
the buyer's transaction, then pushes it home at expiry. The same wallet can also quote spot through a **SwapVM**
strategy, and a custom SwapVM instruction, `ExposureGuard`, keeps the spot strategy from selling a token an option
buyer was promised.

A fixed premium can become stale as the market or time changes. **HAKARI's band** reads a **Uniswap
v4** pool through HAKARI's truncated-oracle hook: around the pool's one-hour TWAP it draws a band of ±5 %, sells less
and at a wider spread as the price nears the edge, and stops selling past it. The fixed width is a demonstration
parameter. Fixed quotes also expire and can be bound to their original reference price; a recovering TWAP cannot
renew them. A separate [experimental settlement adapter](docs/settlement.md) tries TWAP windows and may end in
refunds if none is accepted. Quote protection is the main demonstration.

Built at ETHGlobal Tokyo 2026 on Robinhood Chain, one Continuity Track entry for two partner prizes: 1inch **Build an
Aqua App** and Uniswap Foundation **Best Uniswap Stack Contribution**. This repository started as a separate
Uniswap study and changed shape during the event; [docs/history.md](docs/history.md) tells how.

| Start here | |
|---|---|
| [How it fits together](#how-it-fits-together) | One picture and the path of a trade |
| [For 1inch reviewers](#for-1inch-reviewers-aqua-and-swapvm) · [For Uniswap reviewers](#for-uniswap-reviewers-v4-hook-and-band) | The integration, file by file |
| [docs/band.md](docs/band.md) | Quote validity, optional anchors, the fixed demonstration band and its limits |
| [docs/settlement.md](docs/settlement.md) | Experimental settlement: window selection, deferral and refund outcomes |
| [docs/history.md](docs/history.md) · [docs/extraction.md](docs/extraction.md) | How the repository got here; what was brought in from the team's private code and what was left out |
| [archive/](archive/README.md) | The first study, "what it costs to fake a price", kept as it was |
| [FEEDBACK.md](FEEDBACK.md) | Uniswap developer feedback |

## Vexi, and what this repository is

[Vexi](https://github.com/vexi-v1) is the team's options venue on Robinhood Chain: vaults that write covered calls
and cash-secured puts on tokenized stocks and quote a board of strikes and expiries, settled by delivery. Its code is
private. This repository is not Vexi. It is the part of the team's ETHGlobal entry that the two partners review,
written to stand on its own:

- how a writer's collateral can stay in its wallet until a fill (**1inch Aqua**, **SwapVM**), and
- when a writer that relies on an on-chain price should stop quoting, and when it may settle (**Uniswap v4**).

Vexi's own pricing and vault accounting are not here. In their place this repository uses the simplest honest
stand-ins: a `FixedPremium` pricer (one expiring premium per series, with an optional price anchor) and a band of fixed width.

## How it fits together

```
                                   ┌──────────────────────────── Uniswap v4 (PoolManager 0x8366…0951) ─┐
  maker wallet (TSLA, USDG)        │  reference pool TSLA/USDG ── hooks: HakariOracleHook 0x3b58…D080  │
   │  approve Aqua once            └──────────────┬─────────────────────────────────┬──────────────────┘
   │  ship: virtual balances                      │ observe (raw + truncated TWAP)  │ observe (settle TWAP)
   ▼                                              ▼ slot0, liquidity (StateLibrary) ▼
 1inch Aqua ──── strategy A: app = AquaWriter    StabilityBandPricer ── FixedPremium  HookTwapExpiryPrice
   │         └── strategy B: SwapVM spot pool      (±5 % around the 1 h TWAP)           (5-min TWAP, ±5 % check)
   │                 │                                   │ ask(series, n)                    │ priceAt(expiry)
   │                 └ ExposureGuard: depth ≤ wallet − promised                             │
   │                                                     ▼                                   ▼
   └── pull at a fill, push at close ◄────────── OptionBook: post · buy · settle · exercise · close
```

The path of one trade:

1. **Ship.** The maker approves Aqua once per token and ships two strategies on the same balance: one whose app is
   its `AquaWriter`, one a SwapVM spot pool guarded by `ExposureGuard`. Nothing moves.
2. **Post.** The writer posts covered calls or cash-secured puts on the `OptionBook`, priced by the band over a
   `FixedPremium` with an explicit quote deadline (and optionally a captured price anchor). Still nothing moves; `AquaWriter.promised(token)` records the promise, and `ExposureGuard` shrinks
   the spot pool to what is not promised, at the same price.
3. **Buy.** The book asks the band, which reads the v4 pool: inside the band it returns the fixed premium, widened by
   how far the price is from the center, for at most as many contracts as that distance allows. The buyer pays; inside
   the same `buy`, `AquaWriter.provide` calls `Aqua.pull` and exactly the collateral leaves the maker's wallet for the
   book. Past the band's edge the buy reverts `Paused(OutsideBand)`.
4. **Experimental settlement.** After expiry anyone calls `settle`: `HookTwapExpiryPrice` returns the hook's five-minute TWAP at
   expiry if it is within 5 % of the preceding band window; otherwise it tries subsequent windows. If none is
   accepted before the book's grace ends, collateral is returned and pooled premiums are refundable pro rata by
   contract. This can also happen after a genuine market gap; see [settlement outcomes](docs/settlement.md).
5. **Close.** Holders exercise by delivery. Unexercised collateral, exercise proceeds and premiums go back to the
   maker through `Aqua.push`, credited to the same strategy. Returning virtual balances does not automatically
   create new option orders or new `promised` amounts.

## For 1inch reviewers: Aqua and SwapVM

Code in [`aqua/`](aqua/), a Foundry project pinned to 1inch `aqua` `ef24220` and `swap-vm` `v1.0.2` (the interface of
the router deployed on Robinhood Chain 4663). Canonical Aqua and the deployed SwapVM router are used unmodified.

| What | Where |
|---|---|
| The Aqua app: binds the maker's shipped strategy, posts orders as promises | [`AquaWriter.sol`](aqua/src/aqua/AquaWriter.sol) `bind`, `post` |
| Collateral pulled from the maker's wallet only at a fill, inside the buyer's transaction | `AquaWriter.provide` → `AQUA.pull(MAKER, strategyHash, collateral, amount, BOOK)`, called from [`OptionBook.buy`](aqua/src/book/OptionBook.sol), which checks arrival by balance delta |
| Escrow, exercise proceeds and premiums pushed home into the same strategy | `AquaWriter.onReturned` → `AQUA.push`, called from `OptionBook.close`; `AquaWriter.claimPremium` takes the premium from the book once the series is settled and pushes it the same way |
| What the maker can back right now: min(virtual balance, wallet balance, allowance to Aqua) | `AquaWriter.available` |
| The promise the spot strategy must respect | `AquaWriter.promised`, grown at `post`, consumed at `provide`, dropped at `release` |
| Custom SwapVM instruction: same price, depth capped at the unpromised balance | [`ExposureGuard.sol`](aqua/src/swapvm/ExposureGuard.sol) `_exposureGuardXD`, `capToFree` |
| The same guard on the canonical router already deployed on 4663, through its `Extruction` opcode | [`ExposureGuardExtruction.sol`](aqua/src/swapvm/ExposureGuardExtruction.sol) |
| Router subclass: the deployed router's opcode table plus `ExposureGuard`, every existing opcode keeps its number | [`WriterSwapVMRouter.sol`](aqua/src/swapvm/WriterSwapVMRouter.sol) |
| Proofs, on a fork of 4663 against canonical Aqua and the deployed router | [`test/Lifecycle.t.sol`](aqua/test/Lifecycle.t.sol) (the Aqua invariants), [`test/ExposureGuard.t.sol`](aqua/test/ExposureGuard.t.sol) (without the guard a spot fill takes promised collateral and the option buyer is refused), [`test/ExposureGuardCanonical.t.sol`](aqua/test/ExposureGuardCanonical.t.sol) (the guard on `0x111111338c…`), [`test/CanonicalAqua.t.sol`](aqua/test/CanonicalAqua.t.sol), [`test/GuardProperties.t.sol`](aqua/test/GuardProperties.t.sol) (fuzzed) |

## For Uniswap reviewers: v4 hook and band

| What | Where |
|---|---|
| The hook: OpenZeppelin's `BaseOracleHook` (Panoptic's truncated oracle) plus both TWAPs in one call; deployed on 46630 at [`0x3b58…D080`](https://explorer.testnet.chain.robinhood.com/address/0x3b58D774cE351227B24A91103b20bA4fc068D080), its address mined for its flag bits | [`src/HakariOracleHook.sol`](src/HakariOracleHook.sol), [`script/Deploy.s.sol`](script/Deploy.s.sol) (CREATE2 salt loop), [`test/HakariOracleHook.t.sol`](test/HakariOracleHook.t.sol) |
| The band reads the reference pool: `slot0` and in-range liquidity through v4-core's `StateLibrary` (`extsload`), raw and truncated cumulative ticks from the hook's `observe` | [`StabilityBandPricer.status`](aqua/src/band/StabilityBandPricer.sol) |
| The oracle is read from the pool key: `key.hooks` is the hook | `StabilityBandPricer` constructor, `HookTwapExpiryPrice.setSource` |
| Tick → price through `TickMath.getSqrtPriceAtTick`, √P² without a 320-bit overflow, either token order, any decimals | [`BandMath.priceOf`](aqua/src/band/BandMath.sol) |
| The hook's truncation used as a check: raw and truncated TWAPs more than a half-width apart pause the book | `StabilityBandPricer.status` (`SeriesDisagree`) |
| Experimental settlement-window selection, including deferral and refund outcomes | [`HookTwapExpiryPrice.sol`](aqua/src/band/HookTwapExpiryPrice.sol) |
| A hooked pool on testnet: `PositionManager.initializePool`, full-range `MINT_POSITION` + `SETTLE_PAIR` through Permit2, `increaseObservationCardinalityNext`, `PoolSwapTest` swaps | [`aqua/script/HookedPool.s.sol`](aqua/script/HookedPool.s.sol), record [`aqua/deployments/46630-hooked-pool.json`](aqua/deployments/46630-hooked-pool.json) |
| Proofs | [`test/StabilityBand.t.sol`](aqua/test/StabilityBand.t.sol) (the band on a mock PoolManager that `StateLibrary` reads like the real one), [`test/StabilityTwapSettle.t.sol`](aqua/test/StabilityTwapSettle.t.sol), and [`test/StabilityBandFork.t.sol`](aqua/test/StabilityBandFork.t.sol): the hook's **deployed 46630 bytecode**, etched at its own address on a 4663 fork, as the hook of a new TSLA/USDG pool on the **real PoolManager** |

## Run it

Requires [Foundry](https://getfoundry.sh). The fork tests need an RPC for Robinhood Chain 4663 that serves historical
state (`https://rpc.ordofi.network` did during the event; the official endpoint keeps only minutes of state).

```bash
git clone --recurse-submodules https://github.com/vexi-v1/vexi-hakari.git && cd vexi-hakari
forge test                                  # the hook: 5 tests

cd aqua
cp .env.example .env                        # fill in RH_MAINNET_RPC (read-only, fork source only)
forge test                                  # Aqua, quote validity, band, experimental settlement; fork block 72,248,228
```

Robinhood Chain mainnet 4663 is read-only here: every transaction in the tests goes to a local fork, and every
account is a plain address funded on the fork; nobody is impersonated.

## On Robinhood Chain testnet 46630

| What | Address |
|---|---|
| `HakariOracleHook` (MAX_ABS_TICK_DELTA 250) | [`0x3b58D774cE351227B24A91103b20bA4fc068D080`](https://explorer.testnet.chain.robinhood.com/address/0x3b58D774cE351227B24A91103b20bA4fc068D080) |
| AAPL/USDG v4 pool with the hook (0.30 %, spacing 60), opened at 624 USDG, full range, ring of 128 observations | pool id `0x3e8b60d6f58a9f894f1b76f3a8239814f0186b78e2990801773a55fd34e43fbe` ([initialise](https://explorer.testnet.chain.robinhood.com/tx/0xb8741b881a6294e56b1d24badf7a9398af03c14b1e2304cd7ffb5d6c1ec278ad), [liquidity](https://explorer.testnet.chain.robinhood.com/tx/0x7585c5b7fcbf3e64e6e1268d30aa047c63e444e30f904f7c2964a6970cd088d7)) |
| The band and the settlement source over that pool | not yet deployed from this repository: `aqua/script/DeployBand.s.sol` (see [aqua/README.md](aqua/README.md)) |

The testnet pool is the team's own stand-in, not an independent market. The fork tests run the same hook on the real
PoolManager next to the real TSLA/USDG liquidity of mainnet.

## Provenance and AI disclosure

Everything in this repository was written during ETHGlobal Tokyo 2026 (from 2026-09-25 21:29 JST). The hook and the
first study were built here, commit by commit. The Aqua seam, the band and the settlement source were written in the
team's private repository during the event and brought here on 2026-09-27; [docs/history.md](docs/history.md) lists
when each part was written and [docs/extraction.md](docs/extraction.md) what was changed on the way. No code from Vexi
or any other pre-existing project is included. Public libraries are pinned submodules, unmodified: v4-core,
OpenZeppelin `uniswap-hooks` and `openzeppelin-contracts`, forge-std, 1inch `aqua`, `swap-vm` and `solidity-utils`.

Built with Claude Code (Anthropic), with subsequent quote-validity and documentation work using Codex (OpenAI). The prompts that shaped the work are in [docs/prompts/](docs/prompts/); the rules
every AI session follows are in [AGENTS.md](AGENTS.md).

## License

File by file; [LICENSE](LICENSE) is the map and each Solidity file's SPDX header is authoritative. MIT by default;
the options book and the Aqua writer under BUSL-1.1 (MIT from 2028-09-27); the SwapVM extensions under 1inch's
SwapVM license. Powered by SwapVM — © Degensoft Ltd 2025. Uses Aqua — © Degensoft Ltd 2025, called through its
published ABI only.
