# Rules for AI agents working in this repo

HAKARI is an ETHGlobal Tokyo 2026 entry (Uniswap Foundation prize). These rules bind every
AI session that edits the repo. The product spec is `SPEC.md`; the original prompt that
produced it is under `docs/prompts/`.

1. **Robinhood Chain mainnet (chain id 4663) is read-only.** Every transaction is sent to a
   local anvil fork of 4663 or to the testnet (chain id 46630). No script in this repo may
   broadcast to 4663.
2. **Hackathon provenance.** Code written before the hackathon started (2026-09-25 21:00 JST)
   is not pasted in. Knowledge and public on-chain data are reused; code is rewritten here.
   Public libraries are fine: `v4-core`, `uniswap-hooks` (OpenZeppelin), `forge-std`, `viem`.
   Pre-existing work we build on is listed in `README.md` § "Provenance".
3. **Secrets.** Never read, print or log a `.env` file or a private key. The 46630 deploy key
   lives only in an environment variable; it never appears in `argv` or in a log line.
4. **Licence and language.** MIT, English. Commit continuously; a single last-day commit is
   grounds for disqualification.
5. **Disclosure.** AI-generated code is disclosed in `README.md` § "AI disclosure". Prompts
   that shape the work are appended to `docs/prompts/log.md` as they are used.
6. **Honesty in `FEEDBACK.md`.** Only friction actually hit is written down, with what was
   tried and what worked.
