# FEEDBACK.md — friction met while building on the Uniswap stack

ETHGlobal Tokyo 2026 · HAKARI · Uniswap Foundation "Best Uniswap Stack Contribution".
Only things we actually ran into, in the order we hit them. Each entry says what we tried
and what finally worked, so the Foundation can reproduce it.

Chain context: Robinhood Chain mainnet (4663, read-only for us) and testnet (46630), both
with the official v4 PoolManager at `0x8366a39CC670B4001A1121B8F6A443A643e40951`.

## 1. The v4 deployments page does not list Robinhood Chain testnet (46630)

`developers.uniswap.org/docs/protocols/v4/deployments` lists Robinhood Chain 4663. The
testnet 46630 has the same PoolManager, StateView, Quoter, PositionManager and Permit2 at
the same addresses (checked with `eth_getCode`: PoolManager, StateView and V4Quoter runtime code is
byte-identical; PositionManager and Permit2 differ only in their chain-id / EIP-712
domain-separator immutables), but nothing on the
page says so. We found it by probing the mainnet addresses on the testnet RPC. A one-line
"testnet: same addresses" note would have saved the probing. (First hit in our pre-hackathon
research on 2026-09-23, re-checked at H0; logged 21:29 JST.)

## 2. `eth_call` state override works on the Robinhood RPC — a lens needs no deployment

`https://rpc.mainnet.chain.robinhood.com` accepts the geth-style third `eth_call` argument
(`{address: {code: ...}}`). That let us run `PushCostLens` against *live mainnet pools*
without deploying anything to a chain we are not allowed to write to. This is worth a
paragraph in the v4 docs for anyone building read-only tooling: a quoter-style contract
that reverts with its result can be injected per call. (Found while planning the gauge;
logged 21:29 JST.)

## 3. `eth_getLogs` on the public RPC times out above a few hundred thousand blocks

A single `Swap`/`ModifyLiquidity` filter over ~900k blocks returns `log query timed out`
(-32000). 100k-block windows work. Nothing in the error says what the cap is. (First hit in our
pre-hackathon research on 2026-09-25, before H0; re-checked for the gauge; logged 21:29 JST.)

_(more entries are appended below as they happen)_

## 4. `BaseOracleHook`: reading the truncated TWAP is itself a truncation step

OpenZeppelin `uniswap-hooks` `BaseOracleHook` (Panoptic's design). `observe()` transforms the last
stored observation to `now` before answering, and that transform is clipped by `maxAbsTickDelta`
like a stored one. So after a push, the truncated TWAP a consumer reads is one Δ further along
than the last *written* truncated tick, and the number of Δ-steps an attacker gets is "pokes +
1", not "pokes". We found it with a failing test that expected `before + Δ` and got `before + 2Δ`
(`test/HakariOracleHook.t.sol`). Neither the OZ docs nor the Panoptic write-up says the read
counts as a step. Not a bug — it is the right behaviour for an extrapolated observation — but the
documentation for `observe` should say it, because a "max Δ per second" mental model is off by
one. (Logged 21:50 JST.)

## 5. Protocol fees are switched on for pools on Robinhood Chain, and nothing tells you

`slot0.protocolFee` is `2048500` on TSLA/USDG and NVDA/USDG (500 pips each way) and `4097000` on
HIMS/USDG (1000 pips each way). The effective swap fee is therefore 3,498 pips on a "0.3 %" pool
and 9,991 on a "0.9 %" pool. The `Swap` event's `fee` field shows it; the deployments page, the
pool explorers and the fee tier in the key do not. Anyone estimating slippage or attack cost from
`key.fee` on this chain is ~17 % low. `PushCostLens.depthToMove` folds the protocol fee in the way
`Pool.swap` does (`ProtocolFeeLibrary.calculateSwapFee`); it took reading `Pool.sol` to know that
was needed. A note on the deployments page per chain ("protocol fee: on, X pips") would help. (Logged 21:50 JST.)

## 6. `StateLibrary` reads the tick bitmap but nothing walks it

To price a push from *outside* a pool (a view, callable from inside someone else's unlock, and
from a historical reconstruction) we needed "next initialized tick from here". v4-core's
`TickBitmap.nextInitializedTickWithinOneWord` only works on a storage mapping the caller owns;
`StateLibrary` exposes `getTickBitmap(poolId, wordPos)` but no walker over it, and `StateView`
in v4-periphery does not add one. We re-implemented the word walk over `extsload`
(`src/libraries/TickBitmapView.sol`, ~30 lines that mirror `TickBitmap` bit for bit). A
`StateLibrary.nextInitializedTickWithinOneWord(manager, poolId, tick, tickSpacing, lte)` would
save every quoter, liquidity-depth tool and simulator from doing this. (Logged 22:14 JST.)

## 7. The truncated-oracle family has no "both series" read

`BaseOracleHook.observe` already returns the raw and truncated cumulatives side by side, which
is exactly the signal a consumer needs to notice a push — but every downstream adapter we
found (`V3TruncatedOracleAdapter`, the `OracleHookWithV3Adapters` pair) exposes *one* series in
a v3-shaped interface. `HakariOracleHook.twaps(id, window)` is a 12-line wrapper that returns
both TWAP ticks; the interesting decisions (SPEC.md § 3.3) all start from their disagreement.
Worth a first-class getter in the library, and a sentence in the README saying the two series
are meant to be compared, not chosen between. (Logged 22:14 JST.)
