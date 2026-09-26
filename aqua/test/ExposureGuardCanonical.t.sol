// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { stdError } from "forge-std/StdError.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { XYCSwap } from "@1inch/swap-vm/src/instructions/XYCSwap.sol";

import { ExposureGuardExtruction } from "../src/swapvm/ExposureGuardExtruction.sol";

import { ForkFixture } from "./helpers/ForkFixture.sol";
import { AquaPrograms } from "./helpers/AquaPrograms.sol";

/// @notice The ExposureGuard policy on the **canonical** SwapVM router deployed on 4663, through its `Extruction`
///         opcode: no router is redeployed, and a spot fill still cannot take what an open option order promised.
contract ExposureGuardCanonicalTest is ForkFixture {
    uint256 internal constant SPOT_TSLA = 40e18;
    uint256 internal constant SPOT_USDG = 16_000e6;
    uint256 internal constant WALLET_TSLA = 30e18;

    ISwapVM internal constant router = ISwapVM(ROUTER);
    ExposureGuardExtruction internal guard;
    AquaPrograms internal programs;
    address internal taker = makeAddr("taker");

    function setUp() public override {
        super.setUp();
        guard = new ExposureGuardExtruction();
        programs = new AquaPrograms(AQUA);
        vm.label(ROUTER, "CanonicalSwapVMRouter");
        vm.label(address(guard), "ExposureGuardExtruction");
        _shipAndBind();
        _giveTslaFromMaker(makeAddr("elsewhere"), _wallet(TSLA) - WALLET_TSLA);
    }

    function _shipSpot(bool guarded, uint64 salt) internal returns (ISwapVM.Order memory order, bytes32 hash) {
        bytes memory program = guarded
            ? programs.extructionGuardedXycProgram(address(guard), address(writer), salt)
            : programs.xycProgram(salt);
        order = programs.aquaOrder(maker, program);
        vm.prank(maker);
        hash = aqua.ship(ROUTER, abi.encode(order), _addrs(TSLA, USDG), _amts(SPOT_TSLA, SPOT_USDG));
        assertEq(hash, router.hash(order));
    }

    function _quoteOut(ISwapVM.Order memory order, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (uint256 out)
    {
        (, out,) = router.quote(order, tokenIn, tokenOut, amountIn, programs.takerData(taker, true));
    }

    function _xyc(uint256 amountIn, uint256 balanceIn, uint256 balanceOut) internal pure returns (uint256) {
        return amountIn * balanceOut / (balanceIn + amountIn);
    }

    function test_ExtructionOpcodeInThePinnedAquaTable() public view {
        // The deployed router runs the AquaOpcodes table; the fills below prove it accepts the program.
        assertEq(programs.opcodeOfExtruction(), 32, "Extruction is opcode 32 in the AquaOpcodes table");
    }

    function test_CanonicalRouterCapsAtTheUnpromisedBalance() public {
        (ISwapVM.Order memory guarded, bytes32 guardedHash) = _shipSpot(true, 1);
        (ISwapVM.Order memory unguarded,) = _shipSpot(false, 2);
        uint256 seriesId = _series(true);
        uint256 orderId = _post(seriesId, 10); // free = 30 - 10 = 20 TSLA

        uint256 amountIn = 400e6;
        uint256 unguardedOut = _xyc(amountIn, SPOT_USDG, SPOT_TSLA);
        uint256 guardedOut = _xyc(amountIn, Math.ceilDiv(SPOT_USDG * 20e18, SPOT_TSLA), 20e18);
        assertEq(_quoteOut(unguarded, USDG, TSLA, amountIn), unguardedOut, "canonical router, unguarded");
        assertEq(_quoteOut(guarded, USDG, TSLA, amountIn), guardedOut, "canonical router, guarded by extruction");

        deal(USDG, taker, amountIn);
        uint256 walletBefore = _wallet(TSLA);
        vm.startPrank(taker);
        IERC20(USDG).approve(ROUTER, amountIn);
        vm.expectEmit(AQUA);
        emit IAqua.Pulled(maker, ROUTER, guardedHash, TSLA, guardedOut);
        (, uint256 amountOut,) = router.swap(guarded, USDG, TSLA, amountIn, programs.takerData(taker, true));
        vm.stopPrank();
        assertEq(amountOut, guardedOut);
        assertEq(walletBefore - _wallet(TSLA), guardedOut);

        _buyExpectPulled(buyer, orderId, 10, TSLA, 10e18);
        assertEq(_wallet(TSLA), WALLET_TSLA - guardedOut - 10e18, "the promised depth was real");
    }

    function test_CanonicalRouterQuotesNothingWhenEverythingIsPromised() public {
        (ISwapVM.Order memory guarded,) = _shipSpot(true, 1);
        _post(_series(true), 30);
        bytes memory takerData = programs.takerData(taker, true);
        vm.expectRevert(abi.encodeWithSelector(XYCSwap.XYCSwapRequiresBothBalancesNonZero.selector, 0, 0));
        router.quote(guarded, USDG, TSLA, 400e6, takerData);
    }

    function test_CanonicalRouterRefusesTheTwentyFirstTsla() public {
        (ISwapVM.Order memory guarded,) = _shipSpot(true, 1);
        _post(_series(true), 10); // free = 20
        bytes memory takerData = programs.takerData(taker, false);
        (uint256 inFor19,,) = router.quote(guarded, USDG, TSLA, 20e18 - 1, takerData);
        assertGt(inFor19, 0);
        vm.expectRevert(stdError.divisionError);
        router.quote(guarded, USDG, TSLA, 20e18, takerData);
    }
}
