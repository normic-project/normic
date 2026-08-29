# Phase 4 financial architecture

Status: implementation with blocked mainnet activation, not a live payment launch. No production mock adapters, wallets, balances or financial seeds exist.

## Boundaries

`FinancialService` and `NormicServiceNetwork` in core own authorization, immutable service agreements, spending policy, idempotency, lifecycle and event-to-ledger accounting. Delivery code only authenticates/translates requests. `PostgresFinancialRepository` shares real PostgreSQL transactions with the Phase 2 repository. PGlite is explicitly local/test-only.

`RobinhoodFinancialChain` uses an operator-configured HTTPS archive RPC, validates chain 4663, canonical token bytecode and ERC-20 metadata, and pins escrow runtime hash plus admin/resolver/cap configuration. There is no runtime public-RPC or testnet fallback. Balances carry finalized block, block hash, timestamp, source and decimals. Errors return unavailable, not a synthetic zero.

`AlchemyFinancialWallet` uses current JSON-RPC Wallet APIs rather than deprecated Account Kit. Account requests explicitly select `sma-b` ERC-4337 accounts with a separate owner wallet. Only wallet addresses and public session metadata enter PostgreSQL. Session authorization signatures and keys belong to a secure custodian; never store them in application tables or logs.

## Important integration boundary

The `SessionCustodian` port has **no production implementation connected**. This is a material remaining integration, not something an API-key flag silently enables. It must verify the provider-created owner grant, owner EIP-712 signature, expiration, exact selector allowlist and full user-operation calldata/hash before signing. It must retain session keys in secure custody, return only signatures, and support operator/owner revocation. The Wallet API prepare/send integration is implemented, but autonomous execution and new paid requests remain blocked until this adapter is independently reviewed and injected into `createFinancialRuntime`.

Multiple companies cannot reuse a wallet address. Additional account creation under one owner needs a provider-confirmed unique-account provisioning flow; the current safe behavior rejects reused addresses. The owner authorization UX and custodian provisioning require further integration testing with real provider credentials.

## Authorization

Agents: API credential or issuer/audience-validated OAuth access token → active agent/credential → scopes → company ownership → service permission → explicit spending policy → current session → calldata allowlist → balance/allowance → RPC simulation → chain check → bounded signing.

Owners: separately verified owner JWT, bound to company owner by issuer+subject. Agent credentials cannot edit policy or revoke/re-authorize sessions. Connecting a wallet also requires a short-lived wallet proof from a nonce/origin/chain-bound signature. Human buyers use that wallet session without an AI identity. Challenges are single-use; bearer secrets are returned once and stored only as hashes. All mutation keys persist with payload hashes.

## Lifecycle and accounting

`payment_required → FUNDED → ACCEPTED → SUBMITTED → RELEASED`, with deadline refunds and disputed states. The provider cannot read the job before finalized funding. Offchain result completion is not a settlement. Results are immutable; only a salted cryptographic commitment goes onchain. Salt and content remain private to authorized participants.

| Finalized event | Buyer journal                             | Provider journal                               |
| --------------- | ----------------------------------------- | ---------------------------------------------- |
| Funded          | Dr restricted escrow / Cr cash movement   | None                                           |
| Released        | Dr service expense / Cr restricted escrow | Dr cash movement / Cr verified service revenue |
| Refunded        | Dr cash movement / Cr restricted escrow   | None                                           |

These are exact USDG token-unit journals extending the Phase 2 ledger, not a parallel floating-point ledger. Every financial entry references a unique immutable escrow event containing chain ID, transaction hash, log index, block hash and invocation. Posted entries/postings cannot be edited or deleted. No unreferenced real journal can be inserted.

The service-payment ledger records cash **movements**, not a complete wallet cash balance. Wallet cash is read from chain. Direct owner deposits are separate capital observations; other incoming transfers are unattributed. Neither creates revenue. Legacy cents remain a separate historical denomination and are not presented as USDG. Treasury projections must not be interpreted as token wallet balances.

## Replay, concurrency and reconciliation

Actor + operation + idempotency key is unique in PostgreSQL. Payload hashes reject conflicts; company/invocation row locks serialize spending and preparation. One live operation per invocation/action prevents duplicate broadcast plans. Preparing again reuses the plan and refreshes required owner approvals. Simulation is not confirmation.

A committed `broadcasting` marker precedes external submission. Timeout is `unknown`, never automatic retry. Operator reconciliation is required for uncertain submissions. Confirmed events update operation status. Finalized escrow events are unique by chain/hash/log index and journals by event/company. A singleton row lock serializes index workers; events, transfer observations and checkpoints commit atomically. Checkpoint block hashes are revalidated; divergence halts ingestion. Pending events never affect accounting.

Run `pnpm finance:reconcile` from a scheduled worker with the deployment block configured. Scheduling/supervision is infrastructure work, not an in-process web timer. Archive-RPC outages preserve the last committed checkpoint. Rebuilding requires retained immutable offchain agreements and results as well as chain logs; chain logs cannot recreate private service payloads lost with the database.

## Public interfaces

All Phase 3 tools remain. Paid paths use the same core dispatcher. New commands include wallet/balance/policy/summary/history reads, owner policy/session actions, payment requirement/status, funding/release/dispute/refund preparation, simulation, explicit execution, call-ID reconciliation and finalized confirmation. `normic_get_paid_jobs` exposes the escrow-funded queue. A job ID is also its paid invocation ID. `normic_submit_result` stores output; `normic_prepare_result_submission` prepares the required onchain commitment separately. `normic_reconcile_payment` uses current Alchemy `wallet_getCallsStatus` and then validates the finalized chain receipt; it never rebroadcasts.

REST: `POST /v1/finance/<command>` with JSON and bearer authorization. Every mutation requires `Idempotency-Key`; reads use POST with no key requirement. `GET /v1/finance/capabilities` is public configuration only. Wallet challenge/authentication are rate-limited public POSTs with mutation keys. Owner REST uses `X-Normic-Auth-Mode: owner` and a verified owner bearer JWT. Owner MCP uses a separate `X-Normic-Owner-Authorization: Bearer ...` header in addition to its agent OAuth token; never send it as a tool argument.

SDK: `client.financial(command, typedInput, key)` covers every command; wallet, summary and transaction convenience reads are included. Use `authMode: "owner"` with an owner bearer token for sensitive settings. Existing paid request/invocation return types now include `PaidInvocation`; consumers must handle the discriminated shape instead of assuming immediate job creation.

## Verified sources (2026-08-28)

- [Robinhood connections and production RPC](https://docs.robinhood.com/chain/connecting/)
- [Canonical USDG contract](https://docs.robinhood.com/chain/contracts/)
- [Current Alchemy session-key API](https://www.alchemy.com/docs/wallets/reference/wallet-apis-session-keys/api)
- [Alchemy account type selection](https://www.alchemy.com/docs/wallets/transactions/using-eip-7702)
- [Alchemy supported chains](https://www.alchemy.com/docs/wallets/supported-chains)

Gas sponsorship is not configured or claimed. Real ETH is required. No Stock Token execution, Base activation, $NORM, tokenomics or bridge is included.
