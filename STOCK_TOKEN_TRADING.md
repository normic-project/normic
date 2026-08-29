# Robinhood Stock Token trading

Phase 5 is a fail-closed, spot-only path for canonical Robinhood Stock Tokens on Robinhood Chain Mainnet (`chainId 4663`). It supports only `USDG → Stock Token` and `Stock Token → USDG`. It does not support bridges, leverage, margin, lending, derivatives, short sales, arbitrary calls, or owner-capital investment.

## Verified venue

The concrete adapter is the 0x Swap API AllowanceHolder quote endpoint. Robinhood documents RFQ trading as a launch execution model and 0x identifies Robinhood Chain support. The adapter treats `api.0x.org` as a quote service, not an authority to approve arbitrary calldata. A returned `transaction.to`, `allowanceTarget`, spender, token pair, direct route, source, amount, simulation status, and zero native value must all match deployment-controlled allowlists.

No router or spender address is built into source code. This checkout has no reviewed address allowlist, so execution is **BLOCKED**. An operator must independently verify current chain-4663 contracts, insert a versioned `trading_venue_configs` record with an audit event, and configure the exact matching environment values. A quote can never add its own target to an allowlist.

Sources: [Robinhood building with Stock Tokens](https://docs.robinhood.com/chain/building-with-stock-tokens/), [0x supported chains](https://docs.0x.org/docs/introduction/supported-chains), [0x AllowanceHolder quote API](https://docs.0x.org/api-reference/evm-ap-is/swap/allowanceholder-getquote), and [0x contract/approval guidance](https://docs.0x.org/docs/core-concepts/contracts).

## Canonical assets

Symbols and user-supplied addresses are never trusted. For each request Normic:

1. retrieves fresh official Robinhood asset and price/halt records;
2. requires exactly one deployment on chain 4663;
3. validates the asset UID, canonical address, symbol, decimals, bytecode, status, halt state, `uiMultiplier()`, pending multiplier, effective time, and oracle pause against finalized onchain state;
4. validates canonical USDG at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` by address, code, symbol and decimals;
5. rejects stale, contradictory, paused, halted, inactive, unknown, or wrong-chain data.

Supported assets are therefore dynamic: an asset is supported only for the duration of a request when the official registry, finalized contract state, configured oracle feed, owner allowlist, and verified venue all agree. There is no static production asset list and no fake fallback.

Official sources: [Stock Token API](https://docs.robinhood.com/chain/stock-token-apis/), [canonical contracts](https://docs.robinhood.com/chain/contracts/), and [Robinhood Chain connection parameters](https://docs.robinhood.com/chain/connecting/).

## Runtime status

This checkout has no production eligibility provider, reviewed `TradingSessionCustodian`, 0x API key/allowlists, or versioned oracle feed configuration. Real quote/execution capability reports **BLOCKED**. No mainnet write or Stock Token purchase was performed.
