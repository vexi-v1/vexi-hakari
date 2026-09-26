# Reviewer code map

Line references describe the current public-extraction working tree. Publish this revision before submitting;
relative links preserve the GitHub branch or commit being viewed. Recheck anchors after later source edits.

| Integration | Exact entry point | What it proves |
|---|---|---|
| Aqua strategy binding | [aqua/src/aqua/AquaWriter.sol:86](../aqua/src/aqua/AquaWriter.sol#L86) | Requires a shipped strategy belonging to this maker and app. |
| Exact collateral pull | [aqua/src/aqua/AquaWriter.sol:170](../aqua/src/aqua/AquaWriter.sol#L170) | AQUA.pull transfers collateral directly to the book during buy. |
| Book arrival check | [aqua/src/book/OptionBook.sol:221](../aqua/src/book/OptionBook.sol#L221) | Checks actual collateral received and mints buyer positions atomically. |
| Return through Aqua | [aqua/src/aqua/AquaWriter.sol:179](../aqua/src/aqua/AquaWriter.sol#L179) | Pushes returned funds to the currently bound strategy; requires it to remain active. |
| Live availability | [aqua/src/aqua/AquaWriter.sol:157](../aqua/src/aqua/AquaWriter.sol#L157) | Minimum of active virtual balance, wallet balance and allowance. |
| SwapVM instruction | [aqua/src/swapvm/ExposureGuard.sol:42](../aqua/src/swapvm/ExposureGuard.sol#L42) | Caps the strategy at wallet inventory not promised by this writer. |
| Canonical-router extension | [aqua/src/swapvm/ExposureGuardExtruction.sol:25](../aqua/src/swapvm/ExposureGuardExtruction.sol#L25) | The same policy through the deployed router's Extruction instruction. |
| Both hook TWAPs | [src/HakariOracleHook.sol:24](../src/HakariOracleHook.sol#L24) | Thin wrapper over OpenZeppelin BaseOracleHook; upstream oracle design is credited. |
| v4 state and observations | [aqua/src/band/StabilityBandPricer.sol:199](../aqua/src/band/StabilityBandPricer.sol#L199) | StateLibrary slot0/liquidity and hook observe; computes pause, spread and size. |
| Executable refusal | [aqua/src/band/StabilityBandPricer.sol:281](../aqua/src/band/StabilityBandPricer.sol#L281) | Reverts Paused or SizeCapped before returning an option premium. |
| Live original-anchor source | [aqua/src/band/StabilityBandPricer.sol:260](../aqua/src/band/StabilityBandPricer.sol#L260) | Reads current pool price independently of the rolling center. |
| Quote validity | [aqua/src/book/FixedPremium.sol:87](../aqua/src/book/FixedPremium.sol#L87) | Enforces quote deadline and optional original-price deviation. |
| Tick-to-price conversion | [aqua/src/band/BandMath.sol:30](../aqua/src/band/BandMath.sol#L30) | Handles token order and decimal scaling with full-precision arithmetic. |
| Experimental settlement | [aqua/src/band/HookTwapExpiryPrice.sol:141](../aqua/src/band/HookTwapExpiryPrice.sol#L141) | Selects the first accepted observation window; see settlement limitations. |
| Observation cache | [aqua/src/band/HookTwapExpiryPrice.sol:147](../aqua/src/band/HookTwapExpiryPrice.sol#L147) | Permissionless recording before the observation ring loses history. |
| Both sponsors in one buy | [aqua/test/StabilityBandFork.t.sol:311](../aqua/test/StabilityBandFork.t.sol#L311) | Fork integration: hooked v4 reference, band, OptionBook and canonical Aqua. |
| Canonical SwapVM fill | [aqua/test/ExposureGuardCanonical.t.sol:66](../aqua/test/ExposureGuardCanonical.t.sol#L66) | Actual spot token transfer followed by successful option collateral pull. |
| Return-path liveness limit | [aqua/test/Lifecycle.t.sol:465](../aqua/test/Lifecycle.t.sol#L465) | Docking blocks a return until the maker ships and binds an active strategy. |

Run the selected evidence with [the judge demo](demo.md). The [readiness review](submission-review.md)
distinguishes implementation evidence from external actions still requiring confirmation.
