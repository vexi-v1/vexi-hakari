# Submission readiness review — 2026-09-27 JST

**The current integration and AI documentation are published; the external submission is not yet verified
complete.** The local working tree passed 5 hook tests and 92 Aqua/band/settlement tests at the implementation-review
snapshot. The earlier anonymous check found only the previous study; the publication check below supersedes
that finding. Document/link and website checks are separate from the earlier contract-test run.

## Required actions before submission

| Priority | Finding | Evidence / action to close it |
|---|---|---|
| Done | Publish the current integration to the public default branch | On 2026-09-27, `main` was fast-forwarded from `aefa923` to `290b189458c66dc4be988cbaf8f72fa1456355a5` and pushed, preserving the integration commits. Anonymous requests returned the current README, FEEDBACK, reviewer code map, OptionBook and AI-document indexes byte-for-byte. The actual dashboard revision and entered feedback URL remain separate checks. |
| Done | Open-source eligibility | `AquaWriter.sol`, `OptionBook.sol` and `ICollateralSource.sol` are MIT (were BUSL-1.1). ETHGlobal requires the new parts of a Continuity entry to remain open source, and neither 1inch prize nor 1inch's licenses ask for BUSL; the SwapVM extensions keep LicenseRef-Degensoft-SwapVM-1.1, which that license requires. See `LICENSE` and `THIRD_PARTY_NOTICES.md`. |
| Done | Uniswap Developer Feedback Form submitted | On 2026-09-27, the user confirmed completion and supplied the form's success message: "Thanks for sharing your feedback". See the submission confirmation below. The prepared answers remain in [the form draft](uniswap-feedback-draft.md). |
| Done; published | Missing Aqua AI development documents | [AI usage](ai-usage.md) and the [artifact package](prompts/aqua/README.md) now provide the original handoff specs/plan/demo/facts, the later AI-usage record and build/review briefs, plus explicit public-interface excerpts from the source band's document. The manifest identifies source Git objects and checksums. Raw conversations/review reports absent from the versioned source are disclosed as unavailable; the original development history and external submission state remain separate checks. |
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
  pointers to integration code and lines. The hook/band code and feedback exist; licensing was updated and the user
  confirmed form submission. Publication and public-link checks remain in the checklist below.
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

## Licensing decision (resolved 2026-09-27)

The three team-owned files that were BUSL-1.1 are MIT: `aqua/src/aqua/AquaWriter.sol`, `aqua/src/book/OptionBook.sol`
and `aqua/src/book/ICollateralSource.sol`. The rules that decided it:

- ETHGlobal, Rules on Pre-existing Work: "All new parts of extending an existing project must remain open source."
  These files were written at the event; BUSL-1.1 says of itself that it is not an open-source license.
- The 1inch prize texts set no license. 1inch's own licenses reach only code derived from Aqua or SwapVM: the SwapVM
  extensions must carry LicenseRef-Degensoft-SwapVM-1.1 (SwapVM-1.1 §3.1 A), and independent code that only calls
  Aqua is not subject to Aqua's copyleft (Aqua-Source-1.1 §3.3). `AquaWriter` only calls Aqua through `IAqua`;
  `OptionBook` and `ICollateralSource` import nothing from 1inch.
- Uniswap asks for a public repository with open-source code.

Upstream licenses stay intact: [LICENSES/SwapVM-1.1.txt](../LICENSES/SwapVM-1.1.txt) and
[LICENSES/Aqua-Source-1.1.txt](../LICENSES/Aqua-Source-1.1.txt) are byte-for-byte copies of the pinned texts, and
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) lists every dependency. Commercial use of Aqua or SwapVM still
needs a commercial license from Degensoft, whatever license our own files carry.

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

## Uniswap feedback submission — confirmed 2026-09-27

The user reported that the form was completed and supplied this success message:

> Thanks for sharing your feedback
> Your feedback helps us improve the developer experience for everyone building on Uniswap.

This records the participant's confirmation of a successful submission. The final field values and a submission
identifier were not provided; the preparation draft is not an exact transcript of the submitted answers.

## Public-document check — 2026-09-27

The document review made unauthenticated requests, without GitHub credentials. The repository was public, with
`main` as its default branch, but that branch still held the earlier study at
`aefa9236a1302ace3e766266eb44a27aaa8a8fbc`. The source revision reviewed locally started at
`c7cdd32`, plus the document changes from this review. Request timestamps, statuses, hashes and local-link results
are in [the check record](evidence/2026-09-27-public-documents.json). This is a dated snapshot, not a live status indicator.

At 05:03 JST, all 129 local document links resolved and 27 selected source anchors matched their intended
functions or statements. The public README and FEEDBACK pages returned HTTP 200 but contained the earlier study;
the public reviewer-code-map page returned 404. No contract tests were rerun for these documentation-only edits.

| Check | Meaning / completion condition |
|---|---|
| Public repository | Confirmed public through GitHub's unauthenticated API. This alone does not establish that the submitted implementation is present. |
| README and feedback content | Check the body as well as HTTP status. The old `main` has files with these names, so successful responses can still show the wrong project version. |
| Integration links | README now links to the hook, pool reads, observation handling, quote refusal, settlement and fork proofs by source line. Local path/anchor checks do not mark unpublished remote files as available. |
| Feedback quality | Eight build-experience findings have concrete implementation references and scoped requests. The revision credits existing cardinality NatSpec, avoids claiming the mint guide lacks action constants, and distinguishes test helpers and synthetic fork evidence from production integrations. |
| Form submission | User-confirmed complete. The draft recommends `https://github.com/vexi-v1/vexi-hakari/blob/main/FEEDBACK.md`; the actual entered URL was not recorded and still needs confirmation. Do not treat the draft as the submitted form. |
| Final public verification | After publication, resolve the submitted branch to a commit, fetch README, FEEDBACK and every linked integration file anonymously, check line targets, and record that commit. Verify the actual URL entered in the form; a correct URL whose content is updated does not by itself call for another form submission. |

## Final handoff checklist

Publication follow-up on 2026-09-27: [Actions run 36269481775](https://github.com/vexi-v1/vexi-hakari/actions/runs/36269481775)
built and deployed `290b189458c66dc4be988cbaf8f72fa1456355a5` successfully. Anonymous HTTP requests to the homepage
and its nine public assets returned HTTP 200 and matched the local build byte-for-byte; the seven selected
repository files named above (including both AI indexes and their manifest) also matched. The live browser loaded
all five scenarios; selecting replay step 7, switching English to Traditional Chinese, and selecting the calculator's
outside-band preset worked. Seven website tests and the source/evidence checksum build passed. A fresh recursive
clone and the external dashboard/form values were not verified in this publication check.

- [x] Owners resolve the three BUSL file licenses: MIT (see "Licensing decision").
- [x] Recover the missing Aqua AI documents locally, with file-level attribution, source manifest and explicit record limitations.
- [x] Publish the complete reviewed revision to `main`, preserving its existing commits.
- [ ] Verify a fresh recursive clone.
- [ ] Ensure README code links and the feedback link open without a signed-in GitHub session.
- [ ] Confirm the actual feedback URL entered in the completed form and that it serves the current integration feedback.
- [ ] Rehearse the demo; preserve visible transfer and refusal evidence. Add the optional recording URL.
- [x] Submit the Uniswap Developer Feedback Form; user-confirmed success message recorded above.
- [ ] Confirm the dashboard's Continuity track, both sponsors and the full submitted state before 09:00 JST.

Unmarked items mean **not verified**, not necessarily that the team has never done them elsewhere.
