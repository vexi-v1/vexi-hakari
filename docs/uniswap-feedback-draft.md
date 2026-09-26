# Uniswap Developer Feedback Form — ready-to-paste draft

Form: [developers.uniswap.org/hackathon-feedback](https://developers.uniswap.org/hackathon-feedback).
**Form status: submitted, confirmed by the user on 2026-09-27.** The success message is recorded in the
[submission review](submission-review.md#uniswap-feedback-submission--confirmed-2026-09-27).
The answers below are retained as the preparation draft, not an exact transcript of the final submission.
This document contains no participant contact details, ratings or consent.

## Selections and participant details

| Form field | Answer |
|---|---|
| First name, email, Telegram handle | Enter the submitting participant's actual details. Last name is optional |
| Which hackathon did you participate in? | ETHGlobal Tokyo 2026 |
| Did you complete a project during the hackathon? | Yes |
| Are you building an AI-powered or agentic project? | No — this public integration has no autonomous agent; AI assistance during development is disclosed below |
| Were you able to successfully integrate Uniswap into your project? | Yes |
| How long did it take to get your first successful integration working? | Select the actual elapsed time |
| Documentation and overall support ratings | Choose each rating from your own experience |
| Do you plan to continue building? | Select the team's actual plan |
| What type of support did you use? | Technical docs; Code examples / templates. Add other options only if actually used |
| Follow-up permission and legal consent | The participant must make these choices |

## What did you build?

We built HAKARI, a Uniswap v4 quote guard for options writers on Robinhood Chain. It addresses a practical problem:
a fixed option quote can remain available after its reference market has moved.

Our hook extends OpenZeppelin's BaseOracleHook. A pricing wrapper reads the pool's live state and its raw and
truncated time-weighted average prices (TWAPs). As the current price moves away from the one-hour TWAP, the wrapper
reduces the maximum size of each fill and increases the quoted premium. Beyond a configurable band, the option
book rejects new purchases. We also added quote deadlines and optional original-price anchors, so a rolling TWAP
catching up with a sustained move cannot silently renew stale terms.

This check runs within the same purchase transaction that pulls collateral from the writer's wallet through
1inch Aqua. A SwapVM instruction limits a shared spot strategy to inventory not promised to option orders.

We deployed the hook and a hooked pool on testnet, and verified successful purchases, token transfers and rejected
fills on a local mainnet fork. The 5% demo band illustrates the policy; it does not establish a correct external
market price.

## What was the biggest blocker you faced?

The main challenge was getting from a deployed oracle hook to a usable TWAP history. After pool initialization,
the observation ring holds only one entry. Without increasing its capacity first, a swap at a later timestamp
overwrites the earlier observation, leaving the hook unable to answer our one-hour TWAP request.

We addressed this by increasing observation cardinality before generating swap history, allowing the requested
window to accumulate, and making the quote wrapper reject purchases when the history cannot be read. Our tests
cover both a working window and an unavailable reference.

A short example covering initialization, ring growth, warm-up and the first successful observe call would have
made this integration much easier. The relevant findings are documented under the observation-cardinality and
oldest-observation sections of our FEEDBACK.md.

## If applicable: what was the hardest part of building an agentic app on Uniswap?

Not applicable: HAKARI's public integration does not run an autonomous agent. We used Claude Code and Codex to
assist implementation, tests and documentation under human direction, and recorded the development prompts in
the repository.

## What support was missing, or could have been better?

Three practical additions would have helped us most:

1. An end-to-end oracle-consumer example: grow the observation ring, build enough history, read a TWAP, and handle
   unavailable history explicitly. An oldest-observation timestamp getter would also make readiness checks simpler.
2. A tested price-conversion recipe for sqrtPriceX96 that handles token order, token decimals and intermediate
   overflow. We implemented this using the approach in v3's OracleLibrary; a v4 example would save other consumers
   from repeating that work.
3. A complete Foundry script for the first liquidity position, including ERC-20 approval to Permit2, Permit2
   approval to PositionManager, action encoding and liquidity calculation. Clear guidance on which minimal swap
   router to use on each testnet would help complete the workflow.

These suggestions come from the integration issues we encountered during the build and documented in FEEDBACK.md.

## Any additional feedback?

Detailed integration feedback:
https://github.com/vexi-v1/vexi-hakari/blob/main/FEEDBACK.md

Project repository:
https://github.com/vexi-v1/vexi-hakari

The v4 hook interface and StateLibrary let us connect pool observations to a rule enforced during an option
purchase without modifying PoolManager. One particularly useful testing detail was that Robinhood Chain's mainnet
and testnet use the same PoolManager address: we could install our deployed testnet hook bytecode on a local
mainnet fork and exercise it against the real PoolManager. The test accounts and pool activity were generated
locally.

This is a Continuity Track extension of Vexi. The repository separates the new integration from the existing
product and documents its development history. FEEDBACK.md contains eight findings from the current integration,
each with the issue, our workaround and a suggested improvement; earlier research is archived separately.

---

Aqua — © Degensoft Ltd 2025. SwapVM — © Degensoft Ltd 2025.
