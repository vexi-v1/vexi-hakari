# ETHGlobal Tokyo 2026: submission texts

Draft text for the ETHGlobal form. Complete [the readiness checks](submission-review.md) before submitting. Track: **Continuity**. Partner prizes: 1inch **Build an Aqua App - Continuity Track** and
Uniswap Foundation **Best Uniswap Stack Contribution**. Repository: <https://github.com/vexi-v1/vexi-hakari>, the
entry's only public repository; Vexi's own codebase stays private and is not linked.

## Tagline

Options written from a wallet through 1inch Aqua, with a Uniswap v4 price band that tells the writer when to stop.

## Short description (≤ 280 characters)

Options collateral stays in the maker's wallet until a fill through 1inch Aqua. A configurable Uniswap v4 TWAP band reduces quote size and pauses new fills on large deviations. Fixed quotes expire and can carry an original-price anchor.

## Long description

Writing a fully collateralised option today means locking the collateral in a protocol before anyone buys. The
writers with the most depth will not hand over custody, so option books stay thin.

Here the writer's tokens stay in its own wallet. An `AquaWriter` is a 1inch Aqua app: the writer ships a strategy to
it and posts covered calls and cash-secured puts as promises. When a buyer buys, Aqua `pull`s exactly the collateral
of the contracts sold from the writer's wallet, inside the buyer's transaction; at expiry, unexercised collateral,
exercise proceeds and premiums come home through Aqua `push`, credited to the same strategy. The same wallet can
quote spot through a SwapVM strategy, and `ExposureGuard`, a custom SwapVM instruction, shrinks that spot pool to what
the options have not promised, at the same price. Fills still check live balances, allowances and strategy state. It runs as an
opcode on our router and, through SwapVM's `Extruction`, on 1inch's router already deployed on Robinhood Chain.

A fixed premium can become stale as the market or time changes, and a pool anyone can trade is a price anyone
can push. HAKARI (秤, "the scale") started at this event as a study of what it costs to fake a Uniswap
v4 price: on Robinhood Chain's stock-token weekend of 2026-08-30, while minting was closed, pushing the HIMS/USDG pool
10 % cost 12 USDG, and the pool stood at 54.50 against a Friday close of 28.84. It now guards the writer.
`HakariOracleHook`, OpenZeppelin's truncated-oracle hook with both TWAPs in one call, records each second's price
before the first swap, so a push undone inside one transaction never reaches its TWAP. `StabilityBandPricer` draws a
band of ±5 % around a hooked pool's one-hour TWAP: the nearer the price is to the edge, the fewer contracts per trade
and the wider the spread; past the edge new fills stop. The fixed 5% default is an illustrative, configurable
parameter inspired by market price bands, not a reproduction of LULD or a calibrated safety threshold.
Fixed quotes have explicit deadlines and optional anchors captured when set: a rolling TWAP catching up with a
persistent move cannot renew an expired quote or move its original anchor.

A separate experimental `HookTwapExpiryPrice` adapter selects the first TWAP window accepted against a band drawn
before expiry. Deferral can select a post-expiry price; a genuine gap or a sustained manipulation can leave no
accepted window. After the book's grace, the result is collateral return and pooled-premium refunds pro rata by
contract, not a guaranteed fair settlement. The primary demonstration is quote protection before new fills.

Integration tests use a fork of Robinhood Chain mainnet 4663: canonical Aqua, the deployed SwapVM router, real
TSLA and USDG, and the hook's deployed testnet bytecode on the real v4 PoolManager. Fork-free tests cover quote
validity and original anchors, the taper's size-times-deviation arithmetic and experimental settlement outcomes.

Aqua — © Degensoft Ltd 2025. Powered by SwapVM — © Degensoft Ltd 2025.

## How it's made

- **Contracts:** Solidity, Foundry. The hook: solc 0.8.26 against v4-core and OpenZeppelin `uniswap-hooks`, its
  address mined for its flag bits and deployed with CREATE2 on testnet 46630. The Aqua seam, the band and the
  settlement: solc 0.8.30, cancun, via-IR, against 1inch `aqua` `ef24220`, `swap-vm` `v1.0.2` (the interface of the
  router deployed on 4663), `solidity-utils`, OpenZeppelin `v5.4.0` and v4-core `v4.0.0` (libraries and types:
  `StateLibrary`, `TickMath`, `FullMath`, `PoolKey`, `PoolId`, `Currency`).
- **Tests:** on a fork of Robinhood Chain 4663 pinned at block 72,248,228; nobody is impersonated, every account is a
  plain address funded on the fork. The hook's deployed runtime bytecode is etched at its own address on the fork and
  runs unchanged against the real PoolManager (the same address on both chains). Fork-free suites fuzz the guard and
  the band's taper.
- **SwapVM programs:** built byte by byte in the test helpers: `ExposureGuard` (opcode 34 on our router, or
  `Extruction` 32 on the canonical one), `x·y=k`, a salt.
- **Testnet 46630:** the hook, and an AAPL/USDG v4 pool created with it through PositionManager and Permit2
  (`MINT_POSITION` + `SETTLE_PAIR`, full range), its observation ring grown to 128.
