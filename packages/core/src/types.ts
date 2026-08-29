export type Id = string;
export type Money = number;
export type JsonObject = Record<string, unknown>;

export const API_SCOPES = [
  "company:read",
  "company:write",
  "services:read",
  "services:write",
  "jobs:read",
  "jobs:write",
  "transactions:read",
  "economy:spend",
  "markets:read",
  "portfolio:read",
  "portfolio:trade",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];
export type AgentFramework =
  "claude-code" | "hermes" | "openclaw" | "codex" | "custom";

export type User = {
  id: Id;
  email: string;
  name: string;
  createdAt: Date;
  authIssuer?: string | null;
  authSubject?: string | null;
};
export type Agent = {
  id: Id;
  userId: Id;
  companyId: Id;
  name: string;
  handle: string;
  framework: AgentFramework;
  status: "active" | "suspended";
  createdAt: Date;
};
export type Company = {
  id: Id;
  ownerUserId: Id;
  primaryAgentId: Id;
  slug: string;
  name: string;
  description: string;
  industry: string;
  website: string | null;
  createdAt: Date;
};

export type ServiceStatus = "draft" | "active" | "paused" | "archived";
export type PricingModel = "free" | "fixed" | "quote" | "unavailable";
export type Service = {
  id: Id;
  companyId: Id;
  agentId: Id;
  slug: string;
  name: string;
  description: string;
  category: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  status: ServiceStatus;
  version: number;
  pricingModel: PricingModel;
  quotedPrice: string | null;
  quotedCurrency: string | null;
  paymentExecution: "unavailable";
  createdAt: Date;
  updatedAt: Date;
};
export type ServiceSearch = {
  keyword?: string;
  category?: string;
  companyId?: Id;
  providerAgentId?: Id;
  status?: ServiceStatus;
  pricingModel?: PricingModel;
  cursor?: string;
  limit?: number;
  sort?: "created_desc" | "created_asc" | "name_asc";
};
export type ServicePage = { items: Service[]; nextCursor: string | null };

export type InvocationStatus =
  "created" | "accepted" | "processing" | "completed" | "failed" | "cancelled";
export type PricingSnapshot = {
  model: PricingModel;
  quotedPrice: string | null;
  quotedCurrency: string | null;
  paymentExecution: "unavailable";
  serviceVersion: number;
};
export type ServiceInvocation = {
  id: Id;
  serviceId: Id;
  buyerAgentId: Id;
  providerAgentId: Id;
  input: JsonObject;
  status: InvocationStatus;
  pricingSnapshot: PricingSnapshot;
  createdAt: Date;
  acceptedAt: Date | null;
  processingAt: Date | null;
  completedAt: Date | null;
  failureReason: string | null;
};
export type ServiceJob = {
  id: Id;
  invocationId: Id;
  providerAgentId: Id;
  status: InvocationStatus;
  createdAt: Date;
  acceptedAt: Date | null;
  processingAt: Date | null;
  completedAt: Date | null;
};
export type ServiceResult = {
  id: Id;
  invocationId: Id;
  jobId: Id;
  providerAgentId: Id;
  output: JsonObject;
  createdAt: Date;
};
export type InvocationView = {
  invocation: ServiceInvocation;
  job: ServiceJob;
  result: ServiceResult | null;
  service: Service;
};

export type TransactionStatus = "pending" | "posted" | "failed" | "reversed";
export type Transaction = {
  id: Id;
  type: "service_purchase" | "external_sale" | "reversal";
  buyerCompanyId: Id | null;
  buyerLabel: string;
  sellerCompanyId: Id;
  serviceId: Id;
  amountCents: Money;
  status: TransactionStatus;
  ledgerEntryId: Id | null;
  reversalOfTransactionId: Id | null;
  failureReason: string | null;
  createdAt: Date;
  postedAt: Date | null;
};

export type ActivityType =
  | "agent.registered"
  | "company.created"
  | "company.updated"
  | "service.created"
  | "service.updated"
  | "job.requested"
  | "job.accepted"
  | "job.processing"
  | "job.completed"
  | "job.failed"
  | "job.cancelled"
  | "credential.created"
  | "credential.rotated"
  | "credential.revoked"
  | "policy.denied"
  | "chain.read";
export type Activity = {
  id: Id;
  companyId: Id;
  type: ActivityType;
  summary: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: Date;
};

export type Treasury = {
  id: Id;
  companyId: Id;
  balanceCents: Money;
  assetsCents: Money;
  liabilitiesCents: Money;
  ledgerVersion: number;
  updatedAt: Date;
};

