# Submission readiness review — 2026-09-27 JST

**The implementation is demonstrable locally, but the submission is not yet verified complete.** The local
working tree passed 5 hook tests and 92 Aqua/band/settlement tests. The public default branch still showed the
previous study when checked anonymously; the current integration must be published before judges can inspect it.

## Required actions before submission

| Priority | Finding | Evidence / action to close it |
|---|---|---|
| P0 | Public repository does not yet contain this entry | GitHub's unauthenticated tree API returned `main = aefa9236a1302ace3e766266eb44a27aaa8a8fbc`, with no `aqua/`, at about 04:22 JST. Local work is on `tk-137-aqua-band-slice` with uncommitted changes. Publish the reviewed integration and verify the submitted ref anonymously; preferably make it the default branch. A local passing suite is not evidence that judges can access that code. |
| P0 | Open-source eligibility is unresolved | `AquaWriter.sol`, `OptionBook.sol`, and `ICollateralSource.sol` are BUSL-1.1 with no additional use grant until 2028-09-27. The event requires new Continuity work to remain open source; Uniswap also requires open-source code. Ask the owners to approve an appropriate open-source license for these team-owned files, or obtain the organizers' explicit acceptance of this mixed-license scope. Do not represent public source availability as resolved eligibility. |
| P0 | No Uniswap form receipt is recorded | Having `FEEDBACK.md` does not complete the separate Developer Feedback Form. Use [the prepared answers](uniswap-feedback-draft.md), include the public `FEEDBACK.md` URL, submit with the actual participant's details, and retain confirmation. |
| P0 | Dashboard completion and partner selection are unverified | The supplied `/events/tokyo2026/project` link redirects to sign-in in the review browser. Verify the actual title, descriptions, repository revision, selected Continuity track, both partner prizes and final submitted status. The link alone is not a submission receipt. |
| P1 | Transfer demonstration needs to be presented | [demo.md](demo.md) and `bash scripts/judge-demo.sh` now provide reproducible call traces. Record or present the successful ERC-20 transfers, `Pulled`/`Pushed`, the SwapVM fill and the band's refusal. A test count or archived website by itself is insufficient evidence for this requirement. |
| P1 | Current submission has no verified demo-video URL | A video is optional under the general event rules, but strongly useful for partner review. Record the current integration, not only the archived study. Add its URL to the dashboard and README when available. |
| P1 | Imported work's development evidence needs a final check | `history.md` describes when the private implementation was written; those dates are not independently established by public commit history. Preserve genuine history and reviewable, non-sensitive event-time spec/prompt artifacts for the extracted integration. Do not fabricate intermediate commits or expose the private product. |

These are completion checks, not a request to redeploy to mainnet. Neither targeted prize requires the full
entry to be deployed there; 1inch explicitly permits a local fork.

## Official requirements mapped to evidence

Checked against the live pages on 2026-09-27:

