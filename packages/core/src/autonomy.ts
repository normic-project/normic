import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  PolicyDeniedError,
} from "./errors.js";
import { canonicalJson } from "./finance.js";
import { AuthorizationPipeline } from "./policy.js";
import {
  createServiceSchema,
  idempotencyKeySchema,
  requestServiceSchema,
  submitResultSchema,
  updateServiceSchema,
} from "./schemas.js";
import type { RequestContext } from "./types.js";
import type {
  ActionApproval,
  ActionHistory,
  ActionInspection,
  ActionPlan,
  AgentHeartbeat,
  AutonomyAction,
  AutonomyActor,
  AutonomyOperationsPort,
  AutonomyRepository,
  ControlDecision,
  Opportunity,
  OwnerMandate,
} from "./autonomy-types.js";

const units = z.string().regex(/^(0|[1-9][0-9]*)$/);
const optionalLimit = units.nullable();
const stockId = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const reasonSummary = z.string().trim().min(1).max(500);
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const actorHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const ownerMandateInputSchema = z
  .object({
    companyId: z.uuid(),
    mode: z.enum(["MANUAL", "SUPERVISED", "AUTONOMOUS"]),
    allowServiceOperations: z.boolean(),
    allowServiceBuying: z.boolean(),
    maxServiceSpendUsdg: optionalLimit,
    allowStockTokenTrading: z.boolean(),
    maxTradeUsdg: optionalLimit,
    maxDailyInvestmentUsdg: optionalLimit,
    maxStockTokenExposureUsdg: optionalLimit,
    minimumCashReserveUsdg: optionalLimit,
    allowedStockTokenIds: z.array(stockId).max(256),
    maxTotalDailySpendUsdg: optionalLimit,
    sessionExpiresAt: z.iso.datetime(),
    killSwitches: z
      .object({
        pauseAll: z.boolean(),
        pauseTrading: z.boolean(),
        pauseServiceBuying: z.boolean(),
        pauseJobAcceptance: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const heartbeatInputSchema = z
  .object({
    companyId: z.uuid(),
    sessionId: z.string().trim().min(8).max(256),
    status: z.enum(["ONLINE", "IDLE", "BUSY", "PAUSED"]),
    currentJobId: z.uuid().nullable().default(null),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const autonomyActionSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("CREATE_SERVICE"), input: createServiceSchema })
    .strict(),
  z
    .object({ type: z.literal("UPDATE_SERVICE"), input: updateServiceSchema })
    .strict(),
  z.object({ type: z.literal("ACCEPT_JOB"), jobId: z.uuid() }).strict(),
  z.object({ type: z.literal("START_JOB"), jobId: z.uuid() }).strict(),
  z
    .object({ type: z.literal("SUBMIT_RESULT"), input: submitResultSchema })
    .strict(),
  z
    .object({
      type: z.literal("BUY_AGENT_SERVICE"),
      input: requestServiceSchema,
    })
    .strict(),
  z.object({ type: z.literal("BUY_STOCK_TOKEN"), quoteId: z.uuid() }).strict(),
  z.object({ type: z.literal("SELL_STOCK_TOKEN"), quoteId: z.uuid() }).strict(),
  z.object({ type: z.literal("NO_ACTION") }).strict(),
]);

export const submitActionPlanSchema = z
  .object({
    companyId: z.uuid(),
    opportunityId: z.uuid().nullable().default(null),
    action: autonomyActionSchema,
    reasonSummary,
    expiresAt: z.iso.datetime(),
  })
  .strict();

const allow = (code: string, summary: string): ControlDecision => ({
  result: "ALLOW",
  code,
  summary,
});
const block = (code: string, summary: string): ControlDecision => ({
  result: "BLOCK",
  code,
  summary,
});

export class AutonomyService {
  private readonly auth = new AuthorizationPipeline();

  constructor(
    readonly repository: AutonomyRepository,
    readonly operations: AutonomyOperationsPort,
  ) {}

  private actorId(actor: AutonomyActor) {
    return actor.kind === "agent"
      ? `agent:${actor.context.principal.agentId}`
      : actor.kind === "owner"
        ? `owner:${actorHash(`${actor.owner.issuer}|${actor.owner.subject}`)}`
        : `human:${actor.wallet.toLowerCase()}`;
  }

  private async authorize(
    repository: AutonomyRepository,
    actor: AutonomyActor,
    companyId: string,
    scope: "company:read" | "company:write" = "company:read",
  ) {
    if (actor.kind === "agent") {
      await this.auth.assert(repository.economy, actor.context, {
        scope,
        companyId,
      });
      const credential = await repository.economy.getCredential(
        actor.context.principal.credentialId,
      );
      if (
        !credential ||
        credential.agentId !== actor.context.principal.agentId ||
        credential.revokedAt ||
        (credential.expiresAt && credential.expiresAt <= new Date()) ||
        !credential.scopes.includes(scope)
      )
        throw new AuthenticationError();
      return;
    }
    if (actor.kind !== "owner")
      throw new AuthorizationError(
        "A verified owner or agent identity is required.",
      );
    const company = await repository.economy.getCompany(companyId);
    const owner = company
      ? await repository.economy.getUser(company.ownerUserId)
      : null;
    if (
      !company ||
      !owner ||
      owner.authIssuer !== actor.owner.issuer ||
      owner.authSubject !== actor.owner.subject
    )
      throw new AuthorizationError(
        "The verified owner does not own this company.",
      );
  }

  private owner(actor: AutonomyActor) {
    if (actor.kind !== "owner")
      throw new AuthorizationError(
        "Only the verified human owner may enable or increase autonomy.",
      );
    return actor.owner;
  }

  async getAutonomy(actor: AutonomyActor, companyId: string) {
    await this.authorize(this.repository, actor, companyId);
    const mandate = await this.repository.getMandate(companyId);
    const company = await this.repository.economy.getCompany(companyId);
    if (!company) throw new NotFoundError("Company");
    const heartbeat = await this.effectiveHeartbeat(company.primaryAgentId);
    return { companyId, mandate, heartbeat };
  }

  async getMandate(actor: AutonomyActor, companyId: string) {
    await this.authorize(this.repository, actor, companyId);
    return this.repository.getMandate(companyId);
  }

  private validateMandateInput(input: z.infer<typeof ownerMandateInputSchema>) {
    if (new Date(input.sessionExpiresAt) <= new Date())
      throw new PolicyDeniedError("The autonomy mandate session has expired.");
    if (
      input.allowServiceBuying &&
      (!input.maxServiceSpendUsdg || !input.maxTotalDailySpendUsdg)
    )
      throw new PolicyDeniedError(
        "Service buying requires explicit per-purchase and total daily limits.",
      );
    if (
      input.allowStockTokenTrading &&
      (!input.maxTradeUsdg ||
        !input.maxDailyInvestmentUsdg ||
        !input.maxStockTokenExposureUsdg ||
        !input.minimumCashReserveUsdg ||
        !input.maxTotalDailySpendUsdg ||
        input.allowedStockTokenIds.length === 0)
    )
      throw new PolicyDeniedError(
        "Stock Token autonomy requires explicit limits, reserve, and an asset allowlist.",
      );
    if (
      new Set(input.allowedStockTokenIds.map((id) => id.toLowerCase())).size !==
      input.allowedStockTokenIds.length
    )
      throw new PolicyDeniedError("Allowed Stock Token IDs must be unique.");
  }

  async updateMandate(
    actor: AutonomyActor,
    raw: z.input<typeof ownerMandateInputSchema>,
    key: string,
  ) {
    const owner = this.owner(actor);
    const input = ownerMandateInputSchema.parse(raw);
    this.validateMandateInput(input);
    idempotencyKeySchema.parse(key);
    return this.repository.transaction(async (repository) => {
      await this.authorize(repository, actor, input.companyId);
      await repository.lockCompany(input.companyId);
      const claim = await repository.claim(
        this.actorId(actor),
        "autonomy.mandate.updated",
        key,
        hash(input),
      );
      if (claim.replay) return claim.response as OwnerMandate;
      const previous = await repository.getMandate(input.companyId);
      const value: OwnerMandate = {
        ...input,
        allowedStockTokenIds: input.allowedStockTokenIds.map((id) =>
          id.toLowerCase(),
        ),
        version: (previous?.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: `owner:${actorHash(`${owner.issuer}|${owner.subject}`)}`,
      };
      await repository.saveMandate(value);
      await repository.audit(
        "autonomy.mandate.updated",
        input.companyId,
        null,
        this.actorId(actor),
        { version: String(value.version), mode: value.mode },
      );
      await repository.complete(
        this.actorId(actor),
        "autonomy.mandate.updated",
        key,
        value,
      );
      return value;
    });
  }

  async pauseAutonomy(actor: AutonomyActor, companyId: string, key: string) {
    if (actor.kind === "human")
      throw new AuthorizationError(
        "A verified owner or agent identity is required.",
      );
    idempotencyKeySchema.parse(key);
    return this.repository.transaction(async (repository) => {
      await this.authorize(repository, actor, companyId);
      await repository.lockCompany(companyId);
      const claim = await repository.claim(
        this.actorId(actor),
        "autonomy.paused",
        key,
        hash({ companyId }),
      );
      if (claim.replay) return claim.response as OwnerMandate;
      const current = await repository.getMandate(companyId);
      if (!current)
        throw new PolicyDeniedError("No owner mandate is configured.");
      const value: OwnerMandate = {
        ...current,
        mode: "MANUAL",
        killSwitches: { ...current.killSwitches, pauseAll: true },
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: this.actorId(actor),
      };
      await repository.saveMandate(value);
      await repository.audit(
        "autonomy.paused",
        companyId,
        null,
        this.actorId(actor),
      );
      await repository.complete(
        this.actorId(actor),
        "autonomy.paused",
        key,
        value,
      );
      return value;
    });
  }

  async heartbeat(
    actor: AutonomyActor,
    raw: z.input<typeof heartbeatInputSchema>,
    key: string,
  ) {
    if (actor.kind !== "agent")
      throw new AuthorizationError("Only the agent may publish its heartbeat.");
    const input = heartbeatInputSchema.parse(raw);
    idempotencyKeySchema.parse(key);
    await this.authorize(
      this.repository,
      actor,
      input.companyId,
      "company:write",
    );
    const mandate = await this.repository.getMandate(input.companyId);
    if (!mandate)
      throw new PolicyDeniedError("No owner mandate is configured.");
    const expiresAt = new Date(input.expiresAt);
    if (
      expiresAt <= new Date() ||
      expiresAt > new Date(mandate.sessionExpiresAt)
    )
      throw new PolicyDeniedError(
        "Heartbeat expiration must be current and within the owner mandate session.",
      );
    return this.repository.transaction(async (repository) => {
      const claim = await repository.claim(
        this.actorId(actor),
        "autonomy.heartbeat",
        key,
        hash(input),
      );
      if (claim.replay) return claim.response as AgentHeartbeat;
      const prior = await repository.getHeartbeat(
        actor.context.principal.agentId,
      );
      const now = new Date().toISOString();
      const value: AgentHeartbeat = {
        agentId: actor.context.principal.agentId,
        companyId: input.companyId,
        sessionId: input.sessionId,
        status: input.status,
        currentJobId: input.currentJobId,
        connectedAt:
          prior?.sessionId === input.sessionId ? prior.connectedAt : now,
        lastHeartbeatAt: now,
        expiresAt: input.expiresAt,
      };
      await repository.saveHeartbeat(value);
      await repository.complete(
        this.actorId(actor),
        "autonomy.heartbeat",
        key,
        value,
      );
      return value;
    });
  }

  private async effectiveHeartbeat(agentId: string) {
    const heartbeat = await this.repository.getHeartbeat(agentId);
    if (!heartbeat) return null;
    if (new Date(heartbeat.expiresAt) <= new Date())
      return { ...heartbeat, status: "OFFLINE" as const };
    return heartbeat;
  }

  private async agentContext(plan: ActionPlan): Promise<RequestContext> {
    const credential = await this.repository.economy.getCredential(
      plan.credentialId,
    );
    if (
      !credential ||
      credential.agentId !== plan.agentId ||
      credential.revokedAt ||
      (credential.expiresAt && credential.expiresAt <= new Date())
    )
      throw new AuthenticationError(
        "The action plan credential is no longer valid.",
      );
    return {
      principal: {
        ...plan.authSnapshot,
        scopes: credential.scopes,
        expiresAt: credential.expiresAt,
      },
    };
  }

  private heartbeatDecision(heartbeat: AgentHeartbeat | null): ControlDecision {
    if (
      !heartbeat ||
      new Date(heartbeat.expiresAt) <= new Date() ||
      ["OFFLINE", "PAUSED"].includes(heartbeat.status)
    )
      return block(
        "AGENT_OFFLINE",
        "A current non-paused agent heartbeat is required.",
      );
    return allow("AGENT_PRESENT", "The agent heartbeat is current.");
  }

  private mandateDecision(
    mandate: OwnerMandate | null,
    action: AutonomyAction,
    inspection: ActionInspection,
    dailySpend: bigint,
  ): ControlDecision {
    if (!mandate)
      return block("MANDATE_MISSING", "No owner mandate is configured.");
    if (new Date(mandate.sessionExpiresAt) <= new Date())
      return block("MANDATE_EXPIRED", "The owner mandate session has expired.");
    if (mandate.killSwitches.pauseAll)
      return block("KILL_SWITCH_ALL", "All autonomy is paused by the owner.");
    if (mandate.mode === "MANUAL" && action.type !== "NO_ACTION")
      return block(
        "MANUAL_MODE",
        "Manual mode does not permit agent execution.",
      );
    const financial = BigInt(inspection.financialAmountUsdg);
    const notional = BigInt(inspection.notionalAmountUsdg);
    if (
      [
        "CREATE_SERVICE",
        "UPDATE_SERVICE",
        "START_JOB",
        "SUBMIT_RESULT",
      ].includes(action.type) &&
      !mandate.allowServiceOperations
    )
      return block(
        "SERVICE_OPERATIONS_DISABLED",
        "Service operations are disabled.",
      );
    if (action.type === "ACCEPT_JOB") {
      if (
        !mandate.allowServiceOperations ||
        mandate.killSwitches.pauseJobAcceptance
      )
        return block("JOB_ACCEPTANCE_PAUSED", "Job acceptance is paused.");
    }
    if (action.type === "BUY_AGENT_SERVICE") {
      if (
        !mandate.allowServiceBuying ||
        mandate.killSwitches.pauseServiceBuying
      )
        return block(
          "SERVICE_BUYING_PAUSED",
          "Service buying is not authorized.",
        );
      if (
        mandate.maxServiceSpendUsdg === null ||
        financial > BigInt(mandate.maxServiceSpendUsdg)
      )
        return block(
          "SERVICE_SPEND_LIMIT",
          "The service purchase exceeds the mandate limit.",
        );
    }
    if (["BUY_STOCK_TOKEN", "SELL_STOCK_TOKEN"].includes(action.type)) {
      if (!mandate.allowStockTokenTrading || mandate.killSwitches.pauseTrading)
        return block(
          "TRADING_PAUSED",
          "Stock Token trading is not authorized.",
        );
      if (
        !inspection.stockTokenId ||
        !mandate.allowedStockTokenIds.includes(
          inspection.stockTokenId.toLowerCase(),
        )
      )
        return block(
          "ASSET_NOT_ALLOWED",
          "The Stock Token is not owner-allowlisted.",
        );
      if (
        notional > 0n &&
        (mandate.maxTradeUsdg === null ||
          notional > BigInt(mandate.maxTradeUsdg))
      )
        return block(
          "TRADE_SIZE_LIMIT",
          "The trade exceeds the mandate limit.",
        );
      if (
        action.type === "BUY_STOCK_TOKEN" &&
        (mandate.maxDailyInvestmentUsdg === null ||
          BigInt(inspection.dailyInvestmentUsdg) + financial >
            BigInt(mandate.maxDailyInvestmentUsdg))
      )
        return block(
          "DAILY_INVESTMENT_LIMIT",
          "The daily investment limit would be exceeded.",
        );
      if (
        (action.type === "BUY_STOCK_TOKEN" &&
          mandate.maxStockTokenExposureUsdg === null) ||
        (action.type === "BUY_STOCK_TOKEN" &&
          mandate.maxStockTokenExposureUsdg !== null &&
          BigInt(inspection.stockExposureUsdg) >
            BigInt(mandate.maxStockTokenExposureUsdg))
      )
        return block(
          "STOCK_EXPOSURE_LIMIT",
          "Stock Token exposure exceeds the mandate.",
        );
      if (
        action.type === "BUY_STOCK_TOKEN" &&
        (inspection.cashBalanceUsdg === null ||
          mandate.minimumCashReserveUsdg === null ||
          BigInt(inspection.cashBalanceUsdg) <
            financial + BigInt(mandate.minimumCashReserveUsdg))
      )
        return block(
          "CASH_RESERVE",
          "The minimum USDG reserve would be breached.",
        );
    }
    if (
      financial > 0n &&
      (mandate.maxTotalDailySpendUsdg === null ||
        dailySpend + financial > BigInt(mandate.maxTotalDailySpendUsdg))
    )
      return block(
        "TOTAL_DAILY_SPEND",
        "The total daily spending limit would be exceeded.",
      );
    return allow(
      "MANDATE_ALLOW",
      "The exact action is permitted by the current mandate.",
    );
  }

  private async syncOpportunities(context: RequestContext) {
    const candidates = await this.operations.opportunities(context);
    const agent = await this.repository.economy.getAgent(
      context.principal.agentId,
    );
    if (!agent) throw new NotFoundError("Agent");
    const mandate = await this.repository.getMandate(agent.companyId);
    const heartbeat = await this.repository.getHeartbeat(agent.id);
    if (mandate)
      candidates.push({
        companyId: agent.companyId,
        agentId: agent.id,
        kind: "MANDATE_CHANGE",
        sourceType: "owner_mandate",
        sourceId: `${agent.companyId}:${mandate.version}`,
        fingerprint: hash({
          kind: "MANDATE_CHANGE",
          companyId: agent.companyId,
          version: mandate.version,
        }),
        title: "Owner mandate updated",
        summary: `Owner mandate version ${mandate.version} is active in ${mandate.mode} mode.`,
        priority: "HIGH",
        data: { version: mandate.version, mode: mandate.mode },
        expiresAt: mandate.sessionExpiresAt,
      });
    if (
      heartbeat &&
      new Date(heartbeat.expiresAt).getTime() - Date.now() <= 15 * 60_000
    )
      candidates.push({
        companyId: agent.companyId,
        agentId: agent.id,
        kind: "SESSION_EXPIRATION",
        sourceType: "agent_heartbeat",
        sourceId: heartbeat.sessionId,
        fingerprint: hash({
          kind: "SESSION_EXPIRATION",
          agentId: agent.id,
          sessionId: heartbeat.sessionId,
          expiresAt: heartbeat.expiresAt,
        }),
        title: "Agent session expiration",
        summary:
          "The current agent heartbeat session is near expiration or expired.",
        priority: "HIGH",
        data: {
          sessionId: heartbeat.sessionId,
          expiresAt: heartbeat.expiresAt,
        },
        expiresAt: heartbeat.expiresAt,
      });
    for (const candidate of candidates) {
      await this.repository.saveOpportunity({
        ...candidate,
        id: randomUUID(),
        status: "OPEN",
        createdAt: new Date().toISOString(),
        claimedAt: null,
        dismissedAt: null,
      });
    }
  }

  async getOpportunities(actor: AutonomyActor, companyId: string, limit = 50) {
    if (actor.kind !== "agent")
      throw new AuthorizationError(
        "Opportunities are scoped to the connected agent.",
      );
    await this.authorize(this.repository, actor, companyId);
    await this.syncOpportunities(actor.context);
    return this.repository.listOpportunities(
      companyId,
      Math.min(100, Math.max(1, limit)),
    );
  }

  async getOpportunity(actor: AutonomyActor, id: string) {
    const value = await this.repository.getOpportunity(z.uuid().parse(id));
    if (!value) throw new NotFoundError("Opportunity");
    await this.authorize(this.repository, actor, value.companyId);
    return value;
  }

  async setOpportunityStatus(
    actor: AutonomyActor,
    id: string,
    status: "CLAIMED" | "DISMISSED",
    key: string,
  ) {
    if (actor.kind !== "agent")
      throw new AuthorizationError(
        "Only the assigned agent may update an opportunity.",
      );
    idempotencyKeySchema.parse(key);
    return this.repository.transaction(async (repository) => {
      const value = await repository.getOpportunity(z.uuid().parse(id));
      if (!value) throw new NotFoundError("Opportunity");
      await this.authorize(repository, actor, value.companyId);
      const claim = await repository.claim(
        this.actorId(actor),
        `autonomy.opportunity.${status.toLowerCase()}`,
        key,
        hash({ id, status }),
      );
      if (claim.replay) return claim.response as Opportunity;
      if (value.status !== "OPEN" && value.status !== status)
        throw new PolicyDeniedError("The opportunity is no longer open.");
      const now = new Date().toISOString();
      const updated: Opportunity = {
        ...value,
        status,
        claimedAt: status === "CLAIMED" ? now : value.claimedAt,
        dismissedAt: status === "DISMISSED" ? now : value.dismissedAt,
      };
      await repository.updateOpportunity(updated);
      await repository.complete(
        this.actorId(actor),
        `autonomy.opportunity.${status.toLowerCase()}`,
        key,
        updated,
      );
      return updated;
    });
  }

  private history(plan: ActionPlan): ActionHistory {
    return {
      id: randomUUID(),
      companyId: plan.companyId,
      agentId: plan.agentId,
      opportunityId: plan.opportunityId,
      planId: plan.id,
      actionType: plan.action.type,
      mandateVersion: plan.mandateVersion,
      policyResult: plan.policyResult,
      riskResult: plan.riskResult,
      executionResult: plan.status,
      transactionReference: plan.transactionReference,
      createdAt: new Date().toISOString(),
    };
  }

  async submitActionPlan(
    actor: AutonomyActor,
    raw: z.input<typeof submitActionPlanSchema>,
    key: string,
  ) {
    if (actor.kind !== "agent")
      throw new AuthorizationError(
        "Only an authenticated agent may submit an action plan.",
      );
    const input = submitActionPlanSchema.parse(raw);
    idempotencyKeySchema.parse(key);
    if (new Date(input.expiresAt) <= new Date())
      throw new PolicyDeniedError("The action plan has expired.");
    await this.authorize(this.repository, actor, input.companyId);
    const inspection = await this.operations.inspect(
      actor.context,
      input.action,
    );
    if (inspection.companyId !== input.companyId)
      throw new AuthorizationError(
        "The action resource belongs to another company.",
      );
    const plan = await this.repository.transaction(async (repository) => {
      await repository.lockCompany(input.companyId);
      const claim = await repository.claim(
        this.actorId(actor),
        "autonomy.action.submitted",
        key,
        hash(input),
      );
      if (claim.replay) {
        const replay = claim.response as ActionPlan;
        return (await repository.getPlan(replay.id)) ?? replay;
      }
      const mandate = await repository.getMandate(input.companyId);
      const heartbeat = await repository.getHeartbeat(
        actor.context.principal.agentId,
      );
      const daily = BigInt(
        await repository.dailyExecutedSpend(input.companyId),
      );
      const reserved = BigInt(
        await repository.activeReservations(input.companyId),
      );
      let policy = this.heartbeatDecision(heartbeat);
      if (policy.result === "ALLOW")
        policy = this.mandateDecision(
          mandate,
          input.action,
          inspection,
          daily + reserved,
        );
      const persistedRisk = await repository.riskStatus(input.companyId);
      const risk =
        inspection.risk.result === "BLOCK"
          ? inspection.risk
          : persistedRisk.state === "BLOCKED" &&
              inspection.financialKind !== "NONE"
            ? block("CIRCUIT_BREAKER", "A financial circuit breaker is active.")
            : allow("RISK_ALLOW", "Current risk controls allow this action.");
      const actionHash = hash(input.action);
      const status =
        policy.result === "BLOCK" || risk.result === "BLOCK"
          ? "BLOCKED"
          : mandate?.mode === "SUPERVISED"
            ? "PENDING_APPROVAL"
            : "EXECUTING";
      const value: ActionPlan = {
        id: randomUUID(),
        companyId: input.companyId,
        agentId: actor.context.principal.agentId,
        credentialId: actor.context.principal.credentialId,
        opportunityId: input.opportunityId,
        action: input.action as AutonomyAction,
        actionHash,
        reasonSummary: input.reasonSummary,
        mandateVersion: mandate?.version ?? 0,
        mode: mandate?.mode ?? "MANUAL",
        status,
        policyResult: policy,
        riskResult: risk,
        financialAmountUsdg: inspection.financialAmountUsdg,
        notionalAmountUsdg: inspection.notionalAmountUsdg,
        transactionReference: null,
        failureCode:
          status === "BLOCKED"
            ? policy.result === "BLOCK"
              ? policy.code
              : risk.code
            : null,
        authSnapshot: actor.context.principal,
        createdAt: new Date().toISOString(),
        expiresAt: input.expiresAt,
        executedAt: null,
      };
      await repository.savePlan(value);
      if (status === "PENDING_APPROVAL") {
        const approval: ActionApproval = {
          id: randomUUID(),
          planId: value.id,
          actionHash,
          status: "PENDING",
          ownerIssuer: null,
          ownerSubject: null,
          decidedAt: null,
          expiresAt: input.expiresAt,
          createdAt: value.createdAt,
        };
        await repository.saveApproval(approval);
      } else if (
        status === "EXECUTING" &&
        BigInt(value.financialAmountUsdg) > 0n
      ) {
        const available = BigInt(
          await this.operations.capitalAvailable(input.companyId),
        );
        if (available < BigInt(value.financialAmountUsdg) + reserved + daily) {
          value.status = "BLOCKED";
          value.riskResult = block(
            "INSUFFICIENT_VERIFIED_CAPITAL",
            "Verified earned capital is insufficient for this action.",
          );
          value.failureCode = value.riskResult.code;
          await repository.savePlan(value);
        } else {
          await repository.reserve(
            value.id,
            value.companyId,
            value.financialAmountUsdg,
            value.expiresAt,
          );
        }
      }
      if (value.status === "BLOCKED")
        await repository.addHistory(this.history(value));
      await repository.complete(
        this.actorId(actor),
        "autonomy.action.submitted",
        key,
        value,
      );
      return value;
    });
    return plan.status === "EXECUTING"
      ? this.executePrepared(plan, `${key}:execute`)
      : plan;
  }

  private async executePrepared(plan: ActionPlan, key: string) {
    let result: { result: unknown; transactionReference: string | null };
    try {
      if (new Date(plan.expiresAt) <= new Date())
        throw new PolicyDeniedError("The action plan has expired.");
      const context = await this.agentContext(plan);
      const heartbeat = await this.effectiveHeartbeat(plan.agentId);
      if (this.heartbeatDecision(heartbeat).result === "BLOCK")
        throw new PolicyDeniedError("The agent is offline or paused.");
      const current = await this.repository.getMandate(plan.companyId);
      if (!current || current.version !== plan.mandateVersion)
        throw new PolicyDeniedError(
          "The owner mandate changed after plan approval.",
        );
      const inspection = await this.operations.inspect(context, plan.action);
      const policy = this.mandateDecision(
        current,
        plan.action,
        inspection,
        BigInt(await this.repository.dailyExecutedSpend(plan.companyId)),
      );
      const persistedRisk = await this.repository.riskStatus(plan.companyId);
      if (
        policy.result === "BLOCK" ||
        inspection.risk.result === "BLOCK" ||
        (inspection.financialKind !== "NONE" &&
          persistedRisk.state === "BLOCKED")
      )
        throw new PolicyDeniedError(
          policy.result === "BLOCK"
            ? policy.summary
            : inspection.risk.result === "BLOCK"
              ? inspection.risk.summary
              : "A financial circuit breaker is active.",
        );
      result = await this.operations.execute(
        context,
        plan.action,
        plan.reasonSummary,
        key,
      );
      plan = {
        ...plan,
        status: "EXECUTED",
        transactionReference: result.transactionReference,
        executedAt: new Date().toISOString(),
      };
      await this.repository.transaction(async (repository) => {
        await repository.savePlan(plan);
        await repository.finishReservation(plan.id, "CONSUMED");
        const approval = await repository.getApproval(plan.id, true);
        if (approval)
          await repository.saveApproval({
            ...approval,
            status: "EXECUTED",
            decidedAt: approval.decidedAt ?? new Date().toISOString(),
          });
        await repository.addHistory(this.history(plan));
      });
      return plan;
    } catch (error) {
      plan = {
        ...plan,
        status: "FAILED",
        failureCode:
          error instanceof PolicyDeniedError ? error.code : "EXECUTION_FAILED",
        executedAt: new Date().toISOString(),
      };
      await this.repository.transaction(async (repository) => {
        await repository.savePlan(plan);
        await repository.finishReservation(plan.id, "RELEASED");
        const approval = await repository.getApproval(plan.id, true);
        if (approval)
          await repository.saveApproval({
            ...approval,
            status: "FAILED",
            decidedAt: approval.decidedAt ?? new Date().toISOString(),
          });
        await repository.addHistory(this.history(plan));
      });
      return plan;
    }
  }

  async decideActionPlan(
    actor: AutonomyActor,
    planId: string,
    decision: "APPROVED" | "REJECTED",
    key: string,
  ) {
    const owner = this.owner(actor);
    idempotencyKeySchema.parse(key);
    const plan = await this.repository.transaction(async (repository) => {
      const current = await repository.getPlan(z.uuid().parse(planId), true);
      if (!current) throw new NotFoundError("Action plan");
      await this.authorize(repository, actor, current.companyId);
      await repository.lockCompany(current.companyId);
      const claim = await repository.claim(
        this.actorId(actor),
        `autonomy.action.${decision.toLowerCase()}`,
        key,
        hash({ planId, decision, actionHash: current.actionHash }),
      );
      if (claim.replay) {
        const replay = claim.response as ActionPlan;
        return (await repository.getPlan(replay.id)) ?? replay;
      }
      const approval = await repository.getApproval(planId, true);
      if (!approval || approval.status !== "PENDING")
        throw new PolicyDeniedError(
          "The action plan is not pending owner approval.",
        );
      if (
        approval.actionHash !== current.actionHash ||
        hash(current.action) !== current.actionHash
      )
        throw new PolicyDeniedError(
          "The exact approved action payload has changed.",
        );
      if (new Date(approval.expiresAt) <= new Date()) {
        const expired = { ...current, status: "EXPIRED" as const };
        await repository.savePlan(expired);
        await repository.saveApproval({ ...approval, status: "EXPIRED" });
        await repository.addHistory(this.history(expired));
        return expired;
      }
      const decidedAt = new Date().toISOString();
      await repository.saveApproval({
        ...approval,
        status: decision,
        ownerIssuer: owner.issuer,
        ownerSubject: owner.subject,
        decidedAt,
      });
      const updated: ActionPlan = {
        ...current,
        status: decision === "APPROVED" ? "EXECUTING" : "REJECTED",
      };
      if (decision === "APPROVED" && BigInt(updated.financialAmountUsdg) > 0n) {
        const reserved = BigInt(
          await repository.activeReservations(updated.companyId),
        );
        const spent = BigInt(
          await repository.dailyExecutedSpend(updated.companyId),
        );
        const available = BigInt(
          await this.operations.capitalAvailable(updated.companyId),
        );
        if (available < BigInt(updated.financialAmountUsdg) + reserved + spent)
          throw new PolicyDeniedError(
            "Verified earned capital is insufficient.",
          );
        await repository.reserve(
          updated.id,
          updated.companyId,
          updated.financialAmountUsdg,
          updated.expiresAt,
        );
      }
      await repository.savePlan(updated);
      if (decision === "REJECTED")
        await repository.addHistory(this.history(updated));
      await repository.complete(
        this.actorId(actor),
        `autonomy.action.${decision.toLowerCase()}`,
        key,
        updated,
      );
      return updated;
    });
    return plan.status === "EXECUTING"
      ? this.executePrepared(plan, `${key}:execute`)
      : plan;
  }

  async getActionPlan(actor: AutonomyActor, id: string) {
    const plan = await this.repository.getPlan(z.uuid().parse(id));
    if (!plan) throw new NotFoundError("Action plan");
    await this.authorize(this.repository, actor, plan.companyId);
    return plan;
  }

  async getPendingApprovals(actor: AutonomyActor, companyId: string) {
    this.owner(actor);
    await this.authorize(this.repository, actor, companyId);
    return this.repository.listPendingApprovals(companyId);
  }

  async getActionHistory(actor: AutonomyActor, companyId: string, limit = 50) {
    await this.authorize(this.repository, actor, companyId);
    return this.repository.listHistory(
      companyId,
      Math.min(100, Math.max(1, limit)),
    );
  }

  async getTreasury(actor: AutonomyActor, companyId: string) {
    await this.authorize(this.repository, actor, companyId);
    return this.operations.treasury(actor, companyId);
  }

  async getCapitalSources(actor: AutonomyActor, companyId: string) {
    await this.authorize(this.repository, actor, companyId);
    return this.operations.capitalSources(actor, companyId);
  }

  async getRiskStatus(actor: AutonomyActor, companyId: string) {
    await this.authorize(this.repository, actor, companyId);
    const [persisted, live] = await Promise.all([
      this.repository.riskStatus(companyId),
      this.operations.riskStatus(actor, companyId),
    ]);
    return {
      companyId,
      state:
        persisted.state === "BLOCKED" || live.state === "BLOCKED"
          ? ("BLOCKED" as const)
          : ("CLEAR" as const),
      circuitBreakers: [...persisted.circuitBreakers, ...live.circuitBreakers],
      checkedAt: new Date().toISOString(),
    };
  }
}
