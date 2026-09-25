# Demo runbook — video (2–4 min, human voice) and booth

Four segments, ~3 minutes, following `SPEC.md` § 5. Every number below is real and already in the
repo; the commands reproduce them. Record at ≥ 720p, no TTS, no speed-ups.

## Before recording

```bash
cd vexi-hakari
forge build
python3 -m http.server 8790 --bind 127.0.0.1   # then open http://localhost:8790/web/  (dark mode looks best)
```

Show the saved fork output in `docs/demo-outputs/` rather than re-running the fork tests on camera:
a fresh run forks a new block, so its numbers will not match the README, and it rewrites the
committed `web/decisions/*.json`. `ThreeLayers` is local and deterministic, so it is fine to run
live:

```bash
forge test --match-contract ThreeLayers -vv                          # ~1 s, no RPC
# only if you need a fresh fork run (then `git checkout -- web/decisions test/fixtures` afterwards):
# forge test --match-contract 'ShadowPoolForkTest|PushCostLensForkTest' -vv   # ~4 min, 4663 fork
```

Explorer for the public transactions: <https://explorer.testnet.chain.robinhood.com>.

## Segment 1 · 0:00–0:30 · the problem

**Show:** the web page, section 1. Click **Measure** on the TSLA/USDG preset (≈ 10 s; it injects
the lens into mainnet with an `eth_call` state override — say so). Point at the +5 % row and read
the fees and the capital it ties up off the screen; the live book moves, so do not quote a number
from this file.

Scroll to section 2, the two HIMS charts.

**Say:** "Every protocol that settles on a Uniswap pool assumes the price is real. This is the
HIMS pool on Robinhood Chain on a Sunday: minting was closed, nobody could arbitrage. At 19:40 UTC
pushing it 10 % cost 1,351 dollars; four hours later it cost 12, and the price was already 43
against a 28.84 close. It peaked at 54 the moment minting reopened. How much trust a price
deserves depends on what it costs to fake."

## Segment 2 · 0:30–1:15 · layer 1, the atomic push

```bash
forge test --match-contract ThreeLayers --match-test layer1 -vv
```

**Show:** `naive settlement tick 499` vs `honest tick -1`, then `hook raw TWAP -1` and
`hook truncated TWAP -1`.

**Say:** "A protocol that reads `slot0` gets pushed 500 ticks and settles on it, inside one
transaction, and the attacker pushes it back. HakariOracleHook writes its observation *before*
the first swap of each second, so a push undone within the second never existed. Both of its
series still say minus one."

## Segment 3 · 1:15–2:15 · layers 2 and 3, hold it and price it

```bash
forge test --match-contract ThreeLayers --match-test 'layer2and3|layer3' -vv
```

**Show:** thin pool — `raw TWAP 3000`, `truncated TWAP 650`, `cost to fake 8.2e11`,
`gain if faked 2.6e17`, `used raw? false`. Deep pool — `raw 1650`, `truncated 550`,
`cost 3.2e18 > gain 1.2e17`, `used raw? true`.

Then the TSLA-shaped pool (`docs/demo-outputs/fork-tests.txt`): holding +5 % for the window on the
real TSLA/USDG liquidity profile ties up ~133,000 USDG. With the pool held there, SafeSettle's
estimate of what it costs to fake the remaining gap is ~150 USDG on a weekend and ~890 on a
weekday, against a 4,801 USDG gain on a 100k settlement (read the exact figures off the saved
output).

**Say:** "Truncation caps how far the recorded price can move per observation — but it lags in a
real crash. So SafeSettle asks the lens: what would it cost to hold this pool where the raw
series says it is, for the whole window? If that costs more than the settlement pays, the move
is real and we use the raw price. If it is cheaper — like here, about 150 dollars against a 4,800
dollar move on a 100,000 dollar payout — we settle on the truncated price and the attacker paid
fees for nothing."

## Segment 4 · 2:15–2:45 · it is on-chain

**Show:** README § "Deployed on Robinhood Chain testnet 46630" and the explorer:

- hook `0xa953EA9E06937f4169cBc04032B947Dad0b15080` (address ends in `…5080`: the `0x1080` flag
  bits, mined salt), lens `0x4fe982eBF315925D14bF11917fdad43400703d28`, settle
  `0xBc1f6adB55eFD483abBc1e46e1F7dA6f34ea02e4`, all on the official PoolManager `0x8366…0951`.
- the public run: pool `0xc2c8…108f`, `Settled` in tx
  `0x5dfc71837a834ac839a9a9d775013f6129f8a4d67066e32df373c09f9ad15441` — raw 3000, truncated 1250,
  cost 6.1e11 vs gain 1.9e23 → truncated (decoded from the event log; the explorer shows the raw
  log data). Do not re-run `Deploy` or `DemoPool` for the video: they overwrite the deployment
  records the README points at.

**Say:** "Hook, lens and settler are live on the official v4 PoolManager on Robinhood testnet, and
this transaction is the whole loop happening for real. Any protocol can call PushCostLens today,
on mainnet, without us deploying anything: eth_call with a state override. The README points at
the exact lines: unlock, swap, BalanceDelta."

## Booth: questions you will get

- **Why not just truncate?** Because it lags in a genuine crash and short-changes honest holders.
  Some protocols turn it off for that reason. HAKARI keeps both series and decides per settlement.
- **Is the cost model right?** It is v0 and the README lists its limits. Each walk counts fees only
  and is capped, but it starts from the current price and reads current liquidity, so a held push
  or just-in-time liquidity can move the estimate either way (README § "Known limitations"). The
  decision rule is replaceable; the measurement is the contribution.
- **Why two modes in the lens?** v4 forbids nested `unlock`, so a contract already inside one
  cannot use the exact simulation; the view walk over `StateLibrary` is for them.
- **The 0.3 % pools charge 0.35 %?** Yes — protocol fees are on for these pools on Robinhood
  Chain; the lens folds them in the way `Pool.swap` does. It is in FEEDBACK.md.
- **Where do the atomic-push numbers come from?** Our own options venue on testnet 46630 (Vexi):
  +87 bps per contract against its rate-limited spot. No Vexi code is in this repo.
- **Can I try it on my pool?** Section 3 of the web page: paste the PoolKey. It also gives a
  calibrated Δ (p99 of the pool's per-block tick moves) and whether a stock token is inside the
  Robinhood mint window right now.
