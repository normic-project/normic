# Normic Phase 3 implementation report

## 1. Architecture changes

The application now coordinates persisted external-agent services. The core owns authorization, policy, immutable agreements, lifecycle transitions, idempotency, and auditing. Next.js is presentation and a thin authenticated private-job endpoint. MCP/REST and the SDK use the same core. Providers remain separate from accounting.

## 2. Removed production dummy systems

The in-memory economic runtime, mock settlement flows, seeded marketplace/company/activity views, and financial rankings are no longer runtime sources. Seed is empty. Package builds remove stale generated modules. The new local default database is separate from legacy development files; those older files were preserved, not silently rebranded as live data.

Migration 0003 removes the specifically identified legacy demo records. Migration 0005 refuses unrecognized financial history or nonzero legacy treasury projections. Back up and archive an earlier database before upgrading. No service operation can create cash, revenue, P&L, or a ledger entry.

## 3. Database changes

Five ordered migrations define the current schema. Phase 3 adds `service_invocations`, `service_jobs`, `service_results`, `onboarding_idempotency`, and `rate_limit_windows`. Services now have provider identity, input/output schema documents, version, four publication states and explicitly unavailable payment execution. Users gain external issuer/subject binding.

Unique constraints prevent duplicate jobs/results and idempotency claims. Invocation agreements, final states, results, audit events and posted ledger history have database guards. Row locks protect transitions and updates. Ledger accounting and the treasury projection are retained for reconciliation, with application posting disabled outside automated fixtures.

## 4. Robinhood Chain mainnet integration

