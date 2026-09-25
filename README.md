# HAKARI (秤) — what it costs to fake a price

A scale for any protocol that reads a price from a Uniswap v4 pool: **can this price be pushed
right now, what would pushing it cost, and should the price be trusted?**

ETHGlobal Tokyo 2026 · Uniswap Foundation "Best Uniswap Stack Contribution" · MIT · Robinhood Chain.

- Spec: [`SPEC.md`](SPEC.md) · Friction log for the Foundation: [`FEEDBACK.md`](FEEDBACK.md) ·
  Prompts and planning artifacts: [`docs/prompts/`](docs/prompts/)
- Live gauge page: `python3 -m http.server 8790` from the repo root, then open
  <http://localhost:8790/web/> (static; talks to mainnet 4663 read-only from the browser)

## The problem in one table

Every protocol that settles on a v4 pool price — options, lending, perps, liquidations — assumes
the pool's price is real. Three ways it is not, all measured on Robinhood Chain:

| | What happens | Measured |
|---|---|---|
| **A. Atomic push** | Push the pool, settle against the pushed price, push back — one transaction, flash-loanable. | On our own options venue on testnet 46630 (Vexi): +87 bps per contract; +181.7 bps after 30 s of quiet. |
| **B. Sustained push** | Hold the pool off-price for the TWAP window. Without truncation one observation can jump arbitrarily far. | OpenZeppelin's `BaseOracleHook(2 * MAX_TICK)` = truncation off. |
| **C. Fenced pool** | Stock-token mint/redeem closes for the weekend; no arbitrageur can push back; float drains into one pool. | HIMS/USDG, Sunday 2026-08-30: **29.38 → 54.50 USDG** (NYSE close 28.84); cost to push +10 % fell from **1,351 USDG to 12 USDG**. |

Truncating the oracle (Panoptic-style, Δ ticks per observation) blocks B and C — and lags in a
genuine crash, cheating honest holders. That is a trade-off, not a bug. **HAKARI's answer:
trust a move if faking it would cost more than faking it would earn.**

## What we built

```
real v4 pool ──▶ PushCostLens ──▶ SafeSettle ──▶ settlement price + why
                     │                ▲
                     ▼                │
              gauge + web      HakariOracleHook (raw + truncated TWAP)
```

| Piece | What it does | Where |
|---|---|---|
| **`PushCostLens`** | What it costs to push any v4 pool by *x* ticks and sell back. Exact mode runs a real `swap` to a price limit inside `unlock` and reverts with the answer; view mode walks the tick bitmap through `StateLibrary`. Works on mainnet with an `eth_call` state override — no deployment. | [`src/PushCostLens.sol`](src/PushCostLens.sol) |
| **`HakariOracleHook`** | OpenZeppelin's truncated oracle hook + `twaps()` returning the raw **and** truncated TWAP side by side. `afterInitialize` + `beforeSwap` only, address bits `0x1080`. | [`src/HakariOracleHook.sol`](src/HakariOracleHook.sol) |
| **`SafeSettle`** + **`CostModel`** | Demo settlement rule: raw ≈ truncated → raw. Else price the fake with the lens; cost > gain → the move is genuine, settle raw; cost ≤ gain → settle truncated. Emits `Settled(id, raw, trunc, usedRaw, cost, gain)`. | [`src/SafeSettle.sol`](src/SafeSettle.sol), [`src/CostModel.sol`](src/CostModel.sol) |
| **Gauge** (TypeScript) | Mainnet cost ladder (1/5/10 % each way), Δ calibration from `Swap` events, the HIMS weekend rebuilt from `ModifyLiquidity` logs, Robinhood mint-window flag. | [`gauge/`](gauge/), data in [`gauge/data/`](gauge/data/) |
| **Web** | Paste a pool → live cost to push, fenced-or-not, suggested Δ; HIMS replay charts; SafeSettle's decision log. | [`web/`](web/) |

## Where the Uniswap integration is (for the auditors)

Everything runs against the **official v4 PoolManager** `0x8366a39CC670B4001A1121B8F6A443A643e40951`
(same address on Robinhood Chain 4663 and testnet 46630).

