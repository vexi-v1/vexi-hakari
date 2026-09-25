# HAKARI (秤) — what it costs to fake a price

**A Uniswap v4 price is only as trustworthy as it is expensive to fake.** HAKARI measures that cost for
any v4 pool, turns it into the largest settlement the pool can safely carry right now, and settles on the
pool's TWAP only below that line. Above it, it refuses.

![HIMS/USDG on Sunday 2026-08-30: pool price vs the NYSE close, and the cost to push it 10 %](docs/img/hims-weekend.svg)

Sunday 2026-08-30 was Robinhood Chain's busiest day ever: $270.6M of stock-token volume
([SQD](https://sqd.dev/learn/robinhood-stock-token-volume/)). It was also a day when no stock token can be
minted or redeemed, so nobody could arbitrage. By 23:53 UTC, with minting still closed, pushing the HIMS/USDG
v4 pool 10 % higher cost **12 USDG** in fees (it had cost 1,351 four hours earlier). When minting reopened
the pool stood at **54.50 USDG**; the stock had closed Friday at **28.84**. Any lending market, perp or option
settling on that pool would have paid out on a price no arbitrage could correct. HAKARI measures it: the largest
settlement the pool could safely carry fell from **7,259 USDG** at 19:40 to **115 USDG** at 23:53, and `SafeSettle`
refuses anything above that line. Our first rule, which chose between the raw and the truncated TWAP, would not
have: replaying the weekend's swaps through it ([`gauge/data/hims-hook-replay.json`](gauge/data/hims-hook-replay.json), `npm run hims:hook`) settles at 43–50 USDG at 00:43:30, and up to 51.70 during the squeeze. An internal review showed why, and the rule
changed ([What the review found](#what-the-review-found-and-what-changed)).

**See it minute by minute:** [`web/squeeze/`](web/squeeze/) replays the weekend from Robinhood Chain's own logs —
HIMS, BONER and USDG prices and pool inventories, the float, HAKARI's cost to push, and what X said at the time, in
English and 繁中 (data and checks: [`gauge/src/squeeze/`](gauge/src/squeeze/), `npm run squeeze`).

ETHGlobal Tokyo 2026 · Uniswap Foundation "Best Uniswap Stack Contribution" · MIT ·
[`FEEDBACK.md`](FEEDBACK.md) · spec [`SPEC.md`](SPEC.md) · prompts [`docs/prompts/`](docs/prompts/)

## What it is

| Piece | What it does | Where |
|---|---|---|
| **`PushCostLens`** | What it costs to push any v4 pool to a price and sell straight back. **Exact mode** runs real swaps to a price limit inside `unlock` and reverts with the answer (the V4Quoter pattern, with a price limit V4Quoter lacks). **View mode** walks the tick bitmap through `StateLibrary`, from any starting price, so a contract already inside an unlock can still ask. Needs no deployment: inject its bytecode with an `eth_call` state override. | [`src/PushCostLens.sol`](src/PushCostLens.sol) |
| **`HakariOracleHook`** | OpenZeppelin's truncated oracle hook plus `twaps()`: the raw **and** truncated TWAP in one call. Records before the first swap of each second, so a push undone in the same transaction is never seen. | [`src/HakariOracleHook.sol`](src/HakariOracleHook.sol) |
| **`SafeSettle`** + **`CostModel`** | A demo settlement rule. For moves of 0.5–20 % (plus the gap between the two TWAPs), both ways from the price now, the lens prices holding the move over the window, re-pushing after every pull-back while arbitrage is open. Cost ÷ what the move earns per unit of exposure, minimised, is the **max safe exposure**. The total exposure settling on the price must be below it to settle on the raw TWAP; otherwise it refuses. Emits `Settled(id, raw, trunc, trusted, exposure, maxSafeExposure, bindingTicks, bindingUp)`. | [`src/SafeSettle.sol`](src/SafeSettle.sol), [`src/CostModel.sol`](src/CostModel.sol) |
| **Gauge** (TypeScript) | Live cost ladder, Δ calibration from `Swap` events, any past weekend rebuilt from `ModifyLiquidity` logs, the Robinhood mint-window flag, and the HIMS weekend replayed minute by minute through the hook and `SafeSettle` (`npm run hims:hook`). | [`gauge/`](gauge/), data in [`gauge/data/`](gauge/data/) |
| **Web page** | Paste any pool → live cost to push it, fenced or not, suggested Δ. HIMS replay, every stock pool over a weekend, SafeSettle's decisions. | [`web/`](web/) — `python3 -m http.server 8790 --bind 127.0.0.1`, open <http://localhost:8790/web/> |

### Why not just truncate the oracle?

Truncation (Panoptic's design: each observation moves at most Δ ticks) slows a sustained push. It does not stop
one: Δ is per *observation*, so a push held with one dust swap a second catches the truncated series up in x/Δ
seconds, and then both TWAPs agree on the fake. And in a genuine crash truncation lags, settling honest holders on
a stale price. So `SafeSettle` does not ask whether the two TWAPs disagree. It asks whether this pool, right now,
is deep enough that faking any relevant move would cost more than it could earn on everything settling on it.

The same real TSLA/USDG liquidity gives opposite answers depending on the world. A 30-minute TWAP, 100,000 USDG
settling ([`test/fork/ShadowPool.fork.t.sol`](test/fork/ShadowPool.fork.t.sol), block 72,419,444):

| | Max safe exposure | 100,000 USDG |
|---|---|---|
| Weekend: nobody pushes back | 12,089 USDG | **refused** |
| Weekday, arbitrage pulls back every 60 s | 112,262 USDG | settle on raw |
| Weekday, arbitrage every 12 s | 486,467 USDG | settle on raw |
| Weekend, a +5 % push held for 10 s | 2,607 USDG | **refused** |

The reversion time is the caller's input, not a measurement. At 30 minutes each rung pays 1 + ⌈hold ÷ reversion⌉
round trips, so the bound scales about as 1 ÷ reversion: slower than roughly 70 s and this 100,000 USDG would be
refused on a weekday too. The test asserts the derivable ratios (≥ 9× the weekend bound at 60 s, ≥ 39/9 more at
12 s), not the decisions, which move with the live book. One settlement on this book costs about 1.05M gas with
arbitrage closed and 4.1M with it open (three push widths per move), storage cold.

### Was HIMS a one-off?

![Every stock pool, the weekend of 2026-09-18: the largest settlement each could carry on Friday vs its lowest while minting was closed](docs/img/weekend-2026-09-18.svg)

We rebuilt the 12 deepest Robinhood stock pools plus HIMS for the weekend of 2026-09-18 → 21, from Friday's
US close to Monday, every six hours and around the mint reopening: 187 points, and at every one the rebuilt
liquidity equals the chain's own `Swap` record ([`gauge/data/weekend-2026-09-18.json`](gauge/data/weekend-2026-09-18.json)).
**Nothing collapsed.** The lowest max safe exposure while minting was closed was 0.69× (GOOGL) to 2.4× (GLD)
of Friday's; HIMS 1.06×. On 2026-08-30 HIMS fell to 0.016× (7,259 → 115 USDG).

So a closed mint window does not make a pool cheap to push. It removes the force that would push a price
back, and on 08-30 the price left the LPs' ranges and the HIMS inventory moved to another pool. That can
happen on a given weekend, and most weekends it doesn't. This is why HAKARI measures at settlement instead
of reading the calendar: a calendar rule would refuse every weekend, including the ones where the book held, while
a big enough exposure is unsafe on any weekend. `npm run weekend -- <friday>` rebuilds any weekend.

## Where the Uniswap integration is

Everything runs against the **official v4 PoolManager** `0x8366a39CC670B4001A1121B8F6A443A643e40951`
(same address on Robinhood Chain 4663 and testnet 46630). Links are pinned to commit `98bc7d7`.

| What | Code |
|---|---|
| `PoolManager.unlock` → `unlockCallback`, reverting with the result | [`PushCostLens.sol#L85`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/PushCostLens.sol#L85), [`#L104`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/PushCostLens.sol#L104) |
| Push leg: `poolManager.swap` to a `sqrtPriceLimitX96`, `BalanceDelta` read | [`PushCostLens.sol#L114`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/PushCostLens.sol#L114) |
| Return leg: sell exactly what came out | [`PushCostLens.sol#L125`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/PushCostLens.sol#L125) |
| Push to an exact price | [`PushCostLens.sol#L76`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/PushCostLens.sol#L76) |
| View walk over `StateLibrary` (`getSlot0`, `getLiquidity`, `getTickBitmap`, `getTickLiquidity`), protocol fee folded in as `Pool.swap` does | [`PushCostLens.sol#L179`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/PushCostLens.sol#L179), [`#L267`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/PushCostLens.sol#L267), [`TickBitmapView.sol#L14`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/libraries/TickBitmapView.sol#L14) |
| Walk from any price (the honest one), through the liquidity as it is now | [`PushCostLens.sol#L197`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/PushCostLens.sol#L197), [`#L231`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/PushCostLens.sol#L231) |
| `BaseOracleHook.observe` → both TWAPs | [`HakariOracleHook.sol#L24`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/HakariOracleHook.sol#L24) |
| Refuse to answer inside an unlock (`TransientStateLibrary.isUnlocked`) | [`SafeSettle.sol#L76`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/SafeSettle.sol#L76) |
| The decision: max safe exposure vs the exposure settling | [`SafeSettle.sol#L79-L88`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/SafeSettle.sol#L79-L88), [`CostModel.sol#L40`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/CostModel.sol#L40) (the bound), [`#L68`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/CostModel.sol#L68) (holding a move against arbitrage), [`#L102`](https://github.com/vexi-v1/vexi-hakari/blob/98bc7d793ce37f1a9570b1197673df0cf0afd6c4/src/CostModel.sol#L102) (what it earns) |
| Hook salt mined against the CREATE2 proxy for the `0x1080` flag bits | [`script/Deploy.s.sol`](script/Deploy.s.sol) |

### On-chain, testnet 46630 (sources verified on the explorer)

Lens and hook deployed from commit `798ab19`, `SafeSettle` from `98bc7d7` (the `src/` the links above point
to), all by the project wallet `0x51E4EfE117e8Baf023dab3B7Cb5380DF1d378DF1`. Explorer:
<https://explorer.testnet.chain.robinhood.com>.

| Contract | Address | Deploy tx |
|---|---|---|
| `PushCostLens` | [`0x4E73CcC9Aed21FFBf3F69d9Dd92f9F33F39669E5`](https://explorer.testnet.chain.robinhood.com/address/0x4E73CcC9Aed21FFBf3F69d9Dd92f9F33F39669E5) | [`0x85288ca1…d5d6`](https://explorer.testnet.chain.robinhood.com/tx/0x85288ca13826577622afa4177ab3335b8e5a0e9e0de13af39495ed534d99d5d6) |
| `HakariOracleHook` (Δ = 250) | [`0x3b58D774cE351227B24A91103b20bA4fc068D080`](https://explorer.testnet.chain.robinhood.com/address/0x3b58D774cE351227B24A91103b20bA4fc068D080) | [`0xf591433a…8d50`](https://explorer.testnet.chain.robinhood.com/tx/0xf591433a7322099962a117b9ebad9a0671f9dc36dcb7e323b035aacfaa538d50) |
| `SafeSettle` | [`0x68435Bf7A1c207A62E0C3acc6884383B2B273561`](https://explorer.testnet.chain.robinhood.com/address/0x68435Bf7A1c207A62E0C3acc6884383B2B273561) | [`0x87accb14…7370`](https://explorer.testnet.chain.robinhood.com/tx/0x87accb14f57925715ea52de655bd56892a266153d479bcdde292b9da7d2b7370) |

**The whole loop, in public.** [`script/DemoPool.s.sol`](script/DemoPool.s.sol) creates a pool with the hook
on the official PoolManager (id `0xe454eb2b3746dce8cff428120140f68ff83ae5aff586e358c940da5e8a71306c`), adds a
thin book, pushes the price +35 % and keeps it there with small swaps. A minute later
[`script/DemoSettle.s.sol`](script/DemoSettle.s.sol) calls `SafeSettle.settle` with a 60-second window and
1,000,000 tokens of exposure:
[tx `0x50c06e53…299e`](https://explorer.testnet.chain.robinhood.com/tx/0x50c06e53dad5689111ed40cbb80f8cb4dd43f1f357db44d141b9da48f4dc299e)
emits `Settled` with raw tick 3000, truncated 1250, trusted **false**: the thin pool could safely carry
3.2 × 10¹² wei (0.0000032 tokens), bound set by a 1,823-tick move up. 382k gas on this thin pool; a real
book costs more (below). Decode it yourself:

```bash
cast receipt 0x50c06e53dad5689111ed40cbb80f8cb4dd43f1f357db44d141b9da48f4dc299e --rpc-url https://rpc.testnet.chain.robinhood.com/rpc --json | jq -r '.logs[0].data' | xargs cast abi-decode --input 'Settled(int24,int24,bool,uint256,uint256,int24,bool)'
```

On mainnet 4663 we write nothing: the lens runs there by state override
([`gauge/src/lens.ts`](gauge/src/lens.ts), [`web/app.js`](web/app.js)).

## Numbers

**The lens against a real pool.** On a 4663 fork at block 72,419,444, buying 10 TSLA and selling them back
in one unlock nets −26.126663 USDG; the lens pushed to the exact price that buy reached reports 26.126663
USDG for 10.000000 TSLA ([`test/fork/PushCostLens.fork.t.sol`](test/fork/PushCostLens.fork.t.sol)). The fork
follows the chain head, because the public RPC does not keep old state, so the test asserts agreement
within 0.1 % rather than a fixed figure. Output saved in [`docs/demo-outputs/`](docs/demo-outputs/) by
[`script/record-fork-tests.sh`](script/record-fork-tests.sh), which runs on the public RPC and masks every URL.

**The HIMS weekend**, rebuilt from 1,998 `ModifyLiquidity` logs. At each point's last `Swap`, the rebuilt
active liquidity equals that event's own `liquidity` field ([`gauge/data/hims-replay.json`](gauge/data/hims-replay.json)).
"HIMS in pool" is curve principal excluding fees, not the reserves you could sell into. "Max safe exposure" is
`SafeSettle`'s bound with nobody pushing back, computed by the gauge's mirror of `CostModel`:

| Block | Time (UTC) | Mint window | USDG/HIMS | HIMS in pool | Cost to push +10 % | Max safe exposure |
|---|---|---|---|---|---|---|
| 50,265,277 | Sun 19:40 | closed | 29.38 | 2,606 | 1,351 USDG | 7,259 USDG |
| 50,415,299 | Sun 23:53 | closed | 43.27 | 67 | **12 USDG** | **115 USDG** |
| 50,444,948 | Mon 00:43 (last block before the first mint, #50,444,949) | open | 54.50 | 32 | 13 USDG | 124 USDG |
| 50,490,000 | Mon 01:59 | open | 29.31 | 2,036 | 867 USDG | 5,310 USDG |
| 50,772,447 | Mon 09:54 | open | 29.48 | 2,567 | 1,307 USDG | 7,009 USDG |

**Cost ladder**, mainnet 4663, block 72,241,051 ([`gauge/data/ladder.json`](gauge/data/ladder.json)). Pushing
the stock *up*; fees lost / capital needed, in USDG. A snapshot: the book moves (TSLA's +5 % cost ranged about
1.3k–2.3k USDG within an hour on 2026-09-25), and the web page's **Refresh live** re-measures at the head:

| Pool | Price | +1 % | +5 % | +10 % |
|---|---|---|---|---|
| TSLA/USDG | 381.30 | 503 / 72,174 | 1,275 / 183,977 | 1,487 / 215,284 |
| NVDA/USDG | 225.91 | 273 / 39,119 | 1,280 / 185,401 | 2,013 / 293,857 |
| HIMS/USDG | 29.36 | 170 / 8,560 | 723 / 36,765 | 1,143 / 58,607 |

The "0.3 %" pools on this chain charge 0.35 %: the protocol fee is on (`FEEDBACK.md` § 5).

**Δ calibration**: p99 tick move between consecutive swap blocks over the 300k blocks up to
72,241,326 ([`gauge/data/delta.json`](gauge/data/delta.json)): TSLA 3, NVDA 10, HIMS 10, AI memecoin 193. That
window is ≈ 8.4 h on 2026-09-25 (04:27–12:53 UTC, before the NYSE open) with n = 132 / 96 / 6 / 63 swaps, so
HIMS is indicative only; it is per swap *block*, while the oracle writes at most once per *second*. One hook
carries one Δ, so a stock-grade and a memecoin-grade hook are two deployments.

## The three layers, as tests

`forge test --match-contract ThreeLayers -vv` ([`test/demo/ThreeLayers.t.sol`](test/demo/ThreeLayers.t.sol)), one
token of exposure each:

1. **An atomic push fools `slot0`, not the hook.** A naive consumer settles on tick 499 after a 500-tick push
   undone in the same transaction; both of the hook's series read the honest tick, −1. (Inherited from the
   OpenZeppelin / Panoptic hook: the observation is written before the first swap of each second.)
2. **A push held on a thin pool is refused, whether the TWAPs disagree or not.** Held 10 s: raw 3000, truncated
   650. Held 42 s: both 3000. Either way the pool could safely carry about 3 × 10⁻⁶ tokens: refused.
3. **A genuine surge is trusted on a deep pool and refused on a thin one.** Deep, arbitrage every 5 s: max safe
   9.56 tokens, settle on raw 1650 while truncation lags at 550. Thin: 9.6 × 10⁻⁶ tokens, refused. Where faking is
   cheap the rule cannot tell real from fake, and it says so instead of paying on a lagging price.

The atomic case is not hypothetical. On our own options venue on testnet 46630 (Vexi), a push-trade-push
earned +87 bps per contract after fees. That measurement is not reproduced in this repo; layer 1 is the
in-repo evidence.

## What the review found, and what changed

An internal adversarial review (Abner's session, `e581e23`) attacked the first rule, which settled on raw or
truncated depending on whether a fake of the gap between the two TWAPs was cheaper than its gain:

| Finding | First rule | Now (`98bc7d7`) | Test |
|---|---|---|---|
| A push held until both TWAPs agree | settled on the fake, unchecked | refused | `test_pushHeldUntilTheSeriesConverge_isStillRefused` |
| The HIMS weekend, a five-hour drift | settled at 43–52 USDG | refused above 115 USDG | gauge `hims-replay`; the gauge's bound is pinned to `CostModel.maxSafeExposure` by `WalkFixture` + `max-safe-exposure.test.ts` |
| A genuine surge on a thin pool | settled on the lagging truncated price | refused, explicitly | `test_layer3_genuineSurgeOnThinPool_isRefused` |
| Gain counted per call | ten settlements each "not worth faking" | the input is the total exposure on the price | documented; the caller supplies it |
| TSLA weekday/weekend contrast | flipped inside a 43k–106k notional band at 5 s | a bound about 9× higher on a weekday (60 s reversion) than on a weekend | `test_tslaShapedBook_maxSafeExposure_weekendVsWeekday` |
| A liquidity wall across transactions | bought trust | **still buys trust** (below) | `test_knownLimit_aWallAcrossTransactions_buysTrust` |

Earlier the review had also found that the walk started from the pushed price and that a wall inside one unlock
inflated the cost (fixed in `d93a700`), and that the gain used the tick's direction where the quote is currency0
(fixed in `fced71c`).

## Limitations

- **A liquidity wall across transactions buys trust.** The bound reads the liquidity present at settlement.
  `SafeSettle` refuses to answer inside an unlock, which stops add-ask-remove in one transaction, but three
  separate transactions (even in one block) are not stopped, and the wall's owner gets it all back. The fix is
  time-weighted liquidity recorded by the hook (new flags, new salt, new pool), so a wall must stand for the whole
  window. `test_knownLimit_aWallAcrossTransactions_buysTrust` demonstrates the limit.
- **Two inputs are trusted.** `exposure` must be the total settling on that price (every position, every
  protocol), which no contract can see. `arbReversionSeconds` is the caller's statement about arbitrage: 0 while
  mint/redeem is closed, and otherwise a slow, measured bound, since a fast one overstates what faking costs. With
  arbitrage closed the bound is a lower bound (fees on an exact retrace); with it open, it is only as good as the
  reversion time. `settle` is permissionless: a `Settled` log is only as meaningful as its caller.
- **Refusal can be forced.** A rule that refuses when a pool is thin hands a lever to anyone who can make it look
  thin at settlement: an LP pulling liquidity just before expiry, or a push into a thin stretch (the bound is read
  from the price now). What a refused settlement does next (wait and retry, extend the expiry, fall back to a slower
  source) is the integrator's call, and that fallback is where the next attack goes. HAKARI does not choose it.
- **The ladder samples moves up to 20 %.** On the pools we measured the bound was usually set by the 20 % rung,
  where liquidity thins, so a larger move could be cheaper still and the true bound lower.
- **Gas.** One settlement on the TSLA book costs about 1.05M gas with arbitrage closed and 4.1M with it open
  (6–7 moves × 2 directions × up to 3 push widths, each a capped walk), storage cold. Fine on an L2, heavy on L1;
  a wider or adaptive ladder would cost more.
- **View mode sees stored fees only.** `depthToMove` / `roundTripCost` fold in the LP and protocol fee from
  `slot0`; hook-taken charges and per-swap fee overrides appear only in the exact `quotePush`. Measured in review
  on BONER/HIMS (dynamic fee, hooked): view ≈ 0.066 × exact. On hooked pools the bound can be far too high; GLD's
  pool in the weekend chart is one (marked †).
- **The walk is capped** (`MAX_WALK_STEPS` = 64 segments); past the cap a cost is "at least this"
  (`costComplete = false`), so the bound is too.
- **One Δ per hook**, fixed at deployment, and the hook only covers pools created with it. Δ now affects only the
  truncated TWAP reported alongside, not the decision.
- **`SafeSettle` is a demo rule**, not a product. The contribution is the measurement (lens, bound, gauge) and the
  two-series hook; the rule shows one way to use them.

## Prior art

| Work | What it did | What HAKARI adds |
|---|---|---|
| [Chaos Labs, TWAP manipulation research](https://chaoslabs.xyz/posts/chaos-labs-uniswap-v3-twap-oracles) (Uniswap Foundation grant, Jan 2023) | An off-chain tool to simulate manipulating Uniswap v3 TWAP oracles | v4; the cost as an on-chain call and as a zero-deploy `eth_call`; tied to a settlement decision |
| [Euler, `uni-v3-twap-manipulation`](https://github.com/euler-xyz/uni-v3-twap-manipulation) | Cost-of-attack for v3 TWAPs, behind Euler's oracle risk grades | v4 pools, per settlement, with the arbitrage state as an input |
| [Uniswap, "Uniswap v3 TWAP Oracles in Proof of Stake"](https://blog.uniswap.org/uniswap-v3-oracles) (Oct 2022) | Multi-block manipulation cost for major pairs | The same question for thin pools whose arbitrage switches off on a schedule |
| Panoptic's truncated oracle, OpenZeppelin `BaseOracleHook` | Clip each observation to ±Δ | We build on it and expose both series; the decision is not a choice between them (a held push makes them agree) but a bound from the pool's depth |
| `V4Quoter` | Quote a swap by amount via unlock + revert | The same pattern to a price limit, plus a view path for callers already inside an unlock |

What is new here is the combination on v4, and a measured case: a stock-token weekend on which the cost of
faking a price fell two orders of magnitude in four hours, next to a rebuilt weekend on which it did not.

## Run it

```bash
git clone --recurse-submodules https://github.com/vexi-v1/vexi-hakari && cd vexi-hakari
forge test --no-match-path 'test/fork/*'          # 37 tests, no RPC
script/record-fork-tests.sh                       # 5 fork tests on real pools (public RPC, ~4 min), URLs masked
cd gauge && npm ci && npm test                    # 21 tests: the walk and the bound are pinned to the Solidity ones
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
the first two `SafeSettle` deployments, from `798ab19` (`0x64890652…B150`) and `fced71c` (`0x8191E930…6f44`),
replaced by the rule above.

## AI disclosure

Most of the code, tests and docs here were written by AI agents (Claude Code), test-first, directed by the two
of us, each from our own machine. Eric wrote the spec ([`docs/prompts/2026-09-25-spec-zh.md`](docs/prompts/2026-09-25-spec-zh.md),
translated as `SPEC.md`) and directed the build; Abner joined at 22:24 JST and directed the internal review
and the docs passes. Every instruction from either of us is in [`docs/prompts/log.md`](docs/prompts/log.md),
and the review's fixes are in the history. The pace of the commit history is the agents'.

## Next

- **Time-weighted liquidity in the hook**, so a liquidity wall has to stand for the whole window.
- **Measure the reversion time** per pool from the `Swap` stream instead of taking it as an input, and feed the
  mint-window flag from the gauge.
- **A wider, adaptive ladder**, searching for the cheapest move instead of sampling six.
- Upstream: a price-limit quote on `V4Quoter` and a directional tick search next to `ReservesLens`
  (`FEEDBACK.md` § 1, § 3).
