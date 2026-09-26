# vexi-aqua

**Write options from a wallet that never deposits.** A writer's collateral stays in its own wallet or Safe and moves
only when a buyer buys, pulled through 1inch Aqua. The same balance also quotes spot through a SwapVM strategy. A custom
SwapVM instruction (`ExposureGuard`) keeps the two from promising the same tokens twice.

Built at ETHGlobal Tokyo 2026 (From Scratch track) on Robinhood Chain, for the 1inch **Build an Aqua App** prize.
Start with [docs/SPEC.md](docs/SPEC.md); the 1inch details are in [docs/spec-1inch.md](docs/spec-1inch.md).

> **Status:** spec written; implementation in progress. Sections marked *TODO* are filled in as the code lands.

## Quick start

```bash
cp .env.example .env
```

Fill in `RH_MAINNET_RPC` (read-only, used only as the fork source). Then start a fork of Robinhood Chain 4663:

```bash
anvil --fork-url "$RH_MAINNET_RPC" --fork-block-number "$RH_MAINNET_FORK_BLOCK"
```

*TODO: build, test and demo commands.*

## Where to verify the integration

*TODO: add file paths and line numbers once the code lands.*

| What | Contract | Lines |
|---|---|---|
| Aqua `pull` from the writer's wallet at the moment of a buy | `contracts/aqua/AquaWriter.sol` | |
| Aqua `push` of unexercised collateral and premiums back into the strategy | `contracts/aqua/AquaWriter.sol` | |
| Custom SwapVM instruction: spot quotes only the unpromised balance | `contracts/swapvm/ExposureGuard.sol` | |
| Router subclass that registers the instruction | `contracts/swapvm/WriterSwapVMRouter.sol` | |
| The options book that takes collateral only at a fill | `contracts/book/MiniBook.sol` | |

## Rules this repo follows

- Robinhood Chain mainnet 4663 is **read-only**. Every transaction goes to a local fork.
- All code was written during the event. AI assistance is disclosed in [docs/ai-usage.md](docs/ai-usage.md).

## License

MIT, except `contracts/swapvm/`, which extends 1inch SwapVM under `LicenseRef-Degensoft-SwapVM-1.1`. Powered by
SwapVM. 1inch Aqua is used as a dependency under its own license.