- [1inch: Build an Aqua App — Continuity Track](https://ethglobal.com/events/tokyo2026/prizes/1inch): a custom
  Aqua position using official Aqua/SwapVM contracts, executable transfers in the demo (local forks allowed),
  and genuine development history. SwapVM use is favored. The matching evidence is `AquaWriter`, canonical-router
  `Extruction`, lifecycle tests and the demo runner. Select the Continuity-specific award, rather than describing
  this as a Classic entry.
- [Uniswap: Best Uniswap Stack Contribution — Continuity](https://ethglobal.com/events/tokyo2026/prizes/uniswap-foundation):
  public open-source code, `FEEDBACK.md`, the completed Developer Feedback Form linking that file, and README
  pointers to integration code and lines. The hook/band code and feedback exist; license eligibility, publication
  and form completion remain the checks above.
- [ETHGlobal submission instructions](https://ethglobal.com/events/tokyo2026/info/details): deadline **2026-09-27
  09:00 JST**; select the partner prizes in the dashboard, disclose reused work and AI assistance, and preserve
  development artifacts. [Continuity rules](https://ethglobal.com/rules) require substantive new work and an
  explicit account of what predated the event.

## What is already present

- An Aqua app with exact-fill collateral pulls, return flows, live availability checks, and lifecycle tests.
- Both a custom SwapVM opcode and a canonical-router `Extruction` integration, with a negative control showing
  why the guard matters.
- A real v4 hook, testnet hook/pool records, an executable band consumer, fixed-quote expiry and optional original
  anchors, and explicit experimental-settlement limitations.
- English submission text, an architecture diagram, history/extraction notes, licenses and substantial Uniswap
  feedback. [Reviewer code pointers](reviewer-code-map.md), [demo instructions](demo.md) and
  [form answers](uniswap-feedback-draft.md) supplement these materials.

## Judge-facing weaknesses to address in the presentation

| Likely objection | Accurate response / remaining limitation |
|---|---|
| “This is only an OpenZeppelin oracle wrapper.” | Credit `BaseOracleHook`. Lead with the v4-backed rule that actually rejects an `OptionBook.buy`, and show one successful buy across both sponsors. The wrapper alone is a small contribution. |
| “Shared liquidity guarantees every displayed order can fill.” | It does not. The maker can move funds, revoke approval or dock a strategy. `available` and the atomic collateral check refuse an underfunded fill. Only strategies using the guard honor its promise policy. |
| “A 5% band establishes a safe or correct stock price.” | It is an owner-configured demo parameter, not LULD implementation, external price verification or an attack-cost guarantee. The center can follow a persistent move. Optional original anchors and mandatory deadlines address stale terms, not economic fair pricing. |
| “Collateral always returns automatically at expiry.” | Returning funds requires close/claim transactions and an active Aqua strategy. The existing `test_DockedStrategyBlocksCloseUntilTheMakerRebinds` shows that docking blocks close until the maker rebinds. Holder refunds on an unsettled series are a separate path. |
| “The size taper caps total risk.” | It caps one call. Splitting trades can consume more of the posted order; there is no aggregate/time-based risk budget. Default `minLiquidity = 0` also provides no meaningful positive-depth threshold until configured. |
| “Settlement refusal is automatically safer.” | A caller must retry, deferred acceptance selects a later price, and a genuine gap can cause premium refunds instead of exercise. Explain this as an experimental adapter, not the central production claim. |
| “It is already a usable deployed options product.” | The public deliverable is a contract integration with tests and scripts. The testnet hook/pool exist; the full public stack and a current trading UI are not deployed from this repository. Private product deployments are not evidence for this public code. |

## Licensing decision to resolve with the owners

The team-owned files requiring a decision are:

1. `aqua/src/aqua/AquaWriter.sol`
2. `aqua/src/book/OptionBook.sol`
3. `aqua/src/book/ICollateralSource.sol`

If their copyright owners approve MIT, update the three SPDX headers, the root license map and README license
paragraph together. Keep upstream licenses and SwapVM-derived notices intact. No license change was made in this
review. [MariaDB's BSL explanation](https://mariadb.com/bsl-faq-mariadb/) distinguishes present source availability
from open-source status after the change date; sponsor acceptance of the current combination is not established.

## Verification record

At the review snapshot, Foundry 1.3.5 with solc 0.8.26 / 0.8.30:

```text
root: forge test
5 passed, 0 failed, 0 skipped

aqua: RH_MAINNET_RPC=https://rpc.ordofi.network RH_MAINNET_FORK_BLOCK=72248228 forge test
92 passed, 0 failed, 0 skipped; 10 suites
```

The [demo rehearsal transcript](evidence/2026-09-27-demo.txt) records **12 selected tests passed**, including
actual Aqua pull/push call excerpts and the band's expected refusal. These are a subset of the suites above.

The initial sandboxed runs crashed in Foundry's macOS system-proxy initialization. Running the same tests outside
that sandbox succeeded. This was an execution-environment issue, not a Solidity test failure. No `.env` contents
or keys were inspected; no deployment or mainnet transaction was sent. Existing uncommitted quote-validity changes
were present and are included in these results; this review did not author those contract changes.

## Final handoff checklist

- [ ] Owners resolve the three BUSL file licenses or obtain an explicit eligibility answer.
- [ ] Publish the complete reviewed revision, preserving real history; verify a fresh recursive clone.
- [ ] Ensure README code links and the feedback link open without a signed-in GitHub session.
- [ ] Rehearse the demo; preserve visible transfer and refusal evidence. Add the optional recording URL.
- [ ] Complete the Uniswap form with genuine ratings/contact details and save its confirmation.
- [ ] Confirm the dashboard's Continuity track, both sponsors and the full submitted state before 09:00 JST.

Unmarked items mean **not verified**, not necessarily that the team has never done them elsewhere.
