# Uniswap developer feedback — HAKARI band

ETHGlobal Tokyo 2026 · Uniswap Foundation "Best Uniswap Stack Contribution".

These eight findings come from building the option book and its price band in `aqua/` on 2026-09-26/27.
Each describes an integration issue we encountered, our workaround, and what would have helped.

The band reads pool state through `StateLibrary` and raw/truncated TWAPs through `HakariOracleHook`, based on
OpenZeppelin's `BaseOracleHook`. We tested it on a Robinhood Chain mainnet fork (4663) and created a hooked pool on
testnet (46630), using PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`, PositionManager and Permit2.
See [the band](docs/band.md) and [experimental settlement](docs/settlement.md) for the consumer's behavior and limits.
The observations below reflect the build, not a fresh review of upstream documentation or deployments.

## 1. No safe "price from `sqrtPriceX96`" recipe

The v4 [read pool state](https://developers.uniswap.org/docs/protocols/v4/guides/read-pool-state) guide stops at
`sqrtPriceX96`. It does not show turning it into a human price with token decimals and token order, and does not warn
that squaring a uint160 can need 320 bits, so every integrator who uses a pool as a price reference writes this by
hand. We borrowed v3's `OracleLibrary.getQuoteAtTick` split (square exactly below 2^128, go through X128 above) and
needed tests on powers of two, both token orders and a fuzz over the whole tick range to trust it
([`BandMath.priceOf`](aqua/src/band/BandMath.sol)). A documented helper, or a function in v4-periphery, would remove a
class of bugs.

## 2. No word on `slot0` as a reference price

The same guide reads `slot0` with no note that it can be moved inside one transaction and that v4 has no built-in
oracle. We designed for it (the band's center is a hook TWAP; `slot0` only decides how far from it we are), but a
one-paragraph warning with a link to oracle-hook examples belongs next to `getSlot0`.

## 3. Minting from a plain script needs three things the mint guide leaves out

The [mint position](https://developers.uniswap.org/docs/protocols/v4/guides/managing-liquidity/mint-position) guide
names `Actions.MINT_POSITION` and `Actions.SETTLE_PAIR` but not their byte values (we used `0x02` and `0x0d` from
v4-periphery's `Actions.sol` rather than add the whole periphery as a dependency, and confirmed them only by
simulating against the deployed PositionManager); it does not mention the two Permit2 approvals the settle step needs
(`token.approve(Permit2)`, then `Permit2.approve(token, PositionManager, amount, expiration)`); and it does not show
computing liquidity for full range from token amounts. A short "first position from a Foundry script" page with those
three would have saved us the most time.

## 4. v4-core as a Foundry submodule

The repository has one release tag (`v4.0.0`) while `main` has moved on, so `forge install` without a tag lands on an
arbitrary `main` commit (this repository ends up with two: the hook builds against a later `main` commit, `aqua/`
against `v4.0.0`). Foundry also picks up v4-core's own `remappings.txt`, adding `hardhat/` and `@ensdomains/` entries
that point into a `node_modules/` a submodule checkout does not have. Saying which tag or commit the deployed
PoolManagers were built from would help.

## 5. The same PoolManager address on both chains let us run a testnet hook on a mainnet fork

Worked well. We etched the hook's deployed 46630 bytecode at its own flag-mined address on a 4663 fork, and it ran
unchanged against the real PoolManager (its immutable `poolManager` matched)
([`test/StabilityBandFork.t.sol`](aqua/test/StabilityBandFork.t.sol)). One of our most useful integration tests, and
only possible because the addresses match; worth saying on the deployments page.

## 6. The cardinality trap is easy to fall into with a v4 oracle hook

After `initialize` the ring holds one observation; the first swap in a later second overwrites it unless
`increaseObservationCardinalityNext` was called first, and the growth only takes effect on the write after that. A
one-hour TWAP then reverts (`TargetPredatesOldestObservation`) for an hour after every swap. This is v3's behaviour,
but the v4 hook docs and the OpenZeppelin hook's NatSpec do not warn about it. A line in the oracle-hook guide ("grow
the ring before the first swap; size it to swap-seconds per window") would help.

## 7. No cheap way to ask for the oldest observation

A consumer that wants "the longest window available, up to W" must read `stateById` and then `observationsById` to
find the oldest timestamp, or call `observe` and catch the revert. An `oldestObservationTimestamp(poolId)` view on the
oracle hook would make fail-closed consumers simpler; ours catches the revert and pauses.

## 8. `PoolSwapTest` and `PoolModifyLiquidityTest` are what scripts end up using on a testnet

They live under v4-core's `src/test`; the only minimal swap router we found on Robinhood testnet was one deployed from
that folder. Either blessing them for scripts or listing a periphery router on testnets would help.

---

Earlier research is kept separately in [historical feedback](archive/feedback-history.md).
