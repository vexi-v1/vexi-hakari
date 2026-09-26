#!/usr/bin/env bash
# Aqua — © Degensoft Ltd 2025. SwapVM — © Degensoft Ltd 2025.
# Local Foundry execution only. No private key, forge script, or broadcast.
set -euo pipefail

mode="${1:-all}"
case "$mode" in
  all|1inch|uniswap|limits|shared) ;;
  *) printf 'Usage: bash scripts/judge-demo.sh [all|1inch|uniswap|limits|shared]\n' >&2; exit 2 ;;
esac
command -v forge >/dev/null || { printf 'Install Foundry first: https://getfoundry.sh\n' >&2; exit 1; }
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root/aqua"

# An archive RPC is read only; token funding and contract calls occur in the local test EVM.
# The endpoint can be overridden without changing the pinned demonstration state.
export RH_MAINNET_RPC="${RH_MAINNET_RPC:-https://rpc.ordofi.network}"
export RH_MAINNET_FORK_BLOCK=72248228
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

if [[ "$mode" == all || "$mode" == 1inch ]]; then
  printf '\n1inch: ship/post, exact collateral pulls, collateral and premium returns\n'
  forge test --match-contract '^LifecycleTest$' --match-test '^test_Invariant[1245]_' -vvvv
  printf '\n1inch: a real spot fill on the canonical SwapVM router, then an option fill\n'
  forge test --match-contract '^ExposureGuardCanonicalTest$' --match-test '^test_CanonicalRouterCapsAtTheUnpromisedBalance\(' -vvvv
  printf '\n1inch: the failure without the guard\n'
  forge test --match-contract '^ExposureGuardTest$' --match-test '^test_WithoutTheGuardASpotFillTakesWhatTheOptionsPromised\(' -vvvv
fi

if [[ "$mode" == all || "$mode" == uniswap ]]; then
  printf '\nUniswap: v4 hook -> band -> OptionBook -> Aqua, taper, refusal, experimental settlement\n'
  forge test --match-contract '^StabilityBandForkTest$' \
    --match-test '^test_(ABuyThroughTheBandPullsFromTheMakerThroughAqua|InsideTheBandTheBookTapers|APushOfTheReferencePastTheBandPausesTheBook|APushAtExpiryDefersSettlementOnTheRealHook)\(' -vvvv
fi

if [[ "$mode" == all || "$mode" == limits ]]; then
  printf '\nLimits: quote expiry and fixed anchor; a rolling TWAP cannot renew either\n'
  forge test --match-contract '^FixedPremiumTest$' --match-test '^test_ExpiredQuoteBlocksBookBuyWithoutMovingFundsAndDoesNotBlockSettlement\(' -vv
  forge test --match-contract '^StabilityBandTest$' --match-test '^test_AnchorRefusesAfterRollingBandRecovers\(' -vv
fi

if [[ "$mode" == all || "$mode" == 1inch || "$mode" == shared ]]; then
  printf '\n1inch: multiple series share backing while the canonical router still trades spot\n'
  forge test --match-contract '^ExposureGuardCanonicalTest$' --match-test '^test_Shared' -vvvv
fi
