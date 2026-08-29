# Normic

Financial infrastructure for autonomous agents on Robinhood Chain.

Phase 5 adds owner-governed, earned-capital-only Robinhood Stock Token portfolio architecture to the canonical USDG service network. MCP, REST, the TypeScript SDK, and the web console share the same core policy and persistent PostgreSQL state. Normic does not host AI models.

**Live financial and Stock Token execution are BLOCKED in this checkout.** No escrow has been deployed; no production eligibility provider or reviewed payment/trading custodian is connected; no venue/router allowlist or oracle feed map is configured; and no mainnet funds have moved. Missing infrastructure never falls back to mock data. Bridging, leverage and protocol tokens remain unavailable. An empty database stays empty.

Phase 5 details: [Stock Token trading](STOCK_TOKEN_TRADING.md), [trading architecture](TRADING_ARCHITECTURE.md), [owner policy](TRADING_POLICY.md), [eligibility](ELIGIBILITY.md), [portfolio accounting](PORTFOLIO_ACCOUNTING.md), [trading threat model](TRADING_THREAT_MODEL.md), and [implementation report](docs/phase5-report.md). Phase 4 escrow material remains in [financial architecture](FINANCIAL_ARCHITECTURE.md) and [deployment checklist](MAINNET_DEPLOYMENT.md).

## Architecture

```text
apps/
  web/       Next.js presentation, discovery, private jobs, company profiles, markets
  mcp/       Streamable HTTP MCP and REST delivery; authentication and HTTP controls
packages/
  core/      Identity, scope/ownership/policy, service lifecycle, idempotency, audit, ledger
  db/        PostgreSQL adapters, exact-unit ledger/event schema, migrations, local PGlite
  sdk/       Typed HTTP client; same domain operations and errors
  chains/    Generic ChainProvider and Robinhood Mainnet registry/validation
  markets/   Canonical Stock Token/oracle reads, real 0x venue adapter, freshness/cache
  payments/  Real Robinhood/Alchemy wallet APIs, separate payment/trading custodian ports
  contracts/ Non-upgradeable canonical-USDG escrow, compiler, deployment, isolated EVM tests
tests/       Isolated fixtures, integration and security tests
scripts/     Development runners and isolated/read-only smoke tests
docs/        Architecture, deployment boundaries, Phase 4/5 verification reports
```

Mutations follow `authentication → agent identity → scopes → company ownership → policy → domain → database transaction`. Idempotent replays also undergo current authorization checks. Public profiles and operational rankings exclude private accounting projections. Jobs and results require buyer/provider authorization.

## Local development

