# Prompts and planning artifacts

ETHGlobal asks spec-driven teams to include every spec file, prompt and planning artifact in
the repository. This directory is that record.

| File | What |
| --- | --- |
| `2026-09-25-spec-zh.md` | The original spec, in Traditional Chinese, as handed to the AI at H0. [`archive/hakari-v1/SPEC.md`](../../archive/hakari-v1/SPEC.md) is its English translation. The same document had a second part: a post-hackathon plan for connecting this work to our other project. It gave no instructions for this build and no code here came from it, so it is not included. |
| `log.md` | Every instruction that shaped the work after the spec, in order, with what came out of it. |

Tooling: Claude Code (Anthropic), followed by Codex (OpenAI) for quote-validity changes, review and submission preparation. Eric wrote the spec and directed the build;
Abner directed the internal review and the docs passes. The public instruction record is in `log.md`;
the AI wrote the code, tests and docs under `AGENTS.md`.
See the root [README](../../README.md#provenance-and-ai-disclosure).
