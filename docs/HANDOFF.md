# Handoff — state of HAKARI at 2026-09-26 03:00 JST (H6)

For whoever takes this to submission (Abner). Everything technical is done and pushed; what is
left needs a person: recording the video, the two forms, and flipping the repo public.
Deadline **2026-09-27 09:00 JST**; aim for 06:00.

## What exists and what was verified

| Piece | Status | Verified how |
|---|---|---|
| `PushCostLens`, `HakariOracleHook`, `SafeSettle`, `CostModel` | done | `forge test`: 24 unit tests green (no RPC) |
| G1: lens vs a manual 10-TSLA round trip on a 4663 fork | done | `forge test --match-contract PushCostLensForkTest -vv` (−26.73 vs 26.64 USDG at block 72,232,582) |
| Shadow pool: real TSLA/USDG profile + hook on the official PoolManager, sustained push, SafeSettle | done | `forge test --match-contract ShadowPool -vv` (~3 min) |
| Three-layer demo tests (write `web/decisions/*.json`) | done | `forge test --match-contract ThreeLayers -vv` |
| Gauge: ladder, Δ calibration, HIMS replay, mint window (`gauge/data/*.json`) | done | `cd gauge && npm test` (11 green); HIMS reconstruction equals every Swap event's liquidity |
| Web page (`web/`), live "Measure" against mainnet | done | opened in a browser, live TSLA measure returned |
| 46630 deployment (lens, hook Δ 250, settle) | done | `deployments/46630.json`, receipts in `broadcast/Deploy.s.sol/46630/` |
| 46630 public demo (pool with hook, push, `Settled` event) | done | `deployments/46630-demo-pool.json`, `broadcast/DemoPool.s.sol/46630/`, `broadcast/DemoSettle.s.sol/46630/` |
| `README.md` with line pointers, `FEEDBACK.md` (7 entries), `SPEC.md`, `docs/prompts/` | done | — |
| Demo runbook | done | `docs/DEMO.md`, outputs in `docs/demo-outputs/` |

## What is left (human)

1. **Make the repo public** (Eric said: later, before submission):
   `gh repo edit vexi-v1/vexi-hakari --visibility public`. The Uniswap prize requires it.
2. **Uniswap Developer Feedback Form** — <https://developers.uniswap.org/hackathon-feedback>.
   Paste the `FEEDBACK.md` link: `https://github.com/vexi-v1/vexi-hakari/blob/main/FEEDBACK.md`
   (only resolves once the repo is public). The form is a hard requirement of the prize.
3. **Video**, 2–4 min, ≥ 720p, a human voice, no TTS, no speed-ups: follow `docs/DEMO.md`.
4. **Hacker Dashboard submission** (ETHGlobal). Track: **Classic / From Scratch** — every line was
   written after 21:00 JST on 9/25 (Eric confirmed); public libraries only. Partner prize:
   **Uniswap Foundation — Best Uniswap Stack Contribution** (select up to 3; only Uniswap fits).
   Paste-ready text below.

### Submission text

**Title:** HAKARI — what it costs to fake a price

**Short description:** A scale for any protocol that reads a price from a Uniswap v4 pool: can
this price be pushed right now, what would pushing it cost, and should it be trusted? A lens that
prices a push against any v4 pool (with no deployment, via eth_call state override), an oracle
hook that keeps the raw and the truncated TWAP side by side, and a settlement rule that trusts a
move only if faking it would cost more than it earns. Measured on Robinhood Chain, including the
HIMS weekend where the cost to push fell from 1,351 to 12 USDG.

**Long description:** see `README.md` §§ "The problem in one table", "What we built", "Numbers".
Copy those three sections.

**How it's made:** Solidity on Uniswap `v4-core` (official PoolManager on Robinhood Chain 4663 /
46630) and OpenZeppelin `uniswap-hooks` (`BaseOracleHook`); `PushCostLens` uses the V4Quoter
pattern (unlock → swap to a price limit → revert with the result) plus a `StateLibrary` tick walk
with the protocol fee folded in; `HakariOracleHook` mined to the `0x1080` flag bits; TypeScript
gauge on viem (event reconstruction of the HIMS pool, Δ calibration, mint-window flag); static
web page. Built with Claude Code from a human-written spec, test-first; prompts in
`docs/prompts/`.

**Links:** repo `https://github.com/vexi-v1/vexi-hakari`; testnet 46630 contracts — hook
`0xa953EA9E06937f4169cBc04032B947Dad0b15080`, lens `0x4fe982eBF315925D14bF11917fdad43400703d28`,
settle `0xBc1f6adB55eFD483abBc1e46e1F7dA6f34ea02e4`; public `Settled` tx
`0x5dfc71837a834ac839a9a9d775013f6129f8a4d67066e32df373c09f9ad15441`
(<https://explorer.testnet.chain.robinhood.com>).

## Rules of the repo (short)

- Mainnet 4663 is read-only. Both deploy scripts `require(block.chainid == 46630)`.
- `.env` is never read or printed by an AI. It holds `RH_MAINNET_RPC`, `RH_TESTNET_RPC`,
  `HAKARI_DEPLOYER_KEY`. The key controls `0x51E4EfE117e8Baf023dab3B7Cb5380DF1d378DF1`
  (≈ 0.1 ETH on 46630 minus what the demo spent). **Do not use Vexi's `0x5AB1…7799`.**
- Commit continuously; `git add -- <file>` then `git commit -- <paths>`; pull before push; never
  `--amend` or force-push (the history is part of the submission).
- No pre-hackathon code. Knowledge yes, code no.

## Gotchas you may hit

- **Fork tests read empty state / wrong chain.** The public RPC is load-balanced; the tests fork
  60 blocks behind head and fall back to the public mainnet URL if `RH_MAINNET_RPC` answers a
  different chain id (the `.env` once had the two RPCs swapped). If `setUp` says "RPC returned no
  state", run it again.
- **`DemoSettle` reverts with `TargetPredatesOldestObservation`.** The window must fit inside the
  pool's on-chain history; the script reads the first observation's timestamp from the hook. Wait
  a minute after `DemoPool` and retry. A new demo run creates a new pool (new tokens); the old
  one stays on-chain.
- **`quotePush` cannot be called from inside another unlock** (v4 `AlreadyUnlocked`); use
  `depthToMove` / `roundTripCost` there.
- **Web page shows 404s in the console on first load** if `web/decisions/*.json` for the shadow
  scenarios are missing: run the ShadowPool fork test once.
- **viem refuses hand-cased addresses.** Everything in `gauge/` is lower-case on purpose.

## If there is time

- `docs/DEMO.md` § booth: rehearse the five answers.
- Re-run `npm run ladder` right before the demo so section 1 of the page is fresh (the page's
  **Refresh live** button does the same in the browser).
- Cost model v1 and `n_max` are listed under README § "Next"; do not start them now.
