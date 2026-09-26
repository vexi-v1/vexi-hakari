---
name: uniswap-v4-hooks
description: Uniswap v4 hook development reference for the HAKARI repo. Use whenever you write, extend, or review a v4 hook (HakariOracleHook, a consumer of it such as the band in aqua/, or a new one), reason about hook permission flags, CREATE2 salt mining, or a deployment script, need to score a hook's security risk, or need any Uniswap protocol reference (v2/v3/v4, UniswapX, Permit2, SDKs, Unichain) not already answered by the vendored libraries under lib/. Trigger even on a short ask like "add a hook", "mine the salt", "is this hook safe", or a passing Uniswap docs question.
---

## Read the vendored code first, docs second

This repo vendors the real thing as git submodules — `lib/v4-core`, `lib/uniswap-hooks`
(OpenZeppelin), `lib/forge-std`. For anything with an authoritative source in code (hook
permission bit values, `IHooks`/`BaseHook` signatures, `BaseOracleHook` internals), read the
vendored file, not this skill or the web — the vendored version is what actually compiles here,
and may be a different point release than what developers.uniswap.org shows. This skill exists
for the slice of content that lives only in prose docs, not in code: the security scoring
rubric, the generic hook-building walkthrough, and pointers into the rest of the Uniswap doc set.

Key vendored files:
- `lib/v4-core/src/libraries/Hooks.sol` — permission flag bit positions, `validateHookPermissions`
- `lib/uniswap-hooks/lib/v4-periphery/src/utils/BaseHook.sol` and `HookMiner.sol` — reference
  implementations, vendored transitively (see "Mining a deployment salt" — don't import these
  directly)
- `lib/uniswap-hooks/src/oracles/panoptic/BaseOracleHook.sol` and `libraries/Oracle.sol` — the
  truncated-oracle base that `src/HakariOracleHook.sol` extends
- `lib/uniswap-hooks/docs/modules/ROOT/pages/oracles.adoc` — OpenZeppelin's own oracle-hook writeup

## Hook lifecycle points

A v4 hook is a contract implementing `IHooks`, called by the singleton `PoolManager` around
pool actions. Ten base points, plus four "return delta" variants that let a hook override the
amounts the PoolManager settles:

- `beforeInitialize` / `afterInitialize`
- `beforeAddLiquidity` / `afterAddLiquidity` (+ `afterAddLiquidityReturnDelta`)
- `beforeRemoveLiquidity` / `afterRemoveLiquidity` (+ `afterRemoveLiquidityReturnDelta`)
- `beforeSwap` (+ `beforeSwapReturnDelta`) / `afterSwap` (+ `afterSwapReturnDelta`)
- `beforeDonate` / `afterDonate`

A hook declares which points it uses two ways that must agree: `getHookPermissions()` returns a
`Hooks.Permissions` struct, and the hook's *deployed address* has the matching bits set.
`Hooks.validateHookPermissions` compares the two, and it runs in the constructor of
OpenZeppelin's `BaseHook` (`lib/uniswap-hooks/src/base/BaseHook.sol`), so a mismatch reverts the
deployment itself. `PoolManager.initialize` runs only `isValidHookAddress`, a check on the
address alone (a return-delta bit needs its action bit; a non-zero hook needs at least one bit
or a dynamic fee) that never looks at `getHookPermissions()`.
Get the exact bit positions from `lib/v4-core/src/libraries/Hooks.sol` — they're `1 << N`
constants, e.g. `AFTER_INITIALIZE_FLAG = 1 << 12`, `BEFORE_SWAP_FLAG = 1 << 7`. Don't hardcode
these from memory; read the file, since a vendored version bump could shift them.

## Mining a deployment salt

This repo does **not** import v4-periphery's `HookMiner` — it isn't remapped. The remappings
are the `remappings` list in `foundry.toml` (there is no `remappings.txt`, and
`auto_detect_remappings = false`): only `v4-core`, `uniswap-hooks`, `forge-std`, and their
`openzeppelin-contracts`/`solmate` deps. The established local pattern is a plain CREATE2
brute-force loop against the deployer's own creation code, as in `script/Deploy.s.sol`:

```solidity
uint160 constant FLAGS = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
uint160 constant FLAG_MASK = Hooks.ALL_HOOK_MASK;

function _mine(bytes memory creationWithArgs) internal view returns (address, bytes32) {
    bytes32 initHash = keccak256(creationWithArgs);
    for (uint256 salt; salt < 200_000; salt++) {
        address a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xFF), CREATE2_DEPLOYER, salt, initHash)))));
        if (uint160(a) & FLAG_MASK == FLAGS && a.code.length == 0) return (a, bytes32(salt));
    }
    revert("no salt");
}
```

Follow this pattern for a new hook rather than pulling in `v4-periphery` as a fresh dependency —
it keeps the dependency surface as-is and matches AGENTS.md's "code is rewritten here" rule.
`CREATE2_DEPLOYER` in this repo is the canonical Arachnid proxy
(`0x4e59b44847b379578588920cA78FbF26c0B4956C`), confirmed present on both Robinhood chain ids.

If you need the public reference implementation for comparison, it's vendored at
`lib/uniswap-hooks/lib/v4-periphery/src/utils/HookMiner.sol` — read it, don't import across
that remapping boundary.

## Scoring a hook's security risk

[references/security-framework.md](references/security-framework.md) has the Uniswap
Foundation's hook-risk scoring rubric: 9 dimensions (complexity, custom math, external
dependencies, external liquidity exposure, TVL potential, team maturity, upgradeability,
autonomous parameter updates, price-impacting behavior), each 0–3 or 0–5, summing to a risk tier
(low/medium/high) with matching audit/monitoring/bug-bounty requirements, plus a
vulnerability-class checklist and an OPSEC section.

This is a different thing from HAKARI's own cost-to-manipulate model (SPEC.md's three trust
layers). The Foundation's framework scores *how much a hook could go wrong* (its own attack
surface); HAKARI's model scores *what it costs to move a price on a given pool*, independent of
hook code quality. Use the Foundation's rubric when reviewing a third-party hook, writing the
security section of the README, or sanity-checking HakariOracleHook or a contract that reads it
against an external standard — not as a substitute for HAKARI's own cost model.

## Building a new hook from scratch

[references/hooks-guide.md](references/hooks-guide.md) has the condensed walkthrough from
developers.uniswap.org's "your first hook" guide (v4-template, `BaseHook`,
`getHookPermissions()`, an `afterSwap`/`afterAddLiquidity` example, Foundry test pattern). Read
`src/HakariOracleHook.sol` and `test/` first for this repo's actual conventions (imports via the
`@openzeppelin/uniswap-hooks/` alias, `BaseOracleHook` as a base) — reach for the generic guide
only when there's no local example to crib from (e.g. a brand-new hook that isn't an oracle hook).

## Anything else in the Uniswap docs

[references/docs-index.md](references/docs-index.md) lists the other doc sections (v2, v3,
UniswapX, Permit2, Universal Router, protocol fee, SDKs, Unichain, subgraphs, governance,
Liquidity Launchpad, Smart Wallet/Calibur, The Compact) with base paths, plus the fetch trick
that got real content for this skill: request a specific page's `llms.mdx` path instead of the
rendered page or the site-wide `/llms-full.txt` (too coarse to pull real code or rubrics from —
a fetch tool summarizing it returns the same few generic sentences regardless of what's asked).
