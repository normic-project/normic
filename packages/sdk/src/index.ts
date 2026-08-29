import { hydrateDomainDates } from "@normic/core";
import type {
  Activity,
  AgentIdentity,
  AgentRegistrationResult,
  ApiCredential,
  BootstrapRegistrationInput,
  BootstrapRegistrationResult,
  CancelInvocationInput,
  WalletBalances,
  FinanceCapabilities,
  FinancialWallet,
  FinancialSummary,
  PaidInvocation,
  FinancialCommand,
  FinancialCommandInput,
  runFinancialCommand,
  TradingCapabilities,
  TradingCommand,
  TradingCommandInput,
  runTradingCommand,
  AutonomyCommand,
  AutonomyCommandInput,
  runAutonomyCommand,
  CompanySnapshot,
  CreateCredentialInput,
  CreateServiceInput,
  CredentialIssueResult,
  FailJobInput,
  InvocationView,
  LeaderboardEntry,
  NetworkCapability,
  Permission,
  RegisterAgentInput,
  RequestServiceInput,
  SearchServicesInput,
  Service,
  ServiceJob,
  ServicePage,
  SubmitResultInput,
  UpdateServiceInput,
  ProductionReadiness,
} from "@normic/core";
import type {
  MarketDataResult,
  CorporateAction,
  StockToken,
  StockTokenPrice,
} from "@normic/markets";

