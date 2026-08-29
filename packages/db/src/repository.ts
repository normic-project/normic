import { randomUUID } from "node:crypto";
import type {
  Activity,
  Agent,
  ApiCredential,
  ApiCredentialRecord,
  ApiScope,
  AuditEvent,
  AuditEventType,
  Company,
  CompanyMetrics,
  EconomyRepository,
  IdempotencyClaim,
  LedgerAccount,
  LedgerEntry,
  LedgerPosting,
  OperationalMetrics,
  Permission,
  PermissionAction,
  Service,
  ServiceInvocation,
  ServiceJob,
  ServicePage,
  ServiceResult,
  ServiceSearch,
  Transaction,
  Treasury,
  User,
} from "@normic/core";
import type { RuntimeDatabase, SqlExecutor, SqlParameter } from "./database.js";

type Row = Record<string, unknown>;

export class PostgresEconomyRepository implements EconomyRepository {
  constructor(private readonly database: RuntimeDatabase | SqlExecutor) {}

  async transaction<T>(
    operation: (repository: EconomyRepository) => Promise<T>,
  ): Promise<T> {
    if ("transaction" in this.database) {
      return this.database.transaction((transaction) =>
        operation(new PostgresEconomyRepository(transaction)),
      );
    }
    return operation(this);
  }

  async createUser(user: User): Promise<void> {
    await this.execute(
      `INSERT INTO users (id, email, name, created_at, auth_issuer, auth_subject) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        user.id,
        user.email,
        user.name,
        user.createdAt,
        user.authIssuer ?? null,
        user.authSubject ?? null,
      ],
    );
  }

  async createAgent(agent: Agent): Promise<void> {
    await this.execute(
      `INSERT INTO agents (id, user_id, company_id, name, handle, framework, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        agent.id,
        agent.userId,
        agent.companyId,
        agent.name,
        agent.handle,
        agent.framework,
        agent.status,
        agent.createdAt,
      ],
    );
  }

  async createCompany(company: Company): Promise<void> {
    await this.execute(
      `INSERT INTO companies
       (id, owner_user_id, primary_agent_id, slug, name, description, industry, website, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        company.id,
        company.ownerUserId,
        company.primaryAgentId,
        company.slug,
        company.name,
        company.description,
        company.industry,
        company.website,
        company.createdAt,
      ],
    );
  }

  async createTreasury(treasury: Treasury): Promise<void> {
    await this.execute(
      `INSERT INTO treasuries
       (id, company_id, balance_cents, assets_cents, liabilities_cents, ledger_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        treasury.id,
        treasury.companyId,
        treasury.balanceCents,
        treasury.assetsCents,
        treasury.liabilitiesCents,
        treasury.ledgerVersion,
        treasury.updatedAt,
      ],
    );
  }

  async createService(service: Service): Promise<void> {
    await this.execute(
      `INSERT INTO services
       (id, company_id, agent_id, slug, name, description, category, input_schema, output_schema,
        status, version, pricing_model, quoted_price, quoted_currency, payment_execution, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        service.id,
        service.companyId,
        service.agentId,
        service.slug,
        service.name,
        service.description,
        service.category,
        JSON.stringify(service.inputSchema),
        JSON.stringify(service.outputSchema),
        service.status,
        service.version,
        service.pricingModel,
        service.quotedPrice,
        service.quotedCurrency,
        service.paymentExecution,
        service.createdAt,
        service.updatedAt,
      ],
    );
  }

  async updateService(service: Service): Promise<void> {
    await this.execute(
      `UPDATE services SET name=$2, description=$3, category=$4, input_schema=$5::jsonb,
       output_schema=$6::jsonb, status=$7, version=$8, pricing_model=$9, quoted_price=$10,
       quoted_currency=$11, payment_execution=$12, updated_at=$13 WHERE id=$1`,
      [
        service.id,
        service.name,
        service.description,
        service.category,
        JSON.stringify(service.inputSchema),
        JSON.stringify(service.outputSchema),
        service.status,
        service.version,
        service.pricingModel,
        service.quotedPrice,
        service.quotedCurrency,
        service.paymentExecution,
        service.updatedAt,
      ],
    );
  }

  async createInvocation(invocation: ServiceInvocation): Promise<void> {
    await this.execute(
      `INSERT INTO service_invocations
       (id, service_id, buyer_agent_id, provider_agent_id, input, status, pricing_snapshot,
        created_at, accepted_at, processing_at, completed_at, failure_reason)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
      invocationParameters(invocation),
    );
  }

  async updateInvocation(invocation: ServiceInvocation): Promise<void> {
    await this.execute(
      `UPDATE service_invocations SET status=$2, accepted_at=$3, processing_at=$4,
       completed_at=$5, failure_reason=$6 WHERE id=$1`,
      [
        invocation.id,
        invocation.status,
        invocation.acceptedAt,
        invocation.processingAt,
        invocation.completedAt,
        invocation.failureReason,
      ],
    );
  }

