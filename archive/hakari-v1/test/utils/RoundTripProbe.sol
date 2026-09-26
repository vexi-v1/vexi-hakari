// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @dev Test-only. The "manual" attacker: buy exactly `amount` of the base token, sell exactly that
///      much back, in one unlock, and report the net position — without holding any token, by
///      reverting out of the unlock the way the lens does. Used to cross-check `PushCostLens`
///      against a real pool without funding anything.
contract RoundTripProbe is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    struct Result {
        uint160 sqrtPriceAfterBuy;
        int24 tickAfterBuy;
        int256 netDelta0;
        int256 netDelta1;
    }

    error Probe(Result r);

    IPoolManager public immutable manager;

    constructor(IPoolManager m) {
        manager = m;
    }

    /// @param buyZero true: buy `amount` of currency0 (paying currency1) then sell it back
    function roundTrip(PoolKey calldata key, bool buyZero, uint256 amount) external returns (Result memory r) {
        try manager.unlock(abi.encode(key, buyZero, amount)) {}
        catch (bytes memory reason) {
            require(bytes4(reason) == Probe.selector, "probe: swap reverted");
            assembly ("memory-safe") {
                let len := sub(mload(reason), 4)
                reason := add(reason, 4)
                mstore(reason, len)
            }
            return abi.decode(reason, (Result));
        }
        revert("probe: unlock returned");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool buyZero, uint256 amount) = abi.decode(data, (PoolKey, bool, uint256));
        Result memory r;
        // exact output buy of `amount`
        BalanceDelta a = manager.swap(
            key,
            SwapParams({
                zeroForOne: !buyZero,
                amountSpecified: int256(amount),
                sqrtPriceLimitX96: buyZero ? TickMath.MAX_SQRT_PRICE - 1 : TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        (r.sqrtPriceAfterBuy, r.tickAfterBuy,,) = manager.getSlot0(key.toId());
        // exact input sell of the same `amount`
        BalanceDelta b = manager.swap(
            key,
            SwapParams({
                zeroForOne: buyZero,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: buyZero ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        r.netDelta0 = int256(a.amount0()) + int256(b.amount0());
        r.netDelta1 = int256(a.amount1()) + int256(b.amount1());
        bytes memory out = abi.encodeWithSelector(Probe.selector, r);
        assembly ("memory-safe") {
            revert(add(out, 0x20), mload(out))
        }
    }
}
