# FEEDBACK.md — friction met while building on the Uniswap stack

ETHGlobal Tokyo 2026 · HAKARI · Uniswap Foundation "Best Uniswap Stack Contribution".
Only things we actually ran into while building this repo. Each entry says what we hit, what we did,
and what would have helped.

Chain context: Robinhood Chain mainnet (4663, read-only for us) and testnet (46630), both with the
official v4 PoolManager at `0x8366a39CC670B4001A1121B8F6A443A643e40951`.

## 1. V4Quoter quotes amounts; we needed to quote a price

The question HAKARI asks is "what does it cost to move this pool to price P and back?". `V4Quoter`'s
`QuoteExactSingleParams` is `{poolKey, zeroForOne, exactAmount, hookData}` — there is no
`sqrtPriceLimitX96`, so it cannot stop at a price. We re-implemented the same unlock → swap → revert
pattern with a price limit (`PushCostLens.quotePush`, `quotePushToPrice`,
[`src/PushCostLens.sol`](src/PushCostLens.sol)). An optional price limit on the quoter, or a
`quoteToPrice`, would serve every risk tool, liquidation bot and oracle checker that thinks in prices
rather than sizes.

## 2. Quoting is impossible from inside an unlock, so on-chain consumers need a second, view path

A contract that is itself running inside `PoolManager.unlock` (a hook, a router step, a settlement
inside a flash action) cannot call a V4Quoter-style quote: the nested `unlock` reverts
`AlreadyUnlocked`. To let `SafeSettle` price a push on-chain we wrote a second implementation, a view
walk over the tick bitmap (`depthToMove`, `depthBetween`), and pinned it to the exact simulation in
tests (within 0.1 %). The quoter docs could say this outright and point to a view alternative.

## 3. Reading the tick bitmap from outside: a word at a time, but no search from a tick

"Next initialized tick from here, in this direction" is the core of every depth or cost calculation. v4-core's
`TickBitmap.nextInitializedTickWithinOneWord` only works on a storage mapping the caller owns. v4-periphery's
`ReservesLens` (merged 2026-07-13) now exposes `getPopulatedTicksInWord(manager, key, wordPos)`, the v4
`TickLens`: every populated tick in one word. What it does not offer is the directional search from a given
tick. We re-implemented that over `extsload`
([`src/libraries/TickBitmapView.sol`](src/libraries/TickBitmapView.sol), ~30 lines that mirror `TickBitmap` bit
for bit; checked against a forge fixture and a TypeScript port). We missed `ReservesLens` at first because we
built against an older periphery. A `nextInitializedTickWithinOneWord(manager, poolId, tick, tickSpacing, lte)`
beside it would save every quoter, depth tool and simulator from writing the search again.

## 4. A view over pool state can be gamed inside an unlock

`SafeSettle` reads the pool's liquidity through `StateLibrary` to price a fake. An attacker who holds
the unlock can add a huge position, call the consumer while the wall is up, and remove it before the
unlock ends: the cost to fake looks enormous and the manipulated price is trusted. We only saw this in
review. The fix was one line with `TransientStateLibrary.isUnlocked` (refuse to answer while the
manager is unlocked; `test/SafeSettle.t.sol` `test_settle_fromInsideAnUnlock_reverts`). We found no
security note on this for `StateView` / `StateLibrary` consumers. One would help: "anything you read
from pool state inside someone else's unlock may be transient."

## 5. Protocol fees are on for pools on Robinhood Chain, and nothing surfaces it

`slot0.protocolFee` is `2048500` on TSLA/USDG and NVDA/USDG (500 pips each way) and `4097000` on
HIMS/USDG (1000 pips each way). The effective swap fee is therefore 3,499 pips on a "0.3 %" pool and
9,991 on a "0.9 %" pool. The `Swap` event's `fee` field shows it; the deployments page, the fee tier in
the key and the explorers do not. The real fee is ~17 % above `key.fee`, so anyone estimating slippage or
attack cost from `key.fee` on this chain is ~14 % low on a "0.3 %" pool (~10 % on "0.9 %"). `PushCostLens` folds the protocol fee in the way `Pool.swap` does
(`ProtocolFeeLibrary.calculateSwapFee`); it took reading `Pool.sol` to know that was needed. A
per-chain "protocol fee: on, X pips" note would help.

