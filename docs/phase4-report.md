# Phase 4 implementation report

Date: 2026-08-28. Status: implementation and local verification complete; production financial activation **BLOCKED**. No mainnet writes, wallet creation, contract deployment or real money movement were performed. No address or transaction hash exists.

1. **Wallet architecture.** Robinhood Mainnet ERC-4337 `sma-b` account provisioning uses current Alchemy Wallet API JSON-RPC. A human owner wallet remains root. Normic stores addresses/status only. Autonomous API prepare/send exists behind a `SessionCustodian` port with no connected production implementation.
2. **Ownership.** Company owner JWT issuer+subject must match the persistent owner. A separate wallet nonce/origin/chain signature proves EVM ownership. Agents cannot create wallets, edit spending policy or revoke/re-authorize sessions.
3. **Sessions.** Provider-created sessions are restricted to exact escrow selectors, expiry, contract and token. Root, ERC-20 approval/transfer, arbitrary call, native transfer, deployment, bridges and trading are excluded. Local revoke blocks immediately but the owner must also revoke onchain.
4. **Spending policy.** Explicit integer base-unit per-transaction/day caps, expiry, canonical token, pinned escrow and allowed actions. There are no default monetary limits. Backend and escrow independently enforce limits.
5. **Escrow.** Small, non-upgradeable, USDG-only contract with strict states, deadlines, buyer review, permissionless post-window release, frozen dispute, explicit resolver, delayed admin changes, pause and immutable maximum. No sweep or generic external call.
6. **Deployment.** BLOCKED. Address: none. Transaction hash: none. Required: dedicated RPC/signer endpoints, deployer address, multisig admin/resolver, admin delay, USDG cap, audit/approval. The script simulates by default and requires `--broadcast`; source-verification support uses Blockscout Standard JSON.
7. **Canonical USDG.** Official Robinhood documentation was checked for `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. Runtime also requires code, symbol `USDG`, ERC-20 reads and onchain decimals at a finalized block. The current public-RPC diagnostic failed, so no local onchain metadata result is claimed.
8. **Service payment lifecycle.** Request creates a private `payment_required` agreement. Finalized funding reveals a job to the provider; accept/start/work/result commitment/review/release follow. Only release settles revenue/expense. Human and agent buyers share the core flow.
9. **Reconciliation.** Finalized receipts/logs are decoded from the pinned contract; parties, amount and full terms are re-read at the event block. Unique event identity, singleton worker lock, atomic checkpointing and block-hash revalidation prevent replay and concurrent drift.
10. **Ledger.** Phase 2 entries/postings now accept exact token units as a separate denomination. Every USDG journal has an immutable escrow event reference and company. Balances are double-entry and posted history cannot change. Direct transfers are capital/unattributed observations only.
11. **MCP.** Existing tools remain. Phase 4 adds wallet/policy/session, payment requirement/status, funding/refund/release/dispute/result preparation, explicit simulation/broadcast/confirmation, paid queue, transactions and summary. Tool descriptions declare read/prepare/simulate/broadcast/finality effects.
12. **REST/SDK.** `POST /v1/finance/<command>` and typed `client.financial()` call the same core dispatcher. Existing service endpoints route fixed USDG pricing to the financial path; the legacy domain rejects paid bypass. Human wallet sessions are supported.
13. **Gas.** Native gas is ETH. Sponsorship is disabled and not claimed. No arbitrary-operation sponsor policy exists.
14. **Dashboard.** English UI adds wallet settings, honest BLOCKED state, owner policy/session actions, real-balance reads, verified revenue/expenses, real explorer links and human purchase flow. It sends no transaction while capability state is blocked.
15. **Security tests.** Application suite covers cross-company and scope denial, revoked credentials, no-secret persistence/logging behavior, idempotency/conflicts/concurrency, spoofed/reverted receipts, simulation failures, unknown broadcast status, direct-transfer exclusion and exact-unit parsing.
16. **Contract tests.** Isolated Ganache suite covers lifecycle, both refunds, dispute outcomes, time-window release, duplicates, reentrancy, unauthorized callers, pause/remedy behavior, zero/over-cap/self payment, wrong chain, session expiry/day caps, 32 seeded fuzz amounts and obligation invariants. This is internal testing, not an audit. Slither/Foundry static analysis were unavailable locally.
17. **Actual mainnet actions.** Documentation lookup only. Mainnet transactions: 0. Funds moved: 0. Deployment attempt: 0. Public RPC reads were unavailable during final verification; no values were fabricated.
18. **Missing production configuration.** `ROBINHOOD_RPC_URL`, `DEPLOYER_RPC_URL`, `DEPLOYER_ADDRESS`, `ADMIN_ADDRESS`, `DISPUTE_RESOLVER_ADDRESS`, `ADMIN_DELAY_SECONDS`, `MAX_SERVICE_PAYMENT_USDG`, `NORMIC_ESCROW_ADDRESS`, runtime hash/deployment block, `ALCHEMY_API_KEY`, production PostgreSQL/OAuth and a reviewed secure SessionCustodian.
19. **Unresolved risks.** No external audit; resolver/admin/canonical-token/provider trust; session-custodian work; owner onchain revocation UX; independent-RPC monitoring; paid-service abuse/Sybil detection; deployment verification; production backups/restore and indexer supervision.
20. **Recommended Phase 5.** Do not start Stock Token trading first. Complete the Phase 4 production gate: external audits, multisig/admin setup, secure custodian integration, source-verified escrow deployment, observability/incident drills and explicitly authorized low-value USDG lifecycle. Only then design read-only-to-trading expansion under separate owner policies.

The authoritative details and operator steps are in `FINANCIAL_ARCHITECTURE.md`, `SECURITY.md`, `THREAT_MODEL.md`, and `MAINNET_DEPLOYMENT.md`.

## Final verification

- Database migration, empty seed and verification: PASS through `0006_phase4_finance.sql`.
- Application unit/integration/security tests: 48 PASS, 0 failed.
- Contract lifecycle/fuzz/invariant tests: 13 PASS, 0 failed, including 32 deterministic bounded amounts.
- Typecheck, lint, Prettier check, MCP build and Next.js production build: PASS.
- Authenticated isolated REST/MCP/SDK/lifecycle smoke suite: PASS; the temporary database was removed and no fixture reached the local database.
- Robinhood market and canonical USDG read diagnostics: UNAVAILABLE during the final run because the upstream returned unavailable/rate-limited responses. No data was fabricated.
- Mainnet deployment validation: BLOCKED before any signing or broadcast because the required RPC, signer, admin, resolver, delay and maximum-payment configuration is absent.
- Static analysis: NOT RUN because Slither and Foundry are not installed in this environment. Internal tests are not an audit.
