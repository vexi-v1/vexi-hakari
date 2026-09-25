# Prompts and planning artifacts

ETHGlobal asks spec-driven teams to include every spec file, prompt and planning artifact in
the repository. This directory is that record.

| File | What |
| --- | --- |
| `2026-09-25-spec-zh.md` | The original spec, in Traditional Chinese, as handed to the AI at H0. `SPEC.md` at the repo root is its English translation. The internal "after the hackathon" half of the same document is about our other project and is not part of this submission. |
| `log.md` | Every prompt that shaped the work after H0, appended as the session goes, with the time and what came out of it. |

Tooling: Claude Code (Anthropic) driven by one human. The human decided what to build (the
spec), what to cut, and reviewed every contract and test; the AI wrote code, tests and docs
under `AGENTS.md`. See `README.md` § "AI disclosure" for the per-file split.
