# Aqua development artifacts

Imported on **2026-09-27** in response to the owner's request to restore the missing AI development documents.
These are records of work during the event, recovered from the private Aqua repository's Git objects. The source
commits were not merged into this repository. [manifest.json](manifest.json) identifies every source revision,
path, Git blob ID, author/committer date and SHA-256 checksum, separately from this import date.

Start with the [recorded build brief and review prompts](revisions/ai-usage-3696f0f.md.txt), then the
[spec](handoff/docs/SPEC.md.txt), [Aqua/SwapVM requirements](handoff/docs/spec-1inch.md.txt) and
[build plan](handoff/docs/plan.md.txt). The [current AI disclosure](../../ai-usage.md) maps the records to the files
judges review in this repository.

## Literal source documents

The twelve files below retain their original bytes. The `.txt` suffix presents them as historical source text:
relative links, commands and instructions inside them refer to the original repository at that time, not this
directory. They are not current instructions to a reader or agent. No private `.env` file or key was inspected.

| Artifact | Source revision | Why it is included |
|---|---|---|
| [Handoff README](handoff/README.md.txt) | `d941521`, 09-25 21:52 JST | The first document the recorded build brief instructed Claude Code to read |
| [SPEC.md](handoff/docs/SPEC.md.txt) | `d941521` | The original Aqua-only problem, book, interfaces and lifecycle specification |
| [spec-1inch.md](handoff/docs/spec-1inch.md.txt) | `d941521` | Aqua app, five invariants, SwapVM guard, requirements and initial open questions |
| [plan.md](handoff/docs/plan.md.txt) | `d941521` | Gates G0–G3, demo schedule, cut order and minimum deliverable |
| [demo.md](handoff/docs/demo.md.txt) | `d941521` | The original token-transfer demonstration plan |
| [facts.md](handoff/docs/facts.md.txt) | `d941521` | The integration facts and unresolved questions available at the handoff |
| [Initial ai-usage.md](handoff/docs/ai-usage.md.txt) | `d941521` | The original disclosure template; its empty code table is historical, not the completed record |
| [Empty environment template](handoff/env-template.txt) | `d941521` | The handoff spec's referenced `.env.example`, stored as text; no populated secret values |
| [Resolved integration facts](revisions/facts-36e7553.md.txt) | `36e7553`, 09-25 22:09 JST | Fork pin, public addresses and pinned Aqua/SwapVM interfaces resolved at G0 |
| [Reviewed demo plan](revisions/demo-e6329d7.md.txt) | `e6329d7`, 09-25 23:48 JST | The revised roles, canonical-router guard and decoded transfer presentation |
| [Revised integration specification](revisions/spec-1inch-53ab29a.md.txt) | `53ab29a`, 09-26 03:18 JST | The guard correction, exercise/grace behavior and independent holder refunds |
| [AI usage, build brief and review prompts](revisions/ai-usage-3696f0f.md.txt) | `3696f0f`, 09-26 16:02 JST | Tool attribution, the translated 21:58 build brief, per-change prompt summaries, human-review notes and the sponsor/technical-review briefs |

The recorded handoff was at 21:58 JST; its documents were committed at 21:52. The later files are explicitly
later revisions, not represented as the original handoff. Model labels are preserved as the source record states
them; this import does not independently authenticate model versions or every historical test result.

## Band source excerpts and the public adaptation

[band-source-excerpts.txt](band-source-excerpts.txt) preserves four exact passages from `docs/stability.md` at
`bf0bbed` (09-27 02:32 JST): source lines 15–19, 182–187, 212–213 and 222–224. They describe the HAKARI hook,
first-accepted-window settlement, permissionless recording and observation-ring availability. The manifest gives
the full source document's fingerprint, each included range's checksum and every omitted line range.

This is an **explicit excerpt**, not a copy of the full source spec. The omitted material includes private product
pricing/risk policy, private deployment examples and source-specific parameters outside the public entry. No
omitted text is rewritten or supplied as a purported historical prompt. The public band uses the fixed percentage
chosen during extraction, specified in [band.md](../../band.md); its experimental settlement is described in
[settlement.md](../../settlement.md). The owner's extraction instruction and the decision to use a fixed-premium
stand-in and a percentage band are recorded in [the public prompt log](../log.md).

The source AI log predates the band and contains no verbatim band conversation. The excerpts and public extraction
record document the surviving evidence; they do not imply that an unavailable conversation transcript was recovered.

## Reading the earlier statements correctly

| Historical wording or design | Current entry |
|---|---|
| `From Scratch`, the original 1inch prize amount, or a plan to publish the Aqua repo | Superseded by the single **Continuity Track** entry and two Continuity partner prizes; this repository is its public review repository. See [history](../../history.md) and [submission](../../submission.md). |
| Eric as the only human on the early Aqua project | Describes that source record's scope. The merged entry also records Abner's direction, review, extraction and documentation decisions. See [current AI usage](../../ai-usage.md). |
| `MiniBook`, a premium stored on each order, Chainlink settlement and its hint API | The public `OptionBook` has an `IPremium` seam; `FixedPremium` adds quote deadlines and optional anchors. Chainlink-specific source and scripts were not extracted. The hook-based settlement adapter has its own documented behavior. |
| No Aqua-related testnet deployment, then a later testnet demo | These are dated stages of the original build. The historical demo is not evidence that the full public stack is deployed today. Use the current [deployment scope](../../../README.md#on-robinhood-chain-testnet-46630). |
| Returned collateral is “promised again”, or a statement that a guard guarantees displayed depth | Aqua virtual credits are distinct from `promised` open orders; funds return through explicit calls to an active strategy. Fills still check wallet balances, allowance and strategy state. See [aqua/README](../../../aqua/README.md). |
| “No assets”, historical legal summaries, and claimed test counts | These statements belong to their source revision. The current logo attribution is in [extraction](../../extraction.md); current licensing is [LICENSE](../../../LICENSE), and historical test counts are not new verification runs. |

The source log itself distinguishes completed human review from “Eric to …” follow-ups. Preserve that distinction:
a requested check is not proof that it happened. Its translated briefs and faithful summaries are not full raw
chat transcripts. The separate review reports were not committed in the source repository; they have not been
reconstructed here. These limitations must remain visible when describing the package to reviewers.

## Verification and scope

The import was checked against the specified local Git objects: all twelve literal documents matched byte for
byte, and all four excerpts matched their declared source lines. The manifest lets a public reader check the
artifact fingerprints; someone with the original history can additionally compare the source blobs. Hashes and Git
timestamps identify records but do not independently prove when the work was created. Private source commit IDs
do not resolve inside this public repository. This package addresses missing documents, not publication of the
original development history or confirmation of external submission status.

Check the public artifact hashes from the repository root:

```bash
python3 - <<'PY'
import hashlib, json
from pathlib import Path
root = Path('docs/prompts/aqua')
manifest = json.loads((root / 'manifest.json').read_text())
for item in manifest['artifacts']:
    data = (root / item['artifactPath']).read_bytes()
    assert hashlib.sha256(data).hexdigest() == item['artifactSha256'], item['artifactPath']
    if item['mode'] == 'verbatim':
        assert item['artifactSha256'] == item['sourceSha256'], item['artifactPath']
print('13 historical artifacts verified')
PY
```

The extraction inventory authorizes this scope. Do not copy newer versions of the private product's documents
over these records: they contain material excluded from this entry. Missing originals are identified as missing;
current explanatory text on this page was written at import time.

Aqua — © Degensoft Ltd 2025. Powered by SwapVM — © Degensoft Ltd 2025.
