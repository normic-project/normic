import type {
  Activity,
  Agent,
  ApiCredential,
  ApiCredentialRecord,
  AuditEvent,
  Company,
  CompanyMetrics,
  Id,
  IdempotencyClaim,
  LedgerAccount,
  LedgerEntry,
  LedgerPosting,
  OperationalMetrics,
  Permission,
  Service,
  ServiceInvocation,
  ServiceJob,
  ServicePage,
  ServiceResult,
  ServiceSearch,
  Transaction,
  Treasury,
  User,
} from "./types.js";

export interface EconomyRepository {
  transaction<T>(
    operation: (repository: EconomyRepository) => Promise<T>,
  ): Promise<T>;
  createUser(user: User): Promise<void>;
  createAgent(agent: Agent): Promise<void>;
  createCompany(company: Company): Promise<void>;
  createTreasury(treasury: Treasury): Promise<void>;
  createService(service: Service): Promise<void>;
  updateService(service: Service): Promise<void>;
  createInvocation(invocation: ServiceInvocation): Promise<void>;
  updateInvocation(invocation: ServiceInvocation): Promise<void>;
  createJob(job: ServiceJob): Promise<void>;
  updateJob(job: ServiceJob): Promise<void>;
  createResult(result: ServiceResult): Promise<void>;
  createActivity(activity: Activity): Promise<void>;
  createPermission(permission: Permission): Promise<void>;
  createAuditEvent(event: AuditEvent): Promise<void>;
  createCredential(credential: ApiCredentialRecord): Promise<void>;
  getCredential(id: Id): Promise<ApiCredentialRecord | null>;
  getCredentialByHash(secretHash: string): Promise<ApiCredentialRecord | null>;
  listCredentials(agentId: Id): Promise<ApiCredential[]>;
  revokeCredential(id: Id, revokedAt: Date): Promise<void>;
  touchCredential(id: Id, lastUsedAt: Date): Promise<void>;
  claimIdempotency(input: {
    agentId: Id;
    operation: string;
    key: string;
    requestHash: string;
    createdAt: Date;
  }): Promise<IdempotencyClaim>;
  completeIdempotency(input: {
    agentId: Id;
    operation: string;
    key: string;
    response: unknown;
  }): Promise<void>;
  claimOnboarding(input: {
    key: string;
    requestHash: string;
    createdAt: Date;
  }): Promise<IdempotencyClaim>;
  completeOnboarding(input: { key: string; response: unknown }): Promise<void>;
  ensureDynamicOAuthGrant(input: {
    audience: string;
    ownerSubject: string;
    agentId: Id;
    credentialId: Id;
    createdAt: Date;
  }): Promise<"ready" | "unavailable" | "conflict">;
  hasDynamicOAuthGrant(input: {
    audience: string;
    ownerSubject: string;
    agentId: Id;
    credentialId: Id;
  }): Promise<boolean>;
  consumeRateLimit(input: {
    bucket: string;
    limit: number;
    windowSeconds: number;
    now: Date;
  }): Promise<{
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
  }>;
  ensureLedgerAccounts(
    companyId: Id,
    createdAt: Date,
  ): Promise<LedgerAccount[]>;
  createTransaction(transaction: Transaction): Promise<void>;
  updateTransaction(transaction: Transaction): Promise<void>;
  createLedgerEntry(entry: LedgerEntry): Promise<void>;
  createLedgerPostings(postings: LedgerPosting[]): Promise<void>;
  postLedgerEntry(entryId: Id, postedAt: Date): Promise<void>;
  getLedgerEntry(id: Id): Promise<LedgerEntry | null>;
  listLedgerPostings(entryId: Id): Promise<LedgerPosting[]>;
  getMetrics(companyId: Id): Promise<CompanyMetrics>;
  reconcileTreasury(companyId: Id, updatedAt: Date): Promise<Treasury>;
  lockCompanyForUpdate(companyId: Id): Promise<void>;
  lockServiceForUpdate(serviceId: Id): Promise<Service | null>;
  lockJobForUpdate(jobId: Id): Promise<ServiceJob | null>;
  getUser(id: Id): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  getAgent(id: Id): Promise<Agent | null>;
  getAgentByHandle(handle: string): Promise<Agent | null>;
  getCompany(id: Id): Promise<Company | null>;
  getCompanyBySlug(slug: string): Promise<Company | null>;
  getTreasury(companyId: Id): Promise<Treasury | null>;
  getService(id: Id): Promise<Service | null>;
  getInvocation(id: Id): Promise<ServiceInvocation | null>;
  getJob(id: Id): Promise<ServiceJob | null>;
  getJobByInvocation(invocationId: Id): Promise<ServiceJob | null>;
  getResultByInvocation(invocationId: Id): Promise<ServiceResult | null>;
  getTransaction(id: Id): Promise<Transaction | null>;
  getPermission(
    companyId: Id,
    action: Permission["action"],
  ): Promise<Permission | null>;
  listAgents(userId?: Id): Promise<Agent[]>;
  listCompanies(ownerUserId?: Id): Promise<Company[]>;
  listServices(filters?: {
    companyId?: Id;
    status?: Service["status"];
  }): Promise<Service[]>;
  searchServices(filters: ServiceSearch): Promise<ServicePage>;
  listJobs(filters: {
    providerAgentId?: Id;
    buyerAgentId?: Id;
    status?: ServiceJob["status"];
    limit?: number;
  }): Promise<ServiceJob[]>;
  listTransactions(filters?: {
    companyId?: Id;
    limit?: number;
  }): Promise<Transaction[]>;
  listActivities(filters?: {
    companyId?: Id;
    limit?: number;
  }): Promise<Activity[]>;
  listPermissions(companyId: Id): Promise<Permission[]>;
  listAuditEvents(filters?: {
    companyId?: Id;
    limit?: number;
  }): Promise<AuditEvent[]>;
  getOperationalMetrics(companyId: Id): Promise<OperationalMetrics>;
}
