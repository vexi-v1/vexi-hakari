# Uniswap developer feedback — HAKARI band

ETHGlobal Tokyo 2026 · Uniswap Foundation "Best Uniswap Stack Contribution" · Continuity Track.

These eight findings come from building the option book and its price band in `aqua/` on 2026-09-26/27.
They cover friction we encountered, one integration detail that worked well, and specific improvements we would
like. Source links point to this revision; the [reviewer code map](docs/reviewer-code-map.md) connects them to the
entry, and the [public-document check](docs/submission-review.md#public-document-check--2026-09-27) records whether
the revision is available to an unauthenticated reviewer.

The band reads pool state through `StateLibrary` and raw/truncated TWAPs through `HakariOracleHook`, based on
OpenZeppelin's `BaseOracleHook`. We tested it on a Robinhood Chain mainnet fork (4663) and created a hooked pool on
testnet (46630), using PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`, PositionManager and Permit2.
See [the band](docs/band.md) and [experimental settlement](docs/settlement.md) for the consumer's behavior and limits.
These are build-experience notes, not a claim that a topic is absent from all upstream documentation. The linked
Uniswap guides and vendored oracle source were rechecked on 2026-09-27 when refining the feedback.

The most useful improvement for us would be a runnable oracle-consumer example: initialize a hooked pool, grow
its observation ring, accumulate a window, call `observe`, and refuse a quote when that history is unavailable.
Our [successful buy](aqua/test/StabilityBandFork.t.sol#L311),
[out-of-band refusal](aqua/test/StabilityBandFork.t.sol#L359) and
[unavailable-history test](aqua/test/StabilityBand.t.sol#L284) show why each step matters.

## 1. From `sqrtPriceX96` to a whole-token price

**Observed.** The [read-pool-state guide](https://developers.uniswap.org/docs/protocols/v4/guides/read-pool-state)
explains the encoded price. Our consumer also needed quote-per-base units, either token order, and decimal scaling.
Directly squaring a uint160 can require 320 bits.

**Workaround and evidence.** [`BandMath.priceOf`](aqua/src/band/BandMath.sol#L30) uses a Q192 square for values that
fit in uint128, otherwise a Q128 ratio computed with `FullMath.mulDiv`, following v3's conversion approach.
The [consumer constructor](aqua/src/band/StabilityBandPricer.sol#L130) validates decimals up to 18 and derives the scale.

**Request.** Link a conversion example from the state-reading guide, including both token orders, unequal decimals,
rounding and representable output limits. This would shorten the path from a state read to a usable price.

## 2. State reads need an explicit oracle-use caveat

**Observed.** The same guide lists a price oracle as a use case for `getSlot0`. A pool's current price can move
within one transaction, so reading it is not sufficient to establish a trustworthy reference.

**Workaround and evidence.** [`status`](aqua/src/band/StabilityBandPricer.sol#L199) compares the current pool price
with a hook TWAP and checks raw/truncated-series agreement. The [fork refusal](aqua/test/StabilityBandFork.t.sol#L359)
exercises an actual purchase after a push. A [sustained push can become the center](aqua/test/StabilityBandFork.t.sol#L432);
this policy does not establish an external fair price.

**Request.** Put a short caveat next to that use case, linked to oracle-hook examples and their liquidity,
history and manipulation assumptions.

## 3. A complete first-position script would reduce setup work

**Observed.** The [mint-position guide](https://developers.uniswap.org/docs/protocols/v4/guides/managing-liquidity/mint-position)
shows action encoding and links a setup guide. Assembling our Foundry script also required both Permit2 approvals
and the conversion from token amounts to full-range liquidity.

**Workaround and evidence.** [`HookedPool.run`](aqua/script/HookedPool.s.sol#L88) initializes and mints;
[`_plan`](aqua/script/HookedPool.s.sol#L173) computes liquidity and maximum amounts;
[`_mintAndApprove`](aqua/script/HookedPool.s.sol#L195) approves the token to Permit2 and Permit2 to PositionManager.
Our minimal-interface script uses action bytes `0x02`/`0x0d`; the guide's `Actions` imports already supply those
constants for projects using v4-periphery. The [testnet record](aqua/deployments/46630-hooked-pool.json) records our run.

**Request.** A runnable first-position script combining setup, approvals, liquidity calculation and minting,
with the deployed-address and token-order assumptions visible in one place.

## 4. v4-core as a Foundry submodule

**Observed.** Our two Foundry projects ended up with different v4-core revisions. The dependency's remappings also
include `hardhat/` and `@ensdomains/` paths to a `node_modules/` directory absent from our submodule checkout.

**Workaround and evidence.** We pin the hook's v4-core to
[`d153b04`](https://github.com/Uniswap/v4-core/tree/d153b048868a60c2403a3ef5b2301bb247884d46) and the consumer's to
[`e50237c`](https://github.com/Uniswap/v4-core/tree/e50237c43811bd9b526eff40f26772152a42daba), and configure imports in
[the root](foundry.toml) and [consumer](aqua/foundry.toml) projects. The
[pinned dependency remappings](https://github.com/Uniswap/v4-core/blob/e50237c43811bd9b526eff40f26772152a42daba/remappings.txt#L1)
show the paths we encountered. They did not prevent the recorded build from passing.

**Request.** Show a tested Foundry dependency/remapping set and identify the source revision for each deployment,
so integrators can deliberately match source and bytecode.

## 5. The same PoolManager address on both chains let us run a testnet hook on a mainnet fork

**Worked well.** The matching PoolManager addresses let the hook's immutable manager address remain valid when we
installed its deployed 46630 runtime at its flag-mined address on a local 4663 fork.

**Evidence.** The [fixture](aqua/test/StabilityBandFork.t.sol#L172) creates a new hooked pool on the real PoolManager,
and [assertions](aqua/test/StabilityBandFork.t.sol#L276) check the reference and observations. The pool and swap
history are synthetic; this is not a mainnet deployment or evidence that the two chains have identical state.

**Request.** Document this reusable fork-testing pattern alongside chain-specific deployment addresses, with
explicit checks for bytecode compatibility and hook immutables.

## 6. The cardinality trap is easy to fall into with a v4 oracle hook

**Observed.** A newly initialized ring holds one observation. Without growth, a write at a later timestamp replaces
it; a requested window older than retained history reverts with `TargetPredatesOldestObservation`. Merely waiting
an hour does not ensure an hour of retained history on an actively overwritten ring.

**Workaround and evidence.** Our [testnet script](aqua/script/HookedPool.s.sol#L124) grows the ring before its swaps;
the [fork fixture](aqua/test/StabilityBandFork.t.sol#L217) grows it and then builds two hours of observations.
Growth reserves capacity; it does not backfill historical prices.

**Request.** Add an end-to-end warm-up example explaining capacity, elapsed history and distinct-timestamp writes.
The [pinned OpenZeppelin NatSpec](https://github.com/OpenZeppelin/uniswap-hooks/blob/acbd604c409a827f7f98c9517236da860c4fca1a/src/oracles/panoptic/BaseOracleHook.sol#L24)
already explains deferred cardinality growth; our difficulty was translating that into a ready-to-query consumer.

## 7. Discovering the available observation window

**Observed.** The oracle exposes `stateById` and `observationsById`, but a consumer must interpret ring state to
find the oldest initialized observation, or try `observe` and handle failure.

**Workaround and evidence.** Our [observation read](aqua/src/band/StabilityBandPricer.sol#L211) catches failure and
returns `ReferenceUnavailable`; the [consumer test](aqua/test/StabilityBand.t.sol#L284) checks that quotes refuse.
We keep the configured window rather than silently accepting a shorter one.

**Request.** An `oldestObservationTimestamp(poolId)` helper, with partially populated-ring semantics, would make
readiness checks and frontend explanations simpler. This concerns the OpenZeppelin/Panoptic oracle interface,
not a missing PoolManager method.

## 8. Finding a minimal testnet router

**Observed.** Our minimal swaps used `PoolSwapTest` from v4-core's `src/test`, and the fork fixture used
`PoolModifyLiquidityTest` for liquidity. It took extra work to distinguish demonstration helpers from the
recommended application integration path.

**Workaround and evidence.** [`HookedPool._swap`](aqua/script/HookedPool.s.sol#L159) uses `PoolSwapTest`; the
[fork setup](aqua/test/StabilityBandFork.t.sol#L172) uses the test helpers locally. Testnet minting instead goes
through PositionManager and Permit2 as described above.

**Request.** List a supported minimal swap path for each testnet and state when these helpers are suitable for
examples. We are not recommending test helpers as production routers.

---

Earlier research is kept separately in [historical feedback](archive/feedback-history.md).
