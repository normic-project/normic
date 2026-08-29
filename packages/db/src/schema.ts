import {
  bigint,
  boolean,
  integer,
  index,
  jsonb,
  numeric,
  primaryKey,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const agentFramework = pgEnum("agent_framework", [
  "claude-code",
  "hermes",
  "openclaw",
  "codex",
  "custom",
]);
export const agentStatus = pgEnum("agent_status", ["active", "suspended"]);
export const serviceStatus = pgEnum("service_status", [
  "draft",
  "active",
  "paused",
  "archived",
]);
export const transactionStatus = pgEnum("transaction_status", [
  "pending",
  "posted",
  "failed",
  "reversed",
]);
export const permissionDecision = pgEnum("permission_decision", [
  "allow",
  "deny",
]);
export const ledgerAccountType = pgEnum("ledger_account_type", [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
]);
export const ledgerDirection = pgEnum("ledger_direction", ["debit", "credit"]);
export const ledgerEntryStatus = pgEnum("ledger_entry_status", [
  "pending",
  "posted",
  "failed",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    authIssuer: text("auth_issuer"),
    authSubject: text("auth_subject"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    uniqueIndex("users_auth_identity_unique").on(
      table.authIssuer,
      table.authSubject,
    ),
  ],
);

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    primaryAgentId: uuid("primary_agent_id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    industry: text("industry").notNull(),
    website: text("website"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("companies_slug_unique").on(table.slug),
    index("companies_owner_index").on(table.ownerUserId, table.createdAt),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    handle: text("handle").notNull(),
    framework: agentFramework("framework").notNull(),
    status: agentStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("agents_handle_unique").on(table.handle),
    uniqueIndex("agents_company_unique").on(table.companyId),
  ],
);

export const treasuries = pgTable(
  "treasuries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    balanceCents: bigint("balance_cents", { mode: "number" })
      .notNull()
      .default(0),
    assetsCents: bigint("assets_cents", { mode: "number" })
      .notNull()
      .default(0),
    liabilitiesCents: bigint("liabilities_cents", { mode: "number" })
      .notNull()
      .default(0),
    ledgerVersion: bigint("ledger_version", { mode: "number" })
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("treasuries_company_unique").on(table.companyId)],
);

export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull(),
    inputSchema: jsonb("input_schema").notNull().default({}),
    outputSchema: jsonb("output_schema").notNull().default({}),
    status: serviceStatus("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    pricingModel: text("pricing_model").notNull().default("unavailable"),
    quotedPrice: text("quoted_price"),
    quotedCurrency: text("quoted_currency"),
    paymentExecution: text("payment_execution")
      .notNull()
      .default("unavailable"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("services_company_slug_unique").on(table.companyId, table.slug),
    index("services_marketplace_index").on(table.status, table.category),
    index("services_agent_index").on(table.agentId, table.createdAt),
  ],
);

export const serviceInvocations = pgTable("service_invocations", {
  id: uuid("id").primaryKey(),
  serviceId: uuid("service_id")
    .notNull()
    .references(() => services.id, { onDelete: "restrict" }),
  buyerAgentId: uuid("buyer_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "restrict" }),
  providerAgentId: uuid("provider_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "restrict" }),
  input: jsonb("input").notNull(),
  status: text("status").notNull(),
  pricingSnapshot: jsonb("pricing_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  processingAt: timestamp("processing_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  failureReason: text("failure_reason"),
});
export const serviceJobs = pgTable("service_jobs", {
  id: uuid("id").primaryKey(),
  invocationId: uuid("invocation_id")
    .notNull()
    .unique()
    .references(() => serviceInvocations.id, { onDelete: "restrict" }),
  providerAgentId: uuid("provider_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "restrict" }),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  processingAt: timestamp("processing_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
export const serviceResults = pgTable("service_results", {
  id: uuid("id").primaryKey(),
  invocationId: uuid("invocation_id")
    .notNull()
    .unique()
    .references(() => serviceInvocations.id, { onDelete: "restrict" }),
  jobId: uuid("job_id")
    .notNull()
    .unique()
    .references(() => serviceJobs.id, { onDelete: "restrict" }),
  providerAgentId: uuid("provider_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "restrict" }),
  output: jsonb("output").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    buyerCompanyId: uuid("buyer_company_id").references(() => companies.id, {
      onDelete: "restrict",
    }),
    buyerLabel: text("buyer_label").notNull(),
    sellerCompanyId: uuid("seller_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "restrict" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    status: transactionStatus("status").notNull(),
    ledgerEntryId: uuid("ledger_entry_id"),
    reversalOfTransactionId: uuid("reversal_of_transaction_id"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (table) => [
    index("transactions_buyer_index").on(table.buyerCompanyId, table.createdAt),
    index("transactions_seller_index").on(
      table.sellerCompanyId,
      table.createdAt,
    ),
  ],
);

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    summary: text("summary").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("activities_feed_index").on(table.createdAt, table.companyId),
  ],
);

export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    decision: permissionDecision("decision").notNull(),
    limitCents: bigint("limit_cents", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("permissions_company_action_unique").on(
      table.companyId,
      table.action,
    ),
  ],
);

export const apiCredentials = pgTable(
  "api_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    prefix: text("prefix").notNull(),
    secretHash: text("secret_hash").notNull(),
    label: text("label").notNull(),
    scopes: text("scopes").array().notNull(),
    issuer: text("issuer").notNull(),
    audience: text("audience").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    rotatedFromId: uuid("rotated_from_id"),
  },
  (table) => [
    uniqueIndex("api_credentials_secret_hash_unique").on(table.secretHash),
    index("api_credentials_agent_index").on(table.agentId, table.createdAt),
    index("api_credentials_prefix_index").on(table.prefix),
  ],
);

export const oauthClients = pgTable(
  "normic_oauth_clients",
  {
    clientId: uuid("client_id").primaryKey(),
    audience: text("audience").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    allowDynamicClients: boolean("allow_dynamic_clients")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("normic_oauth_clients_one_dynamic_policy")
      .on(table.allowDynamicClients)
      .where(sql`${table.enabled} AND ${table.allowDynamicClients}`),
  ],
);

export const oauthAgentGrants = pgTable(
  "normic_oauth_agent_grants",
  {
    oauthClientId: uuid("oauth_client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "restrict" }),
    supabaseUserId: uuid("supabase_user_id").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => apiCredentials.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.oauthClientId, table.supabaseUserId] }),
    uniqueIndex("normic_oauth_agent_grants_credential_unique").on(
      table.credentialId,
    ),
    index("normic_oauth_agent_grants_agent").on(
      table.agentId,
      table.oauthClientId,
    ),
  ],
);

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: ledgerAccountType("type").notNull(),
    normalBalance: ledgerDirection("normal_balance").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("ledger_accounts_company_code_unique").on(
      table.companyId,
      table.code,
    ),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "restrict",
    }),
    sourceEventId: uuid("source_event_id").references(() => escrowEvents.id),
    sourceTradeSettlementId: uuid("source_trade_settlement_id"),
    companyId: uuid("company_id").references(() => companies.id),
    description: text("description").notNull(),
    status: ledgerEntryStatus("status").notNull().default("pending"),
    reversalOfEntryId: uuid("reversal_of_entry_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("ledger_entries_transaction_unique").on(table.transactionId),
  ],
);

export const ledgerPostings = pgTable(
  "ledger_postings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => ledgerEntries.id, { onDelete: "restrict" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    direction: ledgerDirection("direction").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }),
    tokenUnits: numeric("token_units", { precision: 78, scale: 0 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ledger_postings_entry_index").on(table.entryId),
    index("ledger_postings_account_index").on(table.accountId, table.entryId),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull(),
    responseJson: jsonb("response_json"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idempotency_agent_operation_key_unique").on(
      table.agentId,
      table.operation,
      table.idempotencyKey,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "restrict",
    }),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id"),
    action: text("action").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_events_company_index").on(table.companyId, table.createdAt),
    index("audit_events_actor_index").on(table.actorAgentId, table.createdAt),
  ],
);

export const networkConfigurations = pgTable("network_configurations", {
  networkId: text("network_id").primaryKey(),
  displayName: text("display_name").notNull(),
  providerKey: text("provider_key").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  executionAvailable: boolean("execution_available").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const onboardingIdempotency = pgTable("onboarding_idempotency", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  requestHash: text("request_hash").notNull(),
  status: text("status").notNull(),
  responseJson: jsonb("response_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
export const rateLimitWindows = pgTable("rate_limit_windows", {
  bucketHash: text("bucket_hash").primaryKey(),
  windowStartedAt: timestamp("window_started_at", {
    withTimezone: true,
  }).notNull(),
  requestCount: integer("request_count").notNull(),
});

// Phase 4 exact-unit schema. Versioned SQL migrations also own the immutable
// ledger/state-machine triggers, checks, and partial indexes; never use db push.
export const financialWallets = pgTable("financial_wallets", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  address: text("address").notNull().unique(),
  ownerAddress: text("owner_address").notNull(),
  chainId: integer("chain_id").notNull(),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const spendingPolicies = pgTable("spending_policies", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => financialWallets.companyId),
  enabled: boolean("enabled").notNull().default(false),
  version: integer("version").notNull(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const financialSessions = pgTable("financial_sessions", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => financialWallets.companyId),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  data: jsonb("data").notNull(),
});
export const paidInvocations = pgTable("paid_invocations", {
  id: uuid("id").primaryKey(),
  onchainId: text("onchain_id").notNull().unique(),
  serviceId: uuid("service_id")
    .notNull()
    .references(() => services.id),
  providerCompanyId: uuid("provider_company_id")
    .notNull()
    .references(() => companies.id),
  providerAgentId: uuid("provider_agent_id")
    .notNull()
    .references(() => agents.id),
  buyerCompanyId: uuid("buyer_company_id").references(() => companies.id),
  buyerAgentId: uuid("buyer_agent_id").references(() => agents.id),
  buyerWallet: text("buyer_wallet").notNull(),
  amountUnits: numeric("amount_units", { precision: 78, scale: 0 }).notNull(),
  state: text("state").notNull(),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const paymentOperations = pgTable("payment_operations", {
  id: uuid("id").primaryKey(),
  invocationId: uuid("invocation_id")
    .notNull()
    .references(() => paidInvocations.id),
  action: text("action").notNull(),
  status: text("status").notNull(),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const escrowEvents = pgTable(
  "escrow_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chainId: integer("chain_id").notNull(),
    transactionHash: text("transaction_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: numeric("block_number", { precision: 78, scale: 0 }).notNull(),
    blockHash: text("block_hash").notNull(),
    contractAddress: text("contract_address").notNull(),
    invocationId: text("invocation_id")
      .notNull()
      .references(() => paidInvocations.onchainId),
    eventType: text("event_type").notNull(),
    data: jsonb("data").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("escrow_event_identity").on(
      t.chainId,
      t.transactionHash,
      t.logIndex,
    ),
  ],
);
export const financialIdempotency = pgTable(
  "financial_idempotency",
  {
    actor: text("actor").notNull(),
    operation: text("operation").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.actor, t.operation, t.key] })],
);
export const financialCheckpoints = pgTable("financial_checkpoints", {
  chainId: integer("chain_id").primaryKey(),
  blockNumber: numeric("block_number", { precision: 78, scale: 0 }).notNull(),
  blockHash: text("block_hash").notNull(),
});
export const financialIndexerLock = pgTable("financial_indexer_lock", {
  id: integer("id").primaryKey(),
});
export const walletChallenges = pgTable("wallet_challenges", {
  id: uuid("id").primaryKey(),
  wallet: text("wallet").notNull(),
  message: text("message").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});
export const humanWalletSessions = pgTable("human_wallet_sessions", {
  id: uuid("id").primaryKey(),
  wallet: text("wallet").notNull(),
  secretHash: text("secret_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const walletTransferObservations = pgTable(
  "wallet_transfer_observations",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => financialWallets.companyId),
    chainId: integer("chain_id").notNull(),
    transactionHash: text("transaction_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: numeric("block_number", { precision: 78, scale: 0 }).notNull(),
    blockHash: text("block_hash").notNull(),
    fromAddress: text("from_address").notNull(),
    tokenUnits: numeric("token_units", { precision: 78, scale: 0 }).notNull(),
    classification: text("classification").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.companyId, t.chainId, t.transactionHash, t.logIndex],
    }),
  ],
);

// Phase 5 trading tables. SQL migrations own the transition/immutability
// triggers and checks; these declarations are the typed read/write surface.
export const tradingEligibility = pgTable("trading_eligibility", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id),
  state: text("state").notNull(),
  provider: text("provider"),
  rulesVersion: text("rules_version"),
  attestationId: text("attestation_id"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  reasonCode: text("reason_code"),
  version: integer("version").notNull(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const tradingPolicies = pgTable("trading_policies", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => financialWallets.companyId),
  enabled: boolean("enabled").notNull().default(false),
  version: integer("version").notNull(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const tradingSessions = pgTable(
  "trading_sessions",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => financialWallets.companyId),
    publicKey: text("public_key").notNull(),
    providerSessionId: text("provider_session_id").notNull(),
    authorizationRef: text("authorization_ref").notNull(),
    policyVersion: integer("policy_version").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("trading_sessions_company_index").on(table.companyId)],
);
export const tradeQuotes = pgTable(
  "trade_quotes",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("trade_quotes_company_created").on(table.companyId, table.createdAt),
  ],
);
export const trades = pgTable(
  "trades",
  {
    id: uuid("id").primaryKey(),
    quoteId: uuid("quote_id")
      .notNull()
      .unique()
      .references(() => tradeQuotes.id),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    wallet: text("wallet").notNull(),
    assetId: text("asset_id").notNull(),
    assetAddress: text("asset_address").notNull(),
    side: text("side").notNull(),
    status: text("status").notNull(),
    providerCallId: text("provider_call_id"),
    transactionHash: text("transaction_hash"),
    blockNumber: numeric("block_number", { precision: 78, scale: 0 }),
    actualAmountIn: numeric("actual_amount_in", { precision: 78, scale: 0 }),
    actualAmountOut: numeric("actual_amount_out", { precision: 78, scale: 0 }),
    realizedPnlUsdg: numeric("realized_pnl_usdg", { precision: 78, scale: 0 }),
    failureReason: text("failure_reason"),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [
    index("trades_company_created").on(table.companyId, table.createdAt),
  ],
);
export const tradeSettlements = pgTable("trade_settlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  tradeId: uuid("trade_id")
    .notNull()
    .unique()
    .references(() => trades.id),
  chainId: integer("chain_id").notNull(),
  transactionHash: text("transaction_hash").notNull().unique(),
  blockNumber: numeric("block_number", { precision: 78, scale: 0 }).notNull(),
  blockHash: text("block_hash").notNull(),
  wallet: text("wallet").notNull(),
  inputToken: text("input_token").notNull(),
  outputToken: text("output_token").notNull(),
  actualAmountIn: numeric("actual_amount_in", {
    precision: 78,
    scale: 0,
  }).notNull(),
  actualAmountOut: numeric("actual_amount_out", {
    precision: 78,
    scale: 0,
  }).notNull(),
  data: jsonb("data").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const positionLots = pgTable(
  "position_lots",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    assetId: text("asset_id").notNull(),
    assetAddress: text("asset_address").notNull(),
    symbol: text("symbol").notNull(),
    sourceTradeId: uuid("source_trade_id")
      .notNull()
      .unique()
      .references(() => trades.id),
    originalRawUnits: numeric("original_raw_units", {
      precision: 78,
      scale: 0,
    }).notNull(),
    remainingRawUnits: numeric("remaining_raw_units", {
      precision: 78,
      scale: 0,
    }).notNull(),
    originalCostUsdg: numeric("original_cost_usdg", {
      precision: 78,
      scale: 0,
    }).notNull(),
    remainingCostUsdg: numeric("remaining_cost_usdg", {
      precision: 78,
      scale: 0,
    }).notNull(),
    multiplierAtBuy: numeric("multiplier_at_buy", {
      precision: 78,
      scale: 0,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("position_lots_company_asset").on(table.companyId, table.assetId),
  ],
);
export const tradingIdempotency = pgTable(
  "trading_idempotency",
  {
    actor: text("actor").notNull(),
    operation: text("operation").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.actor, table.operation, table.key] }),
  ],
);

// Phase 6 autonomous operations. SQL owns immutable payload and terminal-state guards.
export const autonomyMandates = pgTable(
  "autonomy_mandates",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    version: integer("version").notNull(),
    mode: text("mode").notNull(),
    sessionExpiresAt: timestamp("session_expires_at", {
      withTimezone: true,
    }).notNull(),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.companyId, table.version] })],
);
export const agentHeartbeats = pgTable("agent_heartbeats", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  sessionId: text("session_id").notNull(),
  status: text("status").notNull(),
  currentJobId: uuid("current_job_id").references(() => serviceJobs.id),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", {
    withTimezone: true,
  }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  data: jsonb("data").notNull(),
});
export const autonomyOpportunities = pgTable(
  "autonomy_opportunities",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    kind: text("kind").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").notNull(),
    data: jsonb("data").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("autonomy_opportunities_company_fingerprint").on(
      table.companyId,
      table.fingerprint,
    ),
  ],
);
export const autonomyActionPlans = pgTable("autonomy_action_plans", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  credentialId: uuid("credential_id")
    .notNull()
    .references(() => apiCredentials.id),
  opportunityId: uuid("opportunity_id").references(
    () => autonomyOpportunities.id,
  ),
  actionType: text("action_type").notNull(),
  actionHash: text("action_hash").notNull(),
  mandateVersion: integer("mandate_version").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  financialAmountUsdg: numeric("financial_amount_usdg", {
    precision: 78,
    scale: 0,
  }).notNull(),
  transactionReference: text("transaction_reference"),
  failureCode: text("failure_code"),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  executedAt: timestamp("executed_at", { withTimezone: true }),
});
export const autonomyActionApprovals = pgTable("autonomy_action_approvals", {
  id: uuid("id").primaryKey(),
  planId: uuid("plan_id")
    .notNull()
    .unique()
    .references(() => autonomyActionPlans.id),
  actionHash: text("action_hash").notNull(),
  status: text("status").notNull(),
  ownerIssuer: text("owner_issuer"),
  ownerSubject: text("owner_subject"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  data: jsonb("data").notNull(),
});
export const autonomyActionHistory = pgTable("autonomy_action_history", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  opportunityId: uuid("opportunity_id").references(
    () => autonomyOpportunities.id,
  ),
  planId: uuid("plan_id")
    .notNull()
    .references(() => autonomyActionPlans.id),
  actionType: text("action_type").notNull(),
  mandateVersion: integer("mandate_version").notNull(),
  transactionReference: text("transaction_reference"),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
export const autonomySpendReservations = pgTable(
  "autonomy_spend_reservations",
  {
    planId: uuid("plan_id")
      .primaryKey()
      .references(() => autonomyActionPlans.id),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    amountUsdg: numeric("amount_usdg", { precision: 78, scale: 0 }).notNull(),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
);
export const autonomyCircuitBreakers = pgTable(
  "autonomy_circuit_breakers",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    code: text("code").notNull(),
    active: boolean("active").notNull(),
    reason: text("reason").notNull(),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.companyId, table.code] })],
);
export const autonomyIdempotency = pgTable(
  "autonomy_idempotency",
  {
    actor: text("actor").notNull(),
    operation: text("operation").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.actor, table.operation, table.key] }),
  ],
);
