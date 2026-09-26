# Third-party notices

vexi-hakari pins its dependencies as git submodules and does not modify them. Each is under its own license, found in
the submodule at the pinned commit.

| Component | Path | Pinned at | License |
|---|---|---|---|
| 1inch Aqua | `aqua/lib/aqua` | `ef24220` | LicenseRef-Degensoft-Aqua-Source-1.1 (copy: [LICENSES/Aqua-Source-1.1.txt](LICENSES/Aqua-Source-1.1.txt)). Aqua — © Degensoft Ltd 2025 |
| 1inch SwapVM | `aqua/lib/swap-vm` | `v1.0.2` (`32c687c`) | LicenseRef-Degensoft-SwapVM-1.1 (copy: [LICENSES/SwapVM-1.1.txt](LICENSES/SwapVM-1.1.txt)). SwapVM — © Degensoft Ltd 2025 |
| 1inch solidity-utils | `aqua/lib/solidity-utils` | `6.9.8` (`6f78374`) | MIT |
| OpenZeppelin Contracts | `aqua/lib/openzeppelin-contracts` | `v5.4.0` (`c64a1ed`) | MIT |
| Uniswap v4-core | `aqua/lib/v4-core` | `v4.0.0` (`e50237c`) | Per file: BUSL-1.1, MIT, UNLICENSED and GPL-3.0-or-later, as each file's SPDX header states |
| Uniswap v4-core | `lib/v4-core` | `d153b04` | Per file, as above |
| OpenZeppelin Uniswap Hooks | `lib/uniswap-hooks` | `acbd604` | MIT |
| forge-std | `aqua/lib/forge-std`, `lib/forge-std` | `v1.11.0` (`8e40513`), `v1.16.2` (`bf647bd`) | MIT OR Apache-2.0 |

The pinned `swap-vm` v1.0.2 has one file, `src/interfaces/IMakerHooks.sol`, whose SPDX header names
`LicenseRef-Degensoft-ARSL-1.0-Audit` while its `@custom:license-url` names SwapVM-1.1; upstream relabelled it
SwapVM-1.1 in swap-vm PR #190 (merged 2026-09-08). It is compiled here, unmodified, through `SwapVM.sol`.