  async createJob(job: ServiceJob): Promise<void> {
    await this.execute(
      `INSERT INTO service_jobs
       (id, invocation_id, provider_agent_id, status, created_at, accepted_at, processing_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      jobParameters(job),
    );
  }

  async updateJob(job: ServiceJob): Promise<void> {
    await this.execute(
      `UPDATE service_jobs SET status=$2, accepted_at=$3, processing_at=$4, completed_at=$5 WHERE id=$1`,
      [job.id, job.status, job.acceptedAt, job.processingAt, job.completedAt],
    );
  }

  async createResult(result: ServiceResult): Promise<void> {
    await this.execute(
      `INSERT INTO service_results (id, invocation_id, job_id, provider_agent_id, output, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        result.id,
        result.invocationId,
        result.jobId,
        result.providerAgentId,
        JSON.stringify(result.output),
        result.createdAt,
      ],
    );
  }

  async createTransaction(transaction: Transaction): Promise<void> {
    await this.execute(
      `INSERT INTO transactions
       (id, type, buyer_company_id, buyer_label, seller_company_id, service_id, amount_cents,
        status, ledger_entry_id, reversal_of_transaction_id, failure_reason, created_at, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      transactionParameters(transaction),
    );
  }

  async updateTransaction(transaction: Transaction): Promise<void> {
    await this.execute(
      `UPDATE transactions SET type = $2, buyer_company_id = $3, buyer_label = $4,
       seller_company_id = $5, service_id = $6, amount_cents = $7, status = $8,
       ledger_entry_id = $9, reversal_of_transaction_id = $10, failure_reason = $11,
       created_at = $12, posted_at = $13 WHERE id = $1`,
      transactionParameters(transaction),
    );
  }

  async createActivity(activity: Activity): Promise<void> {
    await this.execute(
      `INSERT INTO activities (id, company_id, type, summary, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        activity.id,
        activity.companyId,
        activity.type,
        activity.summary,
        JSON.stringify(activity.metadata),
        activity.createdAt,
      ],
    );
  }

  async createPermission(permission: Permission): Promise<void> {
    await this.execute(
      `INSERT INTO permissions (id, company_id, action, decision, limit_cents, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        permission.id,
        permission.companyId,
        permission.action,
        permission.decision,
        permission.limitCents,
        permission.createdAt,
        permission.updatedAt,
      ],
    );
  }

  async createAuditEvent(event: AuditEvent): Promise<void> {
    await this.execute(
      `INSERT INTO audit_events
       (id, type, actor_agent_id, company_id, resource_type, resource_id, action, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        event.id,
        event.type,
        event.actorAgentId,
        event.companyId,
        event.resourceType,
        event.resourceId,
        event.action,
        JSON.stringify(event.metadata),
        event.createdAt,
      ],
    );
  }

  async createCredential(credential: ApiCredentialRecord): Promise<void> {
    await this.execute(
      `INSERT INTO api_credentials
       (id, agent_id, prefix, secret_hash, label, scopes, issuer, audience, created_at,
        last_used_at, expires_at, revoked_at, rotated_from_id)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11, $12, $13)`,
      [
        credential.id,
        credential.agentId,
        credential.prefix,
        credential.secretHash,
        credential.label,
        credential.scopes,
        credential.issuer,
        credential.audience,
        credential.createdAt,
        credential.lastUsedAt,
        credential.expiresAt,
        credential.revokedAt,
        credential.rotatedFromId,
      ],
    );
  }

  async getCredential(id: string): Promise<ApiCredentialRecord | null> {
    return firstMapped(
      await this.query(`SELECT * FROM api_credentials WHERE id = $1`, [id]),
      mapCredential,
    );
  }

  async getCredentialByHash(
    secretHash: string,
  ): Promise<ApiCredentialRecord | null> {
    return firstMapped(
      await this.query(`SELECT * FROM api_credentials WHERE secret_hash = $1`, [
        secretHash,
      ]),
      mapCredential,
    );
  }

  async listCredentials(agentId: string): Promise<ApiCredential[]> {
    return (
      await this.query(
        `SELECT * FROM api_credentials WHERE agent_id = $1 ORDER BY created_at DESC`,
        [agentId],
      )
    ).map((row) => {
      const { secretHash: _secretHash, ...credential } = mapCredential(row);
      return credential;
    });
  }

  async revokeCredential(id: string, revokedAt: Date): Promise<void> {
    await this.execute(
      `UPDATE api_credentials SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1`,
      [id, revokedAt],
    );
  }

  async touchCredential(id: string, lastUsedAt: Date): Promise<void> {
    await this.execute(
      `UPDATE api_credentials SET last_used_at = $2 WHERE id = $1`,
      [id, lastUsedAt],
    );
  }