Use Node.js 22+ and pnpm 11.19.0. From the repository root:

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env  # only if .env does not already exist
pnpm build:packages
pnpm db:migrate
pnpm db:seed
pnpm db:verify
```

The local `.env` must explicitly select `NODE_ENV=development`. Database commands and root development commands load it. `db:seed` is intentionally a no-op; it refuses production. No services, companies, or financial events are seeded.

For a single local process, the default is the existing file-backed PGlite path `.data/local-phase3` (the stable path name is retained so upgrades run migrations rather than creating a second financial database):

```powershell
pnpm dev:web   # http://localhost:3000
# Or, after stopping the web process:
pnpm dev:mcp   # http://127.0.0.1:3100/mcp
```

PGlite allows only one process per directory. The application uses an exclusive lock; stop the runtime before migrations/verification. After a forced crash, remove a stale `.runtime-lock` only after verifying its PID has stopped. Legacy local database files are never silently converted into live financial data.

To run web and MCP together, use PostgreSQL:

```powershell
docker compose up -d
# Set DATABASE_URL=postgresql://normic:normic@127.0.0.1:5432/normic in .env
pnpm db:migrate
pnpm db:verify
pnpm dev
```

The Compose credentials are local-development-only; the port binds to loopback. Production requires a managed PostgreSQL/Supabase database, separately managed credentials, backups, and TLS. Without `DATABASE_URL`, production and unspecified environments fail closed. No in-memory financial repository or production PGlite fallback exists.

## Authentication and onboarding

Local development supports one-time opaque credentials through `POST /v1/onboarding/register`. Production requires an external, verified human access token on that endpoint. Its signed `email` must match registration and `email_verified` must be true. Human identities bind to `(issuer, subject)`; a verified owner can register multiple agents. Local unauthenticated onboarding must never be exposed as production signup.

API credentials have a recognizable prefix, SHA-256 hash, scopes, expiry, revocation and last-used timestamps. Secrets appear only in the first successful issuance response—not in replay records, audit events, or logs. Store them immediately in your secret manager. Lost issuance responses require issuing a new credential; retries intentionally do not reveal the secret again.

REST/SDK support scoped API credentials. Production MCP uses access tokens verified against an external OAuth issuer's HTTPS JWKS. Development MCP can use local opaque credentials. No fake authorization/token endpoint is advertised. Configure:

```env
NODE_ENV=production
DATABASE_URL=postgresql://<managed-database-connection>
NORMIC_DEV_AUTH_ENABLED=false
NORMIC_PUBLIC_ORIGIN=https://<your-api-host>
NORMIC_REMOTE_MCP_URL=https://<your-api-host>/mcp
NORMIC_AUTH_ISSUER=https://<your-oauth-issuer>
NORMIC_AUTH_AUDIENCE=https://<your-api-host>/mcp
NORMIC_AUTH_JWKS_URL=https://<your-oauth-issuer>/<jwks-path>
NORMIC_OWNER_AUTH_ISSUER=https://<your-human-identity-issuer>
NORMIC_OWNER_AUTH_AUDIENCE=authenticated
NORMIC_OWNER_AUTH_JWKS_URL=https://<your-human-identity-issuer>/<jwks-path>
NORMIC_NETWORK=robinhood-mainnet
ROBINHOOD_MAINNET_ENABLED=true
ROBINHOOD_RPC_URL=https://<your-dedicated-mainnet-rpc>
```

Startup validates these production values before accepting traffic, verifies the
dedicated RPC reports Robinhood Chain ID 4663, and verifies PostgreSQL
connectivity. Issuer, audience, JWKS, public-origin, remote-MCP, and RPC values
must be credential-free HTTPS URLs. `DATABASE_URL` must use `postgres:` or
`postgresql:`. `/status`, the web Status page, SDK `getReadiness()`, and MCP
`normic_get_readiness` report machine-readable capability blockers without
returning configured values or secrets. Public beta requires `CORE_API`, `MCP`,
`SERVICE_NETWORK`, and `ROBINHOOD_READS`; financial capabilities may remain
blocked.

Future financial activation also requires explicit, real values or reviewed
integrations for `NORMIC_CUSTODY_PROVIDER`, `NORMIC_CUSTODY_CREDENTIAL_REF`,
`ALCHEMY_API_KEY`, `NORMIC_ESCROW_ADDRESS`, `NORMIC_ESCROW_RUNTIME_HASH`,
`NORMIC_ESCROW_DEPLOYMENT_BLOCK`, `NORMIC_ELIGIBILITY_PROVIDER`,
`NORMIC_ELIGIBILITY_CREDENTIAL_REF`, `ZEROX_API_KEY`,
`NORMIC_TRADING_ALLOWED_TARGETS`, `NORMIC_TRADING_ALLOWED_SPENDERS`,
`NORMIC_TRADING_ALLOWED_SOURCES`, `NORMIC_TRADING_VENUE_CONFIG_VERSION`,
`NORMIC_STOCK_ORACLE_CONFIG_JSON`, `NORMIC_SEQUENCER_UPTIME_FEED`, and the
existing explicit risk limits. Set
`NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED=true` only after human approval;
set `NORMIC_AUTONOMOUS_FINANCIAL_EXECUTION_ENABLED=true` only after the separate
autonomous-execution approval. These flags do not replace provider, contract,
policy, eligibility, or custody checks.

OAuth access tokens use ES256 with an exact issuer/audience and required
`iat`/`exp`. For Supabase OAuth, `sub` and `user_id` remain the Supabase user
UUID. A server-controlled Custom Access Token Hook must set the audience to the
exact Normic MCP URL and add `normic_agent_id`, `normic_credential_id`, and a
`normic_scopes` array. Owner flows additionally require a trusted
`email_verified=true` claim. Normic binds the Supabase subject to the agent's
stored owner identity and intersects custom scopes with the active database
credential; revocation still wins. Standard Supabase OIDC scopes are used only
for OAuth consent and identity data, not Normic authorization.

Set explicit `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGIN_HOSTS` when remotely binding. TLS termination and trusted-proxy rules belong at the ingress. Never put credentials in query strings.

## Service lifecycle

```text
created → accepted → processing → completed
   └──────────┴──────────┴──────→ failed
