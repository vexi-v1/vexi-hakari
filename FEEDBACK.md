# FEEDBACK.md — friction met while building on the Uniswap stack

ETHGlobal Tokyo 2026 · HAKARI · Uniswap Foundation "Best Uniswap Stack Contribution".
Only things we actually ran into while building this repo. Each build entry says what we hit, what we did,
and what would have helped. The current band's integration feedback comes first; earlier findings remain below
as historical evidence. Entry numbers are stable identifiers, retained so existing references still work.

| Read first | Scope |
|---|---|
| [Current: the option book and its band](#current-the-option-book-and-its-band) | Items 13–20: the current integration in `aqua/` |
| [Historical: the archived first study](#historical-the-archived-first-study) | Items 1–12: evidence and lessons from the earlier design |
| [Background research, not re-checked during the build](#background-research-not-re-checked-during-the-build) | Item 21: research notes, kept separate from build findings |

Chain context for these recorded observations: Robinhood Chain mainnet (4663, read-only for us) and testnet
(46630), with the official v4 PoolManager at `0x8366a39CC670B4001A1121B8F6A443A643e40951`.
These are build-time reports, not a fresh check of upstream documentation or current deployments.

## Current: the option book and its band

Items 13–20 were recorded while building the option book and its band (`aqua/`, 2026-09-26/27).
The band reads a v4 pool's `slot0` through `StateLibrary` and its TWAP through `HakariOracleHook` (OpenZeppelin's
`BaseOracleHook`, Panoptic's truncated oracle). A separate experimental settlement source reads the same hook.
We tested both on a fork of 4663 against the real PoolManager and deployed a hooked pool on 46630 through
PositionManager and Permit2. See [the current band](docs/band.md) and [experimental settlement](docs/settlement.md).

### 13. No safe "price from `sqrtPriceX96`" recipe

The v4 [read pool state](https://developers.uniswap.org/docs/protocols/v4/guides/read-pool-state) guide stops at
`sqrtPriceX96`. It does not show turning it into a human price with token decimals and token order, and does not warn
that squaring a uint160 can need 320 bits, so every integrator who uses a pool as a price reference writes this by
hand. We borrowed v3's `OracleLibrary.getQuoteAtTick` split (square exactly below 2^128, go through X128 above) and
needed tests on powers of two, both token orders and a fuzz over the whole tick range to trust it
([`BandMath.priceOf`](aqua/src/band/BandMath.sol)). A documented helper, or a function in v4-periphery, would remove a
class of bugs.

### 14. No word on `slot0` as a reference price

The same guide reads `slot0` with no note that it can be moved inside one transaction and that v4 has no built-in
oracle. We designed for it (the band's center is a hook TWAP; `slot0` only decides how far from it we are), but a
one-paragraph warning with a link to oracle-hook examples belongs next to `getSlot0`.

### 15. Minting from a plain script needs three things the mint guide leaves out

The [mint position](https://developers.uniswap.org/docs/protocols/v4/guides/managing-liquidity/mint-position) guide
names `Actions.MINT_POSITION` and `Actions.SETTLE_PAIR` but not their byte values (we used `0x02` and `0x0d` from
v4-periphery's `Actions.sol` rather than add the whole periphery as a dependency, and confirmed them only by
simulating against the deployed PositionManager); it does not mention the two Permit2 approvals the settle step needs
(`token.approve(Permit2)`, then `Permit2.approve(token, PositionManager, amount, expiration)`); and it does not show
computing liquidity for full range from token amounts. A short "first position from a Foundry script" page with those
three would have saved us the most time.

### 16. v4-core as a Foundry submodule

The repository has one release tag (`v4.0.0`) while `main` has moved on, so `forge install` without a tag lands on an
arbitrary `main` commit (this repository ends up with two: the hook builds against a later `main` commit, `aqua/`
against `v4.0.0`). Foundry also picks up v4-core's own `remappings.txt`, adding `hardhat/` and `@ensdomains/` entries
that point into a `node_modules/` a submodule checkout does not have. Saying which tag or commit the deployed
PoolManagers were built from would help.

### 17. The same PoolManager address on both chains let us run a testnet hook on a mainnet fork

Worked well. We etched the hook's deployed 46630 bytecode at its own flag-mined address on a 4663 fork, and it ran
unchanged against the real PoolManager (its immutable `poolManager` matched)
([`test/StabilityBandFork.t.sol`](aqua/test/StabilityBandFork.t.sol)). One of our most useful integration tests, and
only possible because the addresses match; worth saying on the deployments page.

### 18. The cardinality trap is easy to fall into with a v4 oracle hook

After `initialize` the ring holds one observation; the first swap in a later second overwrites it unless
`increaseObservationCardinalityNext` was called first, and the growth only takes effect on the write after that. A
one-hour TWAP then reverts (`TargetPredatesOldestObservation`) for an hour after every swap. This is v3's behaviour,
but the v4 hook docs and the OpenZeppelin hook's NatSpec do not warn about it. A line in the oracle-hook guide ("grow
the ring before the first swap; size it to swap-seconds per window") would help.

### 19. No cheap way to ask for the oldest observation

A consumer that wants "the longest window available, up to W" must read `stateById` and then `observationsById` to
find the oldest timestamp, or call `observe` and catch the revert. An `oldestObservationTimestamp(poolId)` view on the
oracle hook would make fail-closed consumers simpler; ours catches the revert and pauses.

### 20. `PoolSwapTest` and `PoolModifyLiquidityTest` are what scripts end up using on a testnet

They live under v4-core's `src/test`; the only minimal swap router we found on Robinhood testnet was one deployed from
that folder. Either blessing them for scripts or listing a periphery router on testnets would help.

## Historical: the archived first study

Items 1–12 belong to [the archived first study](archive/README.md). They are retained because the reproduced
oracle, quoter and integration findings remain useful context; they are not claims that the old consumers or
safety policies are part of the current band. `SafeSettle`, `PushCostLens`, the gauge and the old live board refer
to that archived implementation. Bare README section references in these entries refer to
[the study's README](archive/hakari-v1/README.md), not the current repository README. Some oracle findings also
have tests in the retained root hook project.

### 1. V4Quoter quotes amounts; we needed to quote a price

The question HAKARI asks is "what does it cost to move this pool to price P and back?". `V4Quoter`'s
`QuoteExactSingleParams` is `{poolKey, zeroForOne, exactAmount, hookData}` — there is no
`sqrtPriceLimitX96`, so it cannot stop at a price. We re-implemented the same unlock → swap → revert
pattern with a price limit (`PushCostLens.quotePush`, `quotePushToPrice`,
[`src/PushCostLens.sol`](archive/hakari-v1/src/PushCostLens.sol)). An optional price limit on the quoter, or a
`quoteToPrice`, would serve every risk tool, liquidation bot and oracle checker that thinks in prices
rather than sizes.

### 2. Quoting is impossible from inside an unlock, so on-chain consumers need a second, view path

A contract that is itself running inside `PoolManager.unlock` (a hook, a router step, a settlement
inside a flash action) cannot call a V4Quoter-style quote: the nested `unlock` reverts
`AlreadyUnlocked`. To let `SafeSettle` price a push on-chain we wrote a second implementation, a view
walk over the tick bitmap (`depthToMove`, `depthBetween`), and pinned it to the exact simulation in
tests (within 0.1 %). The quoter docs could say this outright and point to a view alternative.

### 3. Reading the tick bitmap from outside: a word at a time, but no search from a tick

"Next initialized tick from here, in this direction" is the core of every depth or cost calculation. v4-core's
`TickBitmap.nextInitializedTickWithinOneWord` only works on a storage mapping the caller owns. v4-periphery's
`ReservesLens` (merged 2026-07-13) now exposes `getPopulatedTicksInWord(manager, key, wordPos)`, the v4
`TickLens`: every populated tick in one word. What it does not offer is the directional search from a given
tick. We re-implemented that over `extsload`
([`src/libraries/TickBitmapView.sol`](archive/hakari-v1/src/libraries/TickBitmapView.sol), ~30 lines that mirror `TickBitmap` bit
for bit; checked against a forge fixture and a TypeScript port). We missed `ReservesLens` at first because we
built against an older periphery. A `nextInitializedTickWithinOneWord(manager, poolId, tick, tickSpacing, lte)`
beside it would save every quoter, depth tool and simulator from writing the search again.

### 4. A view over pool state can be gamed inside an unlock

`SafeSettle` reads the pool's liquidity through `StateLibrary` to price a fake. An attacker who holds
the unlock can add a huge position, call the consumer while the wall is up, and remove it before the
unlock ends: the cost to fake looks enormous and the manipulated price is trusted. We only saw this in
review. The fix was one line with `TransientStateLibrary.isUnlocked` (refuse to answer while the
manager is unlocked; `test/SafeSettle.t.sol` `test_settle_fromInsideAnUnlock_reverts`). We found no
security note on this for `StateView` / `StateLibrary` consumers. One would help: "anything you read
from pool state inside someone else's unlock may be transient."

### 5. Protocol fees are on for pools on Robinhood Chain, and nothing surfaces it

`slot0.protocolFee` is `2048500` on TSLA/USDG and NVDA/USDG (500 pips each way) and `4097000` on
HIMS/USDG (1000 pips each way). The effective swap fee is therefore 3,499 pips on a "0.3 %" pool and
9,991 on a "0.9 %" pool. The `Swap` event's `fee` field shows it; the deployments page, the fee tier in
the key and the explorers do not. The real fee is ~17 % above `key.fee`, so anyone estimating slippage or
attack cost from `key.fee` on this chain is ~14 % low on a "0.3 %" pool (~10 % on "0.9 %"). `PushCostLens` folds the protocol fee in the way `Pool.swap` does
(`ProtocolFeeLibrary.calculateSwapFee`); it took reading `Pool.sol` to know that was needed. A
per-chain "protocol fee: on, X pips" note would help.

### 6. `BaseOracleHook`: reading the truncated TWAP is itself a truncation step

OpenZeppelin `uniswap-hooks` `BaseOracleHook` (Panoptic's design). `observe()` transforms the last
stored observation to `now` before answering, and that transform is clipped by `maxAbsTickDelta` like
a stored one. So after a push the truncated TWAP a consumer reads is one Δ further along than the
last *written* truncated tick: an attacker gets "pokes + 1" steps, not "pokes". We found it with a
failing test that expected `before + Δ` and got `before + 2Δ` (`test/HakariOracleHook.t.sol`). It is
the right behaviour for an extrapolated observation, but the `observe` docs should say so; a "max Δ
per second" mental model is off by one.

### 7. The truncated-oracle family has no "both series" read

`BaseOracleHook.observe` already returns the raw and truncated cumulatives side by side. Every adapter we
found (`V3TruncatedOracleAdapter`, `OracleHookWithV3Adapters`) exposes one series in a v3-shaped interface.
`HakariOracleHook.twaps(id, window)` is a 12-line wrapper returning both TWAP ticks. What the pair tells
you is narrower than we first thought: a gap means a push is still in flight, but agreement proves
nothing, because a push held with one dust swap a second catches the truncated series up and both then
agree on the fake. Our first rule chose between the series by their gap and was beaten that way in review;
`SafeSettle` now prices the gap as one more move a faker would pay for and decides on the pool's depth
(README § What the review found). Worth a first-class getter, and a sentence in the docs saying what the
gap does and does not tell you.

### 8. The v4 deployments page does not list Robinhood Chain testnet (46630)

The page lists 4663. Testnet 46630 has the same PoolManager, StateView, Quoter, PositionManager and
Permit2 at the same addresses (checked with `eth_getCode`: PoolManager, StateView and V4Quoter runtime code
is byte-identical; PositionManager and Permit2 differ only in their chain-id / EIP-712 domain-separator
immutables), but nothing on the page says so. A one-line "testnet: same addresses" note would have saved the
probing.

### 9. Worth documenting: a lens needs no deployment

Because `PushCostLens` answers by reverting inside `unlock`, it never needs to exist on-chain to be
used. We inject its runtime code with an `eth_call` state override (`{address: {code}}`) and ask
mainnet pools directly, from Node and from the browser (`gauge/src/lens.ts`, `web/app.js`). That
turns "deploy a quoter to every chain" into "ship bytecode", and it lets anyone measure a chain they
cannot or should not write to. A paragraph in the quoter docs would spread the pattern.

### 10. A v4 pool has no oracle unless it was created with one

A v3 pool carried `observe()`. A v4 pool has a TWAP only if its creator attached an oracle hook, and the
hook is part of the `PoolKey`, so a pool created without one can never gain it. On Robinhood Chain, 26 of
the 28 deepest stock-token pools have no hook at all; the other two (GLD, AMZN) are dynamic-fee pools
whose hooks carry the `beforeInitialize` and `beforeSwap` flags
([`gauge/data/stock-pools.json`](archive/hakari-v1/gauge/data/stock-pools.json)). For the 26, the only on-chain price is
`slot0`, the spot price one transaction can move (`test/demo/ThreeLayers.t.sol`, layer 1), unless someone
creates a second pool with an oracle hook and it attracts liquidity of its own. That is why HAKARI's hook
sits on a new pool, and why its HIMS replay is counterfactual: the real HIMS pool could never have had
it. Nothing we read at pool creation said that choosing no hook means no manipulation-resistant price,
ever. A sentence where pools are created, and a reference oracle hook per chain that creators can pick,
would help.

### 11. A dynamic-fee pool's stored fee is 0: a view reader cannot know what a swap will pay

The live board (`web/live/`) prices every stock pool each minute with a view walk, as `SafeSettle` does. On the
two dynamic-fee pools among them, GLD/USDG and AMZN/USDG (`fee = 0x800000`), `StateView.getSlot0` returns
`protocolFee = 0, lpFee = 0` (read 2026-09-26), while their last swaps paid 6,000 and 3,450 pips (the `Swap`
event's `fee`). So the walk prices a push there at zero fees and `SafeSettle`'s bound reads 0: it refuses every
settlement. That is conservative, but it is not a measurement. The fee a swap will pay lives in the hook's
`beforeSwap`, and only an exact quote (a swap inside `unlock`, the `quotePush` path) sees it. What we did: the
board labels the two pools "dynamic fee: not compared" instead of showing a collapse, and README § Limitations
says view mode sees stored fees only. What would help: a view convention for dynamic-fee hooks (the fee they would
charge for given swap parameters), or a line in the StateView docs that `lpFee` means nothing on a `0x800000` pool.

### 12. An observation credits its tick to the whole span since the previous one: a quiet window reads the swap before it

`Oracle.write` (OpenZeppelin `uniswap-hooks`, Panoptic's design, the same as Uniswap v3) stores at time `t` the
tick that stood since the previous observation, multiplied by the seconds it stood. That is correct: between two
swaps only one price stands. The trap is what it means for a window: a fix window with no swap inside it is priced
entirely by the last swap before it opened, whether it is read while still open (the record is extrapolated with
the live tick) or after a later swap has written the span into storage. A push one second before the window, and
nothing until one second after it, is what the window reads (`test/HakariOracleHook.t.sol`
`test_observe_aPushBeforeAQuietWindow_isWhatTheWindowReads`). On our own venue 31 of the 39 fix windows that
carried exposure had no swap inside them (README § A second consumer).

We hit this the night before submission, reviewing a rule we then dropped: a clamp of the fix window to a
trailing reference, applied where the hook writes. Any rule keyed on *when an observation is written* can be
skipped by not swapping; a window rule has to segment the stored record at the window's own boundaries when it
reads, and treat the extrapolated tail the same way. Found in the design review, then reproduced with the test.
What would help: one sentence in the `observe` / `BaseOracleHook` docs saying that an observation prices the whole
span back to the previous one, and that a window containing no observation is priced by the swap that preceded it.

## Background research, not re-checked during the build

The following note predates the integration work. It is retained for traceability, not presented as a newly
verified problem with the current upstream documentation.

### 21. From our research before building (not re-checked during the build)

`https://developers.uniswap.org/llms-full.txt` omits Robinhood Chain and says UniswapX V3 is on Arbitrum only, while
the live supported-chains page lists 4663; coding agents read that file first. The v4 deployments page labels
`0x8876…0904` on 4663 just "Universal Router", while the API page says Robinhood has no 2.0 deployment, so an
integrator cannot tell which swap encoding it expects. And the same-address Permit2 and Universal Router have
different code hashes on 46630 and 4663 (Permit2's differ only by its cached chain id, confirmed through
`DOMAIN_SEPARATOR`); a one-line note would save integrators a scare.
