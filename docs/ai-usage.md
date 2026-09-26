# AI usage in the public entry

This is the current disclosure for the merged Vexi × HAKARI Continuity entry. It covers the public code, tests,
documentation and website. Earlier artifact wording describes earlier stages; [history.md](history.md) and
[extraction.md](extraction.md) define what this entry includes. The disclosure was consolidated on 2026-09-27.

## People and tools

Eric directed the original Aqua implementation: the preserved source record attributes the specs to Eric working
with Claude, and records the gate checks and requested review/rework. Abner directed HAKARI's review, the public
extraction, the fixed-percentage demonstration scope, licensing/documentation decisions and website work. The
prompt log records decisions and corrections, including approaches rejected before they were built. These are
the team's recorded contributions; this document does not claim independent observation of every historical review.

Claude / Claude Code (Anthropic) assisted the initial specs, implementation, tests and documentation. The Aqua
source log records its original model labels and the translated build/review briefs. Codex (OpenAI) assisted the
subsequent quote-validity work, review, submission documentation, evidence-backed website and this artifact import.
AI assistance is extensive across these files; the human contribution is problem selection, specifications,
acceptance criteria, evaluation of evidence and decisions about the implementation and public scope.

## Where AI was used

| Public files / assets | AI assistance | Human direction and surviving record |
|---|---|---|
| `src/HakariOracleHook.sol`, root tests/scripts and the first study in `archive/hakari-v1/` | Claude Code: implementation, tests, measurement tooling and explanatory documents | Eric's [original HAKARI spec](prompts/2026-09-25-spec-zh.md); Eric/Abner's follow-up decisions and review in [the prompt log](prompts/log.md). The oracle itself is credited to OpenZeppelin/Panoptic. |
| `aqua/src/aqua/`, `aqua/src/book/OptionBook.sol`, collateral/price interfaces and `FixedExpiryPrice`; corresponding lifecycle/refund tests | Claude Code: original Aqua caller, book, tests, later review fixes and public adaptation | Eric's [Aqua spec and plan](prompts/aqua/README.md), original five invariants, build brief, per-change summaries and review prompts. Abner's extraction instruction removed private product features; the original `MiniBook` is not claimed to be identical to the public `OptionBook`. |
| `aqua/src/swapvm/`, SwapVM-derived test helpers, `aqua/deployed-46630/src/` | Claude Code: custom instruction, router table, canonical `Extruction`, tests and source publication | The same [Aqua records](prompts/aqua/revisions/ai-usage-3696f0f.md.txt) record the guard correction and review; the [public log](prompts/log.md) records the later decision to publish the deployed router. Upstream SwapVM's code and license remain attributed. |
| `aqua/src/band/`, hooked-pool/band scripts and band/settlement tests | Claude Code: source integration and its public fixed-percentage adaptation; Codex: later quote-validity integration and explanatory review | The source document's [explicit public-interface excerpts](prompts/aqua/band-source-excerpts.txt), Abner's [extraction instruction](prompts/log.md), and current [band](band.md) / [settlement](settlement.md) specifications. The source band conversation is not present in the saved AI log; no verbatim transcript is claimed. |
| `aqua/src/book/FixedPremium.sol`, `IQuoteReference.sol`, quote-expiry/anchor tests and corresponding band changes | Claude Code: initial fixed-premium stand-in; Codex: mandatory deadline, optional captured anchor and tests | Abner's public-scope and stale-quote review instructions in [the log](prompts/log.md); [quote-validity specification](band.md#quote-validity-is-separate-from-the-rolling-band). |
| `aqua/test/WebsiteEvidence.t.sol`, `scripts/website-evidence.py`, `scripts/build-website.py`, `index.html`, `website/` and Pages workflow | Codex: continuous fork scenarios, export/build code, replay, calculator, English/Traditional Chinese presentation and tests | Abner requested a reproducible website, then bilingual presentation and Vexi branding. Requests are in [the log](prompts/log.md); exact source/configuration inputs for the recorded EVM evidence are identified in `website/evidence/source-files.json`. |
| README, feedback, submission/demo/reviewer documentation and this artifact index | Claude Code and Codex: drafting, review, link checks and organizing evidence | Eric's original brief; Abner's review and submission-preparation instructions in [the log](prompts/log.md). An AI-authored preparation draft is not proof of a submitted form's final fields. |

The existing Vexi logo is a reused branding asset authorized by the owner, not a newly AI-generated image. Its
reuse is disclosed in [extraction.md](extraction.md). The website uses public-site code and system-font fallbacks.
The visual band calculator is illustrative; the EVM replay data comes from actual local-fork tests, not invented
market history. Only repository assets are covered here; any separately submitted slide/video assets need their
own accurate attribution.

## Specs, prompts and plans available to reviewers

- [HAKARI original spec and instruction log](prompts/README.md).
- [Recovered Aqua artifact package](prompts/aqua/README.md): twelve literal historical documents, including the
  implementation handoff and later AI-usage log, plus one clearly labeled set of band-source excerpts.
- [Source manifest](prompts/aqua/manifest.json): full source commits, paths, Git blob IDs, dates and checksums;
  included/omitted ranges for the excerpted document.
- [Current public band specification](band.md), [settlement specification](settlement.md), [demo plan](demo.md)
  and [website specification](website.md), with the shaping instructions in [the public log](prompts/log.md).

The preserved Aqua log already uses translated briefs and faithful summaries. Full raw conversations and separate
review reports were not present in the versioned source documents inspected for this import. This package does
not claim to recover those missing originals or to contain all private product planning. Exclusions are explicit
in the artifact index and extraction inventory; they are not replaced with invented historical instructions.
Public accessibility still depends on publishing the reviewed revision. Track/partner selection and the final
submission state are separate checks in [submission-review.md](submission-review.md).

Aqua — © Degensoft Ltd 2025. Powered by SwapVM — © Degensoft Ltd 2025.