export type PermissionAction =
  | "service:create"
  | "service:update"
  | "service:request"
  | "job:accept"
  | "job:process"
  | "job:complete"
  | "job:fail"
  | "job:cancel"
  | "treasury:transfer"
  | "asset:trade";
export type Permission = {
  id: Id;
  companyId: Id;
  action: PermissionAction;
  decision: "allow" | "deny";
  limitCents: Money | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ApiCredential = {
  id: Id;
  agentId: Id;
  prefix: string;
  label: string;
  scopes: ApiScope[];
  issuer: string;
  audience: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  rotatedFromId: Id | null;
};
export type ApiCredentialRecord = ApiCredential & { secretHash: string };
export type AuthPrincipal = {
  agentId: Id;
  userId: Id;
  credentialId: Id;
  scopes: ApiScope[];
  issuer: string;
  audience: string;
  expiresAt: Date | null;
};
export type RequestContext = { principal: AuthPrincipal; requestId?: string };

export type LedgerAccountType =
  "asset" | "liability" | "equity" | "revenue" | "expense";
export type LedgerDirection = "debit" | "credit";
export type LedgerAccount = {
  id: Id;
  companyId: Id;
  code:
    | "cash"
    | "service_revenue"
    | "service_expense"
    | "other_asset"
    | "liability"
    | "stock_asset"
    | "trading_pnl";
  name: string;
  type: LedgerAccountType;
  normalBalance: LedgerDirection;
  createdAt: Date;
};
export type LedgerEntry = {
  id: Id;
  transactionId: Id;
  description: string;
  status: "pending" | "posted" | "failed";
  reversalOfEntryId: Id | null;
  createdAt: Date;
  postedAt: Date | null;
};
export type LedgerPosting = {
  id: Id;
  entryId: Id;
  accountId: Id;
  direction: LedgerDirection;
  amountCents: Money;
  createdAt: Date;
};

export type AuditEventType =
  | "agent.registered"
  | "company.created"
  | "company.changed"
  | "credential.created"
  | "credential.rotated"
  | "credential.revoked"
  | "permission.changed"
  | "service.created"
  | "service.updated"
  | "service.requested"
  | "job.accepted"
  | "job.started"
  | "job.completed"
  | "job.failed"
  | "job.cancelled"
  | "authentication.failed"
  | "authorization.denied"
  | "chain.configuration.changed"
  | "chain.read.failed"
  | "market.data.stale";
export type AuditEvent = {
  id: Id;
  type: AuditEventType;
  actorAgentId: Id | null;
  companyId: Id | null;
  resourceType: string;
  resourceId: Id | null;
  action: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type IdempotencyClaim =
  | { state: "claimed" }
  | { state: "replay"; response: unknown }
  | { state: "conflict" }
  | { state: "processing" };

export type CompanyMetrics = {
  revenueCents: Money;
  expensesCents: Money;
  pnlCents: Money;
  cashCents: Money;
  assetsCents: Money;
  liabilitiesCents: Money;
  netWorthCents: Money;
};
export type OperationalMetrics = {
  servicesPublished: number;
  jobsCompleted: number;
  jobsFailed: number;
  totalJobs: number;
  uniqueBuyers: number;
  completionRate: number;
};
export type CompanySnapshot = {
  company: Company;
  agent: Agent;
  treasury: Treasury;
  metrics: CompanyMetrics;
  operations: OperationalMetrics;
  services: Service[];
};
export type PublicCompanySnapshot = Pick<
  CompanySnapshot,
  "company" | "agent" | "operations" | "services"
>;
export type OperationalLeaderboardEntry = PublicCompanySnapshot & {
  rank: number;
};
export type LeaderboardEntry = OperationalLeaderboardEntry;
export type AgentIdentity = {
  agent: Agent;
  company: Company;
  scopes: ApiScope[];
  credentialId: Id;
};
export type NetworkCapability = {
  id: string;
  displayName: string;
  family: "evm";
  chainId: number;
  primary: boolean;
  enabled: boolean;
  executionAvailable: false;
  readOnlyAvailable: boolean;
  capabilities: readonly string[];
  status: "inactive" | "read-only" | "unavailable";
};
export type BootstrapRegistrationResult = {
  identity: CompanySnapshot;
  credential: ApiCredential;
  secret: string | null;
  secretShown: boolean;
};
export type AgentRegistrationResult = CompanySnapshot & {
  credential: ApiCredential;
  secret: string | null;
  secretShown: boolean;
};
