// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HakariOracleHook} from "./HakariOracleHook.sol";
import {PushCostLens} from "./PushCostLens.sol";
import {CostModel} from "./CostModel.sol";

/// @title SafeSettle
/// @notice A demo settlement rule (not a product): settle on the raw TWAP only if the pool is deep enough that faking a
///         price move would cost more than it could earn on everything settling on that price; otherwise refuse.
/// @dev The question is not whether the raw and truncated series disagree: truncation moves Δ per observation, so a push
///      held long enough makes them agree on the fake. The question is how much exposure this pool's depth can carry
///      right now (CostModel.maxSafeExposure). The two series still inform it: their gap, when there is one, is priced
///      as one more move. `exposure` must be the total settling on this price (every position, not one call), and
///      `arbReversionSeconds` is the caller's statement about the world (0 for a stock token while Robinhood's
///      mint/redeem window is closed): those two inputs are where this contract trusts its integrator. It refuses to
///      answer while the PoolManager is unlocked (a liquidity wall added and removed in one transaction).
contract SafeSettle {
    using PoolIdLibrary for PoolKey;
    using TransientStateLibrary for IPoolManager;

    struct Decision {
        int24 rawTick;
        int24 truncTick;
        bool trusted; // exposure < maxSafeExposure: settle on rawTick
        int24 tickUsed; // rawTick when trusted, 0 when refused (read `trusted`)
        uint256 maxSafeExposure; // quote units
        int24 bindingTicks; // the move that sets the bound
        bool bindingUp; // its tick direction
        uint256 bindingCost; // what faking that move costs, quote units
        bool costComplete; // false: the binding walk hit its cap; the bound is "at least this"
    }

    event Settled(
        PoolId indexed id,
        int24 rawTick,
        int24 truncTick,
        bool trusted,
        uint256 exposure,
        uint256 maxSafeExposure,
        int24 bindingTicks,
        bool bindingUp
    );

    error WrongHook();
    error PoolManagerUnlocked();

    HakariOracleHook public immutable hook;
    PushCostLens public immutable lens;
    /// @dev A gap this small between the two TWAPs is rounding and honest drift, not one more move to price.
    int24 public constant TOLERANCE_TICKS = 10;
    uint256 public constant MAX_WALK_STEPS = 64;

    constructor(HakariOracleHook _hook, PushCostLens _lens) {
        hook = _hook;
        lens = _lens;
    }

    /// @param window              TWAP window in seconds
    /// @param exposure            total payout notional settling on this price, in the quote currency's units
    /// @param quoteIsCurrency0    which side of the pool is the quote (USDG is currency0 in HIMS/USDG, currency1 in TSLA/USDG)
    /// @param arbReversionSeconds how often arbitrageurs pull the price back, in seconds; 0 when nobody can (mint/redeem
    ///                            closed). Pass a slow, measured bound: a fast one overstates what faking costs.
    function settlePrice(
        PoolKey calldata key,
        uint32 window,
        uint256 exposure,
        bool quoteIsCurrency0,
        uint32 arbReversionSeconds
    ) public view returns (Decision memory d) {
        if (address(key.hooks) != address(hook)) revert WrongHook();
        if (lens.poolManager().isUnlocked()) revert PoolManagerUnlocked();
        (d.rawTick, d.truncTick) = hook.twaps(key.toId(), window);
        int24 gap = d.rawTick > d.truncTick ? d.rawTick - d.truncTick : d.truncTick - d.rawTick;
        CostModel.Bound memory b = CostModel.maxSafeExposure(
            lens, key, gap > TOLERANCE_TICKS ? gap : int24(0), window, arbReversionSeconds, quoteIsCurrency0, MAX_WALK_STEPS
        );
        d.maxSafeExposure = b.maxSafeExposure;
        d.bindingTicks = b.ticks;
        d.bindingUp = b.up;
        d.bindingCost = b.cost;
        d.costComplete = b.complete;
        d.trusted = exposure < b.maxSafeExposure;
        d.tickUsed = d.trusted ? d.rawTick : int24(0);
    }

    /// @notice Same decision, written to the log with its reason.
    function settle(
        PoolKey calldata key,
        uint32 window,
        uint256 exposure,
        bool quoteIsCurrency0,
        uint32 arbReversionSeconds
    ) external returns (Decision memory d) {
        d = settlePrice(key, window, exposure, quoteIsCurrency0, arbReversionSeconds);
        emit Settled(key.toId(), d.rawTick, d.truncTick, d.trusted, exposure, d.maxSafeExposure, d.bindingTicks, d.bindingUp);
    }
}