  async claimIdempotency(input: {
    agentId: string;
    operation: string;
    key: string;
    requestHash: string;
    createdAt: Date;
  }): Promise<IdempotencyClaim> {
    const inserted = await this.query(
      `INSERT INTO idempotency_records
       (agent_id, operation, idempotency_key, request_hash, status, created_at)
       VALUES ($1, $2, $3, $4, 'processing', $5)
       ON CONFLICT (agent_id, operation, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        input.agentId,
        input.operation,
        input.key,
        input.requestHash,
        input.createdAt,
      ],
    );
    if (inserted.length > 0) return { state: "claimed" };
    const [record] = await this.query(
      `SELECT request_hash, status, response_json FROM idempotency_records
       WHERE agent_id = $1 AND operation = $2 AND idempotency_key = $3`,
      [input.agentId, input.operation, input.key],
    );
    if (!record) return { state: "processing" };
    if (String(record.request_hash) !== input.requestHash)
      return { state: "conflict" };
    if (record.status === "completed")
      return { state: "replay", response: jsonValue(record.response_json) };
    return { state: "processing" };
  }

  async completeIdempotency(input: {
    agentId: string;
    operation: string;
    key: string;
    response: unknown;
  }): Promise<void> {
    await this.execute(
      `UPDATE idempotency_records SET status = 'completed', response_json = $4::jsonb, completed_at = now()
       WHERE agent_id = $1 AND operation = $2 AND idempotency_key = $3`,
      [
        input.agentId,
        input.operation,
        input.key,
        JSON.stringify(input.response),
      ],
    );
  }

  async claimOnboarding(input: {
    key: string;
    requestHash: string;
    createdAt: Date;
  }): Promise<IdempotencyClaim> {
    const inserted = await this.query(
      `INSERT INTO onboarding_idempotency
       (idempotency_key, request_hash, status, created_at)
       VALUES ($1,$2,'processing',$3)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [input.key, input.requestHash, input.createdAt],
    );
    if (inserted.length > 0) return { state: "claimed" };
    const [row] = await this.query(
      `SELECT request_hash, status, response_json FROM onboarding_idempotency WHERE idempotency_key=$1`,
      [input.key],
    );
    if (!row) return { state: "processing" };
    if (text(row.request_hash) !== input.requestHash)
      return { state: "conflict" };
    if (row.status === "completed")
      return { state: "replay", response: jsonValue(row.response_json) };
    return { state: "processing" };
  }

  async completeOnboarding(input: {
    key: string;
    response: unknown;
  }): Promise<void> {
    await this.execute(
      `UPDATE onboarding_idempotency SET status='completed', response_json=$2::jsonb,
       completed_at=now() WHERE idempotency_key=$1`,
      [input.key, JSON.stringify(input.response)],
    );
  }

  async ensureDynamicOAuthGrant(input: {
    audience: string;
    ownerSubject: string;
    agentId: string;
    credentialId: string;
    createdAt: Date;
  }): Promise<"ready" | "unavailable" | "conflict"> {
    const [policy] = await this.query(
      `SELECT client_id FROM normic_oauth_clients
       WHERE enabled AND allow_dynamic_clients AND audience=$1
       FOR UPDATE`,
      [input.audience],
    );
    if (!policy) return "unavailable";
    const clientId = text(policy.client_id);
    const [existing] = await this.query(
      `SELECT agent_id FROM normic_oauth_agent_grants
       WHERE oauth_client_id=$1 AND supabase_user_id=$2 FOR UPDATE`,
      [clientId, input.ownerSubject],
    );
    if (existing && text(existing.agent_id) !== input.agentId)
      return "conflict";
    await this.execute(
      `INSERT INTO normic_oauth_agent_grants
       (oauth_client_id,supabase_user_id,agent_id,credential_id,created_at,revoked_at)
       VALUES($1,$2,$3,$4,$5,NULL)
       ON CONFLICT(oauth_client_id,supabase_user_id) DO UPDATE SET
         credential_id=EXCLUDED.credential_id,
         revoked_at=NULL`,
      [
        clientId,
        input.ownerSubject,
        input.agentId,
        input.credentialId,
        input.createdAt,
      ],
    );
    return "ready";
  }

  async hasDynamicOAuthGrant(input: {
    audience: string;
    ownerSubject: string;
    agentId: string;
    credentialId: string;
  }): Promise<boolean> {
    const [row] = await this.query(
      `SELECT 1 FROM normic_oauth_agent_grants g
       JOIN normic_oauth_clients c ON c.client_id=g.oauth_client_id
       WHERE c.enabled AND c.allow_dynamic_clients AND c.audience=$1
         AND g.supabase_user_id=$2 AND g.agent_id=$3 AND g.credential_id=$4
         AND g.revoked_at IS NULL`,
      [input.audience, input.ownerSubject, input.agentId, input.credentialId],
    );
    return Boolean(row);
  }

  async consumeRateLimit(input: {
    bucket: string;
    limit: number;
    windowSeconds: number;
    now: Date;
  }): Promise<{
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
  }> {
    const [row] = await this.query(
      `INSERT INTO rate_limit_windows (bucket_hash, window_started_at, request_count)
       VALUES ($1,$3,1)
       ON CONFLICT (bucket_hash) DO UPDATE SET
         window_started_at = CASE WHEN rate_limit_windows.window_started_at <= $3 - ($2 * interval '1 second')
                                  THEN $3 ELSE rate_limit_windows.window_started_at END,
         request_count = CASE WHEN rate_limit_windows.window_started_at <= $3 - ($2 * interval '1 second')
                              THEN 1 ELSE rate_limit_windows.request_count + 1 END
       RETURNING request_count, window_started_at`,
      [input.bucket, input.windowSeconds, input.now],
    );
    const count = integer(row?.request_count);
    const elapsed = Math.max(
      0,
      Math.floor(
        (input.now.getTime() - date(row?.window_started_at).getTime()) / 1000,
      ),
    );
    return {
      allowed: count <= input.limit,
      remaining: Math.max(0, input.limit - count),
      retryAfterSeconds: Math.max(1, input.windowSeconds - elapsed),
    };
  }

