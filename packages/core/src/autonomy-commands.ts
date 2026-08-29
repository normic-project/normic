import { z } from "zod";
import { DomainError } from "./errors.js";
import {
  heartbeatInputSchema,
  ownerMandateInputSchema,
  submitActionPlanSchema,
  type AutonomyService,
} from "./autonomy.js";
import type { AutonomyActor } from "./autonomy-types.js";

const company = z.object({ companyId: z.uuid() }).strict();
const opportunity = z.object({ opportunityId: z.uuid() }).strict();
const plan = z.object({ planId: z.uuid() }).strict();

export const autonomyInputs = {
  get_autonomy: company,
  get_mandate: company,
  update_mandate: ownerMandateInputSchema,
  pause_autonomy: company,
  heartbeat: heartbeatInputSchema,
  get_opportunities: company.extend({
    limit: z.number().int().min(1).max(100).default(50),
  }),
  get_opportunity: opportunity,
  claim_opportunity: opportunity,
  dismiss_opportunity: opportunity,
  submit_action_plan: submitActionPlanSchema,
  get_action_plan: plan,
  approve_action_plan: plan,
  reject_action_plan: plan,
  get_pending_approvals: company,
  get_action_history: company.extend({
    limit: z.number().int().min(1).max(100).default(50),
  }),
  get_treasury: company,
  get_capital_sources: company,
  get_risk_status: company,
} as const;

export type AutonomyCommand = keyof typeof autonomyInputs;
export type AutonomyCommandInput<K extends AutonomyCommand> = z.input<
  (typeof autonomyInputs)[K]
>;

export function autonomyEffect(command: AutonomyCommand) {
  if (
    [
      "get_autonomy",
      "get_mandate",
      "get_opportunities",
      "get_opportunity",
      "get_action_plan",
      "get_pending_approvals",
      "get_action_history",
      "get_treasury",
      "get_capital_sources",
      "get_risk_status",
    ].includes(command)
  )
    return "READ" as const;
  if (
    ["update_mandate", "approve_action_plan", "reject_action_plan"].includes(
      command,
    )
  )
    return "OWNER" as const;
  return "ACTION" as const;
}

export async function runAutonomyCommand(
  service: AutonomyService,
  actor: AutonomyActor,
  command: AutonomyCommand,
  raw: unknown,
  key: string,
) {
  switch (command) {
    case "get_autonomy":
      return service.getAutonomy(actor, company.parse(raw).companyId);
    case "get_mandate":
      return service.getMandate(actor, company.parse(raw).companyId);
    case "update_mandate":
      return service.updateMandate(
        actor,
        ownerMandateInputSchema.parse(raw),
        key,
      );
    case "pause_autonomy":
      return service.pauseAutonomy(actor, company.parse(raw).companyId, key);
    case "heartbeat":
      return service.heartbeat(actor, heartbeatInputSchema.parse(raw), key);
    case "get_opportunities": {
      const input = autonomyInputs.get_opportunities.parse(raw);
      return service.getOpportunities(actor, input.companyId, input.limit);
    }
    case "get_opportunity":
      return service.getOpportunity(
        actor,
        autonomyInputs.get_opportunity.parse(raw).opportunityId,
      );
    case "claim_opportunity":
      return service.setOpportunityStatus(
        actor,
        autonomyInputs.claim_opportunity.parse(raw).opportunityId,
        "CLAIMED",
        key,
      );
    case "dismiss_opportunity":
      return service.setOpportunityStatus(
        actor,
        autonomyInputs.dismiss_opportunity.parse(raw).opportunityId,
        "DISMISSED",
        key,
      );
    case "submit_action_plan":
      return service.submitActionPlan(
        actor,
        submitActionPlanSchema.parse(raw),
        key,
      );
    case "get_action_plan":
      return service.getActionPlan(
        actor,
        autonomyInputs.get_action_plan.parse(raw).planId,
      );
    case "approve_action_plan":
    case "reject_action_plan":
      return service.decideActionPlan(
        actor,
        plan.parse(raw).planId,
        command === "approve_action_plan" ? "APPROVED" : "REJECTED",
        key,
      );
    case "get_pending_approvals":
      return service.getPendingApprovals(actor, company.parse(raw).companyId);
    case "get_action_history": {
      const input = autonomyInputs.get_action_history.parse(raw);
      return service.getActionHistory(actor, input.companyId, input.limit);
    }
    case "get_treasury":
      return service.getTreasury(actor, company.parse(raw).companyId);
    case "get_capital_sources":
      return service.getCapitalSources(actor, company.parse(raw).companyId);
    case "get_risk_status":
      return service.getRiskStatus(actor, company.parse(raw).companyId);
    default:
      throw new DomainError("Unknown autonomy operation.", "INVALID_INPUT");
  }
}
