# "Your first hook" — condensed walkthrough (reference)

Source: developers.uniswap.org, `/docs/protocols/v4/guides/hooks/your-first-hook`. This is the
generic v4-template flow for a brand-new hook. For this repo, prefer looking at
`src/HakariOracleHook.sol` and `test/` for the actual local conventions (different base
contract, different import aliases, own CREATE2-mining pattern — see SKILL.md) — read this only
when the generic shape doesn't have a local example to crib from.

## Scaffold (not needed in this repo)

```bash
git clone https://github.com/uniswapfoundation/v4-template.git
cd v4-template
forge install
forge test
```

The equivalent pieces are already vendored under `lib/` and configured in `foundry.toml` — don't
re-clone the template here.

## Shape of a hook contract

- Extend `BaseHook`, constructor takes an `IPoolManager`
- Override `getHookPermissions()` to return a `Hooks.Permissions` struct with only the callbacks
  you use set to `true` — the rest default `false`
- Implement the callbacks you declared, e.g. `_afterSwap` / `_afterAddLiquidity`; each must
  return its function selector (and a delta, for a return-delta variant) to signal success back
  to the PoolManager
- `hookData` (bytes passed through swap/modify-liquidity calls) is how a hook receives
  caller-supplied context, e.g. `abi.decode(hookData, (address))` to recover a user address

## Worked example from the guide (a points-reward hook)

Permissions: only `afterAddLiquidity` and `afterSwap` set. `_afterSwap` checks the swap is in an
ETH/TOKEN pool and mints points proportional to ETH in; `_afterAddLiquidity` mints points
proportional to ETH contributed. A separate `onlyOwner`-mintable ERC20 holds the points. Tests
assert a 1:1 ETH→points ratio for swaps and proportional points for liquidity adds, using a
`getHookData()` helper to encode the user address for the callback to decode.

## Deploying it

See SKILL.md § "Mining a deployment salt" for the pattern actually used in this repo. The
generic guide instead shows importing v4-periphery's `HookMiner.find(...)` directly:

```solidity
(address hookAddress, bytes32 salt) = HookMiner.find(
    CREATE2_DEPLOYER,
    flags,
    type(PointsHook).creationCode,
    constructorArgs
);
```

Don't follow that import here unless you've deliberately added the `v4-periphery` remapping —
it isn't in the `remappings` list in `foundry.toml` (`forge-std`, `v4-core`, `uniswap-hooks`,
and their `openzeppelin-contracts`/`solmate` deps; there is no `remappings.txt`).