  async ensureLedgerAccounts(
    companyId: string,
    createdAt: Date,
  ): Promise<LedgerAccount[]> {
    const definitions: ReadonlyArray<
      Pick<LedgerAccount, "code" | "name" | "type" | "normalBalance">
    > = [
      { code: "cash", name: "Cash", type: "asset", normalBalance: "debit" },
      {
        code: "service_revenue",
        name: "Service revenue",
        type: "revenue",
        normalBalance: "credit",
      },
      {
        code: "service_expense",
        name: "Service expense",
        type: "expense",
        normalBalance: "debit",
      },
      {
        code: "other_asset",
        name: "Other assets",
        type: "asset",
        normalBalance: "debit",
      },
      {
        code: "liability",
        name: "Liabilities",
        type: "liability",
        normalBalance: "credit",
      },
      {
        code: "stock_asset",
        name: "Stock Token cost basis",
        type: "asset",
        normalBalance: "debit",
      },
      {
        code: "trading_pnl",
        name: "Realized trading PnL",
        type: "revenue",
        normalBalance: "credit",
      },
    ];
    for (const definition of definitions) {
      await this.execute(
        `INSERT INTO ledger_accounts (id, company_id, code, name, type, normal_balance, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (company_id, code) DO NOTHING`,
        [
          randomUUID(),
          companyId,
          definition.code,
          definition.name,
          definition.type,
          definition.normalBalance,
          createdAt,
        ],
      );
    }
    return (
      await this.query(
        `SELECT * FROM ledger_accounts WHERE company_id = $1 ORDER BY code`,
        [companyId],
      )
    ).map(mapLedgerAccount);
  }

