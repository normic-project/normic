import type { FinancialActor } from "./finance-types.js";
import type { EconomyRepository } from "./repository.js";
import type {
  CreateServiceInput,
  RequestServiceInput,
  SubmitResultInput,
  UpdateServiceInput,
} from "./schemas.js";
import type { JsonObject, RequestContext } from "./types.js";

export type AutonomyMode = "MANUAL" | "SUPERVISED" | "AUTONOMOUS";
export type AgentPresence = "ONLINE" | "IDLE" | "BUSY" | "OFFLINE" | "PAUSED";

export type AutonomyKillSwitches = {
  pauseAll: boolean;
  pauseTrading: boolean;
  pauseServiceBuying: boolean;
  pauseJobAcceptance: boolean;
};

export type OwnerMandate = {
  companyId: string;
  version: number;
  mode: AutonomyMode;
  allowServiceOperations: boolean;
  allowServiceBuying: boolean;
  maxServiceSpendUsdg: string | null;
  allowStockTokenTrading: boolean;
  maxTradeUsdg: string | null;
  maxDailyInvestmentUsdg: string | null;
  maxStockTokenExposureUsdg: string | null;
  minimumCashReserveUsdg: string | null;
  allowedStockTokenIds: string[];
  maxTotalDailySpendUsdg: string | null;
  sessionExpiresAt: string;
  killSwitches: AutonomyKillSwitches;
  updatedAt: string;
  updatedBy: string;
};

export type AgentHeartbeat = {
  agentId: string;
  companyId: string;
  sessionId: string;
  status: AgentPresence;
  currentJobId: string | null;
  connectedAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
};

export type OpportunityKind =
  | "AVAILABLE_SERVICE_JOB"
  | "COMPLETED_PAYMENT"
  | "TREASURY_REVIEW"
  | "INVESTABLE_CAPITAL"
  | "PORTFOLIO_RISK"
  | "STOCK_TOKEN_CORPORATE_ACTION"
  | "SESSION_EXPIRATION"
  | "MANDATE_CHANGE";
export type OpportunityStatus = "OPEN" | "CLAIMED" | "DISMISSED" | "EXPIRED";
export type Opportunity = {
  id: string;
  companyId: string;
  agentId: string;
  kind: OpportunityKind;
  sourceType: string;
  sourceId: string;
  fingerprint: string;
  title: string;
  summary: string;
  priority: "LOW" | "MEDIUM" | "HIGH";
  status: OpportunityStatus;
  data: JsonObject;
  createdAt: string;
  expiresAt: string | null;
  claimedAt: string | null;
  dismissedAt: string | null;
};

export type AutonomyAction =
  | { type: "CREATE_SERVICE"; input: CreateServiceInput }
  | { type: "UPDATE_SERVICE"; input: UpdateServiceInput }
  | { type: "ACCEPT_JOB"; jobId: string }
  | { type: "START_JOB"; jobId: string }
  | { type: "SUBMIT_RESULT"; input: SubmitResultInput }
  | { type: "BUY_AGENT_SERVICE"; input: RequestServiceInput }
  | { type: "BUY_STOCK_TOKEN"; quoteId: string }
  | { type: "SELL_STOCK_TOKEN"; quoteId: string }
  | { type: "NO_ACTION" };

export type ActionPlanStatus =
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "EXECUTING"
  | "EXECUTED"
  | "FAILED"
  | "BLOCKED";
export type ApprovalStatus =
  "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "EXECUTED" | "FAILED";
export type ControlDecision = {
  result: "ALLOW" | "BLOCK";
  code: string;
  summary: string;
};

export type ActionPlan = {
  id: string;
  companyId: string;
  agentId: string;
  credentialId: string;
  opportunityId: string | null;
  action: AutonomyAction;
  actionHash: string;
  reasonSummary: string;
  mandateVersion: number;
  mode: AutonomyMode;
  status: ActionPlanStatus;
  policyResult: ControlDecision;
  riskResult: ControlDecision;
  financialAmountUsdg: string;
  notionalAmountUsdg: string;
  transactionReference: string | null;
  failureCode: string | null;
  authSnapshot: RequestContext["principal"];
  createdAt: string;
  expiresAt: string;
  executedAt: string | null;
};

export type ActionApproval = {
  id: string;
  planId: string;
  actionHash: string;
  status: ApprovalStatus;
  ownerIssuer: string | null;
  ownerSubject: string | null;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
};

