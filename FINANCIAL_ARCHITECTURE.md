# Phase 4 financial architecture

Status: implementation with blocked mainnet activation, not a live payment launch. No production mock adapters, wallets, balances or financial seeds exist.

## Boundaries

`FinancialService` and `NormicServiceNetwork` in core own authorization, immutable service agreements, spending policy, idempotency, lifecycle and event-to-ledger accounting. Delivery code only authenticates/translates requests. `PostgresFinancialRepository` shares real PostgreSQL transactions with the Phase 2 repository. PGlite is explicitly local/test-only.

`RobinhoodFinancialChain` uses an operator-configured HTTPS archive RPC, validates chain 4663, canonical token bytecode and ERC-20 metadata, and pins escrow runtime hash plus admin/resolver/cap configuration. There is no runtime public-RPC or testnet fallback. Balances carry finalized block, block hash, timestamp, source and decimals. Errors return unavailable, not a synthetic zero.

`AlchemyFinancialWallet` derives direct WebAuthn MAv2 accounts using the pinned Account Kit smart-contract adapter (4.88.5). The official WebAuthn factory uses Modular Account V2, **not** the EOA-root SMA-bytecode variant; new records are accurately typed `erc4337-mav2-webauthn`. Existing `erc4337-sma-b` records remain unchanged. No external owner wallet or Privy root is created. Salt is always zero. The factory, implementation, validation module and EntryPoint must exist on chain 4663, their configuration must match, and local CREATE2 prediction must equal the factory's read-only address calculation.

## Create Normic Wallet

Deploy schema migration `0014_webauthn_wallet_provisioning.sql` before releasing this code (0013 alone is insufficient). The migration adds immutable wallet/root linkage and consistency guards; it inserts no users, wallets, credentials or sessions. Use the existing `pnpm db:migrate` release step with production `DATABASE_URL` supplied securely. Do not run production seed commands. The code is not an automatic production migration runner.

At `https://normic.tech/wallet`, a verified Supabase owner with actual authenticated MCP activity clicks **Create Normic Wallet**. `/api/finance/prepare_financial_identity` reserves the company binding; `begin_financial_passkey_registration` returns a five-minute challenge; the browser performs native WebAuthn registration; `complete_financial_passkey_registration` verifies and stores public metadata. `provision_financial_wallet` then derives and binds the counterfactual address without a signature or blockchain submission. Each call uses the current Supabase owner bearer session and owner auth mode; each mutation has an idempotency key. Agent tools cannot enroll passkeys or provision financial wallets.

RP ID is `normic.tech`, origin is exactly `https://normic.tech`, discoverable credentials and user verification are required, and only valid P-256 public coordinates are stored. Cross-origin ceremonies are rejected. Challenges are stored only as hashes, including in audit/idempotency state. Reissuing a challenge invalidates its predecessor; replayed challenge-issuance keys require a fresh request. Successful registration commits independently of provider availability, so **Resume wallet setup** never requires a replacement passkey. Existing wallets are displayed after normal owner authentication. No spending session, token approval or agent financial authority is created by this flow.

Recovery uses the user's existing or synced primary passkey. An additional recovery credential can only be prepared after a fresh assertion by the active primary root. Such a candidate is **not onchain authority**: activating it requires a separate explicit root-signed onchain validation installation. It cannot authorize further recovery or silently replace the immutable root. There is no backend recovery key or email-only root reset. Losing every copy of the root without previously installing recovery cannot be repaired by Normic.

## Important integration boundary

`PrivySessionCustodian` retains its separate, scoped secp256k1 session-signing role. It never receives a financial root key. The legacy EOA/EIP-712 session-installation path rejects WebAuthn-root accounts before creating a Privy signer; a passkey root must explicitly approve onchain session installation. This wallet-enrollment release does not perform that authorization and leaves financial, owner-financial, trading and autonomous execution flags false.

Company locks, a unique company/root binding, unique credential and root public-key identity, unique wallet address and immutable database triggers prevent duplicate or substituted accounts. Root provisioning retries return the existing binding; changing a Privy session signer cannot change the address.

## Authorization

Agents: API credential or issuer/audience-validated OAuth access token → active agent/credential → scopes → company ownership → service permission → explicit spending policy → current session → calldata allowlist → balance/allowance → RPC simulation → chain check → bounded signing.

Owners: separately verified owner JWT (`aud=authenticated`), bound to company owner by issuer+subject. The server verifies the Supabase signature, expiration and email confirmation in trusted `auth.users`; MCP claims are not required for owner auth. Agent credentials cannot edit policy or revoke/re-authorize sessions. Financial root enrollment uses the passkey flow above. The separate human-buyer EVM wallet proof flow remains unchanged. All mutation keys persist with payload hashes.

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
