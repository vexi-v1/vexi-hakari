# Archive

Work that is no longer on this repository's main line, kept here so that every link, number and test from it can
still be read. Nothing in `archive/` is built or tested by the main line. To run it as it was, check out the last
commit before the archive, `aefa923` (2026-09-27 01:20 JST):

```bash
git checkout aefa923
forge test                                  # the contracts, incl. fork tests (RH_MAINNET_RPC)
cd gauge && npm ci && npm test              # the TypeScript gauge
```

Why it moved: [`docs/history.md`](../docs/history.md).

## `hakari-v1/`: the first study, "what it costs to fake a price"

HAKARI started on 2026-09-25 as a Uniswap-only entry that asked one question: how much does it cost to push a
Uniswap v4 pool's price, and how much value can safely settle on that price? It answered it with a cost model, a
settlement demo, a gauge that replays real Robinhood Chain weekends, and public pages. On 2026-09-27 the team folded
HAKARI into its 1inch Aqua entry, and the question on the main line became a narrower one: when should an option
writer that relies on a v4 price stop quoting? The study's measurements are why that answer exists; its code is no
longer needed for it.

| Path | What it was for |
|---|---|
| [`README.md`](hakari-v1/README.md) | The study's front page: the HIMS/USDG weekend of 2026-08-30 (a 10 % push for 12 USDG while minting was closed), the three layers, the internal review, limitations, prior art, provenance and AI disclosure |
| [`SPEC.md`](hakari-v1/SPEC.md) | The study's spec, the English translation of [`docs/prompts/2026-09-25-spec-zh.md`](../docs/prompts/2026-09-25-spec-zh.md) |
| [`src/PushCostLens.sol`](hakari-v1/src/PushCostLens.sol), [`src/libraries/TickBitmapView.sol`](hakari-v1/src/libraries/TickBitmapView.sol) | Prices a push of any v4 pool: exactly, by swapping inside `PoolManager.unlock` and reverting with the cost, or as a view that walks the tick bitmap through `StateLibrary`. Deployed on 46630 at `0xE1AA7dD1Bd65bC9a88fbE62CE03aa4cBb7BfDCa2` |
| [`src/CostModel.sol`](hakari-v1/src/CostModel.sol) | Turns a push cost into the largest exposure a pool can carry ("the line") |
| [`src/SafeSettle.sol`](hakari-v1/src/SafeSettle.sol) | A demo consumer: settles on the hook's TWAP only below the line, refuses above it. Deployed and verified on 46630 at `0xf360b8ebe3A68e8029308A8CAa76E867B0F02c84` |
| [`src/ExposureGuard.sol`](hakari-v1/src/ExposureGuard.sol), [`src/interfaces/IVexi.sol`](hakari-v1/src/interfaces/IVexi.sol) | A hook-free consumer of `CostModel` that read a testnet venue's ERC-6909 exposure against the line. Not the SwapVM `ExposureGuard` in [`aqua/`](../aqua/), which is unrelated |
| [`src/demo/NaiveSpotConsumer.sol`](hakari-v1/src/demo/NaiveSpotConsumer.sol) | The "trusts slot0" consumer of the three-layer demo |
| [`test/`](hakari-v1/test/) | Tests of the above: unit, the three-layer demo, the walk fixture, and fork tests of the lens and the guard on 4663 |
| [`script/`](hakari-v1/script/), [`broadcast/`](hakari-v1/broadcast/), [`deployments/`](hakari-v1/deployments/) | Deploy and demo scripts for the lens, `SafeSettle` and the guard on 46630, their transaction records, HAKARI's own demo pool and two superseded deploy records |
| [`gauge/`](hakari-v1/gauge/) | The TypeScript gauge: weekend replays from Robinhood Chain's logs, the live baseline of 29 stock pools, the mint-window and reversion measurements, the consumers on 4663 (Morpho, Panoptic), the squeeze data |
| [`web/`](hakari-v1/web/) | The static pages that were served on GitHub Pages: the gauge, the live board, the minute-by-minute replay, the plain-words page, the testnet venue board. The old URLs under `web/` redirect here |
| [`docs/demo-outputs/`](hakari-v1/docs/demo-outputs/), [`docs/img/`](hakari-v1/docs/img/) | Recorded test and demo outputs, and the charts the README and the pages draw |

The contracts above that are still deployed on 46630 keep working; nothing on the main line calls them.

Still on the main line from the study: [`src/HakariOracleHook.sol`](../src/HakariOracleHook.sol) (deployed on 46630
at `0x3b58D774cE351227B24A91103b20bA4fc068D080`, the oracle the band in [`aqua/`](../aqua/) reads), its tests,
its deploy script and the prompt record in [`docs/prompts/`](../docs/prompts/). The study's feedback is now in
[`feedback-history.md`](feedback-history.md); the root [`FEEDBACK.md`](../FEEDBACK.md) covers the current band.
