# FEEDBACK.md — friction met while building on the Uniswap stack

ETHGlobal Tokyo 2026 · HAKARI · Uniswap Foundation "Best Uniswap Stack Contribution".
Only things we actually ran into, in the order we hit them. Each entry says what we tried
and what finally worked, so the Foundation can reproduce it.

Chain context: Robinhood Chain mainnet (4663, read-only for us) and testnet (46630), both
with the official v4 PoolManager at `0x8366a39CC670B4001A1121B8F6A443A643e40951`.

## 1. The v4 deployments page does not list Robinhood Chain testnet (46630)

`developers.uniswap.org/docs/protocols/v4/deployments` lists Robinhood Chain 4663. The
testnet 46630 has the same PoolManager, StateView, Quoter, PositionManager and Permit2 at
the same addresses (checked with `eth_getCode`, bytecode hash equal), but nothing on the
page says so. We found it by probing the mainnet addresses on the testnet RPC. A one-line
"testnet: same addresses" note would have saved the probing. (H0)

## 2. `eth_call` state override works on the Robinhood RPC — a lens needs no deployment

`https://rpc.mainnet.chain.robinhood.com` accepts the geth-style third `eth_call` argument
(`{address: {code: ...}}`). That let us run `PushCostLens` against *live mainnet pools*
without deploying anything to a chain we are not allowed to write to. This is worth a
paragraph in the v4 docs for anyone building read-only tooling: a quoter-style contract
that reverts with its result can be injected per call. (H0, discovered while planning the
gauge.)

## 3. `eth_getLogs` on the public RPC times out above a few hundred thousand blocks

A single `Swap`/`ModifyLiquidity` filter over ~900k blocks returns `log query timed out`
(-32000). 100k-block windows work. Nothing in the error says what the cap is. (H0)

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
one. (H2)

## 5. Protocol fees are switched on for pools on Robinhood Chain, and nothing tells you

`slot0.protocolFee` is `2048500` on TSLA/USDG and NVDA/USDG (500 pips each way) and `4097000` on
HIMS/USDG (1000 pips each way). The effective swap fee is therefore 3,498 pips on a "0.3 %" pool
and 9,991 on a "0.9 %" pool. The `Swap` event's `fee` field shows it; the deployments page, the
pool explorers and the fee tier in the key do not. Anyone estimating slippage or attack cost from
`key.fee` on this chain is ~17 % low. `PushCostLens.depthToMove` folds the protocol fee in the way
`Pool.swap` does (`ProtocolFeeLibrary.calculateSwapFee`); it took reading `Pool.sol` to know that
was needed. A note on the deployments page per chain ("protocol fee: on, X pips") would help. (H2)