## 6. `BaseOracleHook`: reading the truncated TWAP is itself a truncation step

OpenZeppelin `uniswap-hooks` `BaseOracleHook` (Panoptic's design). `observe()` transforms the last
stored observation to `now` before answering, and that transform is clipped by `maxAbsTickDelta` like
a stored one. So after a push the truncated TWAP a consumer reads is one Δ further along than the
last *written* truncated tick: an attacker gets "pokes + 1" steps, not "pokes". We found it with a
failing test that expected `before + Δ` and got `before + 2Δ` (`test/HakariOracleHook.t.sol`). It is
the right behaviour for an extrapolated observation, but the `observe` docs should say so; a "max Δ
per second" mental model is off by one.

## 7. The truncated-oracle family has no "both series" read

`BaseOracleHook.observe` already returns the raw and truncated cumulatives side by side. Every adapter we
found (`V3TruncatedOracleAdapter`, `OracleHookWithV3Adapters`) exposes one series in a v3-shaped interface.
`HakariOracleHook.twaps(id, window)` is a 12-line wrapper returning both TWAP ticks. What the pair tells
you is narrower than we first thought: a gap means a push is still in flight, but agreement proves
nothing, because a push held with one dust swap a second catches the truncated series up and both then
agree on the fake. Our first rule chose between the series by their gap and was beaten that way in review;
`SafeSettle` now prices the gap as one more move a faker would pay for and decides on the pool's depth
(README § What the review found). Worth a first-class getter, and a sentence in the docs saying what the
gap does and does not tell you.

## 8. The v4 deployments page does not list Robinhood Chain testnet (46630)

The page lists 4663. Testnet 46630 has the same PoolManager, StateView, Quoter, PositionManager and
Permit2 at the same addresses (checked with `eth_getCode`: PoolManager, StateView and V4Quoter runtime code
is byte-identical; PositionManager and Permit2 differ only in their chain-id / EIP-712 domain-separator
immutables), but nothing on the page says so. A one-line "testnet: same addresses" note would have saved the
probing.

## 9. Worth documenting: a lens needs no deployment

Because `PushCostLens` answers by reverting inside `unlock`, it never needs to exist on-chain to be
used. We inject its runtime code with an `eth_call` state override (`{address: {code}}`) and ask
mainnet pools directly, from Node and from the browser (`gauge/src/lens.ts`, `web/app.js`). That
turns "deploy a quoter to every chain" into "ship bytecode", and it lets anyone measure a chain they
cannot or should not write to. A paragraph in the quoter docs would spread the pattern.

## 10. A v4 pool has no oracle unless it was created with one

A v3 pool carried `observe()`. A v4 pool has a TWAP only if its creator attached an oracle hook, and the
hook is part of the `PoolKey`, so a pool created without one can never gain it. On Robinhood Chain, 26 of
the 28 deepest stock-token pools have no hook at all; the other two (GLD, AMZN) are dynamic-fee pools
whose hooks carry the `beforeInitialize` and `beforeSwap` flags
([`gauge/data/stock-pools.json`](gauge/data/stock-pools.json)). For the 26, the only on-chain price is
`slot0`, the spot price one transaction can move (`test/demo/ThreeLayers.t.sol`, layer 1), unless someone
creates a second pool with an oracle hook and it attracts liquidity of its own. That is why HAKARI's hook
sits on a new pool, and why its HIMS replay is counterfactual: the real HIMS pool could never have had
it. Nothing we read at pool creation said that choosing no hook means no manipulation-resistant price,
ever. A sentence where pools are created, and a reference oracle hook per chain that creators can pick,
would help.
