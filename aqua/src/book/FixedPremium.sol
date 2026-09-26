// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IPremium } from "./IPremium.sol";
import { IQuoteReference } from "./IQuoteReference.sol";

/// @title FixedPremium
/// @notice Owner-set quotes with mandatory expiry and an optional price anchor captured when the quote is set.
/// @dev A rolling TWAP can catch up with a persistent move; it does not renew these terms. Only the owner can
///      renew a quote. These checks do not establish that a premium is economically fair.
contract FixedPremium is IPremium, Ownable {
    struct Terms {
        uint64 validUntil; // exclusive: ask refuses at this timestamp
        uint16 maxDeviationBps; // 0 for a time-only quote
        IQuoteReference priceSource;
        uint256 anchorWad;
    }

    error NoPremium(uint256 seriesId);
    error BadQuoteTerms();
    error QuoteExpired(uint256 seriesId, uint64 validUntil);
    error InvalidReferencePrice();
    error QuoteOffAnchor(uint256 seriesId, uint256 currentWad, uint256 anchorWad);

    event PremiumSet(
        uint256 indexed seriesId,
        uint256 premiumPerContract,
        uint64 validUntil,
        IQuoteReference priceSource,
        uint256 anchorWad,
        uint16 maxDeviationBps
    );

    mapping(uint256 seriesId => uint256 quoteUnitsPerContract) public premiumOf;
    mapping(uint256 seriesId => Terms) public termsOf;

    constructor(address owner_) Ownable(owner_) { }

    /// @notice Sets a time-only quote. A zero premium disables it and clears its terms, regardless of validUntil.
    /// @dev Replaces any previous anchor. Use setAnchoredPremium to retain price protection when renewing.
    function setPremium(uint256 seriesId, uint256 premiumPerContract, uint64 validUntil) external onlyOwner {
        _set(seriesId, premiumPerContract, validUntil, IQuoteReference(address(0)), 0, 0);
    }

    /// @notice Captures the source's live price; subsequent asks must remain within maxDeviationBps of this anchor.
    /// @dev Select the source for this series' base/quote pair. The source is trusted; a manipulated price at quote
    ///      creation is not detected here. A zero premium is disabled through setPremium instead.
    function setAnchoredPremium(
        uint256 seriesId,
        uint256 premiumPerContract,
        uint64 validUntil,
        IQuoteReference priceSource,
        uint16 maxDeviationBps
    ) external onlyOwner {
        require(
            premiumPerContract != 0 && address(priceSource) != address(0) && maxDeviationBps > 0
                && maxDeviationBps <= 5000,
            BadQuoteTerms()
        );
        uint256 anchor = priceSource.referencePriceWad();
        require(anchor > 0, InvalidReferencePrice());
        _set(seriesId, premiumPerContract, validUntil, priceSource, anchor, maxDeviationBps);
    }

    function _set(
        uint256 seriesId,
        uint256 premium,
        uint64 until,
        IQuoteReference priceSource,
        uint256 anchor,
        uint16 deviation
    ) internal {
        if (premium == 0) {
            delete termsOf[seriesId];
            until = 0;
        } else {
            require(until > block.timestamp, BadQuoteTerms());
            termsOf[seriesId] = Terms(until, deviation, priceSource, anchor);
        }
        premiumOf[seriesId] = premium;
        emit PremiumSet(seriesId, premium, until, priceSource, anchor, deviation);
    }

    /// @inheritdoc IPremium
    function ask(uint256 seriesId, uint256 n) external view returns (uint256) {
        uint256 p = premiumOf[seriesId];
        require(p != 0, NoPremium(seriesId));
        Terms memory t = termsOf[seriesId];
        require(block.timestamp < t.validUntil, QuoteExpired(seriesId, t.validUntil));
        if (address(t.priceSource) != address(0)) {
            uint256 current = t.priceSource.referencePriceWad();
            require(current > 0, InvalidReferencePrice());
            uint256 distance = current > t.anchorWad ? current - t.anchorWad : t.anchorWad - current;
            require(
                distance <= Math.mulDiv(t.anchorWad, t.maxDeviationBps, 10_000),
                QuoteOffAnchor(seriesId, current, t.anchorWad)
            );
        }
        return n * p;
    }
}
