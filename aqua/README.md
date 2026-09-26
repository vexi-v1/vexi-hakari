# aqua/: the Aqua seam, the band and the settlement

A Foundry project of its own (solc 0.8.30, cancun, via-IR), next to the hook's project at the repository root. What
it is and why: [the root README](../README.md). The band: [docs/band.md](../docs/band.md).

```
src/aqua/AquaWriter.sol              the 1inch Aqua app: collateral pulled from the maker's wallet only at a fill
src/book/OptionBook.sol              a small book of covered calls and cash-secured puts, settled by delivery
src/book/FixedPremium.sol            one premium per series, set by its owner
src/book/IPremium.sol, ICollateralSource.sol
src/swapvm/ExposureGuard.sol         custom SwapVM instruction: spot depth ≤ wallet − promised, same price
src/swapvm/ExposureGuardExtruction.sol   the same guard on the canonical router, through Extruction
src/swapvm/WriterSwapVMRouter.sol    the deployed router's opcode table plus the guard
src/band/StabilityBandPricer.sol     ±5 % around a hooked v4 pool's TWAP: taper, then pause
src/band/HookTwapExpiryPrice.sol     settlement on the hook's TWAP, deferred when a push moves it out of the band
src/band/BandMath.sol                average tick, tick → price, the band check
src/price/                           IExpiryPrice and a fixed test double
```

## Test

```bash
git submodule update --init --recursive     # if the clone was not recursive
cp .env.example .env                        # RH_MAINNET_RPC: a 4663 endpoint that serves historical state
forge test                                  # fork tests pin block 72,248,228
forge test --match-path "test/{GuardProperties,BookRefund,StabilityBand,StabilityTwapSettle}.t.sol"   # no fork needed
```

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
