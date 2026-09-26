# Public demonstration website

The root `index.html` is the current HAKARI demonstration. It is a static site for
[GitHub Pages](https://vexi-v1.github.io/vexi-hakari/), with no backend, wallet connection, private key, analytics,
CDN dependency or runtime RPC. Deployment status depends on the published branch; a local build does not update
Pages. The first study is linked separately in the footer through its archived source.

## What the visitor can verify

The primary replay follows one continuous `test_WebsiteLifecycle` execution, with the same accounts, wallet and
orders throughout all 15 steps:

1. Maker has 30 TSLA and 20,000 USDG. Buyer and spot taker are separate test accounts.
2. Ship and bind the option strategy, then ship a guarded canonical SwapVM strategy. Tokens stay in the wallet.
3. Post 10 calls and 10 puts at strike 400 USDG. Promises become 10 TSLA and 4,000 USDG; book balances stay zero.
4. Swap 400 USDG through the guarded canonical router. Only unpromised TSLA backs this spot strategy.
5. Buy 5 calls and 3 puts. Aqua pulls 5 TSLA and 1,200 USDG; the buyer separately pays band-adjusted premiums.
6. Push the reference +2.5%: cap shrinks and premium widens.
7. Push +5.1%: a real buy refuses, with unchanged buyer funds and longs.
8. Restore the reference: a fresh quote can be read.
9. Advance to the original quote deadline: a buy refuses despite an open band.
10. Maker explicitly publishes renewed anchored quotes.
11. At expiry, accept and record the first five-minute TWAP window; settle both series.
12. Exercise 3 ITM puts: buyer delivers 3 TSLA and receives 1,200 USDG. The calls are OTM.
13. After the exercise window, close both orders: 5 unused call TSLA and 3 exercise TSLA return through Aqua.
14. Claim premiums separately through Aqua; the book has zero token balances.
15. Release expired unfilled promises. Returned balances do not themselves create new orders.

The page displays each snapshot and the previous snapshot, virtual balances separately from token balances,
band/quote status, and captured EVM logs. The display truncates fractional digits; the downloadable JSON retains
exact integer amounts as strings. Book token balances include premiums and exercise proceeds as well as escrow.
An available quote is not a guarantee that remaining inventory or collateral will allow a buy.

Four separate tests demonstrate original-anchor refusal after a rolling center recovers, the failure without an
inventory guard, delayed settlement and no-window refunds. These cases start from independent fixtures; they do
not extend the main replay. The interactive band calculator is explicitly illustrative and never modifies the
recorded data. It implements the fixed band and integer rounding for the stated assumptions, not a full oracle or
book simulator. Its cap is per call; repeated fills can exceed it.

## Reproduce the evidence

Install Python 3 and Foundry; initialize the repository's pinned submodules. `demo.json` records the Foundry build,
base Git revision, dependency revisions and SHA-256 source fingerprint used for the shipped data.

```bash
git clone --recurse-submodules https://github.com/vexi-v1/vexi-hakari.git
cd vexi-hakari
python3 scripts/website-evidence.py
python3 scripts/build-website.py
python3 -m http.server 8787 --directory _site --bind 127.0.0.1
```

Open `http://127.0.0.1:8787`. Use an HTTP server rather than opening `index.html` as a `file:` URL, because the
browser fetches the JSON artifact. Node.js 24 runs the small calculator checks:

```bash
node --test website/band.test.mjs
```

The generator runs five tests in `aqua/test/WebsiteEvidence.t.sol` with `EXPORT_WEBSITE=true`, then publishes:

| Artifact | Contents |
|---|---|
| `website/evidence/demo.json` | Scenario snapshots, raw local EVM logs, addresses, fork pin and provenance |
| `website/evidence/trace.txt` | Successful Foundry `-vvvv` trace, with the RPC endpoint redacted |
| `website/evidence/source.zip` | Exact first-party source/configuration inputs and applicable license files |
| `website/evidence/source-files.json` | SHA-256 of each source input |

The generator stops on a failed test and never replaces the public evidence with a failed run. If
`sourceInputsModified` is true, the base revision alone is insufficient: check out that revision and overlay the
files from `source.zip`, then initialize the dependency revisions recorded in `demo.json` and rerun. The snapshot
contains the generator and the test, so uncommitted input changes remain inspectable and reproducible. It contains
no dependency source; those are the pinned public submodules. A newly generated manifest can have a different base
revision or dirty flag even when its source fingerprint and contract snapshots match. Trace wall time and gas
instrumentation are not promised to be byte-identical across tool versions.

An archive RPC must serve block **72,248,228** on Robinhood Chain **4663**. The default is
`https://rpc.ordofi.network`; override `RH_MAINNET_RPC` in the environment if needed. The fork pin cannot silently
fall forward to latest. No script broadcasts a transaction, and no wallet key is required. The export suppresses
RPC endpoint values in the published trace; never substitute secrets into source files.

Fixture construction is explicit: Foundry `deal` funds synthetic accounts, `prank` acts as those accounts,
`etch` installs the verified testnet hook runtime, and a new pool is created on the canonical v4 PoolManager.
Two hours of generated alternating swaps populate its observation ring. The reference-pool trader is separate
from the maker, buyer and spot taker. Canonical Aqua and SwapVM come from the pinned fork. This is an integration
execution in a local EVM, not organic market history or a public transaction stream.

The build verifies the source fingerprint, artifact checksums, expected scenario/step inventory, monotonic test
timestamps and conservation of both tokens across maker/buyer/book/spot-taker at every lifecycle step. Changed
source inputs require regenerating evidence. The build then copies a fixed allowlist into `_site`; it never
publishes the repository wholesale. `source.zip` is also made from a source-file allowlist.

## GitHub Pages

The existing Pages URL is `https://vexi-v1.github.io/vexi-hakari/`. The repository was configured to publish the
root of `main` when this work began. To use `.github/workflows/website.yml`, select **GitHub Actions** under
**Settings → Pages → Build and deployment → Source**. Then publish the reviewed website changes to `main`.

The workflow checks the calculator, verifies the committed evidence and uploads only `_site`. The deploy job
requires `pages: write` and `id-token: write`, targets the `github-pages` environment, and runs only on `main`.
Pull requests build and verify without deploying. It uses relative asset URLs, so it works under the repository
subpath or a custom domain. Evidence generation is a separate explicit operation; a Pages build does not depend
on RPC availability or regenerate financial scenarios opportunistically.

This configuration follows GitHub's [custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Scope

Public fixed premiums, quote deadlines, optional original anchors and a fixed-percentage band only. The five-percent
width is a configurable example, not a calibration or implementation of equity LULD rules. Quote refusal checks
are distinct from experimental settlement-window selection. A later accepted window can change expiry economics;
a persistent genuine gap can result in pooled-premium refunds. See [settlement.md](settlement.md).

Aqua — © Degensoft Ltd 2025. Powered by SwapVM — © Degensoft Ltd 2025.
