# Phase 5 trading threat model

Internal engineering review only; it is not an external security, smart-account, compliance, venue, or financial audit.

| Threat                        | Implemented control                                                                                          | Remaining launch requirement                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Fake/counterfeit token        | Official asset UID + chain deployment + bytecode + ERC-20 metadata + onchain UID/multiplier agreement        | Independent registry/API monitoring                              |
| Wrong chain                   | Chain ID 4663 before reads, quote, simulation, wallet preparation/send and settlement                        | Independent RPCs and outage policy                               |
| Eligibility bypass            | Owner-bound, expiring provider state; agent cannot self-attest                                               | Reviewed production EligibilityProvider and legal rules          |
| Owner-policy bypass           | Owner-only versioned policy; current scope/ownership/permission/session checks                               | External owner auth/consent UX review                            |
| Capital laundering            | Only finalized escrow revenue and confirmed earned-position proceeds enter investable lineage                | Sybil/wash-service controls and monitoring                       |
| Malicious quote/router        | Direct USDG pair, fixed HTTPS quote origin, versioned target/spender/source allowlists, zero native value    | Verify and approve current chain-4663 contracts; monitor changes |
| Unlimited approvals           | Exact allowance required; active configured-spender allowances visible                                       | Owner wallet revoke UX and allowance monitoring                  |
| Oracle manipulation/staleness | Versioned Chainlink feed per asset UID, positive/fresh round, answered round, sequencer/grace, deviation cap | Multi-provider alerting and reviewed heartbeats                  |
| Halt/corporate action bypass  | Fresh official halt/status plus onchain multiplier/pending/effective/oracle-pause checks                     | Incident response for upstream disagreement                      |
| Session compromise            | Separate expiring trading session, no raw key, quote-bound custodian request                                 | Reviewed hardware/isolated TradingSessionCustodian               |
| Calldata substitution         | Immutable quote, target/data/value verification, simulation, custodian recomputation, finalized tx match     | Full account-abstraction/user-op audit                           |
| Duplicate broadcast           | Persistent request hash, unique quote/trade/call/hash/settlement, unknown-state reconciliation               | Worker recovery drills and provider nonce monitoring             |
| Fake settlement/PnL           | Finalized canonical receipt and before/after token deltas; immutable settlement; atomic FIFO/journal         | Independent indexer reconciliation                               |
| Decimal/multiplier error      | BigInt base units, bounded decimals, 18-decimal multiplier, no JS floating-point money                       | Property tests against live verified assets                      |
| IDOR                          | Current credential, identity, scope, owner/company and primary-agent checks in core                          | Least-privilege DB/RLS and penetration test                      |
| Provider outage               | Unavailable result; no production mock or silent venue switch                                                | SLOs, circuit breakers and incident runbook                      |

No real-fund launch should occur before external review of the custody implementation, venue integration, policy engine, accounting and compliance boundary.
