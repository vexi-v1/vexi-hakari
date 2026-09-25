# Prompts and planning artifacts

ETHGlobal asks spec-driven teams to include every spec file, prompt and planning artifact in
the repository. This directory is that record.

| File | What |
| --- | --- |
| `2026-09-25-spec-zh.md` | The original spec, in Traditional Chinese, as handed to the AI at H0. `SPEC.md` at the repo root is its English translation. The same document had a second part: a post-hackathon plan for connecting this work to our other project. It gave no instructions for this build and no code here came from it, so it is not included. |
| `log.md` | Every instruction that shaped the work after the spec, in order, with what came out of it. |

Tooling: Claude Code (Anthropic) driven by one human. The human wrote the spec, made every decision
recorded in `log.md`, and ordered the reviews; the AI wrote the code, tests and docs under `AGENTS.md`.
See `README.md` § "AI disclosure".
