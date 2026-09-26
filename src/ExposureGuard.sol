// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {PushCostLens} from "./PushCostLens.sol";
import {CostModel} from "./CostModel.sol";
import {IVexiVenue, IVexiSpotLeaf} from "./interfaces/IVexi.sol";

/// @title ExposureGuard
/// @notice CostModel's bound on any pool key, hook or no hook, and one consumer whose exposure a contract can read: a
///         fully collateralised ERC-6909 options venue, where what settles on a pool's price at one expiry is the
///         supply of the series expiring then, priced at the pool.
/// @dev SafeSettle needs the HAKARI hook on the pool (its two TWAPs). This contract needs nothing on the pool: it
///      walks the pool's liquidity through the lens and compares. Two ways in:
///      - `verdict` / `check`: the caller states the exposure (source 0: a what-if);
///      - `venueVerdict` / `venueCheck`: the caller names the venue's series ids (source 1). The guard reads each
///        series, requires one (base, quote, expiry), sums the option tokens' supply, finds the pool through the
///        venue's spot registry and prices the sum at slot0.
///      It verifies the ids it is handed: ERC-6909 has no per-id enumeration, so it cannot find every series on an
///      expiry by itself, and nothing in the venue reads it, so it discloses and cannot gate a fix. Like SafeSettle
///      it refuses a verdict while the PoolManager is unlocked (a liquidity wall added and removed in one
///      transaction); `bound` alone answers anywhere, as the lens does.
contract ExposureGuard {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    struct Verdict {
        bytes32 poolId;
        uint256 exposure; // quote units
        uint256 maxSafeExposure; // quote units
        bool trusted; // exposure < maxSafeExposure
        int24 bindingTicks; // the move that sets the bound
        bool bindingUp; // its tick direction
        uint256 bindingCost; // what faking that move costs, quote units
        bool complete; // false: the binding walk hit its cap; the bound is "at least this"
        uint8 source; // 0: exposure stated by the caller; 1: read from the venue
        uint256 nIds; // series ids summed (source 1), else 0
    }

    /// @dev What the venue says about a set of ids: one (base, quote, expiry), its units, the option supply summed.
    struct SeriesSum {
        address base;
        address quote;
        uint64 expiry;
        uint256 baseUnit;
        uint256 quoteUnit;
        uint256 contracts;
    }

    event Checked(
        bytes32 indexed poolId,
        uint8 source,
        uint256 exposure,
        uint256 maxSafeExposure,
        bool trusted,
        int24 bindingTicks,
        bool bindingUp,
        uint256 bindingCost,
        bool complete
    );
    event VenueRead(address base, address quote, uint64 expiry, uint256 contracts, uint256 spotWad, bytes32 idsHash);

    error ManagerMismatch();
    error PoolManagerUnlocked();
    error NoIds();
    error UnknownSeries(uint256 id);
    error DuplicateId(uint256 id);
    error MixedSeries(uint256 id);
    error Expired(uint256 id);
    error NoPool();

    PushCostLens public immutable lens;
    IPoolManager public immutable poolManager;
    IVexiVenue public immutable venue;
    IVexiSpotLeaf public immutable spotLeaf;
    /// @dev Steps for one walk per direction, shared by every push width it prices (as SafeSettle).
    uint256 public constant MAX_WALK_STEPS = 256;
    uint256 internal constant WAD = 1e18;

    constructor(PushCostLens _lens, IPoolManager _poolManager, IVexiVenue _venue, IVexiSpotLeaf _spotLeaf) {
        if (address(_lens.poolManager()) != address(_poolManager)) revert ManagerMismatch();
        lens = _lens;
        poolManager = _poolManager;
        venue = _venue;
        spotLeaf = _spotLeaf;
    }

    // ───────────────────────── any pool ─────────────────────────

    /// @notice The largest exposure this pool can safely carry now, on any key (hookless included).
    /// @param quoteIsCurrency0    which side of the pool the exposure is denominated in
    /// @param window              TWAP window in seconds (irrelevant while `arbReversionSeconds` is 0)
    /// @param arbReversionSeconds how often arbitrageurs pull the price back; 0 when nobody can
    function bound(PoolKey calldata key, bool quoteIsCurrency0, uint32 window, uint32 arbReversionSeconds)
        external
        view
        returns (CostModel.Bound memory)
    {
        return _bound(key, quoteIsCurrency0, window, arbReversionSeconds);
    }

    /// @notice Is `exposure` (quote units) below what this pool can carry? Refuses to answer inside an unlock.
    function verdict(PoolKey calldata key, bool quoteIsCurrency0, uint256 exposure, uint32 window, uint32 arbReversionSeconds)
        public
        view
        returns (Verdict memory v)
    {
        if (poolManager.isUnlocked()) revert PoolManagerUnlocked();
        CostModel.Bound memory b = _bound(key, quoteIsCurrency0, window, arbReversionSeconds);
        v.poolId = PoolId.unwrap(key.toId());
        v.exposure = exposure;
        v.maxSafeExposure = b.maxSafeExposure;
        v.trusted = exposure < b.maxSafeExposure;
        v.bindingTicks = b.ticks;
        v.bindingUp = b.up;
        v.bindingCost = b.cost;
        v.complete = b.complete;
    }

    /// @notice Same verdict, written to the log (source 0: a what-if on a stated exposure).
    function check(PoolKey calldata key, bool quoteIsCurrency0, uint256 exposure, uint32 window, uint32 arbReversionSeconds)
        external
        returns (Verdict memory v)
    {
        v = verdict(key, quoteIsCurrency0, exposure, window, arbReversionSeconds);
        _log(v);
    }

    // ───────────────────────── the venue ─────────────────────────

    /// @notice The exposure the venue's series `ids` put on their pool, against what that pool can carry.
    /// @dev All ids must name unexpired series on one (base, quote, expiry); an option id or its deposit id names the
    ///      same series. Exposure = Σ option supply × spot, in quote units: delta 1 on every contract, an upper bound.
    ///      The TWAP window is the venue's fix window. `arbReversionSeconds` is the caller's statement, as everywhere.
    /// @return v         the verdict, source 1, `nIds` = ids.length
    /// @return base      the series' base asset
    /// @return quote     the series' quote asset, the unit of `v.exposure`
    /// @return expiry    the series' expiry
    /// @return contracts Σ option supply, in base units
    /// @return spotWad   the pool's price now, quote per base, 18 decimals
    function venueVerdict(uint256[] calldata ids, uint32 arbReversionSeconds)
        public
        view
        returns (Verdict memory v, address base, address quote, uint64 expiry, uint256 contracts, uint256 spotWad)
    {
        SeriesSum memory s = _sum(ids);
        (PoolKey memory key, bool quoteIsCurrency0) = _pool(s.base, s.quote);
        spotWad = _spotWad(key, quoteIsCurrency0, s.baseUnit, s.quoteUnit);
        uint256 exposure = FullMath.mulDiv(FullMath.mulDiv(s.contracts, spotWad, s.baseUnit), s.quoteUnit, WAD);
        (,,, uint64 fixWindow) = venue.terms();
        // CostModel takes the key as calldata; the registry hands it back in memory, so we call ourselves
        v = this.verdict(key, quoteIsCurrency0, exposure, uint32(fixWindow), arbReversionSeconds);
        v.source = 1;
        v.nIds = ids.length;
        (base, quote, expiry, contracts) = (s.base, s.quote, s.expiry, s.contracts);
    }

    /// @notice Same read and verdict, written to the log (source 1).
    function venueCheck(uint256[] calldata ids, uint32 arbReversionSeconds)
        external
        returns (Verdict memory v, address base, address quote, uint64 expiry, uint256 contracts, uint256 spotWad)
    {
        (v, base, quote, expiry, contracts, spotWad) = venueVerdict(ids, arbReversionSeconds);
        emit VenueRead(base, quote, expiry, contracts, spotWad, keccak256(abi.encodePacked(ids)));
        _log(v);
    }

    // ───────────────────────── internals ─────────────────────────

    function _bound(PoolKey calldata key, bool quoteIsCurrency0, uint32 window, uint32 arbReversionSeconds)
        private
        view
        returns (CostModel.Bound memory)
    {
        return CostModel.maxSafeExposure(
            lens, key, CostModel.Query(0, window, arbReversionSeconds, quoteIsCurrency0, MAX_WALK_STEPS)
        );
    }

    /// @dev Reads every series and sums the option supply; one (base, quote, expiry) or it reverts.
    function _sum(uint256[] calldata ids) private view returns (SeriesSum memory s) {
        if (ids.length == 0) revert NoIds();
        for (uint256 i; i < ids.length; i++) {
            uint256 optionId = ids[i] & ~uint256(1);
            for (uint256 j; j < i; j++) {
                if ((ids[j] & ~uint256(1)) == optionId) revert DuplicateId(ids[i]);
            }
            IVexiVenue.SeriesView memory r = venue.series(optionId);
            if (r.base == address(0)) revert UnknownSeries(ids[i]);
            if (i == 0) {
                (s.base, s.quote, s.expiry, s.baseUnit, s.quoteUnit) = (r.base, r.quote, r.expiry, r.baseUnit, r.quoteUnit);
            } else if (r.base != s.base || r.quote != s.quote || r.expiry != s.expiry) {
                revert MixedSeries(ids[i]);
            }
            if (r.expiry <= block.timestamp) revert Expired(ids[i]);
            s.contracts += venue.totalSupply(optionId);
        }
    }

    /// @dev The pool the venue fixes (base, quote) from, and which side of it the quote is.
    function _pool(address base, address quote) private view returns (PoolKey memory key, bool quoteIsCurrency0) {
        bool set;
        (key, set) = spotLeaf.poolOf(base, quote);
        if (!set) revert NoPool();
        quoteIsCurrency0 = Currency.unwrap(key.currency0) == quote;
        if (!quoteIsCurrency0 && Currency.unwrap(key.currency1) != quote) revert NoPool();
    }

    /// @dev The pool's price now as quote per base, 18 decimals, whichever side the quote is on. v4 stores
    ///      sqrt(currency1 per currency0) in Q96 over raw token units; the series' units make it a human price
    ///      (the gauge's `priceInQuote`, web/live/core.js).
    function _spotWad(PoolKey memory key, bool quoteIsCurrency0, uint256 baseUnit, uint256 quoteUnit)
        private
        view
        returns (uint256)
    {
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        uint256 scaled = baseUnit * WAD;
        if (quoteIsCurrency0) {
            // base is currency1: quote per base is 1 / P
            return FullMath.mulDiv(FullMath.mulDiv(scaled, FixedPoint96.Q96, sqrtP), FixedPoint96.Q96, sqrtP) / quoteUnit;
        }
        // base is currency0: quote per base is P
        return FullMath.mulDiv(FullMath.mulDiv(scaled, sqrtP, FixedPoint96.Q96), sqrtP, FixedPoint96.Q96) / quoteUnit;
    }

    function _log(Verdict memory v) private {
        emit Checked(
            v.poolId, v.source, v.exposure, v.maxSafeExposure, v.trusted, v.bindingTicks, v.bindingUp, v.bindingCost, v.complete
        );
    }
}
