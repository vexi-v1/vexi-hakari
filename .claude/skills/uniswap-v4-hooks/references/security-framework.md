# Uniswap v4 Hook Security Framework (reference)

Source: developers.uniswap.org, `/docs/protocols/v4/security` — the Uniswap Foundation's
voluntary, self-scored risk framework for hooks. Not an audit and not a safety guarantee; a way
for a team to size the review a hook needs, and for an integrator to gauge how much to trust one
before whitelisting it.

## Scoring: 9 dimensions, self-scored, sum to a tier

| Dimension | Scale | What it's asking |
|---|---|---|
| Complexity | 0–5 | branching, callback count, config surface, multi-step flows |
| Custom math | 0–5 | bonding curves, dynamic fees, TWAMM, non-integer exponents, piecewise functions |
| External dependencies | 0–3 | oracles, lending markets, LSTs, bridges, cross-chain data |
| External liquidity exposure | 0–3 | token holdings, protocol deposits, rehypothecation |
| TVL potential | 0–5 | <$100K → 0, up to $50M+ → 5 |
| Team maturity | 0–3 | prior production deployments, audit history |
| Upgradeability | 0–3 | proxy patterns, admin controls, governance risk |
| Autonomous parameter updates | 0–3 | automatic config/state-driven logic changes |
| Price-impacting behavior | 0–3 | pricing modification, dynamic fees, execution-path influence |

Score conservatively — underestimating a dimension means under-provisioning its safeguards.

## Tiers

- **Low (0–6):** small surface, minimal math, no external interactions. One full audit + AI
  static analysis; math specialist and bug bounty optional.
- **Medium (7–17):** moderate complexity, custom logic, real dependencies. One full audit + AI
  static analysis, second audit optional, bug bounty recommended, monitoring recommended for
  dependencies.
- **High (18–33):** complex math, external liquidity, autonomy, upgradeability, price impact, or
  large TVL. Two formal audits (one math specialist), mandatory bug bounty, extended test suite
  (invariants, stateful fuzzing), mandatory anomaly monitoring, formal verification optional.

## Feature triggers that override the tier

Regardless of total score, these force extra requirements:

1. Custom curve / non-standard math → math-specialist audit, fuzz/unit tests, formal
   verification if TVL scores 5
2. Hook holds its own or external liquidity → continuous monitoring, accounting invariants, bug
   bounty if TVL scores 5
3. External protocol/oracle dependency → dependency-health monitoring, failure-scenario tests,
   bug bounty recommended
4. Autonomous parameter updates → invariant testing, monitoring, two-auditor review if combined
   with custom math
5. Price-impacting behavior → math-specialist audit, monitoring if TVL scores 5, bug bounty,
   formal verification recommended
6. Upgradeable hooks → storage-collision review, documented upgrade policy, time-lock/multisig,
   post-upgrade monitoring
7. TVL scores 5 → mandatory monitoring, mandatory bug bounty, high-quality audit, formal
   verification recommended, liquidity limits/kill switches

## Vulnerability classes it asks you to check

- **Accounting/token handling** — bad delta computation, non-standard tokens (fee-on-transfer,
  rebasing, ERC-777, pausable), rounding cascades from rehypothecation
- **Reentrancy/state drift** — callback reentrancy into the same or a sibling pool, external
  state changes mid-callback, liquidity migrated between callbacks invalidating a snapshot
- **Math correctness** — precision drift, division-by-zero/overflow, fixed-point mixing,
  piecewise-curve discontinuities, non-invertible updates, TWAMM cumulative drift
- **External dependency failure** — stale/manipulated oracle price, a dependency reverting,
  delaying, or losing liquidity; cross-chain message latency/ordering/loss
- **Upgrade hazards** — storage-layout collisions, unsafe upgrade paths, compromised keys, no
  migration procedure
- **Price impact/fee dynamics** — selective post-observation fee increases, non-linear fee vs.
  trade size, reentrancy-driven fee manipulation, unintended MEV vectors
- **Flash accounting/transient state** — adversarial delta manipulation mid-execution,
  unbalanced flows bypassing fee logic, price miscalculation from bad transient assumptions
- **Permission encoding/salt grinding** — wrong CREATE2 salt math, disabled required callbacks
  or unintended extra permissions widening the attack surface
- **Multi-pool/cross-chain** — inconsistent sequential fee behavior, state assumptions that break
  across hops, cross-chain sync failures

## Baseline practices it expects

Minimal/immutable access control over upgradeable, reentrancy guards plus
checks-effects-interactions on every external path, prefer OpenZeppelin over custom primitives,
gas/balance griefing protection, per-callback delta/invariant checks, safe ERC20 return-value
handling, published versioned audit reports, a public vulnerability-disclosure contact,
time-locked multisig upgrades if upgradeable at all.

## OPSEC (not code — process)

Least-privilege on deploy/admin keys, controlled release process, monitored admin/governance
actions, a tested incident-response and pause/kill-switch plan, reassessed before major
deployments. Re-score the tier whenever: a major upgrade ships, incentivized liquidity is added,
TVL jumps, a new external dependency is added, or autonomy/dynamic features change.

## Explicit disclaimer from the source

Scores and tiers "do **not** represent security assurances or guarantees of safety" — a
voluntary, self-directed assessment, not a certification.

## How this relates to HAKARI

This framework scores *how much a given hook could go wrong* (its own attack surface). HAKARI's
own model (SPEC.md's three trust layers, `CostModel.sol`) scores something different: *what it
costs an outsider to move a pool's price*, independent of whether the hook reading that price is
itself well-written. Use this framework to size review effort for a hook — including
HakariOracleHook/ExposureGuard/SafeSettle themselves, or a third party's hook shown at the demo —
not as a substitute for HAKARI's cost model.
