# aqua/: the Aqua seam, the band and the settlement

A Foundry project of its own (solc 0.8.30, cancun, via-IR), next to the hook's project at the repository root. What
it is and why: [the root README](../README.md). The band: [docs/band.md](../docs/band.md).

```
src/aqua/AquaWriter.sol              the 1inch Aqua app: collateral pulled from the maker's wallet only at a fill
src/book/OptionBook.sol              a small book of covered calls and cash-secured puts, settled by delivery
src/book/FixedPremium.sol            expiring quotes, optional captured price anchors
src/book/IPremium.sol, IQuoteReference.sol, ICollateralSource.sol
src/swapvm/ExposureGuard.sol         custom SwapVM instruction: spot depth ≤ wallet − promised, same price
src/swapvm/ExposureGuardExtruction.sol   the same guard on the canonical router, through Extruction
src/swapvm/WriterSwapVMRouter.sol    the deployed router's opcode table plus the guard
src/band/StabilityBandPricer.sol     ±5 % around a hooked v4 pool's TWAP: taper, then pause
src/band/HookTwapExpiryPrice.sol     experimental TWAP settlement-window selection
src/band/BandMath.sol                average tick, tick → price, the band check
src/price/                           IExpiryPrice and a fixed test double
```

## Test

```bash
git submodule update --init --recursive     # if the clone was not recursive
cp .env.example .env                        # RH_MAINNET_RPC: a 4663 endpoint that serves historical state
forge test                                  # fork tests pin block 72,248,228
forge test --match-path "test/{FixedPremium,GuardProperties,BookRefund,StabilityBand,StabilityTwapSettle}.t.sol"   # no fork needed
```

## Build and deploy the SwapVM extensions

`src/swapvm/` modifies 1inch SwapVM and is under its license (LicenseRef-Degensoft-SwapVM-1.1,
[copy](../LICENSES/SwapVM-1.1.txt)), which asks for build and deployment instructions (its §3.1 E). `forge build`
builds them. The tests deploy them on a fork of 4663; to deploy them yourself, for example on a local anvil (the key
never goes on the command line: use an unlocked anvil account, or `--account <keystore>`):

```bash
anvil --fork-url "$RH_MAINNET_RPC" --fork-block-number 72248228    # or a plain `anvil`: the constructors need no state
forge create src/swapvm/ExposureGuardExtruction.sol:ExposureGuardExtruction \
  --rpc-url http://127.0.0.1:8545 --unlocked --from <address> --broadcast
forge create src/swapvm/WriterSwapVMRouter.sol:WriterSwapVMRouter \
  --rpc-url http://127.0.0.1:8545 --unlocked --from <address> --broadcast \
  --constructor-args 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a 0x0000000000000000000000000000000000000000 <owner> "Writer SwapVM" "1.0.2"
```

The router's arguments are canonical Aqua on 4663, no WETH, the owner who may rescue funds, and the EIP-712 name and
version. `ExposureGuardExtruction` has no constructor arguments: a program on the canonical router names it through
the `Extruction` opcode (`test/ExposureGuardCanonical.t.sol`). Powered by SwapVM — © Degensoft Ltd 2025.

## Deploy the band on testnet 46630

The band and the settlement source read the AAPL/USDG pool whose hook is HAKARI's
([`deployments/46630-hooked-pool.json`](deployments/46630-hooked-pool.json), made with the steps in
[`script/HookedPool.s.sol`](script/HookedPool.s.sol)). To deploy them over it, with `BAND_DEPLOYER_KEY` in `.env`:

```bash
forge script script/DeployBand.s.sol --rpc-url robinhood_testnet                       # simulate
forge script script/DeployBand.s.sol --rpc-url robinhood_testnet --broadcast --slow    # deploy; writes deployments/46630-band.json
```

The script refuses any chain but 46630 and any pool but the hooked one. It prints the band's status right after
deploying: the center, the current price, the half-width, where the price sits in the band, and how many contracts
it would sell per call.

## Configure a quote after deployment

The deploy script creates an unpriced `FixedPremium`; it does not open orders or grant an indefinite quote.
The owner chooses a premium, an exclusive deadline and, optionally, a tolerance against a captured original price:

```solidity
// A demonstration policy; choose validity and tolerance explicitly for each use.
premium.setAnchoredPremium(seriesId, premiumInQuoteUnits, validUntil, band, maxDeviationBps);
// Time-only quoting is explicit and replaces any previous anchor:
premium.setPremium(seriesId, premiumInQuoteUnits, validUntil);
// Disable either kind:
premium.setPremium(seriesId, 0, 0);
```

`setPremium` now requires three arguments; there is no two-argument fallback. `PremiumSet` also includes the quote
terms. Consumers must update their ABI when deploying this version. Choose the band's pair to match the series;
its `referencePriceWad` reads live slot0 even with `nowWindow > 0`. A successful `band.status()` alone does not mean
a series' quote is valid. See [quote validity](../docs/band.md) and [experimental settlement](../docs/settlement.md).