export type ActionHistory = {
  id: string;
  companyId: string;
  agentId: string;
  opportunityId: string | null;
  planId: string;
  actionType: AutonomyAction["type"];
  mandateVersion: number;
  policyResult: ControlDecision;
  riskResult: ControlDecision;
  executionResult: string;
  transactionReference: string | null;
  createdAt: string;
};

export type CircuitBreaker = {
  code:
    | "WALLET_RECONCILIATION"
    | "REPEATED_TRANSACTION_FAILURES"
    | "ELIGIBILITY"
    | "SESSION"
    | "ORACLE"
    | "PROVIDER"
    | "BALANCE_DISCREPANCY";
  active: boolean;
  reason: string;
  triggeredAt: string | null;
};
export type AutonomyRiskStatus = {
  companyId: string;
  state: "CLEAR" | "BLOCKED";
  circuitBreakers: CircuitBreaker[];
  checkedAt: string;
};

export type ActionInspection = {
  companyId: string;
  financialAmountUsdg: string;
  notionalAmountUsdg: string;
  financialKind: "NONE" | "SERVICE_BUY" | "STOCK_BUY" | "STOCK_SELL";
  stockTokenId: string | null;
  providerCompanyId: string | null;
  cashBalanceUsdg: string | null;
  dailyInvestmentUsdg: string;
  stockExposureUsdg: string;
  risk: ControlDecision;
};

export type OpportunityCandidate = Omit<
  Opportunity,
  "id" | "status" | "createdAt" | "claimedAt" | "dismissedAt"
>;

export interface AutonomyOperationsPort {
  inspect(
    context: RequestContext,
    action: AutonomyAction,
  ): Promise<ActionInspection>;
  execute(
    context: RequestContext,
    action: AutonomyAction,
    reasonSummary: string,
    key: string,
  ): Promise<{ result: unknown; transactionReference: string | null }>;
  opportunities(context: RequestContext): Promise<OpportunityCandidate[]>;
  treasury(actor: FinancialActor, companyId: string): Promise<unknown>;
  capitalSources(actor: FinancialActor, companyId: string): Promise<unknown>;
  capitalAvailable(companyId: string): Promise<string>;
  riskStatus(
    actor: FinancialActor,
    companyId: string,
  ): Promise<AutonomyRiskStatus>;
}

export type AutonomyClaim =
  { replay: false } | { replay: true; response: unknown };

export interface AutonomyRepository {
  readonly economy: EconomyRepository;
  transaction<T>(operation: (tx: AutonomyRepository) => Promise<T>): Promise<T>;
  lockCompany(companyId: string): Promise<void>;
  claim(
    actor: string,
    operation: string,
    key: string,
    hash: string,
  ): Promise<AutonomyClaim>;
  complete(
    actor: string,
    operation: string,
    key: string,
    response: unknown,
  ): Promise<void>;
  getMandate(companyId: string): Promise<OwnerMandate | null>;
  saveMandate(value: OwnerMandate): Promise<void>;
  getHeartbeat(agentId: string): Promise<AgentHeartbeat | null>;
  saveHeartbeat(value: AgentHeartbeat): Promise<void>;
  saveOpportunity(value: Opportunity): Promise<void>;
  getOpportunity(id: string): Promise<Opportunity | null>;
  listOpportunities(companyId: string, limit: number): Promise<Opportunity[]>;
  updateOpportunity(value: Opportunity): Promise<void>;
  savePlan(value: ActionPlan): Promise<void>;
  getPlan(id: string, lock?: boolean): Promise<ActionPlan | null>;
  listPendingApprovals(
    companyId: string,
  ): Promise<{ plan: ActionPlan; approval: ActionApproval }[]>;
  saveApproval(value: ActionApproval): Promise<void>;
  getApproval(planId: string, lock?: boolean): Promise<ActionApproval | null>;
  addHistory(value: ActionHistory): Promise<void>;
  listHistory(companyId: string, limit: number): Promise<ActionHistory[]>;
  dailyExecutedSpend(companyId: string): Promise<string>;
  activeReservations(companyId: string): Promise<string>;
  reserve(
    planId: string,
    companyId: string,
    amount: string,
    expiresAt: string,
  ): Promise<void>;
  finishReservation(
    planId: string,
    status: "CONSUMED" | "RELEASED",
  ): Promise<void>;
  riskStatus(companyId: string): Promise<AutonomyRiskStatus>;
  audit(
    type: string,
    companyId: string,
    resourceId: string | null,
    actor: string,
    details?: Record<string, string>,
  ): Promise<void>;
}

export type AutonomyActor = FinancialActor;
