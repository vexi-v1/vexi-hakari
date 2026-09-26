# Uniswap Developer Feedback Form — prepared answers

Form: [developers.uniswap.org/hackathon-feedback](https://developers.uniswap.org/hackathon-feedback).
**Status: prepared, not submitted.** The sponsor requires the completed form in addition to the repository file.
After publishing the final revision, include this link in the long-form feedback answer:

<https://github.com/vexi-v1/vexi-hakari/blob/main/FEEDBACK.md>

The visible form was checked on 2026-09-27. Contact details, actual elapsed integration time, numerical ratings,
future plans and consent must come from the participant; they are deliberately not invented here.

| Form field | Prepared answer / input needed |
|---|---|
| First name, last name, email, Telegram | Participant's actual details; do not put private contact details in this public repository |
| Hackathon | ETHGlobal Tokyo 2026 |
| Completed a project? | Yes — a working contract integration demonstrated through local-fork tests; publish its current revision first |
| AI-powered or agentic project? | No autonomous agent in this public integration. AI-assisted development is disclosed separately; that is different from an agentic product |
| Successfully integrated Uniswap? | Yes — v4 PoolManager, HAKARI oracle hook, state reads and quote/refusal flows |
| Time to first integration | Participant selects their actual elapsed time; deployment timestamps are not a substitute |
| Documentation / support scores | Participant selects their honest ratings |
| Continue building? | Participant's actual plan |
| Support used | Technical documentation and code examples are evidenced by the repository. Select office hours, mentorship or Discord only if actually used |
| Follow-up permission / terms | Participant's choice; no consent has been recorded by this draft |

## What did you build?

HAKARI is an options-writer integration on Robinhood Chain. Canonical 1inch Aqua keeps unfilled collateral in a
maker's wallet; a SwapVM guard restricts a shared spot strategy to unpromised inventory. Our Uniswap v4 consumer
reads a hooked pool's raw and truncated TWAPs and live state, reduces quote size and widens spreads near a fixed
demonstration band, then rejects new fills outside it. Fixed quotes also expire and can retain their original
price anchor. An experimental adapter explores settlement-window selection with explicit deferral and refund
limitations. The hook is based on OpenZeppelin BaseOracleHook, which we credit. The public repository includes
the integration source, local-fork tests, testnet hook/pool records and feedback.

## Biggest blocker

Keeping usable oracle history required understanding the v4 oracle hook's observation ring. With one observation,
a later swap overwrites the old history; increasing cardinality must happen before building the window, and growth
takes effect on a later write. We grew the ring, generated swap observations, and made consumers refuse when the
requested window was unavailable. Same-timestamp swaps and truncated-oracle extrapolation also needed explicit
tests so that we did not overstate what the TWAP protected. Current FEEDBACK.md items 18 and 19 describe the
ring issue; the earlier oracle experiments are preserved in archive/feedback-history.md.

## Hardest part of an agentic app

Not applicable to the runtime product. Claude Code and Codex assisted implementation and review under human
direction; the public prompt record explains that development process.

## Missing support / what could be better

A minimal oracle-consumer example should show growing observation cardinality, warming up a window, handling
insufficient history and keeping a settlement record before history wraps. An oldest-observation timestamp getter
would simplify fail-closed consumers. Clear testnet router guidance and a note explaining matching PoolManager
addresses across Robinhood mainnet and testnet would also help integration tests.

## Additional feedback

Our detailed, concrete integration feedback is here:
https://github.com/vexi-v1/vexi-hakari/blob/main/FEEDBACK.md

Items 13–20 concern the current options-band integration. Earlier study findings and the unrechecked research
note are preserved separately in archive/feedback-history.md. We used v4 StateLibrary reads, TickMath/FullMath, hook observations, PositionManager, Permit2 and
swap/liquidity test routers. The mainnet-fork demo uses actual PoolManager code with the deployed testnet hook
runtime and synthetic pool activity; it is not a claim of live adoption or independent price security.