- **Built at the event, in public and in private:** the hook and the first study were built in this repository
  commit by commit; the Aqua seam, the band and the settlement were written during the event in Vexi's private
  codebase and brought here on 2026-09-27, trimmed to the integration (`docs/history.md`, `docs/extraction.md`).
- **AI:** built with Claude Code, with subsequent quote-validity and documentation work using Codex; the prompts are in `docs/prompts/`.

## How is 1inch Aqua / SwapVM used

Aqua is the writer's custody model: one balance, shipped as virtual balances to an options strategy and a SwapVM spot
strategy, moved only at a fill. SwapVM is the spot pool and the place where the two strategies are kept honest.

- `aqua/src/aqua/AquaWriter.sol`: `provide` → `AQUA.pull(MAKER, strategyHash, collateral, amount, BOOK)`, called
  from `OptionBook.buy`; `onReturned` → `AQUA.push`, called from `OptionBook.close`; `claimPremium` takes the premium
  from the book once settled and pushes it the same way; `available` = min(virtual balance, wallet, allowance to
  Aqua); `promised(token)`.
- `aqua/src/swapvm/ExposureGuard.sol`: custom instruction, same price, depth capped at the unpromised balance;
  `ExposureGuardExtruction.sol`: the same policy on the canonical router through `Extruction`;
  `WriterSwapVMRouter.sol`: the deployed router's opcode table plus the guard. `aqua/deployed-46630/`: the router the
  vaults use on testnet 46630, published as deployed, with a second instruction, `DeltaSkew` (opcode 35), that leans
  the spot price against the delta the option book added.
- Proofs: `aqua/test/Lifecycle.t.sol` (the Aqua invariants on the fork), `aqua/test/ExposureGuard.t.sol` (without the
  guard, a spot fill takes promised collateral and the option buyer is refused), `aqua/test/ExposureGuardCanonical.t.sol`
  (the guard on `0x111111338c…`), `aqua/test/GuardProperties.t.sol`.

## How is Uniswap used

Uniswap v4 is the price the writer's book is checked against, through HAKARI's hook.

- `src/HakariOracleHook.sol`: OpenZeppelin `BaseOracleHook` plus `twaps()`, deployed on 46630 at
  `0x3b58D774cE351227B24A91103b20bA4fc068D080`.
- `aqua/src/band/StabilityBandPricer.sol`: `slot0` and in-range liquidity through v4-core's `StateLibrary`, raw and
  truncated cumulative ticks from the hook's `observe`, the oracle read from the pool key's `hooks`; the band, the
  taper and the pause; raw and truncated TWAPs disagreeing pauses the book.
- `aqua/src/band/HookTwapExpiryPrice.sol`: experimental settlement-window selection; rejection can defer the
  price or leave the series refundable. `aqua/src/band/BandMath.sol`: tick → price without a 320-bit overflow, either token order.
- `aqua/script/HookedPool.s.sol`: the hooked testnet pool through `PositionManager.initializePool`,
  `modifyLiquidities` with Permit2, `increaseObservationCardinalityNext`, `PoolSwapTest`.
- Proofs: `aqua/test/StabilityBandFork.t.sol` (the deployed hook on the real PoolManager), `aqua/test/StabilityBand.t.sol`,
  `aqua/test/StabilityTwapSettle.t.sol`, `test/HakariOracleHook.t.sol`.
- Developer feedback: `FEEDBACK.md`.

## AI assistance

Claude and Claude Code assisted the original specs, contracts, tests and documentation. Codex assisted later
quote-validity changes, review, submission documents and the public website. Eric directed the Aqua specification,
build gates and review/rework; Abner directed HAKARI review, extraction, public-scope decisions and the website.
The file-level disclosure is [docs/ai-usage.md](ai-usage.md). The [prompt index](prompts/README.md) includes the
original HAKARI spec and the recovered Aqua specs, build plan, demo/facts and AI-usage log with the original build
and review briefs. A manifest records source revisions and checksums; source-band excerpts and unavailable raw
transcripts are explicitly identified. These records must be accessible at the repository revision submitted.

## Continuity Track: what existed before the event, and what was built at it

**Before the event.** Vexi, the team's options venue on Robinhood Chain: vaults that write covered calls and
cash-secured puts on tokenized stocks, quoting a board of strikes and expiries (a private codebase). No code written
before the event is in the repository; public libraries are pinned submodules, unmodified.

**At the event.** Two additions to Vexi, one per partner: the 1inch Aqua writer (collateral stays in the writer's
wallet until a fill; a SwapVM guard keeps the spot pool on the same balance from selling promised tokens), and,
through HAKARI, the Uniswap v4 band and settlement. HAKARI was built in this repository in public, commit by commit
from `c65549c` (2026-09-25 21:29 JST). The Aqua writer, the band and the settlement were written in Vexi's private
codebase from 2026-09-25 21:46 JST and brought into this repository on 2026-09-27; `docs/history.md` lists when each
part was written. The repository holds only those additions.

---

Aqua — © Degensoft Ltd 2025. SwapVM — © Degensoft Ltd 2025.
