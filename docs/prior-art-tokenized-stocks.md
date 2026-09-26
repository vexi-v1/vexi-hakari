# Prior art: how projects that carry tokenized stocks price them when the market is closed

Reference notes, as of 2026-09-27. Every fact below comes from a page that was opened and is listed under
[Sources](#sources); what could not be confirmed is listed under [Not confirmed](#not-confirmed). The notes were
gathered while reviewing HAKARI's band and settlement adapter against what other projects do. They describe other
projects only; nothing here describes how Vexi prices options or sizes its risk.

## The problem every one of them meets

From Friday 20:00 ET to Sunday 20:00 ET, and on US market holidays, the issuer of a stock token neither mints nor
redeems, and the external price feed holds its last value. The token's on-chain pool becomes the only price that
moves. Anyone who reads that pool as a reference has to decide whether to trust it, and every project below answers
that question in one of three ways:

1. **Freeze or halt by calendar.** Keep the last close, or refuse trades until the market reopens.
2. **Bound each update.** Let the price move, but only within a band around the last close, or by a capped step.
3. **Trust the pool, with divergence checks.** Read the pool, and pull back when its own series disagree.

HAKARI's band is a variant of the second: a ±5 % band around the hook's TWAP, plus a pause when the raw and
truncated series disagree by more than a half-width ([band.md](band.md)). The archived first study measured the
pool's depth instead ([archive/hakari-v1](../archive/hakari-v1/README.md)). Nobody in the survey measures depth at
read time.

## What each project does

### Chainlink tokenized-equity feeds (used by Robinhood, Coinbase B20, xStocks, Ondo)

- 24/5. With the market closed, `marketStatus = 5`; the feed publishes nothing, has no heartbeat, and the last
  value stands with a stale timestamp.
- The integration guide gives integrators three options while the market is closed: pause; allow restricted
  trading within "last-valid price ± threshold"; or reference the tokenized asset's secondary market instead.
- Extended and overnight sessions are single-sourced (Blue Ocean ATS). The guide warns that `mid` can be zero with a
  fresh timestamp and tells integrators to check the bid/ask spread and the jump from the prior value.
- Robinhood Chain's own docs point builders at Chainlink and at `updatedAt` staleness checks; they say nothing
  about weekends or pool prices.

### Aave V4 "Equities Hub" on Base (Coinbase B20, September 2026)

In one line: the price freezes over the weekend, the market does not pause, and the hours during which a position
cannot be repriced are folded into the collateral factor.

- A dedicated hub with one USDC reserve and one Mag-7 spoke. The seven stock tokens are collateral only; USDC is
  the only borrowable asset; stock tokens cannot be borrowed or cross-borrowed.
- Parameters proposed by LlamaRisk on 2026-09-21:

| Asset | Collateral factor = liquidation threshold | Max liquidation bonus | Add cap (tokens) |
|---|---|---|---|
| AAPLc | 78 % | 5.5 % | 15,000 |
| AMZNc | 73 % | 5.5 % | 10,500 |
| GOOGLc | 76 % | 5.5 % | 15,000 |
| METAc | 65 % | 5.5 % | 5,800 |
| MSFTc | 79 % | 5.5 % | 5,200 |
| NVDAc | 70 % | 5.5 % | 24,000 |
| TSLAc | 65 % | 5.5 % | 14,000 |
| USDC | 0 % (borrow only) | none | 32M add / 21M draw |

- Add caps track Coinbase's daily mint allowance per token (about USD 5M a day).
- Oracle: Chainlink total-return feed (share price × issuer multiplier), 0.5 % deviation threshold and 24-hour
  heartbeat while open, nothing while closed. USDC through a stable price cap adapter at 1.04. No SVR at rollout.
- Weekend: no liquidation pause, no borrow pause, no band. The collateral price does not move; a health factor can
  fall only through interest, and a position that crosses the line can be liquidated at any time, including over
  the weekend. Collateral factors come from one-minute Nasdaq bars from May 2018 to August 2026, split by session,
  assuming liquidation completes within five minutes of the next regular open, plus the 0.5 % feed allowance and
  interest over the longest closure on record (92 h 35 min).
- The 5.5 % bonus pays for the most expensive of three exits: issuer redemption (about 2.93 %), a secondary-market
  sale on Base (5.18 %), or a perp hedge outside regular hours (4.59 %, stressed).
- Corporate actions: the issuer pauses mint and redeem, pauses the feed, updates the multiplier, verifies the
  product matches the held value, resumes; the reserve is paused for the same window.
- Risks LlamaRisk names but the parameters do not address: a liquidator receives unvested tokens with no redemption
  right, and no liquidation contract has been allowed to vest; there is no market-making arrangement, and the
  prospectus says the trading price may diverge significantly from the underlying; every admin role is an EOA.

### Kamino Lend (xStocks collateral, Solana)

- Outside market hours (weekends, evenings, pre- and post-market) Kamino accepts a Chainlink-streamed price only if
  it falls within a "custom percentage deviation range" of the price at the last market close; out-of-band prices
  are rejected. The percentage is not published.
- Chainlink's market-status feed and staleness indicator let it react to halts automatically.
- The proposal says the architecture was built "specifically to ensure that xStock prices on Kamino avoid onchain
  liquidity constraints". Launch assets: SPYx, QQQx, GOOGLx, AAPLx, NVDAx, TSLAx, MSTRx, HOODx.

### Hyperliquid HIP-3 / trade.xyz equity perps (24/7)

- Discovery bounds: while the external market is closed, the reference is the last external price (the Friday
  close); the mark may move only within ±(1 ÷ max leverage) of it at any instant. When the price reaches 90 % of
  the way to the edge the reference re-anchors and a fresh bound opens; each direction has a set number of
  re-anchors, after which the bound is a hard cap until external pricing resumes.
- Mark price is the median of three inputs: the oracle price, the oracle price plus a 150-second EMA of the
  perp-minus-oracle basis, and the median of best bid, best ask and last trade. Relayer updates are clamped to
  ±50 bps per update.
- HIP-3 puts oracle operation on the market's deployer; a move of more than 50 % from the start-of-day price
  triggers a validator review of the deployer.
- 2026-07-28, SK Hynix: an erroneous pre-market print on Korea's NXT venue (28.7 % below the prior close) entered
  the oracle. A 10 % instantaneous bound with one permitted reset held the contract's fall to 17.9 %; about
  USD 57.4M of longs across 960 accounts were still liquidated. A bound limits the damage; it does not tell a bad
  external print from a real one, and it knows nothing about depth.

### Kraken xStocks perps (24/7)

- Outside US hours the reference price is the on-chain trading of the xStocks tokens themselves, and funding keeps
  the perp aligned to it. The token's own market price is its reference price. No band or cap is documented.

### Ostium (stock perps, external oracle)

- Stocks trade 09:30 to 16:00 ET, Monday to Friday. Outside those hours market orders are rejected; limit and stop
  orders queue for the open, and the docs warn that queued orders can fill at a gapped price. All 35 stock pairs at
  100x maximum leverage.

### Ondo and xStocks issuers

- Ondo runs its own off-hours quoting for a subset of assets, with wider spreads, smaller maximum order sizes, and
  a warning that the price may diverge from the next primary-market open. The pricing method is proprietary.
- xStocks' developer docs point at Nasdaq Blue Ocean for overnight pricing and say nothing about weekends.

### Panoptic v2 (on Robinhood Chain since 2026-09-14; SPCXx via xStocks)

Panoptic reads no external oracle: every price comes from the Uniswap pool it sits on. On a stock-token pool over a
weekend it faces exactly the situation above, which makes it the closest comparator to HAKARI's band.

- Oracle: the median of 8 stored observations (`pokeOracle`, rate-limited to one per 64 s) and four EMAs at 120,
  240, 600 and 1800 seconds (spot, fast, slow, eons).
- Safe mode is the sum of three tests, each worth one level; a lock adds three:

| Test | Threshold |
|---|---|
| current tick vs spot EMA | > 953 ticks (about 10 %) |
| spot EMA vs fast EMA | > 476 ticks |
| median vs slow EMA | > 1906 ticks |

- Effects: any level forces utilization to 100 % (no cross-margin); level 2 and up allows only covered mints;
  level 3 blocks new mints (`StaleOracle`). Liquidation separately reverts when the current tick is more than
  513 ticks (about 5 %) from the TWAP.
- The C4 audit scope excludes "price manipulation that requires attackers to hold a price across more than one
  block".
- Against a weekend stock pool, the median and all four EMAs come from the same thin pool, so a push held long
  enough makes them agree; that is the same limit [band.md](band.md) states for the band's own TWAP center.
  Blocking liquidation on divergence is the same lever the settlement adapter's refusal hands a losing side
  ([settlement.md](settlement.md)); Panoptic accepts that trade too.

### GapGuard (Robinhood Chain v4 hook, September 2026)

- Uses the NYSE calendar: while the market is closed, a swap that would move its own pool more than about 1 %
  reverts, and the hook charges a surcharge. It protects its own pool and gives outside readers nothing.

## Side by side

| Project | Weekend | Reads pool depth | Where the exposure limit comes from |
|---|---|---|---|
| Chainlink equity feeds | freeze at last close; recommends pause, band, or secondary market | no | left to the integrator |
| Aave Equities Hub | freeze, market stays open | no | collateral factors from historical gaps; static caps |
| Kamino xStocks | last close ± custom % band; out-of-band rejected | no | not published |
| Ostium | market orders rejected | no | per-pair leverage cap |
| trade.xyz / HIP-3 | ratchet band anchored on the last close | no | band = 1 ÷ leverage |
| Kraken xStocks perps | on-chain token price is the reference | no | not published |
| Panoptic v2 | pool's own median and EMAs; divergence enters safe mode | no | safe mode forces covered positions |
| GapGuard | calendar; 1 % per swap | no | none |
| HAKARI band | ±5 % around the hook TWAP; pause on series disagreement | in-range liquidity floor (`minLiquidity`) | per-call size cap and edge spread |
| HAKARI first study (archived) | cost to push, read at settlement | yes | cost ÷ gain per unit of exposure |

Three observations for the README and for reviewers:

1. Chainlink's three options are the industry's own statement of the problem. Aave takes the first, Kamino and
   trade.xyz the second, Panoptic and Kraken's perps the third. The band is a second-option design that reads the
   pool rather than an external feed, which is why it needs the series-disagreement pause.
2. The SK Hynix incident shows a bound limits loss but cannot tell a bad print from a real move. The band's
   "what it does not protect" list already says the same about a push that stands.
3. Aave's own risk assessment concedes that liquidators must exit through the secondary market. Even where the
   oracle is external, realizing collateral depends on pool depth, which is what the archived study measured.

## Not confirmed

- Kamino's band percentage is not published; the rule itself is confirmed by Kamino's governance proposal.
- gTrade's stock trading-hours page returned 404; Ostium's docs give no open-interest caps.
- Panoptic's safe-mode constants are from the December 2025 C4 audit repository, not read from the contract
  deployed on Robinhood Chain.
- Ondo's off-hours pricing method is proprietary; xStocks' weekend behaviour is not documented.

## Sources

- [Chainlink, 24/5 US Equities User Guide](https://docs.chain.link/data-streams/rwa-streams/24-5-us-equities-user-guide)
- [Chainlink, Robinhood tokenized equity feeds](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood)
- [Chainlink, Coinbase B20 tokenized equity feeds](https://docs.chain.link/data-feeds/tokenized-equity-feeds/coinbase)
- [Robinhood Chain, Oracles & Price Feeds](https://docs.robinhood.com/chain/oracles-and-price-feeds/)
- [Aave governance, ARFC: Deploy Aave V4 on Base (LlamaRisk parameters, 2026-09-21)](https://governance.aave.com/t/arfc-deploy-aave-v4-on-base/25427)
- [Aave governance, Coinbase B20 Equities on Base Assessments (LlamaRisk, 2026-09-24)](https://governance.aave.com/t/coinbase-b20-equities-on-base-assessments/25690)
- [Kamino governance, xStocks integration proposal](https://gov.kamino.finance/t/kamino-is-integrating-xstocks-powered-by-the-chainlink-data-standard-to-enable-tokenized-equities-lending/792)
- [Kamino docs, price protection](https://kamino.com/docs/security/oracles/price-protection.md)
- [trade.xyz, discovery bounds](https://docs.trade.xyz/perpetuals/mechanics/discovery-bounds.md)
- [trade.xyz, mark price](https://docs.trade.xyz/perpetuals/mechanics/mark-price.md)
- [Hyperliquid, HIP-3 builder-deployed perpetuals](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3-builder-deployed-perpetuals)
- [Yahoo Finance, Hyperliquid explains SK Hynix liquidations](https://finance.yahoo.com/markets/crypto/articles/hyperliquid-explains-57-million-sk-114320781.html)
- [Kraken, what are xStocks perps](https://www.kraken.com/learn/futures-trading-what-are-xstocks-perps)
- [Ostium docs, markets](https://docs.ostium.com/traders/reference/markets)
- [Ondo docs, market hours and trading availability](https://docs.ondo.finance/ondo-stocks/market-hours-and-trading-availability)
- [xStocks developer docs](https://docs.xstocks.fi/developers)
- [Panoptic v2 `RiskEngine.sol` (C4, December 2025)](https://github.com/code-423n4/2025-12-panoptic/blob/main/contracts/RiskEngine.sol)
- [Panoptic v2 `PanopticPool.sol` (C4, December 2025)](https://github.com/code-423n4/2025-12-panoptic/blob/main/contracts/PanopticPool.sol)
- [Panoptic blog (Robinhood Chain launch, SPCXx)](https://panoptic.xyz/blog)
- [GapGuard](https://github.com/Bytethebuilder/gapguard)
