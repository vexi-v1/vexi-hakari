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