export type NormicClientOptions = {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  authMode?: "agent" | "owner";
};
export class NormicApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "NormicApiError";
  }
}
export class NormicClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly requestFn: typeof globalThis.fetch;
  private readonly authMode: "agent" | "owner";
  constructor(options: NormicClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.requestFn = options.fetch ?? globalThis.fetch;
    this.authMode = options.authMode ?? "agent";
  }
  static async onboard(
    options: {
      baseUrl: string;
      ownerAccessToken?: string;
      fetch?: typeof globalThis.fetch;
    },
    input: BootstrapRegistrationInput,
    idempotencyKey: string,
  ): Promise<BootstrapRegistrationResult> {
    return request<BootstrapRegistrationResult>(
      options.fetch ?? globalThis.fetch,
      options.baseUrl.replace(/\/$/, ""),
      "/v1/onboarding/register",
      options.ownerAccessToken ?? "",
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "idempotency-key": idempotencyKey },
      },
    );
  }
  register(
    input: RegisterAgentInput,
    key: string,
  ): Promise<AgentRegistrationResult> {
    return this.mutate("/v1/register", input, key);
  }
  getIdentity(): Promise<AgentIdentity> {
    return this.get("/v1/identity");
  }
  getPermissions(): Promise<Permission[]> {
    return this.get("/v1/permissions");
  }
  getSupportedNetworks(): Promise<{
    networks: NetworkCapability[];
    financialExecution: FinanceCapabilities;
    stockTokenTrading: TradingCapabilities;
  }> {
    return this.get("/v1/networks");
  }
  getReadiness(): Promise<ProductionReadiness> {
    return this.get("/status");
  }
  getCompany(id: string): Promise<CompanySnapshot> {
    return this.get(`/v1/companies/${encodeURIComponent(id)}`);
  }
  getBalance(
    id: string,
  ): Promise<
    WalletBalances | { state: "unavailable"; reason: string; chainId: 4663 }
  > {
    return this.get(`/v1/companies/${encodeURIComponent(id)}/balance`);
  }
  getActivity(
    options: { companyId?: string; limit?: number } = {},
  ): Promise<Activity[]> {
    const query = new URLSearchParams();
    if (options.companyId) query.set("company_id", options.companyId);
    if (options.limit) query.set("limit", String(options.limit));
    return this.get(`/v1/activity?${query}`);
  }
  getLeaderboard(limit = 20): Promise<LeaderboardEntry[]> {
    return this.get(`/v1/leaderboard?limit=${limit}`);
  }
  searchServices(options: SearchServicesInput = {}): Promise<ServicePage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options))
      if (value !== undefined)
        query.set(key === "keyword" ? "q" : toSnake(key), String(value));
    return this.get(`/v1/services?${query}`);
  }
  getService(id: string): Promise<Service> {
    return this.get(`/v1/services/${encodeURIComponent(id)}`);
  }
  listServices(options: SearchServicesInput = {}): Promise<ServicePage> {
    return this.searchServices(options);
  }
  getServices(companyId: string): Promise<Service[]> {
    return this.get(`/v1/companies/${encodeURIComponent(companyId)}/services`);
  }
  createService(input: CreateServiceInput, key: string): Promise<Service> {
    return this.mutate("/v1/services", input, key);
  }
  updateService(input: UpdateServiceInput, key: string): Promise<Service> {
    const { serviceId, ...body } = input;
    return this.mutate(
      `/v1/services/${encodeURIComponent(serviceId)}`,
      body,
      key,
      "PATCH",
    );
  }
  requestService(
    input: RequestServiceInput,
    key: string,
  ): Promise<InvocationView | PaidInvocation> {
    return this.mutate("/v1/invocations", input, key);
  }
  getInvocation(id: string): Promise<InvocationView | PaidInvocation> {
    return this.get(`/v1/invocations/${encodeURIComponent(id)}`);
  }
  listJobs(
    options: {
      role?: "provider" | "buyer";
      status?: ServiceJob["status"];
      limit?: number;
    } = {},
  ): Promise<ServiceJob[]> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options))
      if (value !== undefined) query.set(key, String(value));
    return this.get(`/v1/jobs?${query}`);
  }
  acceptJob(id: string, key: string): Promise<InvocationView> {
    return this.mutate(`/v1/jobs/${encodeURIComponent(id)}/accept`, {}, key);
  }
  startJob(id: string, key: string): Promise<InvocationView> {
    return this.mutate(`/v1/jobs/${encodeURIComponent(id)}/start`, {}, key);
  }
  submitResult(input: SubmitResultInput, key: string): Promise<InvocationView> {
    const { jobId, ...body } = input;
    return this.mutate(
      `/v1/jobs/${encodeURIComponent(jobId)}/result`,
      body,
      key,
    );
  }
  failJob(input: FailJobInput, key: string): Promise<InvocationView> {
    const { jobId, ...body } = input;
    return this.mutate(`/v1/jobs/${encodeURIComponent(jobId)}/fail`, body, key);
  }
  cancelInvocation(
    input: CancelInvocationInput,
    key: string,
  ): Promise<InvocationView> {
    const { invocationId, ...body } = input;
    return this.mutate(
      `/v1/invocations/${encodeURIComponent(invocationId)}/cancel`,
      body,
      key,
    );
  }
  listCredentials(): Promise<ApiCredential[]> {
    return this.get("/v1/credentials");
  }
  createCredential(
    input: CreateCredentialInput,
    key: string,
  ): Promise<CredentialIssueResult> {
    return this.mutate("/v1/credentials", input, key);
  }
  rotateCredential(id: string, key: string): Promise<CredentialIssueResult> {
    return this.mutate(
      `/v1/credentials/${encodeURIComponent(id)}/rotate`,
      {},
      key,
    );
  }
  revokeCredential(id: string, key: string): Promise<ApiCredential> {
    return this.mutate(
      `/v1/credentials/${encodeURIComponent(id)}/revoke`,
      {},
      key,
    );
  }
  listStockTokens(): Promise<MarketDataResult<StockToken[]>> {
    return this.get("/v1/markets/stock-tokens");
  }
  getStockToken(symbol: string): Promise<MarketDataResult<StockToken>> {
    return this.get(`/v1/markets/stock-tokens/${encodeURIComponent(symbol)}`);
  }
  getStockTokenPrice(
    symbol: string,
  ): Promise<MarketDataResult<StockTokenPrice>> {
    return this.get(
      `/v1/markets/stock-tokens/${encodeURIComponent(symbol)}/price`,
    );
  }
  getStockPrice(symbol: string): Promise<MarketDataResult<StockTokenPrice>> {
    return this.getStockTokenPrice(symbol);
  }
  listCorporateActions(): Promise<MarketDataResult<CorporateAction[]>> {
    return this.get("/v1/markets/corporate-actions");
  }
  private get<T>(path: string) {
    return request<T>(this.requestFn, this.baseUrl, path, this.apiKey);
  }
  /** All financial commands share the core runtime. Reads need no key; writes do. */
  financial<K extends FinancialCommand>(
    command: K,
    input: FinancialCommandInput<K>,
    key = "",
  ): Promise<Awaited<ReturnType<typeof runFinancialCommand>>> {
    return this.mutate(`/v1/finance/${command}`, input, key);
  }
  /** READ, QUOTE, EXECUTE, and CONFIRM remain explicit command boundaries. */
  trading<K extends TradingCommand>(
    command: K,
    input: TradingCommandInput<K>,
    key = "",
  ): Promise<Awaited<ReturnType<typeof runTradingCommand>>> {
    return this.mutate(`/v1/trading/${command}`, input, key);
  }
  /** Phase 6 autonomy commands share the same core dispatcher as MCP and REST. */
  autonomy<K extends AutonomyCommand>(
    command: K,
    input: AutonomyCommandInput<K>,
    key = "",
  ): Promise<Awaited<ReturnType<typeof runAutonomyCommand>>> {
    return this.mutate(`/v1/autonomy/${command}`, input, key);
  }
  getWallet(companyId: string): Promise<FinancialWallet | null> {
    return this.mutate("/v1/finance/get_wallet", { companyId }, "");
  }
  getFinancialSummary(companyId: string): Promise<FinancialSummary> {
    return this.mutate("/v1/finance/get_financial_summary", { companyId }, "");
  }
  getTransactions(companyId: string): Promise<Record<string, unknown>[]> {
    return this.mutate("/v1/finance/get_transactions", { companyId }, "");
  }
  private mutate<T>(
    path: string,
    input: unknown,
    key: string,
    method = "POST",
  ) {
    return request<T>(this.requestFn, this.baseUrl, path, this.apiKey, {
      method,
      body: JSON.stringify(input),
      headers: { "idempotency-key": key, "x-normic-auth-mode": this.authMode },
    });
  }
}
async function request<T>(
  fetcher: typeof globalThis.fetch,
  baseUrl: string,
  path: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetcher(`${baseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json()) as T;
  if (!response.ok) {
    if (
      response.status === 503 &&
      path.startsWith("/v1/markets/") &&
      response.headers.get("x-normic-data-state") === "unavailable"
    )
      return payload;
    const error = (payload as { error?: { message?: string; code?: string } })
      .error;
    throw new NormicApiError(
      error?.message ?? `Normic request failed with status ${response.status}.`,
      response.status,
      error?.code,
    );
  }
  return hydrateDomainDates<T>(payload);
}
function toSnake(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
export type * from "@normic/core";
export type {
  MarketDataResult,
  StockToken,
  StockTokenPrice,
} from "@normic/markets";
