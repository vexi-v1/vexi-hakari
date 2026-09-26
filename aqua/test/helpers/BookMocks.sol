// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { OptionBook } from "../../src/book/OptionBook.sol";
import { ICollateralSource } from "../../src/book/ICollateralSource.sol";
import { IPremium } from "../../src/book/IPremium.sol";
import { IExpiryPrice } from "../../src/price/IExpiryPrice.sol";

/// @notice A mintable OpenZeppelin ERC-20 with chosen decimals.
contract MockToken is ERC20 {
    uint8 internal immutable DECIMALS;

    constructor(string memory symbol_, uint8 decimals_) ERC20(symbol_, symbol_) {
        DECIMALS = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return DECIMALS;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice A price source whose price for an instant may arrive up to `delay` seconds after it, like any feed that
///         publishes late. The book must keep a series settleable for longer than that.
contract DelayedExpiryPrice is IExpiryPrice {
    error NoPrice(address base, address quote);

    uint64 public immutable DELAY;
    mapping(address base => mapping(address quote => bool)) public covered;
    mapping(address base => mapping(address quote => uint256)) public prices;

    constructor(uint64 delay) {
        DELAY = delay;
    }

    function setCovered(address base, address quote, bool isCovered) external {
        covered[base][quote] = isCovered;
    }

    function setPrice(address base, address quote, uint256 priceWad) external {
        prices[base][quote] = priceWad;
    }

    function covers(address base, address quote) external view returns (bool) {
        return covered[base][quote];
    }

    function maxDelay(address, address) external view returns (uint64) {
        return DELAY;
    }

    function priceAt(address base, address quote, uint64) external view returns (uint256 price) {
        price = prices[base][quote];
        require(price != 0, NoPrice(base, quote));
    }
}

/// @notice A collateral source that hands collateral straight from its own balance, posts its own orders, and can be
///         told to refuse every return (to prove that nothing a maker does can hold a holder's refund hostage).
contract WalletSource is ICollateralSource {
    OptionBook internal immutable BOOK;
    bool public refuseReturns;

    constructor(OptionBook book) {
        BOOK = book;
    }

    function setRefuse(bool refuse) external {
        refuseReturns = refuse;
    }

    function post(uint256 seriesId, IPremium pricer, uint256 maxContracts) external returns (uint256) {
        return BOOK.post(seriesId, pricer, maxContracts);
    }

    function available(uint256, address, address collateral) external view returns (uint256) {
        return IERC20(collateral).balanceOf(address(this));
    }

    function provide(uint256, address, address collateral, uint256 amount) external {
        require(IERC20(collateral).transfer(msg.sender, amount), "transfer failed");
    }

    function onReturned(uint256, address, address, uint256) external view {
        require(!refuseReturns, "maker refuses");
    }
}
