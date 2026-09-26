# Integration reconciliation — 2026-09-27

The event-time integration was checked again after fetching the latest source branches. This is an extraction
review, not a claim that the private product was copied in full. The boundary remains [extraction.md](extraction.md).

## Coverage

| Integration | Public implementation and demonstration | Result |
|---|---|---|
| Aqua shipping, fill-time pull, close/premium push | `aqua/src/aqua/AquaWriter.sol`, `OptionBook`, `LifecycleTest`, website lifecycle | Present and retested |
| Shared backing across option series | `AquaWriter.available` reads remaining Aqua balance, wallet and approval; `ExposureGuardCanonicalTest.test_SharedBalanceAcrossSeriesStillTradesSpotAndLimitsFills` | New executable demonstration |
| SwapVM guard on native and canonical routers | `aqua/src/swapvm/`, instruction/Extruction agreement and actual canonical swaps | Latest shared-balance policy ported |
| Uniswap v4 oracle hook | `src/HakariOracleHook.sol`, hook tests and fork consumers | Present and retested |
| Raw/truncated TWAP, reference liquidity, taper and quote pause | `aqua/src/band/StabilityBandPricer.sol`, band/fork tests, bilingual website | Present; public fixed-width policy retained |
| TWAP expiry windows, deferral and refund | `HookTwapExpiryPrice`, settlement tests and website cases | Present; experimental limitations retained |
| Presentation | `docs/demo.md`, `scripts/judge-demo.sh shared`, bilingual website section, existing three/six-minute decks | Shared-balance scene added to site and terminal script; decks remain the earlier narrative |
| Historical deployed SwapVM modification | `aqua/deployed-46630/` | Historical source retained; not represented as the newly updated router |

## The missing update that was found

The guard previously reserved the sum of every unfilled option promise. With many series quoting the same
backing, that sum can exceed the wallet and freeze spot even when the option strategy cannot pull all of it.
The updated guard reserves `min(promised(token), writer strategy virtual balance(token))`, leaving
`max(wallet - reserve, 0)` for spot. It uses Aqua's published `rawBalances` ABI; both native and Extruction forms
share the implementation. This brings over only the permitted SwapVM integration change.

The new call scenario has 30 TSLA in the wallet and 10 TSLA in the writer's Aqua strategy. Two distinct expiries
each quote 100 calls: aggregate promises are 200 TSLA, shared backing is 10, and 20 remain available for spot.
A canonical SwapVM spot fill succeeds. Buying five calls from one series leaves five available to the other;
buying those exhausts the strategy, and a further buy reverts without taking additional collateral. A put test
covers quote-token collateral; another test checks native/Extruction quote parity with oversubscribed promises.
Posted size is not guaranteed simultaneous fill capacity. Wallet withdrawals and approval changes can still
reduce fillability. Only spot strategies carrying the guard follow this policy.

## Intentional differences and remaining boundaries

- Private product pricing, vault accounting, trading UI and product order features remain excluded. FixedPremium
  and a plain maker wallet are the public stand-ins. The fixed-width band remains the disclosed public policy.
- The integration-related source update since the earlier extraction was in ExposureGuard; the source hook band
  and settlement files had no newer event-time change in that interval. Public versions are adaptations, not
  byte-identical copies of the private product.
- Workspace research and its earlier submission ticket are historical planning evidence, not the current public
  submission specification. The current public README/history describe the combined entry. Private notes were
  not imported into this repository.
- The original `aqua/deployed-46630` files still describe their recorded historical deployment. Its original
  bytecode check does not validate a later router. This round neither broadcasts nor claims a new deployed-code
  match. The public band/book/writer stack is still demonstrated on a local fork.
- Existing presentation decks remain available; the additional shared-balance scene is in the bilingual website
  and runnable terminal demo. The main website replay remains five independent scenarios, with this new test
  explicitly described separately rather than fabricated into that recording.
- Repository changes and evidence are local until published. Existing local presentation commits and submission
  edits were preserved. No private repository, deployment or event submission was published by this review.

## Validation

All on-chain execution below is local Foundry fork execution at block 72,248,228. Mainnet is read-only.

| Check | Result |
|---|---|
| Root `forge test -vv` | 5 passed, 0 failed |
| Aqua `forge test -vv` with the pinned fork | 100 passed, 0 failed |
| `bash scripts/judge-demo.sh shared` | 2 passed, 0 failed; [full trace](evidence/2026-09-27-shared-balance.txt) |
| `python3 scripts/website-evidence.py` | Five website scenarios regenerated from current public source |
| `node --test website/*.test.mjs` | 7 passed, 0 failed |
| `python3 scripts/build-website.py` | Source fingerprints, artifact hashes, scenario inventory and token conservation passed |

The exported source archive and manifest identify the exact input files, including local modifications. The
historical demo transcript remains a record of its own earlier run.
