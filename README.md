# HAKARI (秤) — what it costs to fake a price

**A Uniswap v4 price is only as trustworthy as it is expensive to fake.** HAKARI measures that cost for
any v4 pool, keeps the raw and the truncated TWAP side by side in a hook, and settles on the raw price
only when faking it would cost an attacker more than it would earn them.

![HIMS/USDG on Sunday 2026-08-30: pool price vs the NYSE close, and the cost to push it 10 %](docs/img/hims-weekend.svg)

Sunday 2026-08-30 was Robinhood Chain's busiest day ever: $270.6M of stock-token volume
([SQD](https://sqd.dev/learn/robinhood-stock-token-volume/)). It was also a day when no stock token can be
minted or redeemed, so nobody could arbitrage. By 23:53 UTC, with minting still closed, pushing the HIMS/USDG
v4 pool 10 % higher cost **12 USDG** in fees (it had cost 1,351 four hours earlier). When minting reopened
the pool stood at **54.50 USDG**; the stock had closed Friday at **28.84**. Any lending market, perp or option
settling on that pool would have paid out on a fake price.

ETHGlobal Tokyo 2026 · Uniswap Foundation "Best Uniswap Stack Contribution" · MIT ·
[`FEEDBACK.md`](FEEDBACK.md) · spec [`SPEC.md`](SPEC.md) · prompts [`docs/prompts/`](docs/prompts/)

## What it is

| Piece | What it does | Where |
|---|---|---|
| **`PushCostLens`** | What it costs to push any v4 pool to a price and sell straight back. **Exact mode** runs real swaps to a price limit inside `unlock` and reverts with the answer (the V4Quoter pattern, with a price limit V4Quoter lacks). **View mode** walks the tick bitmap through `StateLibrary`, from any starting price, so a contract already inside an unlock can still ask. Needs no deployment: inject its bytecode with an `eth_call` state override. | [`src/PushCostLens.sol`](src/PushCostLens.sol) |
| **`HakariOracleHook`** | OpenZeppelin's truncated oracle hook plus `twaps()`: the raw **and** truncated TWAP in one call. Records before the first swap of each second, so a push undone in the same transaction is never seen. | [`src/HakariOracleHook.sol`](src/HakariOracleHook.sol) |
| **`SafeSettle`** | A demo settlement rule. Raw ≈ truncated → raw. Otherwise price the fake with the lens, from the truncated price to where the pool was held: cost > gain → a genuine move, settle raw; cost ≤ gain → settle truncated. Emits `Settled(id, raw, trunc, usedRaw, cost, gain)`. | [`src/SafeSettle.sol`](src/SafeSettle.sol), [`src/CostModel.sol`](src/CostModel.sol) |
| **Gauge** (TypeScript) | Live cost ladder, Δ calibration from `Swap` events, any past weekend rebuilt from `ModifyLiquidity` logs, the Robinhood mint-window flag. | [`gauge/`](gauge/), data in [`gauge/data/`](gauge/data/) |
| **Web page** | Paste any pool → live cost to push it, fenced or not, suggested Δ. HIMS replay, every stock pool over a weekend, SafeSettle's decisions. | [`web/`](web/) — `python3 -m http.server 8790 --bind 127.0.0.1`, open <http://localhost:8790/web/> |

### Why not just truncate the oracle?

Truncation (Panoptic's design: each observation moves at most Δ ticks) blocks a sustained push. It also
lags in a genuine crash, and then honest holders are settled on a stale price. That is why some protocols
turn it off. HAKARI keeps both series and decides per settlement, using what a fake would cost right now.

The same push on the same TSLA-shaped pool gives opposite answers depending on the world. We hold +5 % for
a 10-second window on a 100,000 USDG settlement ([`test/fork/ShadowPool.fork.t.sol`](test/fork/ShadowPool.fork.t.sol),
block 72,308,997):

| | Faking costs | Faking earns | SafeSettle uses |
|---|---|---|---|
| Weekend: nobody can arbitrage | 2,070 USDG | 4,801 USDG | **truncated** (don't pay on it) |
| Weekday: arbitrage pulls back every 5 s | 5,070 USDG | 4,801 USDG | **raw** (a real move; truncation would only lag) |

## Where the Uniswap integration is

Everything runs against the **official v4 PoolManager** `0x8366a39CC670B4001A1121B8F6A443A643e40951`
(same address on Robinhood Chain 4663 and testnet 46630). Links are pinned to commit `fced71c`.

| What | Code |
|---|---|
| `PoolManager.unlock` → `unlockCallback`, reverting with the result | [`PushCostLens.sol#L85`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/PushCostLens.sol#L85), [`#L104`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/PushCostLens.sol#L104) |
| Push leg: `poolManager.swap` to a `sqrtPriceLimitX96`, `BalanceDelta` read | [`PushCostLens.sol#L114`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/PushCostLens.sol#L114) |
| Return leg: sell exactly what came out | [`PushCostLens.sol#L125`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/PushCostLens.sol#L125) |
| Push to an exact price | [`PushCostLens.sol#L76`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/PushCostLens.sol#L76) |
| View walk over `StateLibrary` (`getSlot0`, `getLiquidity`, `getTickBitmap`, `getTickLiquidity`), protocol fee folded in as `Pool.swap` does | [`PushCostLens.sol#L179`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/PushCostLens.sol#L179), [`#L267`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/PushCostLens.sol#L267), [`TickBitmapView.sol#L14`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/libraries/TickBitmapView.sol#L14) |
| Walk from any price (the honest one), through the liquidity as it is now | [`PushCostLens.sol#L197`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/PushCostLens.sol#L197), [`#L231`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/PushCostLens.sol#L231) |
| `BaseOracleHook.observe` → both TWAPs | [`HakariOracleHook.sol#L24`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/HakariOracleHook.sol#L24) |
| Refuse to answer inside an unlock (`TransientStateLibrary.isUnlocked`) | [`SafeSettle.sol#L67`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/SafeSettle.sol#L67) |
| The decision: cost to fake vs gain if faked | [`SafeSettle.sol#L78-L83`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/SafeSettle.sol#L78-L83), [`CostModel.sol#L27`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/CostModel.sol#L27), [`#L60`](https://github.com/vexi-v1/vexi-hakari/blob/fced71c0a05eabd9f6f5fcbca50df165224759b8/src/CostModel.sol#L60) |
| Hook salt mined against the CREATE2 proxy for the `0x1080` flag bits | [`script/Deploy.s.sol`](script/Deploy.s.sol) |

### On-chain, testnet 46630 (sources verified on the explorer)

Lens and hook deployed from commit `798ab19`, `SafeSettle` from `fced71c` (the `src/` the links above point
to), all by the project wallet `0x51E4EfE117e8Baf023dab3B7Cb5380DF1d378DF1`. Explorer:
<https://explorer.testnet.chain.robinhood.com>.

| Contract | Address | Deploy tx |
|---|---|---|
| `PushCostLens` | [`0x4E73CcC9Aed21FFBf3F69d9Dd92f9F33F39669E5`](https://explorer.testnet.chain.robinhood.com/address/0x4E73CcC9Aed21FFBf3F69d9Dd92f9F33F39669E5) | [`0x85288ca1…d5d6`](https://explorer.testnet.chain.robinhood.com/tx/0x85288ca13826577622afa4177ab3335b8e5a0e9e0de13af39495ed534d99d5d6) |
| `HakariOracleHook` (Δ = 250) | [`0x3b58D774cE351227B24A91103b20bA4fc068D080`](https://explorer.testnet.chain.robinhood.com/address/0x3b58D774cE351227B24A91103b20bA4fc068D080) | [`0xf591433a…8d50`](https://explorer.testnet.chain.robinhood.com/tx/0xf591433a7322099962a117b9ebad9a0671f9dc36dcb7e323b035aacfaa538d50) |
| `SafeSettle` | [`0x8191E93066CE93ca6D6bf338D31e32A655CD6f44`](https://explorer.testnet.chain.robinhood.com/address/0x8191E93066CE93ca6D6bf338D31e32A655CD6f44) | [`0x82d1043c…9296`](https://explorer.testnet.chain.robinhood.com/tx/0x82d1043c10f3573d4c0dc88875006587a8a11c9b47bb3bcc785ee08b399f9296) |

**The whole loop, in public.** [`script/DemoPool.s.sol`](script/DemoPool.s.sol) creates a pool with the hook
on the official PoolManager (id `0xe454eb2b3746dce8cff428120140f68ff83ae5aff586e358c940da5e8a71306c`), adds a
thin book, pushes the price +35 % and keeps it there with small swaps. A minute later
[`script/DemoSettle.s.sol`](script/DemoSettle.s.sol) calls `SafeSettle.settle` with a 60-second window and a
1,000,000-token notional:
[tx `0x8a18e030…7471`](https://explorer.testnet.chain.robinhood.com/tx/0x8a18e030d29caf64970c843ca73483dfd7bcd656bbebe4bbd3ac200b81c27471)
emits `Settled` with raw tick 3000, truncated 1250, cost to fake 5.6 × 10¹¹ wei, gain 1.9 × 10²³ wei →
settled on the truncated price. Decode it yourself:

```bash
cast receipt 0x8a18e030d29caf64970c843ca73483dfd7bcd656bbebe4bbd3ac200b81c27471 --rpc-url https://rpc.testnet.chain.robinhood.com/rpc --json | jq -r '.logs[0].data' | xargs cast abi-decode --input 'Settled(int24,int24,bool,uint256,uint256)'
```

On mainnet 4663 we write nothing: the lens runs there by state override
([`gauge/src/lens.ts`](gauge/src/lens.ts), [`web/app.js`](web/app.js)).

## Numbers

**The lens against a real pool.** On a 4663 fork at block 72,308,997, buying 10 TSLA and selling them back
in one unlock nets −25.885799 USDG; the lens pushed to the exact price that buy reached reports 25.885799
USDG for 10.000000 TSLA ([`test/fork/PushCostLens.fork.t.sol`](test/fork/PushCostLens.fork.t.sol)). The fork
follows the chain head, because the public RPC does not keep old state, so the test asserts agreement
within 0.1 % rather than a fixed figure. Output saved in [`docs/demo-outputs/`](docs/demo-outputs/).

**The HIMS weekend**, rebuilt from 1,998 `ModifyLiquidity` logs. At every point the rebuilt active liquidity
equals the last `Swap` event's own `liquidity` field ([`gauge/data/hims-replay.json`](gauge/data/hims-replay.json)):

| Block | Time (UTC) | Mint window | USDG/HIMS | HIMS in pool | Cost to push +10 % |
|---|---|---|---|---|---|
| 50,265,277 | Sun 19:40 | closed | 29.38 | 2,606 | 1,351 USDG |
| 50,415,299 | Sun 23:53 | closed | 43.27 | 67 | **12 USDG** |
| 50,444,948 | Mon 00:43 (last block before the first mint, #50,444,949) | open | 54.50 | 32 | 13 USDG |
| 50,490,000 | Mon 01:59 | open | 29.31 | 2,036 | 867 USDG |
| 50,772,447 | Mon 09:54 | open | 29.48 | 2,567 | 1,307 USDG |

**Cost ladder**, mainnet 4663, block 72,241,051 ([`gauge/data/ladder.json`](gauge/data/ladder.json)). Pushing
the stock *up*; fees lost / capital needed, in USDG:

| Pool | Price | +1 % | +5 % | +10 % |
|---|---|---|---|---|
| TSLA/USDG | 381.30 | 503 / 72,174 | 1,275 / 183,977 | 1,487 / 215,284 |
| NVDA/USDG | 225.91 | 273 / 39,119 | 1,280 / 185,401 | 2,013 / 293,857 |
| HIMS/USDG | 29.36 | 170 / 8,560 | 723 / 36,765 | 1,143 / 58,607 |

The "0.3 %" pools on this chain charge 0.35 %: the protocol fee is on (`FEEDBACK.md` § 5).

**Δ calibration**: p99 tick move between consecutive swap blocks over the 300k blocks up to
72,241,326 ([`gauge/data/delta.json`](gauge/data/delta.json)): TSLA 3, NVDA 10, HIMS 10, AI memecoin 193. One hook
carries one Δ, so a stock-grade and a memecoin-grade hook are two deployments.

## The three layers, as tests

`forge test --match-contract ThreeLayers -vv` ([`test/demo/ThreeLayers.t.sol`](test/demo/ThreeLayers.t.sol)):

1. **An atomic push fools `slot0`, not the hook.** A naive consumer settles on tick 499 after a 500-tick push
   undone in the same transaction; both of the hook's series read the honest tick, −1.
2. **A sustained push on a thin pool → settle truncated.** Raw TWAP 3000, truncated 650; faking it cost
   7.3 × 10¹¹ wei against a 2.6 × 10¹⁷ wei gain.
3. **A genuine surge on a deep pool → settle raw.** Raw 1650, truncated 550; faking it would cost
   1.0 × 10¹⁸ wei against a 1.2 × 10¹⁷ wei gain, so truncation would only lag.

The atomic case is not hypothetical. On our own options venue on testnet 46630 (Vexi), a push-trade-push
earned +87 bps per contract after fees. That measurement is not reproduced in this repo; layer 1 is the
in-repo evidence.

## Limitations

- **The cost is a lower bound only when nobody arbitrages** (`arbReversionSeconds = 0`): fees on an exact
  retrace through the liquidity the pool has at settlement. With arbitrage open, the holding cost is only as
  good as the reversion time the caller asserts; a faster one than the market delivers overstates the cost
  and makes the raw price look safer. Pass a slow, measured bound. That input, and the mint-window flag, are
  where `SafeSettle` trusts an off-chain gauge.
- **A liquidity wall held across blocks** inflates the cost to fake. `SafeSettle` refuses to answer inside an
  unlock, which stops the free version (add, ask, remove in one transaction). A wall that stays for real
  exposes its capital to every trader while it stands, but this is not stopped.
- **The honest reference is the truncated TWAP**, which itself drifts toward a held push, Δ per observation.
  Pricing from it understates the cost, which is the safe direction.
- **Just-in-time liquidity across blocks.** The cost is read from the liquidity present at settlement; the hook
  keeps no liquidity history. v1: have the hook record time-weighted liquidity (new flags, new salt, new pool).
- **View mode sees stored fees only.** `depthToMove` / `roundTripCost` fold in the LP and protocol fee from
  `slot0`; hook-taken charges and per-swap fee overrides appear only in the exact `quotePush`. Measured in
  review on BONER/HIMS (dynamic fee, hooked): view ≈ 0.066 × exact.
- **Caller inputs.** `window`, `notional`, the quote side and `arbReversionSeconds` come from the integrator,
  and `settle` is permissionless: a `Settled` log is only as meaningful as the caller who emitted it.
- **One Δ per hook**, fixed at deployment, and the hook only covers pools created with it. The walk is capped
  (`MAX_WALK_STEPS`); past the cap the cost is reported as "at least this".
- **`SafeSettle` is a demo rule**, not a product. The contribution is the measurement and the two-series
  hook; the rule is meant to be replaced.

## Prior art

| Work | What it did | What HAKARI adds |
|---|---|---|
| [Chaos Labs, TWAP manipulation research](https://chaoslabs.xyz/posts/chaos-labs-uniswap-v3-twap-oracles) (Uniswap Foundation grant, Jan 2023) | An off-chain tool to simulate manipulating Uniswap v3 TWAP oracles | v4; the cost as an on-chain call and as a zero-deploy `eth_call`; tied to a settlement decision |
| [Euler, `uni-v3-twap-manipulation`](https://github.com/euler-xyz/uni-v3-twap-manipulation) | Cost-of-attack for v3 TWAPs, behind Euler's oracle risk grades | v4 pools, per settlement, with the arbitrage state as an input |
| [Uniswap, "Uniswap v3 TWAP Oracles in Proof of Stake"](https://blog.uniswap.org/uniswap-v3-oracles) (Oct 2022) | Multi-block manipulation cost for major pairs | The same question for thin pools whose arbitrage switches off on a schedule |
| Panoptic's truncated oracle, OpenZeppelin `BaseOracleHook` | Clip each observation to ±Δ | We build on it: both series exposed, Δ calibrated per pool, the choice between them priced |
| `V4Quoter` | Quote a swap by amount via unlock + revert | The same pattern to a price limit, plus a view path for callers already inside an unlock |

What is new here is the combination on v4, and a measured case: the stock-token weekend, when the cost of
faking a price falls by two orders of magnitude on a schedule anyone can read.

## Run it

```bash
git clone --recurse-submodules https://github.com/vexi-v1/vexi-hakari && cd vexi-hakari
forge test --no-match-path 'test/fork/*'          # 33 tests, no RPC
forge test --match-path 'test/fork/*' -vv         # real pools on a 4663 fork (public RPC, ~4 min)
cd gauge && npm ci && npm test                    # 17 tests: the TS math port is pinned to the Solidity walk
npm run discover                                  # the deepest USDG pool of 30 stock tokens
npm run weekend -- 2026-09-18                     # rebuild a weekend for every one of them
npm run hims && npm run ladder && npm run calibrate && npm run charts
```

`.env.example` lists the variables. The gauge rotates across every mainnet RPC you list and checks each one
answers chain 4663. Some tests rewrite files under `web/decisions/` and `test/fixtures/`.

## Provenance

Built during the hackathon, from the first commit onward. Public libraries unchanged: Uniswap `v4-core`
@ `d153b048`, OpenZeppelin `uniswap-hooks` @ `acbd604`, `forge-std` @ `bf647bd`, `viem`. We brought in
knowledge, not code: the HIMS weekend was first traced in our own pre-hackathon research on the same chain.
The numbers above are re-derived here by a new collector, and they match. The atomic-push figure comes from
our other project, Vexi; none of its code is here. An earlier testnet deployment (commit `bb1cf1a`, a shared
deployer wallet) is superseded and kept for the record in `deployments/46630-bb1cf1a-superseded.json`; so is
the first `SafeSettle` from `798ab19` (`0x64890652…B150`), replaced after the currency0 gain fix.

## AI disclosure

Most of the code, tests and docs here were written by an AI agent (Claude Code), test-first, directed by one
human. The human wrote the spec ([`docs/prompts/2026-09-25-spec-zh.md`](docs/prompts/2026-09-25-spec-zh.md),
translated as `SPEC.md`), made every decision in [`docs/prompts/log.md`](docs/prompts/log.md), and ordered an
internal review whose fixes are in the history. The pace of the commit history is the agent's.

## Next

- Measure the arbitrage reversion time per pool from the `Swap` stream, instead of taking it as an input.
- `n_max`: the largest open interest a venue can safely write against a pool, straight from the ladder.
- Upstream: a `StateLibrary` tick walker and a two-series oracle getter (`FEEDBACK.md` § 3, § 7).
