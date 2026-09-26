#!/usr/bin/env bash
# Runs the fork tests and saves their output to docs/demo-outputs/fork-tests.txt with every URL masked.
# forge prints the RPC URL in its errors, and a private RPC URL carries an API key, so nothing unmasked is written.
# Uses the public mainnet RPC (the env override below beats .env), which carries no key.
set -uo pipefail
cd "$(dirname "$0")/.."
out=docs/demo-outputs/fork-tests.txt
RH_MAINNET_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path 'test/fork/*' -vv 2>&1 \
  | sed -E 's#https?://[^[:space:]")]+#<url>#g' \
  | grep -vE '^\s*$' | sed -n '/Ran [0-9] tests/,$p' > "$out"
grep -E 'PASS|FAIL' "$out"