  async createLedgerEntry(entry: LedgerEntry): Promise<void> {
    await this.execute(
      `INSERT INTO ledger_entries
       (id, transaction_id, description, status, reversal_of_entry_id, created_at, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.id,
        entry.transactionId,
        entry.description,
        entry.status,
        entry.reversalOfEntryId,
        entry.createdAt,
        entry.postedAt,
      ],
    );
  }

  async createLedgerPostings(postings: LedgerPosting[]): Promise<void> {
    for (const posting of postings) {
      await this.execute(
        `INSERT INTO ledger_postings (id, entry_id, account_id, direction, amount_cents, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          posting.id,
          posting.entryId,
          posting.accountId,
          posting.direction,
          posting.amountCents,
          posting.createdAt,
        ],
      );
    }
  }

  async postLedgerEntry(entryId: string, postedAt: Date): Promise<void> {
    await this.execute(
      `UPDATE ledger_entries SET status = 'posted', posted_at = $2 WHERE id = $1 AND status = 'pending'`,
      [entryId, postedAt],
    );
  }

  async getLedgerEntry(id: string): Promise<LedgerEntry | null> {
    return firstMapped(
      await this.query(`SELECT * FROM ledger_entries WHERE id = $1`, [id]),
      mapLedgerEntry,
    );
  }

  async listLedgerPostings(entryId: string): Promise<LedgerPosting[]> {
    return (
      await this.query(
        `SELECT * FROM ledger_postings WHERE entry_id = $1 ORDER BY id`,
        [entryId],
      )
    ).map(mapLedgerPosting);
  }

  async getMetrics(companyId: string): Promise<CompanyMetrics> {
    const [row] = await this.query(
      `SELECT
        COALESCE(sum(CASE WHEN a.code = 'cash' THEN CASE WHEN p.direction = 'debit' THEN p.amount_cents ELSE -p.amount_cents END ELSE 0 END), 0)::bigint AS cash_cents,
        COALESCE(sum(CASE WHEN a.code = 'other_asset' THEN CASE WHEN p.direction = 'debit' THEN p.amount_cents ELSE -p.amount_cents END ELSE 0 END), 0)::bigint AS assets_cents,
        COALESCE(sum(CASE WHEN a.code = 'liability' THEN CASE WHEN p.direction = 'credit' THEN p.amount_cents ELSE -p.amount_cents END ELSE 0 END), 0)::bigint AS liabilities_cents,
        COALESCE(sum(CASE WHEN a.code = 'service_revenue' THEN CASE WHEN p.direction = 'credit' THEN p.amount_cents ELSE -p.amount_cents END ELSE 0 END), 0)::bigint AS revenue_cents,
        COALESCE(sum(CASE WHEN a.code = 'service_expense' THEN CASE WHEN p.direction = 'debit' THEN p.amount_cents ELSE -p.amount_cents END ELSE 0 END), 0)::bigint AS expenses_cents
       FROM ledger_accounts a
       LEFT JOIN ledger_postings p ON p.account_id = a.id
       LEFT JOIN ledger_entries e ON e.id = p.entry_id
       WHERE a.company_id = $1 AND (e.status = 'posted' OR e.id IS NULL)`,
      [companyId],
    );
    const cashCents = integer(row?.cash_cents);
    const assetsCents = integer(row?.assets_cents);
    const liabilitiesCents = integer(row?.liabilities_cents);
    const revenueCents = integer(row?.revenue_cents);
    const expensesCents = integer(row?.expenses_cents);
    return {
      revenueCents,
      expensesCents,
      pnlCents: revenueCents - expensesCents,
      cashCents,
      assetsCents,
      liabilitiesCents,
      netWorthCents: cashCents + assetsCents - liabilitiesCents,
    };
  }

  async reconcileTreasury(
    companyId: string,
    updatedAt: Date,
  ): Promise<Treasury> {
    const metrics = await this.getMetrics(companyId);
    const [version] = await this.query(
      `SELECT count(DISTINCT e.id)::bigint AS value
       FROM ledger_entries e
       JOIN ledger_postings p ON p.entry_id = e.id
       JOIN ledger_accounts a ON a.id = p.account_id
       WHERE a.company_id = $1 AND e.status = 'posted'`,
      [companyId],
    );
    const [row] = await this.query(
      `UPDATE treasuries SET balance_cents = $2, assets_cents = $3, liabilities_cents = $4,
       ledger_version = $5, updated_at = $6 WHERE company_id = $1 RETURNING *`,
      [
        companyId,
        metrics.cashCents,
        metrics.assetsCents,
        metrics.liabilitiesCents,
        integer(version?.value),
        updatedAt,
      ],
    );
    if (!row) throw new Error("Treasury projection is missing.");
    return mapTreasury(row);
  }

  async lockCompanyForUpdate(companyId: string): Promise<void> {
    await this.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [
      companyId,
    ]);
  }

  async lockJobForUpdate(jobId: string): Promise<ServiceJob | null> {
    return firstMapped(
      await this.query(`SELECT * FROM service_jobs WHERE id=$1 FOR UPDATE`, [
        jobId,
      ]),
      mapJob,
    );
  }

  async lockServiceForUpdate(serviceId: string): Promise<Service | null> {
    return firstMapped(
      await this.query(`SELECT * FROM services WHERE id=$1 FOR UPDATE`, [
        serviceId,
      ]),
      mapService,
    );
  }

  async getUser(id: string): Promise<User | null> {
    return firstMapped(
      await this.query(`SELECT * FROM users WHERE id = $1`, [id]),
      mapUser,
    );
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return firstMapped(
      await this.query(`SELECT * FROM users WHERE email = $1`, [email]),
      mapUser,
    );
  }

  async getAgent(id: string): Promise<Agent | null> {
    return firstMapped(
      await this.query(`SELECT * FROM agents WHERE id = $1`, [id]),
      mapAgent,
    );
  }

  async getAgentByHandle(handle: string): Promise<Agent | null> {
    return firstMapped(
      await this.query(`SELECT * FROM agents WHERE handle = $1`, [handle]),
      mapAgent,
    );
  }

  async getCompany(id: string): Promise<Company | null> {
    return firstMapped(
      await this.query(`SELECT * FROM companies WHERE id = $1`, [id]),
      mapCompany,
    );
  }

  async getCompanyBySlug(slug: string): Promise<Company | null> {
    return firstMapped(
      await this.query(`SELECT * FROM companies WHERE slug = $1`, [slug]),
      mapCompany,
    );
  }

  async getTreasury(companyId: string): Promise<Treasury | null> {
    return firstMapped(
      await this.query(`SELECT * FROM treasuries WHERE company_id = $1`, [
        companyId,
      ]),
      mapTreasury,
    );
  }

  async getService(id: string): Promise<Service | null> {
    return firstMapped(
      await this.query(`SELECT * FROM services WHERE id = $1`, [id]),
      mapService,
    );
  }

  async getInvocation(id: string): Promise<ServiceInvocation | null> {
    return firstMapped(
      await this.query(`SELECT * FROM service_invocations WHERE id=$1`, [id]),
      mapInvocation,
    );
  }

  async getJob(id: string): Promise<ServiceJob | null> {
    return firstMapped(
      await this.query(`SELECT * FROM service_jobs WHERE id=$1`, [id]),
      mapJob,
    );
  }

  async getJobByInvocation(invocationId: string): Promise<ServiceJob | null> {
    return firstMapped(
      await this.query(`SELECT * FROM service_jobs WHERE invocation_id=$1`, [
        invocationId,
      ]),
      mapJob,
    );
  }

  async getResultByInvocation(
    invocationId: string,
  ): Promise<ServiceResult | null> {
    return firstMapped(
      await this.query(`SELECT * FROM service_results WHERE invocation_id=$1`, [
        invocationId,
      ]),
      mapResult,
    );
  }

  async getTransaction(id: string): Promise<Transaction | null> {
    return firstMapped(
      await this.query(`SELECT * FROM transactions WHERE id = $1`, [id]),
      mapTransaction,
    );
  }

  async getPermission(
    companyId: string,
    action: PermissionAction,
  ): Promise<Permission | null> {
    return firstMapped(
      await this.query(
        `SELECT * FROM permissions WHERE company_id = $1 AND action = $2`,
        [companyId, action],
      ),
      mapPermission,
    );
  }

  async listAgents(userId?: string): Promise<Agent[]> {
    const rows = userId
      ? await this.query(
          `SELECT * FROM agents WHERE user_id = $1 ORDER BY created_at`,
          [userId],
        )
      : await this.query(`SELECT * FROM agents ORDER BY created_at`);
    return rows.map(mapAgent);
  }

  async listCompanies(ownerUserId?: string): Promise<Company[]> {
    const rows = ownerUserId
      ? await this.query(
          `SELECT * FROM companies WHERE owner_user_id = $1 ORDER BY created_at`,
          [ownerUserId],
        )
      : await this.query(`SELECT * FROM companies ORDER BY created_at`);
    return rows.map(mapCompany);
  }

  async listServices(
    filters: { companyId?: string; status?: Service["status"] } = {},
  ): Promise<Service[]> {
    const clauses: string[] = [];
    const parameters: SqlParameter[] = [];
    if (filters.companyId) {
      parameters.push(filters.companyId);
      clauses.push(`company_id = $${parameters.length}`);
    }
    if (filters.status) {
      parameters.push(filters.status);
      clauses.push(`status = $${parameters.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      await this.query(
        `SELECT * FROM services ${where} ORDER BY created_at DESC`,
        parameters,
      )
    ).map(mapService);
  }

  async searchServices(filters: ServiceSearch): Promise<ServicePage> {
    const clauses: string[] = [];
    const parameters: SqlParameter[] = [];
    const add = (sql: string, value: SqlParameter) => {
      parameters.push(value);
      clauses.push(sql.replace("?", `$${parameters.length}`));
    };
    if (filters.keyword) {
      parameters.push(`%${filters.keyword}%`);
      clauses.push(
        `(name ILIKE $${parameters.length} OR description ILIKE $${parameters.length})`,
      );
    }
    if (filters.category) add("category = ?", filters.category);
    if (filters.companyId) add("company_id = ?", filters.companyId);
    if (filters.providerAgentId) add("agent_id = ?", filters.providerAgentId);
    if (filters.status) add("status = ?", filters.status);
    if (filters.pricingModel) add("pricing_model = ?", filters.pricingModel);
    if (filters.cursor) {
      parameters.push(filters.cursor);
      const op =
        filters.sort === "created_asc" || filters.sort === "name_asc"
          ? ">"
          : "<";
      const column = filters.sort === "name_asc" ? "lower(name)" : "created_at";
      const cursorColumn =
        filters.sort === "name_asc" ? "lower(c.name)" : "c.created_at";
      clauses.push(
        `(${column}, id) ${op} (SELECT ${cursorColumn}, c.id FROM services c WHERE c.id=$${parameters.length})`,
      );
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const order =
      filters.sort === "created_asc"
        ? "created_at ASC, id ASC"
        : filters.sort === "name_asc"
          ? "lower(name) ASC, id ASC"
          : "created_at DESC, id DESC";
    const limit = Math.min(filters.limit ?? 20, 100);
    parameters.push(limit + 1);
    const rows = await this.query(
      `SELECT * FROM services ${where} ORDER BY ${order} LIMIT $${parameters.length}`,
      parameters,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(mapService);
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
  }

  async listJobs(filters: {
    providerAgentId?: string;
    buyerAgentId?: string;
    status?: ServiceJob["status"];
    limit?: number;
  }): Promise<ServiceJob[]> {
    const clauses: string[] = [];
    const parameters: SqlParameter[] = [];
    if (filters.providerAgentId) {
      parameters.push(filters.providerAgentId);
      clauses.push(`j.provider_agent_id=$${parameters.length}`);
    }
    if (filters.buyerAgentId) {
      parameters.push(filters.buyerAgentId);
      clauses.push(`i.buyer_agent_id=$${parameters.length}`);
    }
    if (filters.status) {
      parameters.push(filters.status);
      clauses.push(`j.status=$${parameters.length}`);
    }
    parameters.push(Math.min(filters.limit ?? 50, 100));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      await this.query(
        `SELECT j.* FROM service_jobs j JOIN service_invocations i ON i.id=j.invocation_id
       ${where} ORDER BY j.created_at DESC LIMIT $${parameters.length}`,
        parameters,
      )
    ).map(mapJob);
  }

  async getOperationalMetrics(companyId: string): Promise<OperationalMetrics> {
    const [row] = await this.query(
      `SELECT
        (SELECT count(*)::int FROM services WHERE company_id=$1 AND status='active') services_published,
        count(*) FILTER (WHERE j.status='completed')::int jobs_completed,
        count(*) FILTER (WHERE j.status='failed')::int jobs_failed,
        count(j.id)::int total_jobs,
        count(DISTINCT i.buyer_agent_id)::int unique_buyers
       FROM agents a
       LEFT JOIN service_jobs j ON j.provider_agent_id=a.id
       LEFT JOIN service_invocations i ON i.id=j.invocation_id
       WHERE a.company_id=$1`,
      [companyId],
    );
    const totalJobs = integer(row?.total_jobs);
    const jobsCompleted = integer(row?.jobs_completed);
    return {
      servicesPublished: integer(row?.services_published),
      jobsCompleted,
      jobsFailed: integer(row?.jobs_failed),
      totalJobs,
      uniqueBuyers: integer(row?.unique_buyers),
      completionRate: totalJobs === 0 ? 0 : jobsCompleted / totalJobs,
    };
  }

  async listTransactions(
    filters: { companyId?: string; limit?: number } = {},
  ): Promise<Transaction[]> {
    const parameters: SqlParameter[] = [];
    let where = "";
    if (filters.companyId) {
      parameters.push(filters.companyId);
      where = `WHERE buyer_company_id = $1 OR seller_company_id = $1`;
    }
    parameters.push(filters.limit ?? 100);
    return (
      await this.query(
        `SELECT * FROM transactions ${where} ORDER BY created_at DESC LIMIT $${parameters.length}`,
        parameters,
      )
    ).map(mapTransaction);
  }

  async listActivities(
    filters: { companyId?: string; limit?: number } = {},
  ): Promise<Activity[]> {
    const parameters: SqlParameter[] = [];
    let where = "";
    if (filters.companyId) {
      parameters.push(filters.companyId);
      where = `WHERE company_id = $1`;
    }
    parameters.push(filters.limit ?? 50);
    return (
      await this.query(
        `SELECT * FROM activities ${where} ORDER BY created_at DESC LIMIT $${parameters.length}`,
        parameters,
      )
    ).map(mapActivity);
  }

  async listPermissions(companyId: string): Promise<Permission[]> {
    return (
      await this.query(
        `SELECT * FROM permissions WHERE company_id = $1 ORDER BY action`,
        [companyId],
      )
    ).map(mapPermission);
  }

  async listAuditEvents(
    filters: { companyId?: string; limit?: number } = {},
  ): Promise<AuditEvent[]> {
    const parameters: SqlParameter[] = [];
    let where = "";
    if (filters.companyId) {
      parameters.push(filters.companyId);
      where = `WHERE company_id = $1`;
    }
    parameters.push(filters.limit ?? 50);
    return (
      await this.query(
        `SELECT * FROM audit_events ${where} ORDER BY created_at DESC LIMIT $${parameters.length}`,
        parameters,
      )
    ).map(mapAuditEvent);
  }

  private query(
    sql: string,
    parameters: readonly SqlParameter[] = [],
  ): Promise<Row[]> {
    return this.database.query<Row>(sql, parameters);
  }

  private async execute(
    sql: string,
    parameters: readonly SqlParameter[] = [],
  ): Promise<void> {
    await this.database.query(sql, parameters);
  }
}

function transactionParameters(transaction: Transaction): SqlParameter[] {
  return [
    transaction.id,
    transaction.type,
    transaction.buyerCompanyId,
    transaction.buyerLabel,
    transaction.sellerCompanyId,
    transaction.serviceId,
    transaction.amountCents,
    transaction.status,
    transaction.ledgerEntryId,
    transaction.reversalOfTransactionId,
    transaction.failureReason,
    transaction.createdAt,
    transaction.postedAt,
  ];
}

function invocationParameters(invocation: ServiceInvocation): SqlParameter[] {
  return [
    invocation.id,
    invocation.serviceId,
    invocation.buyerAgentId,
    invocation.providerAgentId,
    JSON.stringify(invocation.input),
    invocation.status,
    JSON.stringify(invocation.pricingSnapshot),
    invocation.createdAt,
    invocation.acceptedAt,
    invocation.processingAt,
    invocation.completedAt,
    invocation.failureReason,
  ];
}

function jobParameters(job: ServiceJob): SqlParameter[] {
  return [
    job.id,
    job.invocationId,
    job.providerAgentId,
    job.status,
    job.createdAt,
    job.acceptedAt,
    job.processingAt,
    job.completedAt,
  ];
}

function firstMapped<T>(rows: Row[], mapper: (row: Row) => T): T | null {
  return rows[0] ? mapper(rows[0]) : null;
}
function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}
function integer(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}
function text(value: unknown): string {
  return String(value);
}
function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
function jsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}
function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.startsWith("{"))
    return value.slice(1, -1).split(",").filter(Boolean);
  return [];
}

function mapUser(row: Row): User {
  return {
    id: text(row.id),
    email: text(row.email),
    name: text(row.name),
    createdAt: date(row.created_at),
    authIssuer: nullableText(row.auth_issuer),
    authSubject: nullableText(row.auth_subject),
  };
}
function mapAgent(row: Row): Agent {
  return {
    id: text(row.id),
    userId: text(row.user_id),
    companyId: text(row.company_id),
    name: text(row.name),
    handle: text(row.handle),
    framework: text(row.framework) as Agent["framework"],
    status: text(row.status) as Agent["status"],
    createdAt: date(row.created_at),
  };
}
function mapCompany(row: Row): Company {
  return {
    id: text(row.id),
    ownerUserId: text(row.owner_user_id),
    primaryAgentId: text(row.primary_agent_id),
    slug: text(row.slug),
    name: text(row.name),
    description: text(row.description),
    industry: text(row.industry),
    website: nullableText(row.website),
    createdAt: date(row.created_at),
  };
}
function mapTreasury(row: Row): Treasury {
  return {
    id: text(row.id),
    companyId: text(row.company_id),
    balanceCents: integer(row.balance_cents),
    assetsCents: integer(row.assets_cents),
    liabilitiesCents: integer(row.liabilities_cents),
    ledgerVersion: integer(row.ledger_version),
    updatedAt: date(row.updated_at),
  };
}
function mapService(row: Row): Service {
  return {
    id: text(row.id),
    companyId: text(row.company_id),
    agentId: text(row.agent_id),
    slug: text(row.slug),
    name: text(row.name),
    description: text(row.description),
    category: text(row.category),
    inputSchema: jsonValue(row.input_schema) as Service["inputSchema"],
    outputSchema: jsonValue(row.output_schema) as Service["outputSchema"],
    status: text(row.status) as Service["status"],
    version: integer(row.version),
    pricingModel: text(row.pricing_model) as Service["pricingModel"],
    quotedPrice: nullableText(row.quoted_price),
    quotedCurrency: nullableText(row.quoted_currency),
    paymentExecution: "unavailable",
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}
function mapInvocation(row: Row): ServiceInvocation {
  return {
    id: text(row.id),
    serviceId: text(row.service_id),
    buyerAgentId: text(row.buyer_agent_id),
    providerAgentId: text(row.provider_agent_id),
    input: jsonValue(row.input) as ServiceInvocation["input"],
    status: text(row.status) as ServiceInvocation["status"],
    pricingSnapshot: jsonValue(
      row.pricing_snapshot,
    ) as ServiceInvocation["pricingSnapshot"],
    createdAt: date(row.created_at),
    acceptedAt: nullableDate(row.accepted_at),
    processingAt: nullableDate(row.processing_at),
    completedAt: nullableDate(row.completed_at),
    failureReason: nullableText(row.failure_reason),
  };
}
function mapJob(row: Row): ServiceJob {
  return {
    id: text(row.id),
    invocationId: text(row.invocation_id),
    providerAgentId: text(row.provider_agent_id),
    status: text(row.status) as ServiceJob["status"],
    createdAt: date(row.created_at),
    acceptedAt: nullableDate(row.accepted_at),
    processingAt: nullableDate(row.processing_at),
    completedAt: nullableDate(row.completed_at),
  };
}
function mapResult(row: Row): ServiceResult {
  return {
    id: text(row.id),
    invocationId: text(row.invocation_id),
    jobId: text(row.job_id),
    providerAgentId: text(row.provider_agent_id),
    output: jsonValue(row.output) as ServiceResult["output"],
    createdAt: date(row.created_at),
  };
}
function mapTransaction(row: Row): Transaction {
  return {
    id: text(row.id),
    type: text(row.type) as Transaction["type"],
    buyerCompanyId: nullableText(row.buyer_company_id),
    buyerLabel: text(row.buyer_label),
    sellerCompanyId: text(row.seller_company_id),
    serviceId: text(row.service_id),
    amountCents: integer(row.amount_cents),
    status: text(row.status) as Transaction["status"],
    ledgerEntryId: nullableText(row.ledger_entry_id),
    reversalOfTransactionId: nullableText(row.reversal_of_transaction_id),
    failureReason: nullableText(row.failure_reason),
    createdAt: date(row.created_at),
    postedAt: nullableDate(row.posted_at),
  };
}
function mapActivity(row: Row): Activity {
  return {
    id: text(row.id),
    companyId: text(row.company_id),
    type: text(row.type) as Activity["type"],
    summary: text(row.summary),
    metadata: jsonValue(row.metadata) as Activity["metadata"],
    createdAt: date(row.created_at),
  };
}
function mapPermission(row: Row): Permission {
  return {
    id: text(row.id),
    companyId: text(row.company_id),
    action: text(row.action) as PermissionAction,
    decision: text(row.decision) as Permission["decision"],
    limitCents: row.limit_cents === null ? null : integer(row.limit_cents),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}
function mapCredential(row: Row): ApiCredentialRecord {
  return {
    id: text(row.id),
    agentId: text(row.agent_id),
    prefix: text(row.prefix),
    secretHash: text(row.secret_hash),
    label: text(row.label),
    scopes: stringArray(row.scopes) as ApiScope[],
    issuer: text(row.issuer),
    audience: text(row.audience),
    createdAt: date(row.created_at),
    lastUsedAt: nullableDate(row.last_used_at),
    expiresAt: nullableDate(row.expires_at),
    revokedAt: nullableDate(row.revoked_at),
    rotatedFromId: nullableText(row.rotated_from_id),
  };
}
function mapLedgerAccount(row: Row): LedgerAccount {
  return {
    id: text(row.id),
    companyId: text(row.company_id),
    code: text(row.code) as LedgerAccount["code"],
    name: text(row.name),
    type: text(row.type) as LedgerAccount["type"],
    normalBalance: text(row.normal_balance) as LedgerAccount["normalBalance"],
    createdAt: date(row.created_at),
  };
}
function mapLedgerEntry(row: Row): LedgerEntry {
  return {
    id: text(row.id),
    transactionId: text(row.transaction_id),
    description: text(row.description),
    status: text(row.status) as LedgerEntry["status"],
    reversalOfEntryId: nullableText(row.reversal_of_entry_id),
    createdAt: date(row.created_at),
    postedAt: nullableDate(row.posted_at),
  };
}
function mapLedgerPosting(row: Row): LedgerPosting {
  return {
    id: text(row.id),
    entryId: text(row.entry_id),
    accountId: text(row.account_id),
    direction: text(row.direction) as LedgerPosting["direction"],
    amountCents: integer(row.amount_cents),
    createdAt: date(row.created_at),
  };
}
function mapAuditEvent(row: Row): AuditEvent {
  return {
    id: text(row.id),
    type: text(row.type) as AuditEventType,
    actorAgentId: nullableText(row.actor_agent_id),
    companyId: nullableText(row.company_id),
    resourceType: text(row.resource_type),
    resourceId: nullableText(row.resource_id),
    action: text(row.action),
    metadata: jsonValue(row.metadata) as Record<string, unknown>,
    createdAt: date(row.created_at),
  };
}
