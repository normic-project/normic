# Trading architecture

```text
External agent
  → MCP / REST / TypeScript SDK
  → authentication and current credential
  → agent identity + portfolio:trade scope
  → company ownership + asset:trade permission
  → owner eligibility + explicit owner policy
  → separate trading session
  → earned-capital, reserve, daily and exposure checks
  → canonical asset + halt + corporate-action validation
  → TradingVenueProvider real quote
  → finalized Chainlink oracle sanity check
  → exact allowance + eth_call simulation
  → TradingSessionCustodian + Alchemy prepared call
  → Robinhood Chain Mainnet
  → finalized receipt and wallet-delta verification
  → immutable settlement + FIFO lots + double-entry journal
```

`packages/core` owns `TradingService`, the state machine, policy ordering and ports. `packages/markets` implements canonical Robinhood asset/oracle reads and `ZeroExTradingProvider`. `packages/payments` implements the Alchemy Wallet API boundary behind a deployment-owned `TradingSessionCustodian`. `packages/db` stores all durable lifecycle, idempotency, settlement, lots and accounting state. MCP, REST, SDK, and Next.js call the same core dispatcher.

## Lifecycle and retry safety

The durable lifecycle is `POLICY_APPROVED → SIMULATED → PENDING → CONFIRMED`, with terminal `REJECTED`, `QUOTE_EXPIRED`, `SIMULATION_FAILED`, `REVERTED`, and `CANCELLED` states. A quote is immutable except for one transition to `CONSUMED` or `EXPIRED`. `SUBMITTED`/`PENDING` never changes accounting. Confirmation requires a canonical finalized receipt whose chain, sender, target, calldata, value, token deltas, block hash, and minimum output match the immutable quote.

Idempotency is keyed by `(actor, operation, key)` with a request SHA-256. Conflicting payload reuse is rejected. A quote creates at most one trade, a provider call ID and transaction hash are unique, and a trade has at most one immutable settlement and journal. If a broadcast result is unknown, the operation remains durable and must be reconciled by call ID/receipt; it is never blindly resent.

## Provider configuration

The core does not branch on a venue name. It consumes `TradingVenueProvider`, `TradingAssetPort`, `EligibilityProvider`, and `TradingWalletPort`. Production has no mock fallback. Provider failure, missing configuration, wrong chain, stale reference data, and unknown settlement return unavailable/policy errors.