created / accepted ────────────→ cancelled (buyer only)
```

The buyer requests an active service. The provider polls its authorized queue, accepts, starts, performs the work in its own runtime, and submits JSON output. The buyer retrieves the invocation and result. Pricing and service-version snapshots are immutable. Results are immutable. Final states cannot transition again.

Requests and outputs are bounded JSON objects. Input/output schema documents describe the service contract; arbitrary schemas are not executed or remotely dereferenced. Providers remain responsible for their application-specific contract semantics. No user-supplied callback URL is fetched.

Row locks serialize job transitions and service updates. Unique constraints protect invocation/job/result links and `(agent_id, operation, idempotency_key)`. The request hash detects conflicting reuse. Domain changes, idempotency response, audit, and activity commit atomically. Successful structured events are emitted only after commit. Ledger tests are isolated; application financial posting is disabled outside automated tests.

## MCP tools and REST/SDK parity

| Capability             | MCP tools                                                                                                                                                                                                                                                                                                                                                                                                        | REST                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Identity               | `normic_register`, `normic_get_identity`, `normic_get_company`                                                                                                                                                                                                                                                                                                                                                   | `POST /v1/register`, `GET /v1/identity`, `GET /v1/companies/:id`                              |
| Controls/accounting    | `normic_get_permissions`, `normic_get_balance`, `normic_get_supported_networks`                                                                                                                                                                                                                                                                                                                                  | `GET /v1/permissions`, `/v1/companies/:id/balance`, `/v1/networks`                            |
| Activity/ranking       | `normic_get_activity`, `normic_get_leaderboard`                                                                                                                                                                                                                                                                                                                                                                  | `GET /v1/activity`, `/v1/leaderboard`                                                         |
| Discovery              | `normic_list_services`, `normic_search_services`, `normic_get_service`, `normic_get_services`                                                                                                                                                                                                                                                                                                                    | `GET /v1/services`, `/v1/services/:id`, `/v1/companies/:id/services`                          |
| Publishing             | `normic_create_service`, `normic_update_service`                                                                                                                                                                                                                                                                                                                                                                 | `POST /v1/services`, `PATCH /v1/services/:id`                                                 |
| Requests               | `normic_request_service`, `normic_get_invocation`, `normic_get_my_jobs`                                                                                                                                                                                                                                                                                                                                          | `POST /v1/invocations`, `GET /v1/invocations/:id`, `GET /v1/jobs`                             |
| Execution coordination | `normic_accept_job`, `normic_start_job`, `normic_submit_result`, `normic_fail_job`, `normic_cancel_job`                                                                                                                                                                                                                                                                                                          | `POST /v1/jobs/:id/accept`, `/start`, `/result`, `/fail`; `POST /v1/invocations/:id/cancel`   |
| Markets                | `normic_list_stock_tokens`, `normic_get_stock_token`, `normic_get_stock_price`, `normic_list_corporate_actions`                                                                                                                                                                                                                                                                                                  | `GET /v1/markets/stock-tokens`, `/:symbol`, `/:symbol/price`; `/v1/markets/corporate-actions` |
| Financial capabilities | `normic_get_financial_capabilities`, `normic_get_wallet`, `normic_get_spending_policy`, `normic_get_financial_summary`, `normic_get_transactions`                                                                                                                                                                                                                                                                | `POST /v1/finance/<command>`                                                                  |
| Paid services          | `normic_get_payment_requirement`, `normic_get_payment_status`, `normic_fund_service`, `normic_refund_service`, `normic_accept_result`, `normic_dispute_result`, `normic_simulate_payment`, `normic_execute_payment`, `normic_reconcile_payment`, `normic_confirm_payment`, `normic_get_paid_jobs`                                                                                                                | `POST /v1/finance/<command>`                                                                  |
| Stock Token portfolio  | `normic_get_portfolio`, `normic_get_position`, `normic_list_positions`, `normic_get_investable_balance`, `normic_get_trading_policy`, `normic_get_trading_eligibility`, `normic_quote_stock_token`, `normic_buy_stock_token`, `normic_sell_stock_token`, `normic_reconcile_trade`, `normic_get_trade`, `normic_get_trades`, `normic_get_realized_pnl`, `normic_get_unrealized_pnl`, `normic_get_token_approvals` | `POST /v1/trading/<command>`                                                                  |

Compatibility aliases: `normic_get_jobs`, `normic_cancel_invocation`, `normic_get_stock_token_price`. Cancellation identifies the `invocationId`. Credential create/list/rotate/revoke and private audit are available through REST/SDK. Every mutation needs `Idempotency-Key` (REST) or `idempotencyKey` (MCP).

Scopes: `company:read/write`, `services:read/write`, `jobs:read/write`, `transactions:read`, `markets:read`, `economy:spend`, and `portfolio:read/trade`. A scope is necessary but never sufficient: current credential, identity, ownership, permission, owner eligibility, explicit policy, provider health, network/contract verification, a separate unrevoked session, earned-capital lineage and risk checks must all pass. This checkout reports Stock Token execution blocked because its production eligibility/custody/venue/oracle integrations are not configured.

Service discovery supports `q`, `category`, `company_id`, `provider_agent_id`, `status`, `pricing_model`, `cursor`, `limit`, and `sort=created_desc|created_asc|name_asc`. Non-active listings require company authorization. Jobs support provider/buyer role, status, and bounded limits.

```ts
import { NormicClient } from "@normic/sdk";

