import { z } from "zod";
import { type FinancialService, spendingPolicySchema } from "./finance.js";
import { hashSchema } from "./finance-protocol.js";
import type { FinancialActor } from "./finance-types.js";
import { requestServiceSchema, submitResultSchema } from "./schemas.js";
import { CapabilityBlockedError, DomainError } from "./errors.js";

const company = z.object({ companyId: z.uuid() }).strict(),
  invocation = z.object({ invocationId: z.uuid() }).strict();
export const financialInputs = {
  get_financial_capabilities: z.object({}).strict(),
  get_wallet: company,
  get_balance: company,
  get_spending_policy: company,
  get_financial_summary: company,
  get_transactions: company,
  update_spending_policy: spendingPolicySchema,
  revoke_financial_session: company,
  prepare_financial_session: company,
  connect_wallet: company.extend({
    walletProofToken: z.string().min(1).max(200),
  }),
  register_financial_session: company.extend({
    authorizationRef: z.uuid(),
    ownerAuthorization: z
      .string()
      .regex(/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/),
  }),
  request_service: requestServiceSchema,
  get_payment_requirement: invocation,
  get_payment_status: invocation,
  get_invocation: invocation,
  fund_service: invocation,
  accept_result: invocation,
  dispute_result: invocation,
  refund_service: invocation,
  prepare_result_submission: invocation,
  accept_job: z.object({ jobId: z.uuid() }).strict(),
  start_job: z.object({ jobId: z.uuid() }).strict(),
  submit_result: submitResultSchema,
  simulate_payment: z.object({ operationId: z.uuid() }).strict(),
  execute_payment: z.object({ operationId: z.uuid() }).strict(),
  reconcile_payment: z.object({ operationId: z.uuid() }).strict(),
  confirm_payment: invocation.extend({ transactionHash: hashSchema }),
  get_paid_jobs: z
    .object({ role: z.enum(["buyer", "provider"]).default("provider") })
    .strict(),
} as const;
export type FinancialCommand = keyof typeof financialInputs;
export type FinancialCommandInput<K extends FinancialCommand> = z.input<
  (typeof financialInputs)[K]
>;
export function financialEffect(name: FinancialCommand) {
  return name.startsWith("get_")
    ? "reads"
    : name === "simulate_payment"
      ? "simulates"
      : name === "execute_payment"
        ? "broadcasts"
        : name === "confirm_payment" || name === "reconcile_payment"
          ? "waits for finality"
          : "prepares";
}
export const financialCommandRequiresReadyCapability = (
  name: FinancialCommand,
) =>
  [
    "connect_wallet",
    "prepare_financial_session",
    "register_financial_session",
    "fund_service",
    "accept_result",
    "dispute_result",
    "refund_service",
    "prepare_result_submission",
    "simulate_payment",
    "execute_payment",
    "reconcile_payment",
    "confirm_payment",
  ].includes(name);
export async function runFinancialCommand(
  f: FinancialService,
  a: FinancialActor,
  name: FinancialCommand,
  raw: unknown,
  key: string,
) {
  if (financialCommandRequiresReadyCapability(name)) {
    const capability = f.capabilities();
    if (capability.state !== "ready")
      throw new CapabilityBlockedError("USDG_PAYMENTS", capability.missing);
  }
  switch (name) {
    case "get_financial_capabilities":
      return f.capabilities();
    case "get_wallet":
      return f.getWallet(a, company.parse(raw).companyId);
    case "get_balance":
      return f.getBalance(a, company.parse(raw).companyId);
    case "get_spending_policy":
      return f.getPolicy(a, company.parse(raw).companyId);
    case "get_financial_summary":
      return f.getSummary(a, company.parse(raw).companyId);
    case "get_transactions":
      return f.getTransactions(a, company.parse(raw).companyId);
    case "update_spending_policy":
      return f.updatePolicy(
        a,
        financialInputs.update_spending_policy.parse(raw),
        key,
      );
    case "revoke_financial_session":
      return f.revokeSession(a, company.parse(raw).companyId, key);
    case "prepare_financial_session":
      return f.prepareSessionAuthorization(
        a,
        company.parse(raw).companyId,
        key,
      );
    case "connect_wallet": {
      const p = financialInputs.connect_wallet.parse(raw);
      return f.createWallet(a, p.companyId, p.walletProofToken, key);
    }
    case "register_financial_session":
      return f.registerSession(
        a,
        financialInputs.register_financial_session.parse(raw),
        key,
      );
    case "request_service":
      return f.requestService(a, requestServiceSchema.parse(raw), key);
    case "get_invocation":
    case "get_payment_requirement":
    case "get_payment_status":
      return f.getPaymentStatus(a, invocation.parse(raw).invocationId);
    case "fund_service":
      return f.prepare(a, invocation.parse(raw).invocationId, "fund", key);
    case "accept_result":
      return f.prepare(a, invocation.parse(raw).invocationId, "release", key);
    case "dispute_result":
      return f.prepare(a, invocation.parse(raw).invocationId, "dispute", key);
    case "refund_service":
      return f.prepare(a, invocation.parse(raw).invocationId, "refund", key);
    case "prepare_result_submission":
      return f.prepare(a, invocation.parse(raw).invocationId, "submit", key);
    case "accept_job":
      return f.prepare(
        a,
        financialInputs.accept_job.parse(raw).jobId,
        "accept",
        key,
      );
    case "start_job":
      return f.startJob(a, financialInputs.start_job.parse(raw).jobId, key);
    case "submit_result":
      return f.submitResult(a, submitResultSchema.parse(raw), key);
    case "simulate_payment":
      return f.simulate(
        a,
        financialInputs.simulate_payment.parse(raw).operationId,
        key,
      );
    case "execute_payment":
      return f.execute(
        a,
        financialInputs.execute_payment.parse(raw).operationId,
        key,
      );
    case "reconcile_payment":
      return f.reconcileOperation(
        a,
        financialInputs.reconcile_payment.parse(raw).operationId,
        key,
      );
    case "confirm_payment": {
      const p = financialInputs.confirm_payment.parse(raw);
      return f.confirm(a, p.invocationId, p.transactionHash, key);
    }
    case "get_paid_jobs":
      return f.listJobs(a, financialInputs.get_paid_jobs.parse(raw).role);
    default:
      throw new DomainError("Unknown financial operation.", "INVALID_INPUT");
  }
}
