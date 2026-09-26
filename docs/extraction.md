# What was brought in, and what was left out

The Aqua writer and the band were added to Vexi, the team's existing project, during ETHGlobal Tokyo 2026, in Vexi's
private codebase (see [history.md](history.md)). Vexi stays private; on 2026-09-27 the owners chose to bring into this
repository, the entry's only public one, just what the two partner prizes review. This page is the inventory, so a
reviewer knows what they are looking at and what they are not.

The rule for each part: **does a 1inch or Uniswap reviewer need it to verify the integration?** If yes, it is here,
trimmed to what the integration needs. If it is Vexi's product (how options are priced, how a shared vault accounts
for its depositors, the trading app), it stays private, and the smallest honest stand-in takes its place.

## Brought in

| Part | Here | How it changed on the way |
|---|---|---|
| The Aqua app | [`aqua/src/aqua/AquaWriter.sol`](../aqua/src/aqua/AquaWriter.sol) | Trimmed to the Aqua seam: bind a shipped strategy, post an order as a promise, `provide` (Aqua `pull` at a fill), `onReturned` and `claimPremium` (Aqua `push`), `available`, `release`, `promised` |
| The book | [`aqua/src/book/OptionBook.sol`](../aqua/src/book/OptionBook.sol) | A small book of covered calls and cash-secured puts: create a series, post, buy, settle, exercise by delivery, close, refund. No buybacks and no position tokens for the writer. Every order is priced by an `IPremium` |
| The seams | [`IQuoteReference`](../aqua/src/book/IQuoteReference.sol), [`ICollateralSource`](../aqua/src/book/ICollateralSource.sol), [`IPremium`](../aqua/src/book/IPremium.sol), [`IExpiryPrice`](../aqua/src/price/IExpiryPrice.sol) | Reduced to the calls the book above makes |
| SwapVM guard | [`aqua/src/swapvm/`](../aqua/src/swapvm/): `ExposureGuard`, `ExposureGuardExtruction`, `WriterSwapVMRouter` | Unchanged, except that the router appends only `ExposureGuard` to the deployed router's opcode table |
| The router deployed on testnet 46630 | [`aqua/deployed-46630/`](../aqua/deployed-46630/): `WriterSwapVMRouter` with `ExposureGuard` and `DeltaSkew` | Published as deployed, because 1inch's SwapVM license asks a deployed modification to publish its source; only header comments changed, and the deployed code was checked against it byte for byte. `DeltaSkew` leans the spot price against the delta the option book added (−0.5 per short call, +0.5 per short put). Nothing else in this repository uses it |
| The band | [`aqua/src/band/StabilityBandPricer.sol`](../aqua/src/band/StabilityBandPricer.sol), [`BandMath.sol`](../aqua/src/band/BandMath.sol) | A fixed half-width, 5 % by default ([band.md](band.md)); it wraps any `IPremium` |
| Settlement on the hook | [`aqua/src/band/HookTwapExpiryPrice.sol`](../aqua/src/band/HookTwapExpiryPrice.sol) | The same fixed band decides whether a settle window is accepted |
| Test doubles | [`FixedExpiryPrice`](../aqua/src/price/FixedExpiryPrice.sol) | Unchanged |
| Fork and program helpers | [`aqua/test/helpers/`](../aqua/test/helpers/) | Addresses on 4663, the hook's deployed bytecode, SwapVM program builders (only the programs used here) |
| Tests | [`aqua/test/`](../aqua/test/) | Ported to the trimmed contracts; the band's and the settlement's tests written here |
| The hooked testnet pool | [`aqua/script/HookedPool.s.sol`](../aqua/script/HookedPool.s.sol), [`aqua/deployments/46630-hooked-pool.json`](../aqua/deployments/46630-hooked-pool.json) | The script that made the AAPL/USDG pool with HAKARI's hook on 46630, and its record |

The website additionally reuses the existing Vexi logo as [`website/vexi-logo.svg`](../website/vexi-logo.svg),
unchanged, at the owner's explicit request on 2026-09-27. This branding asset does not include product UI code.

## Written here

| Part | Why |
|---|---|
| [`FixedPremium`](../aqua/src/book/FixedPremium.sol) | The stand-in for Vexi's pricer: one owner-set premium per series, with an explicit deadline and an optional original-price anchor. These generic validity checks remain separate from the rolling band |
| [`aqua/script/DeployBand.s.sol`](../aqua/script/DeployBand.s.sol) | Deploys the band and the settlement source over the hooked pool on 46630 |
| [`docs/`](.), this README, [`FEEDBACK.md`](../FEEDBACK.md) | Written for readers of this repository |

## Left out

| Part | Why |
|---|---|
| Vexi's option pricer and board view | Product: how Vexi prices options. `FixedPremium` stands in |
| The shared vault (depositors' shares of one Aqua maker) | Product: how a Vexi vault accounts for its depositors. Here the maker is a plain wallet, the way Aqua is meant to be used |
| Buybacks and the writer's position tokens | Not needed to show the Aqua seam; they belong with the pricer |
| A settlement source on a Chainlink feed | Not part of either partner integration; the book takes any `IExpiryPrice` |
| A simpler `slot0` check against the Uniswap pool | The band covers it: it reads the same `slot0` through `StateLibrary`, plus the hook's TWAP |
| The trading app, the position page, the demo scripts, the slides and the submission drafts | Product and presentation, not integration |
| Testnet deployments of the private code | They run code that is not in this repository, so this repository does not point to them. The band is redeployed from here with `DeployBand.s.sol` |

## How the move was made

- A copy of the files, not a merge of histories: Vexi's history carries the parts left out. The commits here that
  bring the code in say so, and [history.md](history.md) lists when each part was first written.
- Every contract here compiles and is tested here: `cd aqua && forge test`.

---

Aqua — © Degensoft Ltd 2025. SwapVM — © Degensoft Ltd 2025.
