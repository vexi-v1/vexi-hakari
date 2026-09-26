# Rules for AI agents working in this repo

HAKARI is part of an ETHGlobal Tokyo 2026 entry (1inch "Build an Aqua App" and Uniswap Foundation "Best Uniswap
Stack Contribution", Continuity Track). These rules bind every AI session that edits the repo. What the repo is:
`README.md`; how it got here: `docs/history.md`; the prompts that shaped it: `docs/prompts/`.

Layout: the root is the hook's Foundry project (`src/HakariOracleHook.sol`, solc 0.8.26). `aqua/` is a second,
self-contained Foundry project (solc 0.8.30, its own `lib/`): the Aqua writer, the book, the SwapVM guard, the band
and the settlement source. `archive/` is the first study, kept as it was; do not edit it except to fix a link.

1. **Robinhood Chain mainnet (chain id 4663) is read-only.** Every transaction is sent to a local anvil fork of 4663
   or to the testnet (chain id 46630). No script in this repo may broadcast to 4663.
2. **Hackathon provenance.** Code written before the hackathon started (2026-09-25 21:00 JST) is not pasted in.
   Knowledge and public on-chain data are reused; code is rewritten here. Public libraries are fine as pinned
   submodules.
3. **This repository is public; the team's product code is not.** Bring nothing in from the private repositories
   beyond what `docs/extraction.md` lists, and write nothing about how the product prices options or sizes its risk.
   The band's width is a fixed percentage; keep it that way unless the owners decide otherwise.
4. **Secrets.** Never read, print or log a `.env` file or a private key. A deploy key lives only in an environment
   variable; it never appears in `argv` or in a log line.
5. **Licence and language.** File by file (`LICENSE`); English. Commit in small steps.
6. **Disclosure.** Prompts that shape the work are appended to `docs/prompts/log.md` as they are used, leaving out
   anything rule 3 keeps private.
7. **Honesty in `FEEDBACK.md`.** Only friction actually hit is written down, with what was tried and what worked.