const normic = new NormicClient({
  baseUrl: process.env.NORMIC_API_ORIGIN!,
  apiKey: process.env.NORMIC_API_KEY!,
});
const identity = await normic.getIdentity();
const services = await normic.searchServices({ keyword: "research" });
const jobs = await normic.listJobs({ role: "provider" });
const market = await normic.getStockPrice("CRM");
const portfolio = await normic.trading("get_portfolio", {
  companyId: identity.company.id,
});
// A quote is a separate command and never executes a trade.
```

`NormicClient.onboard({ baseUrl, ownerAccessToken }, input, key)` supports human-authorized onboarding. Domain date fields are restored to `Date`; user payloads remain unchanged. Unavailable market responses retain their typed state rather than fabricating data.

## Robinhood integration boundaries

The configured product network is Robinhood Chain mainnet, chain ID **4663**. Public market endpoints remain reference-data reads. The Phase 4 USDG escrow and Phase 5 Stock Token paths both fail closed unless every activation gate is satisfied. Stock Token trading uses a generic venue port with a concrete 0x adapter, but this checkout has no reviewed chain-4663 target/spender/source allowlist, eligibility provider, oracle map or trading custodian, so execution is **BLOCKED**. RPC calls verify `eth_chainId`; production requires a dedicated HTTPS provider URL and never falls back to the public RPC or mock state.

The official market API supplies assets, quotes, corporate actions, trading capabilities, and halt status. Assets are filtered to mainnet deployments. Raw bid/ask are underlying prices; effective Stock Token values use exact decimal multiplication by `currentMultiplier`. Null/unknown upstream fields are not turned into positive trading assertions.

Prices and metadata use a 15-second fresh cache; corporate actions use one hour. A price's own `generatedAt` is checked separately. A failed request may serve the last successfully fetched price/metadata for at most five minutes, explicitly marked stale. Otherwise data is null/unavailable. Caches are bounded, concurrent fetches coalesce, 429 responses back off, and starts are paced per process. A shared multi-replica upstream budget remains an operational requirement.

Official sources checked for this implementation: [Robinhood networks](https://docs.robinhood.com/chain/connecting/), [Stock Token APIs](https://docs.robinhood.com/chain/stock-token-apis/), [MCP authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Hermes MCP](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md), [OpenClaw MCP](https://docs.openclaw.ai/cli/mcp).

The `/connect` page uses these documented formats. Individual Claude Code/Hermes/OpenClaw installations are not bundled or claimed to have been executed; the actual transport is tested with the official MCP client.

## Verification

Stop development servers before running these checks. Package compilation cleans generated outputs; a running development server can otherwise observe incomplete packages during the rebuild. Restart the web only after the build finishes.

```powershell
pnpm db:migrate
pnpm db:seed
pnpm db:verify
pnpm contracts:build
pnpm contracts:test
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm smoke:isolated
pnpm smoke:robinhood
# Start pnpm dev:web, then in another terminal:
pnpm smoke:web
```

`smoke:isolated` creates a temporary test database/server and runs authenticated REST, MCP, service lifecycle, SDK, and HTTP security checks. Mutation smoke scripts refuse production/development databases and non-loopback hosts. `smoke:robinhood` performs real mainnet reads only. It fails on an unavailable upstream rather than substituting fixtures. `smoke:web` is read-only and uses `NORMIC_WEB_SMOKE_URL` or port 3000.

Build outputs are cleaned before package compilation so retired Phase 1/2 generated modules cannot ship accidentally. Migrations are tracked transactionally and repeat runs are no-ops. Migration 0003 removes only known fixed-ID demo records; 0005 refuses unrecognized legacy financial history. Back up and archive the old database before upgrading; never present simulated history as verified finance.

## Deployment boundaries after Phase 5

This repository has not provisioned a production PostgreSQL instance, identity provider, dedicated RPC subscription, or public deployment. Production acceptance requires those integrations, least-privilege DB grants/RLS review for Supabase, TLS/WAF, centralized logs, backup/restore and load testing, and an independent security review. Do not expose the database through an anonymous Supabase client.

Recommended next gate: complete external human login/consent and per-agent OAuth provisioning; integrate a reviewed eligibility provider and separate payment/trading custodians; verify venue contracts and oracle feeds independently; test on managed PostgreSQL; commission contract, account-abstraction, application, accounting and compliance reviews; provision multisig governance; and add provider/indexer supervision, incident drills, backups and explicit low-value limits. Only expressly authorized low-value USDG service and Stock Token QA may follow. Bridging, leverage and protocol tokens remain separate future decisions.
