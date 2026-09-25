// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {HakariOracleHook} from "./HakariOracleHook.sol";
import {PushCostLens} from "./PushCostLens.sol";
import {CostModel} from "./CostModel.sol";

/// @title SafeSettle
/// @notice A demo settlement rule (not a product): which TWAP to settle on when the raw and truncated series disagree.
/// @dev raw ≈ trunc → raw, nothing to explain. Otherwise: if faking the raw TWAP by the gap would cost the attacker
///      more than it would move this settlement's payout, the move is genuine and the raw price is used (truncation
///      would only lag); if faking is cheaper than the gain, the truncated price is used and the attacker paid fees
///      for nothing. `arbOpen` is the caller's statement about the world (false for a stock token while Robinhood's
///      mint/redeem window is closed) — that is the one place this contract trusts an off-chain gauge.
contract SafeSettle {
    using PoolIdLibrary for PoolKey;

    struct Decision {
        int24 rawTick;
        int24 truncTick;
        int24 tickUsed;
        bool usedRaw;
        uint256 costToFake; // quote units, CostModel v0 lower bound
        uint256 gainIfFaked; // quote units
        bool costComplete; // false: the tick walk hit its cap, costToFake is "at least this"
    }

    event Settled(
        PoolId indexed id, int24 rawTick, int24 truncTick, bool usedRaw, uint256 costToFake, uint256 gainIfFaked
    );

    error WrongHook();

    HakariOracleHook public immutable hook;
    PushCostLens public immutable lens;
    /// @dev Gaps this small are rounding and honest drift, not an attack.
    int24 public constant TOLERANCE_TICKS = 10;
    uint256 public constant MAX_WALK_STEPS = 64;

    constructor(HakariOracleHook _hook, PushCostLens _lens) {
        hook = _hook;
        lens = _lens;
    }

    /// @param window            TWAP window in seconds
    /// @param notionalAtStake   payout notional this settlement moves, in the quote currency's units
    /// @param quoteIsCurrency0  which side of the pool is the quote (USDG is currency0 in HIMS/USDG, currency1 in TSLA/USDG)
    /// @param arbOpen           whether arbitrageurs can pull the price back (mint/redeem open, market open)
    function settlePrice(PoolKey calldata key, uint32 window, uint256 notionalAtStake, bool quoteIsCurrency0, bool arbOpen)
        public
        view
        returns (Decision memory d)
    {
        if (address(key.hooks) != address(hook)) revert WrongHook();
        (d.rawTick, d.truncTick) = hook.twaps(key.toId(), window);
        int24 gap = d.rawTick - d.truncTick;
        bool up = gap > 0;
        int24 x = up ? gap : -gap;
        if (x <= TOLERANCE_TICKS) {
            d.usedRaw = true;
            d.tickUsed = d.rawTick;
            d.costComplete = true;
            return d;
        }
        (d.costToFake, d.costComplete) =
            CostModel.costToFake(lens, key, x, up, window, arbOpen, quoteIsCurrency0, MAX_WALK_STEPS);
        d.gainIfFaked = CostModel.gainIfFaked(notionalAtStake, x, up);
        d.usedRaw = d.costToFake > d.gainIfFaked;
        d.tickUsed = d.usedRaw ? d.rawTick : d.truncTick;
    }

    /// @notice Same decision, written to the log with its reason.
    function settle(PoolKey calldata key, uint32 window, uint256 notionalAtStake, bool quoteIsCurrency0, bool arbOpen)
        external
        returns (Decision memory d)
    {
        d = settlePrice(key, window, notionalAtStake, quoteIsCurrency0, arbOpen);
        emit Settled(key.toId(), d.rawTick, d.truncTick, d.usedRaw, d.costToFake, d.gainIfFaked);
    }
}
