// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { ExposureGuard } from "../src/swapvm/ExposureGuard.sol";

/// @notice Properties of `ExposureGuard.capToFree` over random pools. Pure, no fork.
contract GuardPropertiesTest is Test {
    ExposureGuard internal guard;

    function setUp() public {
        guard = new ExposureGuard();
    }

    /// @dev The out reserve never exceeds `free`, and is untouched when it already fits.
    function testFuzz_OutReserveIsCappedAtFree(uint128 balanceIn, uint128 balanceOut, uint128 free) public view {
        (uint256 cappedIn, uint256 cappedOut) = guard.capToFree(balanceIn, balanceOut, free);
        if (balanceOut <= free) {
            assertEq(cappedIn, balanceIn);
            assertEq(cappedOut, balanceOut);
        } else {
            assertEq(cappedOut, free);
        }
    }

    /// @dev The price never gets better for the taker: cappedIn / cappedOut >= balanceIn / balanceOut, and the
    ///      rounding is the smallest one that keeps it so.
    function testFuzz_PriceNeverImprovesForTheTaker(uint128 balanceIn, uint128 balanceOut, uint128 free) public view {
        vm.assume(balanceOut > free && free > 0);
        (uint256 cappedIn, uint256 cappedOut) = guard.capToFree(balanceIn, balanceOut, free);
        assertGe(cappedIn * uint256(balanceOut), uint256(balanceIn) * cappedOut, "taker cannot get a better rate");
        if (cappedIn > 0) {
            assertLt((cappedIn - 1) * uint256(balanceOut), uint256(balanceIn) * cappedOut, "rounded up by the least");
        }
    }

    /// @dev Nothing free means an empty pool on both sides, so the curve refuses to quote.
    function testFuzz_NothingFreeMeansNothingQuoted(uint128 balanceIn, uint128 balanceOut) public view {
        vm.assume(balanceOut > 0);
        (uint256 cappedIn, uint256 cappedOut) = guard.capToFree(balanceIn, balanceOut, 0);
        assertEq(cappedIn, 0);
        assertEq(cappedOut, 0);
    }

    /// @dev Large reserves do not overflow the scaling.
    function test_LargeReservesDoNotOverflow() public view {
        (uint256 cappedIn, uint256 cappedOut) = guard.capToFree(type(uint200).max, type(uint200).max, 1e18);
        assertEq(cappedOut, 1e18);
        assertEq(cappedIn, 1e18);
    }
}
