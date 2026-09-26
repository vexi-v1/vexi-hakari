// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {SafeSettle} from "../../src/SafeSettle.sol";

/// @dev Writes one SafeSettle decision per scenario to web/decisions/<scenario>.json for the web page.
abstract contract DecisionLog is Test {
    function _record(
        string memory scenario,
        string memory pool,
        uint32 arbReversionSeconds,
        uint32 window,
        uint256 exposure,
        uint8 quoteDecimals,
        string memory unit,
        SafeSettle.Decision memory d
    ) internal {
        string memory row = scenario;
        vm.serializeString(row, "scenario", scenario);
        vm.serializeString(row, "pool", pool);
        vm.serializeUint(row, "arbReversionSeconds", arbReversionSeconds);
        vm.serializeUint(row, "window", window);
        vm.serializeString(row, "exposure", vm.toString(exposure));
        vm.serializeUint(row, "quoteDecimals", quoteDecimals);
        vm.serializeString(row, "unit", unit);
        vm.serializeInt(row, "rawTick", int256(d.rawTick));
        vm.serializeInt(row, "truncTick", int256(d.truncTick));
        vm.serializeString(row, "maxSafeExposure", vm.toString(d.maxSafeExposure));
        vm.serializeInt(row, "bindingTicks", int256(d.bindingTicks));
        vm.serializeBool(row, "bindingUp", d.bindingUp);
        vm.serializeString(row, "bindingCost", vm.toString(d.bindingCost));
        vm.serializeInt(row, "bindingWidth", int256(d.bindingWidth));
        vm.serializeBool(row, "costComplete", d.costComplete);
        string memory out = vm.serializeBool(row, "trusted", d.trusted);
        vm.writeJson(out, string(abi.encodePacked("web/decisions/", scenario, ".json")));
    }
}
