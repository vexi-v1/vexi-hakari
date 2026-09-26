# Uniswap docs — index of everything outside v4 hooks

Fetched via developers.uniswap.org's `/llms-full.txt` outline (2026-09-26). Use this to know
where to look before fetching; fetch the specific page, not the whole `-full.txt` — see "How to
pull a page" below.

| Section | Roughly | Base path |
|---|---|---|
| Integration paths | comparison of 5 ways to integrate (custom linking, API, LP API, SDKs, contracts) | /docs |
| Uniswap API | REST endpoints, Permit2 flow, routing, 16+ chains | /docs/api |
| Uniswap LP API | REST liquidity lifecycle | /docs/api (LP section) |
| Uniswap v4 | core protocol, hooks, security, deployments | /docs/protocols/v4 |
| Uniswap v3 | concentrated liquidity, fee tiers, TWAP oracle, NFT positions | /docs/protocols/v3 |
| Uniswap v2 | constant-product AMM | /docs/protocols/v2 |
| UniswapX | intent-based trading, auctions, filler integration | /docs/uniswapx |
| Liquidity Launchpad | CCA mechanism, token factories | /docs/launchpad |
| Smart Wallet (Calibur) | EIP-7702 delegation, batching, gas abstraction | /docs/calibur |
| The Compact | cross-chain intents, resource locks | /docs/the-compact |
| Permit2 | shared token-approval protocol | /docs/permit2 |
| Universal Router | multi-command execution | /docs/universal-router |
| Protocol fee | fee distribution | /docs/protocols/v4 (fee section) |
| SDKs (v4/v3/v2) | TypeScript: quoting, swaps, liquidity, pool data | /docs/sdk |
| Unichain | OP Stack L2, Flashblocks | /docs/unichain |
| Uniswap AI | LLM toolkit/skills catalog | /docs/ai |
| Subgraphs | GraphQL indexing v2/v3/v4 | /docs/subgraph |
| Governance | UNI voting process | /docs/governance |
| Builder support/FAQs | grants, security, common questions | /docs/faq |

None of this is HAKARI-relevant today (Robinhood Chain 4663/46630 isn't a Uniswap-listed
deployment; HAKARI talks to its own vendored PoolManager address directly). It's here in case a
later feature needs, say, the v4 TS SDK for a frontend quote, or UniswapX/Permit2 if a future
integration needs signature-based approvals.

## How to pull a page

Fetching a rendered `developers.uniswap.org/docs/...` page redirects (303) to
`llms.mdx/docs/...` on the same host — fetch that `llms.mdx` URL directly instead of the
original, e.g.:

```
https://developers.uniswap.org/llms.mdx/docs/protocols/v4/security
```

This returns clean markdown with the actual page content, no nav/CSS. It's more reliable than
fetching `/llms-full.txt` and asking for one section out of it — that file is a compressed index
of the entire doc set, and a fetch tool summarizing it tends to return the same few generic
sentences regardless of what's asked, because the real per-page detail isn't inlined there at
the depth the name suggests.
