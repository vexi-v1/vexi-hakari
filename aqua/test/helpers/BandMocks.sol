// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";

/// @dev An ERC-20 with the decimals it is given. The band and the settlement read only `decimals`; the tests place it
///      at a fixed address (`deployCodeTo`) so which currency of the pool it is, and so the sign of a tick move, is
///      fixed too.
contract BandToken is ERC20 {
    uint8 internal immutable DECIMALS;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        DECIMALS = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return DECIMALS;
    }
}

/// @dev A PoolManager that answers `extsload` from a table laid out as v4's `Pool.State`, so `StateLibrary` reads it
///      exactly as it reads the real one: slot0 (sqrtPriceX96, tick, fees) and in-range liquidity.
contract BandPoolManagerMock {
    mapping(bytes32 slot => bytes32) internal slots;

    function extsload(bytes32 slot) external view returns (bytes32) {
        return slots[slot];
    }

    function setTick(PoolId id, int24 tick, uint128 liquidity) external {
        bytes32 state = keccak256(abi.encodePacked(PoolId.unwrap(id), StateLibrary.POOLS_SLOT));
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);
        slots[state] = bytes32(uint256(sqrtPriceX96) | (uint256(uint24(tick)) << 160) | (uint256(3000) << 208));
        slots[bytes32(uint256(state) + StateLibrary.LIQUIDITY_OFFSET)] = bytes32(uint256(liquidity));
    }
}

/// @dev The oracle a HAKARI hook keeps, simulated: the tick is piecewise constant between moves, the raw cumulative
///      integrates it, and the truncated series moves at most `MAX_DELTA` ticks per observation (Panoptic's rule, the
///      hook's `MAX_ABS_TICK_DELTA`). A move at time t counts from t on, so a move is invisible to a read in the same
///      second, as with the real hook (it writes its observation before the swap). Reads older than the first
///      observation revert, as the real oracle does. Every move also writes the pool's slot0 and liquidity into the
///      `BandPoolManagerMock`, so the pool's price and its oracle agree.
contract MockBandOracle {
    error TargetPredatesOldestObservation(uint32 oldestTimestamp, uint32 targetTimestamp);

    struct Point {
        uint32 time;
        int24 tick;
        int24 truncTick;
        int56 rawCum;
        int56 truncCum;
    }

    int24 public constant MAX_DELTA = 250;
    Point[] public points;
    BandPoolManagerMock internal immutable manager;
    PoolId internal id;
    uint128 internal liquidity = 1e21;
    bool public broken;

    constructor(BandPoolManagerMock manager_) {
        manager = manager_;
    }

    /// @notice The pool is initialized at `tick` now: the first observation.
    function init(PoolId id_, int24 tick) external {
        id = id_;
        points.push(Point(uint32(block.timestamp), tick, tick, 0, 0));
        manager.setTick(id, tick, liquidity);
    }

    function setLiquidity(uint128 l) external {
        liquidity = l;
        manager.setTick(id, points[points.length - 1].tick, l);
    }

    /// @notice Test knob: every `observe` reverts (the ring is gone, or the hook is broken).
    function setBroken(bool b) external {
        broken = b;
    }

    /// @notice The pool trades to `tick` now.
    function moveTo(int24 tick) external {
        Point memory last = points[points.length - 1];
        uint32 t = uint32(block.timestamp);
        if (t == last.time) {
            int24 prevTrunc = points.length > 1 ? points[points.length - 2].truncTick : last.truncTick;
            points[points.length - 1].tick = tick;
            points[points.length - 1].truncTick = _clamp(tick, prevTrunc);
        } else {
            int56 dt = int56(uint56(t - last.time));
            points.push(
                Point(
                    t,
                    tick,
                    _clamp(tick, last.truncTick),
                    last.rawCum + last.tick * dt,
                    last.truncCum + last.truncTick * dt
                )
            );
        }
        manager.setTick(id, tick, liquidity);
    }

    /// @notice Test knob: shift the truncated series of the current segment by `offset` ticks, leaving the raw series
    ///         alone (the two series disagree).
    function shiftTruncated(int24 offset) external {
        points[points.length - 1].truncTick += offset;
    }

    function _clamp(int24 tick, int24 prevTrunc) internal pure returns (int24) {
        if (tick > prevTrunc + MAX_DELTA) return prevTrunc + MAX_DELTA;
        if (tick < prevTrunc - MAX_DELTA) return prevTrunc - MAX_DELTA;
        return tick;
    }

    function observe(uint32[] calldata secondsAgos, PoolId)
        external
        view
        returns (int56[] memory raw, int56[] memory trunc)
    {
        require(!broken, "oracle broken");
        raw = new int56[](secondsAgos.length);
        trunc = new int56[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            uint32 target = uint32(block.timestamp) - secondsAgos[i];
            if (target < points[0].time) revert TargetPredatesOldestObservation(points[0].time, target);
            uint256 j = points.length - 1;
            while (points[j].time > target) j--;
            Point memory p = points[j];
            int56 dt = int56(uint56(target - p.time));
            raw[i] = p.rawCum + p.tick * dt;
            trunc[i] = p.truncCum + p.truncTick * dt;
        }
    }
}
