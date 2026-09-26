# Prompts and planning artifacts

ETHGlobal asks spec-driven teams to include their specs, prompts and planning artifacts. This directory indexes
the surviving source documents and recorded instructions for this public entry. [Current AI usage](../ai-usage.md)
maps tools, human direction and evidence to the public files; the records identify summaries, excerpts and missing
original transcripts rather than claiming a complete raw conversation archive.

| File | What |
| --- | --- |
| `2026-09-25-spec-zh.md` | The original spec, in Traditional Chinese, as handed to the AI at H0. [`archive/hakari-v1/SPEC.md`](../../archive/hakari-v1/SPEC.md) is its English translation. The same document had a second part: a post-hackathon plan for connecting this work to our other project. It gave no instructions for this build and no code here came from it, so it is not included. |
| `log.md` | Recorded instructions that shaped the public work after the spec, with their outcomes; some entries are translations or faithful summaries. |
| [Aqua artifact package](aqua/README.md) | The original Aqua handoff specs, plan, demo/facts and later AI-usage record, plus explicit public-interface excerpts from the source band document. Twelve literal documents and one excerpt artifact, with full source commits, paths, dates and checksums. |

Tooling: Claude Code (Anthropic), followed by Codex (OpenAI) for quote-validity changes, review and submission preparation. Eric wrote the spec and directed the build;
Abner directed the internal review, public extraction and docs passes. The public instruction record is in `log.md`;
the recovered Aqua record describes Eric's original build direction and review. AI assisted the code, tests and docs
under `AGENTS.md`; [the file-level disclosure](../ai-usage.md) identifies the scope and record limitations.
See the root [README](../../README.md#provenance-and-ai-disclosure).

Aqua — © Degensoft Ltd 2025. SwapVM — © Degensoft Ltd 2025.
