import { z } from "zod";
import {
  financialWebAuthnAuthenticationResponseSchema,
  financialWebAuthnRegistrationResponseSchema,
  type FinancialService,
  spendingPolicySchema,
} from "./finance.js";
import { hashSchema } from "./finance-protocol.js";
import type { FinancialActor } from "./finance-types.js";
import { requestServiceSchema, submitResultSchema } from "./schemas.js";
import { CapabilityBlockedError, DomainError } from "./errors.js";

const company = z.object({ companyId: z.uuid() }).strict(),
  invocation = z.object({ invocationId: z.uuid() }).strict();
export const financialInputs = {
  get_financial_capabilities: z.object({}).strict(),
  get_financial_identity: company,
  get_wallet: company,
  prepare_wallet: z.object({}).strict(),
  get_wallet_owner_approval: company.extend({
    agentId: z.uuid(),
    requestId: z.uuid(),
  }),
  get_balance: company,
  get_spending_policy: company,
  get_financial_summary: company,
  get_transactions: company,
  update_spending_policy: spendingPolicySchema,
  revoke_financial_session: company,
  prepare_financial_session: company,
  prepare_canary_review: company.extend({
    role: z.enum(["buyer", "provider"]).default("buyer"),
  }),
  prepare_financial_identity: company,
  provision_financial_wallet: company,
  begin_financial_passkey_registration: company,
  complete_financial_passkey_registration: company.extend({
    response: financialWebAuthnRegistrationResponseSchema,
  }),
  begin_financial_recovery_authorization: company,
  authorize_financial_recovery: company.extend({
    response: financialWebAuthnAuthenticationResponseSchema,
  }),
  complete_financial_recovery_registration: company.extend({
    response: financialWebAuthnRegistrationResponseSchema,
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
    case "get_financial_identity":
      return f.getFinancialIdentity(a, company.parse(raw).companyId);
    case "get_wallet":
      return f.getWallet(a, company.parse(raw).companyId);
    case "prepare_wallet":
      financialInputs.prepare_wallet.parse(raw);
      return f.prepareWallet(a, key);
    case "get_wallet_owner_approval": {
      const p = financialInputs.get_wallet_owner_approval.parse(raw);
      return f.getWalletOwnerApproval(a, p.companyId, p.agentId, p.requestId);
    }
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
    case "prepare_canary_review": {
      const input = financialInputs.prepare_canary_review.parse(raw);
      return f.prepareCanaryReview(a, input.companyId, key, input.role);
    }
    case "prepare_financial_identity":
      return f.prepareFinancialIdentity(a, company.parse(raw).companyId, key);
    case "provision_financial_wallet":
      return f.provisionFinancialWallet(a, company.parse(raw).companyId, key);
    case "begin_financial_passkey_registration":
      return f.beginPasskeyRegistration(
        a,
        company.parse(raw).companyId,
        "primary",
        key,
      );
    case "complete_financial_passkey_registration": {
      const p =
        financialInputs.complete_financial_passkey_registration.parse(raw);
      return f.completePasskeyRegistration(
        a,
        p.companyId,
        "primary",
        p.response,
        key,
      );
    }
    case "begin_financial_recovery_authorization":
      return f.beginRecoveryAuthorization(a, company.parse(raw).companyId, key);
    case "authorize_financial_recovery": {
      const p = financialInputs.authorize_financial_recovery.parse(raw);
      return f.authorizeRecoveryRegistration(a, p.companyId, p.response, key);
    }
    case "complete_financial_recovery_registration": {
      const p =
        financialInputs.complete_financial_recovery_registration.parse(raw);
      return f.completePasskeyRegistration(
        a,
        p.companyId,
        "recovery",
        p.response,
        key,
      );
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