| What | File : line |
|---|---|
| `PoolManager.unlock` → `unlockCallback` (V4Quoter pattern) | [`src/PushCostLens.sol:71`](src/PushCostLens.sol#L71), [`:90`](src/PushCostLens.sol#L90) |
| Push leg: `poolManager.swap` with `sqrtPriceLimitX96` = target, `BalanceDelta` read | [`src/PushCostLens.sol:100`](src/PushCostLens.sol#L100) |
| Return leg: sell exactly `amountOut` back | [`src/PushCostLens.sol:111`](src/PushCostLens.sol#L111) |
| View walk over `StateLibrary` (`getSlot0`, `getLiquidity`, `getTickBitmap`, `getTickLiquidity`) with the protocol fee folded in as `Pool.swap` does | [`src/PushCostLens.sol:155`](src/PushCostLens.sol#L155), [`src/libraries/TickBitmapView.sol:14`](src/libraries/TickBitmapView.sol#L14) |
| `BaseOracleHook.observe` → both TWAPs | [`src/HakariOracleHook.sol:24`](src/HakariOracleHook.sol#L24) |
| The decision: cost to fake vs gain if faked | [`src/SafeSettle.sol:68`](src/SafeSettle.sol#L68)–[`:70`](src/SafeSettle.sol#L70), [`src/CostModel.sol:22`](src/CostModel.sol#L22), [`:50`](src/CostModel.sol#L50) |
| Hook salt mined against the CREATE2 proxy, deployed with `new{salt}` | [`script/Deploy.s.sol`](script/Deploy.s.sol) |

### Deployed on Robinhood Chain testnet 46630 (official PoolManager)

| Contract | Address | Tx |
|---|---|---|
| `PushCostLens` | `0x4fe982eBF315925D14bF11917fdad43400703d28` | `0x8485b16a308daae27e651eafa383e2e77bc8074dcd921de20002aca1ba4fec14` (block 124,119,984) |
| `HakariOracleHook` (Δ = 250) | `0xa953EA9E06937f4169cBc04032B947Dad0b15080` | `0x672889245468d99f4682c3ddc389839961a4289fe08760c401ec770c7ac90347` |
| `SafeSettle` | `0xBc1f6adB55eFD483abBc1e46e1F7dA6f34ea02e4` | `0x606b3b12daaf743ef12a331e65ca4e5298e02ebefbc187b7ee94af52280153bc` |

Record: [`deployments/46630.json`](deployments/46630.json); receipts:
[`broadcast/Deploy.s.sol/46630/run-latest.json`](broadcast/Deploy.s.sol/46630/run-latest.json).

**The whole loop, on-chain, in public** ([`script/DemoPool.s.sol`](script/DemoPool.s.sol) then
[`script/DemoSettle.s.sol`](script/DemoSettle.s.sol)): a pool with the hook attached on the official
PoolManager, pool id `0xc2c886c92ebabe4a0ed74dd65c0dff3fb01c4c1352053179cc9d6bfabcce108f`
(18 txs from `0x719fb003…8333da` to `0x940b02c2…ad69fd`, block 124,125,374), a +35 % push held
with pokes, then `SafeSettle.settle` in tx
`0x5dfc71837a834ac839a9a9d775013f6129f8a4d67066e32df373c09f9ad15441` (block 124,125,707) emitting
`Settled`: raw TWAP tick 3000, truncated 1158 (Δ = 250), cost to fake 6.4e11 vs gain 2.0e23
quote wei → settled on the truncated price. Receipts under `broadcast/DemoPool.s.sol/46630/` and
`broadcast/DemoSettle.s.sol/46630/`.
Mainnet 4663 is read-only for us; there the lens runs via `eth_call` state override
([`gauge/src/lens.ts`](gauge/src/lens.ts), [`web/app.js`](web/app.js)).

## Numbers

**Cost ladder, mainnet 4663, block 72,241,051** ([`gauge/data/ladder.json`](gauge/data/ladder.json)).
"Cost" = fees lost pushing and selling straight back; "capital" = the input the push needs.

| Pool | Price | +1 % cost / capital | +5 % cost / capital | +10 % cost / capital |
|---|---|---|---|---|
| TSLA/USDG | 381.30 | 503 / 72,174 USDG | 1,275 / 183,977 | 1,487 / 215,284 |
| NVDA/USDG | 225.91 | 273 / 39,119 | 1,280 / 185,401 | 2,013 / 293,857 |
| HIMS/USDG | 29.36 | 170 / 8,560 | 723 / 36,765 | 1,143 / 58,607 |
| AI/USDG (memecoin) | 0.238 | 3 / 59 | 13 / 250 | 24 / 471 |

Pushing TSLA 10 % needs barely more capital than pushing it 5 %: the book is concentrated near
the price and thin beyond. And every "0.3 %" pool here charges 0.35 %: the protocol fee is on
(`FEEDBACK.md` § 5).

**The HIMS weekend, rebuilt from 1,998 `ModifyLiquidity` logs**
([`gauge/data/hims-replay.json`](gauge/data/hims-replay.json); at all five points the rebuilt
active liquidity equals the last `Swap` event's `liquidity` field):

| Block | Time (UTC) | Mint window | USDG/HIMS | HIMS in pool | Cost to push +10 % |
|---|---|---|---|---|---|
| 50,265,277 | Sun 19:40 | closed | 29.38 | 2,606 | **1,351 USDG** |
| 50,415,299 | Sun 23:53 | closed | 43.27 | 67 | **12 USDG** |
| 50,444,948 | Mon 00:43 (first mint) | open | 54.50 | 32 | 13 USDG |
| 50,490,000 | Mon 01:59 | open | 29.31 | 2,036 | 867 USDG |
| 50,772,447 | Mon 09:54 | open | 29.48 | 2,567 | 1,307 USDG |

**Δ calibration** (p99 tick move between consecutive swap blocks, last 300k blocks,
[`gauge/data/delta.json`](gauge/data/delta.json)): TSLA 3, NVDA 10, HIMS 10, AI memecoin 193. One
hook carries one Δ; a stock-grade and a memecoin-grade hook are two deployments.

**Real-pool cross-check (G1).** On a 4663 fork at block 72,232,582, buying 10 TSLA and selling
them back in one unlock nets −26.73 USDG; the lens pushed to the same price reports 26.64 USDG
for 9.966 TSLA (tick granularity). Pre-hackathon figure at block 71,937,777: −26.56 USDG.
[`test/fork/PushCostLens.fork.t.sol`](test/fork/PushCostLens.fork.t.sol).

**The attack on a TSLA-shaped book.** A shadow pool on the official PoolManager (4663 fork) with
the real TSLA/USDG liquidity profile copied tick by tick and `HakariOracleHook` (Δ = 3) attached:
holding the price +5 % for a 10-second window ties up 183,885 USDG but *costs* 186 USDG on a
weekend (arbitrage closed) or 1,039 USDG on a weekday — against a 4,801 USDG gain on a 100,000
USDG settlement. `SafeSettle` settles truncated in both cases.
[`test/fork/ShadowPool.fork.t.sol`](test/fork/ShadowPool.fork.t.sol).

## The three layers, as tests

`forge test --match-contract ThreeLayers -vv` ([`test/demo/ThreeLayers.t.sol`](test/demo/ThreeLayers.t.sol)):

1. **Atomic push fools `slot0`, not the hook.** A naive consumer settles on tick 499 after a
   500-tick push undone in the same transaction; both of the hook's series read the honest tick.
   The observation is written *before* the swap, once per second.
2. **Sustained push on a thin pool → settle truncated.** Raw TWAP 3000, truncated 650; cost to
   fake 8.2e11 vs gain 2.6e17 (quote wei). Cheap to fake: do not pay on it.
3. **Genuine surge on a deep pool → settle raw.** Raw 1650, truncated 550; cost 3.2e18 > gain
   1.2e17. Truncation would only lag.

## Cost model v0 (and what it is not)

To move a `W`-second raw TWAP by `x` ticks the attacker holds the pool `d` ticks off-price for
`s` seconds with `d·s ≥ x·W`. `cost = roundTrip(d) + (arbOpen ? s × roundTrip(d) : 0)`: one
push, plus one re-push per second while arbitrageurs keep pulling it back. `roundTrip` counts
fees only (an exact retrace has no impact loss) and the walk is capped, so every figure is a
**lower bound** — the model errs on "cheap". `gain = notional × (1.0001^x − 1)`, delta ≈ 1.
`arbOpen` is the caller's statement about the world; the gauge derives it from Robinhood's
mint/redeem window (closed Sat 02:00 → Mon 02:00 Berlin time) and the asset API's
`tradingCapabilities`. This is a report plus a replaceable decision rule, not a guarantee.

## Run it

```bash
git clone --recurse-submodules https://github.com/vexi-v1/vexi-hakari && cd vexi-hakari
forge test                                   # 24 unit tests, no RPC
forge test --match-contract Fork -vv         # G1 on a 4663 fork (public RPC)
forge test --match-contract ShadowPool -vv   # the TSLA-shaped attack (4663 fork, ~3 min)
cd gauge && npm install && npm test          # TS math port pinned to the Solidity walk
npm run ladder && npm run calibrate && npm run hims && npm run mint-window
```

The gauge writes `gauge/data/*.json`; the web page reads them. `.env.example` lists the two
RPC variables and the testnet deploy key (environment only, never argv).

## Pre-existing work and provenance

Built during the hackathon (H0 = 2026-09-25 21:00 JST; see the commit history). Public
libraries used unchanged: Uniswap `v4-core` @ `d153b048`, OpenZeppelin `uniswap-hooks` @
`acbd604` (`BaseOracleHook`, Panoptic's truncated oracle design), `forge-std` @ `bf647bd`,
`viem`. Knowledge brought in, code rewritten: the HIMS weekend was first traced by our own
pre-hackathon research on the same chain (the numbers above are re-derived here by a new
collector and match), and the atomic-push measurements in the table come from our other
project, Vexi, an options venue on testnet 46630 — none of its code is in this repo.

## AI disclosure

Built with Claude Code from a human-written spec (`docs/prompts/2026-09-25-spec-zh.md`,
translated as `SPEC.md`). The human set the problem, the design, the cut list and reviewed
every contract and test; the AI wrote the Solidity, tests, TypeScript, this README and
`FEEDBACK.md` under `AGENTS.md`, test-first. Every prompt that shaped the work is in
`docs/prompts/log.md`.

## Next

- Cost model v1: holding cost from observed arbitrage latency per pool instead of "one re-push
  per second"; the gauge already has the `Swap` stream to measure it.
- `n_max`: the maximum safe open interest a venue can write against a pool, straight from the
  ladder (`min over x of cost(x) / (S × (1.0001^x − 1))`).
- A `StateLibrary` walker and a two-series getter upstream (`FEEDBACK.md` § 6–7).
