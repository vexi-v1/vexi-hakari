# The SwapVM router deployed on testnet 46630, as deployed

The team's vaults on Robinhood Chain testnet 46630 quote spot through a SwapVM router that carries two custom
instructions. It modifies 1inch SwapVM, whose license asks for the modification's source to be published under the
same license (LicenseRef-Degensoft-SwapVM-1.1 §3.1 A, [copy](../../LICENSES/SwapVM-1.1.txt)). This folder is that
source. The rest of this repository does not use it: `aqua/src/swapvm/` is the same router with `ExposureGuard` alone.

| | |
|---|---|
| Router | [`0xfadDb8796f92C6aA00aF84a6B431E90859C7aeF3`](https://explorer.testnet.chain.robinhood.com/address/0xfadDb8796f92C6aA00aF84a6B431E90859C7aeF3) |
| Deployed | 2026-09-26 20:53 JST, [tx `0x9d87…130a`](https://explorer.testnet.chain.robinhood.com/tx/0x9d872ac1a961c028d245596cc43385821ff8c3164425d1ccc1fc55d47ad0130a) |
| Opcodes | the AquaOpcodes table of 1inch swap-vm v1.0.2, then `ExposureGuard` = 34 and `DeltaSkew` = 35 (`exposureGuardOpcode()`, `deltaSkewOpcode()` on chain) |
| Constructor | Aqua on 46630 (`0xadF842ea37F2Bef630891DE1be803d92DFaF276B`, the pinned `1inch/aqua` source deployed there, since 1inch has no Aqua on the testnet), no WETH, the operator as owner, and an EIP-712 name and version, all readable in the deploy transaction's input |
| Compiler | solc 0.8.30, cancun, via-IR, 700 optimizer runs (`aqua/foundry.toml`), 1inch swap-vm `v1.0.2`, solidity-utils `6.9.8`, OpenZeppelin `v5.4.0` |

| File | What |
|---|---|
| [`src/WriterSwapVMRouter.sol`](src/WriterSwapVMRouter.sol) | `WriterOpcodes` (the AquaOpcodes table with both instructions appended, so every existing opcode keeps its number) and `WriterSwapVMRouter`, adapted from swap-vm's `AquaSwapVMRouter` |
| [`src/ExposureGuard.sol`](src/ExposureGuard.sol) | Opcode 34: the spot pool may sell only what open option orders have not promised, at the same price. Same code as [`aqua/src/swapvm/ExposureGuard.sol`](../src/swapvm/ExposureGuard.sol) |
| [`src/DeltaSkew.sol`](src/DeltaSkew.sol) | Opcode 35, after the curve: leans the spot price against the delta the option book added, reading `optionDelta()` from the writer named in the program. Every short call counts as −0.5 base token and every short put as +0.5; the skew is `min(maxSkewBps, maxSkewBps × |delta| / fullSkewAt)`, and a skew in the taker's favour never takes more than the pool's `balanceOut` |

The instruction arguments (the writer, and for `DeltaSkew` the base token, `maxSkewBps` and `fullSkewAt`) are not in
the router: each strategy carries them in the program it ships to Aqua. The writer that the deployed vaults use is
not in this repository; `aqua/src/aqua/AquaWriter.sol` has no `optionDelta()`.

## That this is the deployed source

The deployed runtime code was compared with these files compiled in the build tree they were deployed from, with the
settings above: the 19,891 bytes of code before the metadata are identical once the 15 immutable slots (the
addresses and the EIP-712 values set in the constructor) are masked. Only the header comments of the three files
changed for publication (license URL pinned to v1.0.2, dated change notes, where it is deployed); that comparison was
repeated with the files as published here and still matched byte for byte.

Built in this repository instead, alongside different files, the bytes differ although the source is the same:
through via-IR, the solc numbering of internal functions (the opcode table is an array of internal function
pointers) follows the AST ids of every file in the build.

## Build and deploy

```bash
cd aqua
FOUNDRY_PROFILE=deployed46630 forge build           # artifacts in deployed-46630/out
anvil                                               # a local chain; the constructor needs no state
FOUNDRY_PROFILE=deployed46630 forge create deployed-46630/src/WriterSwapVMRouter.sol:WriterSwapVMRouter \
  --rpc-url http://127.0.0.1:8545 --unlocked --from <address> --broadcast \
  --constructor-args <aqua> 0x0000000000000000000000000000000000000000 <owner> "<EIP-712 name>" "<EIP-712 version>"
```

No key goes on the command line: use an unlocked anvil account, or `--account <keystore>` on a real chain.

---

Powered by SwapVM — © Degensoft Ltd 2025. Aqua — © Degensoft Ltd 2025.