The only product network is `robinhood-mainnet`, chain ID 4663. `ChainProvider` and the registry remain extensible. `RobinhoodChainProvider` verifies the RPC chain ID and permits block number, block, transaction and bytecode reads. Production requires a dedicated HTTPS RPC; no testnet fallback or transaction broadcast exists. Network facts were checked against [official Robinhood documentation](https://docs.robinhood.com/chain/connecting/).

## 5. Service lifecycle

Buyers discover active services and create an invocation/job. Providers poll their own jobs, accept, start work externally, and submit immutable results. Buyers retrieve their own result. Created/accepted/processing jobs can fail; buyers may cancel before processing. All mutations are authenticated, scoped, ownership/policy checked, idempotent, transactional and audited. The pricing/version agreement remains unchanged when a listing is updated.

## 6. MCP tools

The requested identity, company, balance, permissions, networks, activity and leaderboard tools remain. Service tools include list/search/get/create/update and company services. Job tools include request/get invocation/get my jobs/accept/start/submit result/fail/cancel. Market tools include list Stock Tokens/get token/get stock price/list corporate actions. Compatibility aliases are documented in the README. There are no buy, sell, payment or signer tools.

Production MCP is a Streamable HTTP resource server using exact issuer/audience validation, RS256/ES256 JWKS verification, expiry, per-agent subject and active database credential binding. Requested scopes are intersected with database grants. Opaque MCP credentials are development-only. Protected-resource metadata points to the operator's real external OAuth issuer; there are no pretend authorization/token endpoints. The implementation follows the [official MCP authorization specification](https://modelcontextprotocol.io/specification/draft/basic/authorization).

## 7. REST and SDK

REST supports service discovery and publishing, invocation/job lifecycle, identity, credentials, private audit, operational rankings and read-only markets. The SDK exposes corresponding typed methods, idempotency keys, domain date restoration, and honest unavailable market responses. All mutation smoke tests run against an isolated temporary database.

## 8. External-agent connections

`/connect` documents Claude Code, Hermes, OpenClaw and generic Streamable HTTP clients using official client documentation. Production OAuth and local credential configurations are distinguished. The official MCP client is exercised by authenticated smoke tests. Individual third-party agent applications were not installed or executed, so end-to-end connection with each product is not claimed.

## 9. Live Stock Token data

The adapter reads official assets, quotes, and corporate actions. It preserves nullable trading capabilities, explicit halt information, source URLs, timestamps and stale/unavailable states. Effective bid/ask use exact decimal multiplication by the current corporate-action multiplier; raw underlying prices are retained separately. These semantics were verified against [Robinhood's Stock Token API documentation](https://docs.robinhood.com/chain/stock-token-apis/).

An actual read-only smoke run observed 194 assets, 39 corporate actions, a CRM quote, mainnet block data and deployed contract bytecode. The local website also rendered 194 upstream Stock Tokens and the CRM detail page after network access was enabled. Counts and prices are observations, not constants or fixtures. No transaction was broadcast. Upstream availability is not guaranteed by a single successful smoke run.

## 10. Security controls

Cross-company and cross-invocation access is denied; non-active service listings are private. Credentials are hashed, shown once, expirable, rotatable and revocable. Production onboarding requires verified human identity. Idempotent replays re-check current policy and scopes. Internal errors are redacted. JSON keys/nesting/size and HTTP body size—including chunked MCP requests—are bounded. Callback URLs are never fetched. SQL parameters, row locks and constraints protect persistence.

Structured events exclude credentials and sensitive job payloads. Authentication and authorization failures are auditable. Robinhood failures/staleness are explicit. Database-backed HTTP rate limits, bounded upstream caches, request coalescing and 429 backoff are included. Production still needs perimeter controls and an independent security assessment.

## 11. Production, development and test isolation

Production requires PostgreSQL and external identity-provider configuration. PGlite requires an explicit development/test environment, is file-backed in local runtime, and uses a single-process lock. Concurrent local web/MCP development requires PostgreSQL. Automated fixtures use isolated databases; mutation smoke scripts refuse ordinary local/production instances. The normal local database contains no seeded companies or activity.

## 12. Verification

Verified on August 28, 2026:

| Check                                          | Result                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Frozen dependency installation                 | PASS; all nine workspace projects                                                                    |
| Database migrations                            | PASS; five migrations, repeat application is a no-op                                                 |
| Seed                                           | PASS; intentional no-op, no demo data inserted                                                       |
| Database verification                          | PASS; zero companies, services, jobs and results; no reconciliation mismatch                         |
| Unit and integration tests                     | PASS; 34 tests across five files                                                                     |
| TypeScript typecheck                           | PASS                                                                                                 |
| ESLint                                         | PASS                                                                                                 |
| Prettier formatting                            | PASS                                                                                                 |
| Production build                               | PASS; all packages, MCP server and Next.js                                                           |
| Authenticated REST and MCP                     | PASS against an isolated temporary database/server                                                   |
| Service lifecycle, SDK and HTTP security smoke | PASS; no financial settlement or secret leakage                                                      |
| Web runtime                                    | PASS; eight public routes, missing-resource 404s, private-job authentication and empty-service state |
| Robinhood mainnet read-only smoke              | PASS; real assets, quotes, corporate actions and RPC/contract reads                                  |

The normal local database remained empty; smoke identities and jobs were created only in a temporary test database and removed with that database. The verification commands and smoke boundaries are documented in the README. Passing local PGlite tests is not a claim that managed production PostgreSQL, external OAuth login/consent, or public deployment has been provisioned.

## 13. Known limitations

- No production database, public deployment, external OAuth login/consent service, or dedicated RPC subscription was provisioned in this workspace.
- The owner identity provider must verify email and correctly authorize per-agent OAuth claims; Normic is the resource server, not a hosted login system.
- Automated database integration tests use PGlite's PostgreSQL engine, not a running managed PostgreSQL instance. Production concurrency, pooling, grants/RLS and backup restoration need deployment acceptance testing.
- Browser inspection informed marketplace filter and navigation accessibility improvements. An additional visual reload after the final restart was blocked by browser policy and was not retried; the final HTTP route smoke and production build passed.
- Schema documents are stored safely but not executed as arbitrary validation programs. Providers enforce service-specific input/output semantics.
- Jobs use polling. Provider heartbeats, abandoned-work leases, timeouts, retries and notifications are future work.
- Operational rankings are not fraud-resistant economic reputation. Rate limits and upstream pacing require shared budgets/perimeter policy across replicas.
- Payments, trading, wallets, custody, signing, bridges, token contracts and verified financial ingestion are intentionally absent.

## 14. Recommended Phase 4

Deploy and validate managed PostgreSQL plus human login and per-agent OAuth provisioning. Add production observability, least-privilege grants, ingress abuse controls and recovery drills. Then improve job reliability with leases, heartbeat/timeout policy and notifications; add a safe schema-validation subset and distributed market cache/rate budgets. Financial ingestion or execution requires a separately approved phase with verified sources, risk controls and reconciliation—not simulated money.
