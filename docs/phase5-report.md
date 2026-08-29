# Phase 5 implementation report

Date: 2026-08-28. Implementation status: code and isolated verification; live Stock Token execution **BLOCKED** pending production eligibility, custody, venue/oracle configuration and explicit owner authorization. Mainnet writes performed: **0**. Funds moved: **0**. Trades performed: **0**.

Normic now has a persistent, authenticated and owner-governed Stock Token trading architecture for chain 4663. The concrete venue is the 0x AllowanceHolder Swap API because both current 0x and Robinhood documentation identify supported Robinhood Chain/RFQ execution. No target or spender address is fabricated or hardcoded; absent reviewed allowlists keep the provider blocked.

Canonical assets are resolved dynamically from the official Robinhood API and finalized contracts, including UID, deployment, code, metadata, status, halt, current/pending multiplier and oracle pause. Versioned Chainlink feed mappings are deployment configuration. Unsafe/stale or contradictory data blocks trading.

The owner eligibility port ships unavailable, so an agent cannot self-declare eligibility. Owner policies have explicit limits and no financial defaults. A separate trading session and reviewed custody adapter are mandatory. Earned capital derives only from finalized service journals and confirmed earned-position sale proceeds; owner/external/unattributed transfers are excluded.

Trades persist quotes, safe decision summaries (never hidden chain-of-thought), policy snapshots, states, provider IDs, hashes and final outcomes. Finalized settlement produces FIFO lots and exact-USDG double-entry journals. Portfolio reads reconcile lots with onchain balances and distinguish realized from unrealized PnL.

MCP adds portfolio, position, investable balance, policy, eligibility, quote, buy, sell, trade history, PnL, approval and reconciliation tools with explicit READ/QUOTE/EXECUTE/CONFIRM effects. REST exposes the same dispatcher at `POST /v1/trading/<command>` and the SDK exposes `client.trading()`. The dashboard adds `/portfolio`, owner pause/revoke controls and truthful capability reporting.

Known launch blockers: no production `EligibilityProvider`; no reviewed `TradingSessionCustodian`; no 0x API key or independently verified target/spender/source allowlist; no per-asset Chainlink feed map/sequencer configuration; no funded owner-authorized QA; no independent security/compliance/accounting audit; and no managed production operations review. These are reported as blocked, not simulated.
