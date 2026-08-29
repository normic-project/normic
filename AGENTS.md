# Normic engineering guide

## Product boundary

Normic is the operating layer for existing AI agents. Phase 5 adds guarded spot trading architecture for canonical Robinhood Stock Tokens on Robinhood Chain mainnet (4663), using only verified earned-capital lineage. Real execution must fail closed until eligibility, venue, oracle, custody, provider, owner authorization, and explicit risk limits are verified. Never add fake financial data, production mocks, bridges, protocol tokens, leverage, unrestricted wallet calls, or raw owner/session private-key access.

All website copy and public API/MCP descriptions must be written in English.

## Architecture

- `packages/core` owns business rules, accounting, permission checks, and policy decisions.
- `packages/db` owns PostgreSQL/Supabase-compatible schema, migrations, and database clients.
- `packages/sdk` is the typed HTTP client for non-MCP agents.
- `packages/chains` owns network abstractions. `packages/markets` owns official Robinhood registry/oracle validation and verified venue adapters. `packages/payments` owns Alchemy wallet adapters; autonomous payment and trading signing require separately reviewed custodians. `packages/contracts` owns the USDG-only escrow. Never make a mock provider a runtime fallback.
- `apps/mcp` is the Streamable HTTP MCP and REST delivery layer.
- `apps/web` is the Next.js presentation layer. Do not put accounting or policy rules here.

Posted double-entry ledger postings remain the source of truth for accounting. Service journals require finalized escrow events; trading journals require immutable finalized trade settlements. Offchain job completion, deposits, quotes, simulations, submissions, and unfinalized receipts never create revenue, positions, or PnL. Owner/external transfers never become autonomous investable capital. Every mutation is authenticated, scoped, ownership-checked, policy-checked, idempotent, atomic, and audited.

## Quality gates

Before handing off changes, run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build`. Database changes also require `pnpm db:migrate`, `pnpm db:seed`, and `pnpm db:verify`. Authentication changes require REST and MCP smoke tests.
Financial changes additionally require `pnpm contracts:test` and `pnpm contracts:build`. Phase 5 also requires trading-policy, portfolio-accounting, provider, oracle, simulation, wallet-permission and reconciliation tests. Do not transfer real funds to make tests pass. Mainnet funded QA requires configured eligibility, custody, venue allowlists, oracle feeds, credentials, risk caps and explicit owner authorization.

## Codex Efficiency Rules

- Minimize token and tool usage.
- Only implement what the current task explicitly requires.
- Do not add unrelated features.
- Do not refactor working code unless required.
- Do not redesign working UI unless requested.
- Prefer small targeted edits.
- Do not scan the entire repository for every task.
- Search for relevant implementations first and inspect only necessary files.
- Reuse existing architecture and abstractions.
- Assume completed functionality works unless the current change affects it or tests show a regression.
- Do not reimplement completed functionality.
- Do not repeatedly verify external facts already documented in the repository.
- Browse external documentation only when current API, contract, SDK, or protocol information is required.
- During implementation, run only tests relevant to changed code.
- Do not repeatedly run the full test suite after small changes.
- Only update documentation affected by the current task.
- Do not create unnecessary architecture documents.
- Never create fake production balances, revenue, transactions, blockchain data, contract addresses, or financial activity.
- Test fixtures must remain isolated from production.
- Keep final reports concise.
- Once the requested functionality works and relevant tests pass, STOP.
- Do not continue improving unrelated parts of the repository.
