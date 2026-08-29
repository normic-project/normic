import { createHash } from "node:crypto";
import { decimalToUnits } from "./finance-protocol.js";
import type { FinancialService } from "./finance.js";
import type { FinancialActor } from "./finance-types.js";
import type { NormicEconomy } from "./economy.js";
import type { EconomyRepository } from "./repository.js";
import type { NormicServiceNetwork } from "./service-network.js";
import { stockValueInUsdg, type TradingService } from "./trading.js";
import type {
  ActionInspection,
  AutonomyAction,
  AutonomyOperationsPort,
  AutonomyRiskStatus,
  ControlDecision,
  OpportunityCandidate,
} from "./autonomy-types.js";
import type { RequestContext } from "./types.js";
import { NotFoundError, PolicyDeniedError } from "./errors.js";

const allow = (): ControlDecision => ({
  result: "ALLOW",
  code: "EXISTING_CONTROLS_READY",
  summary: "The existing operation-specific controls are available.",
});
const block = (code: string, summary: string): ControlDecision => ({
  result: "BLOCK",
  code,
  summary,
});
const fingerprint = (...values: string[]) =>
  createHash("sha256").update(values.join("|")).digest("hex");

export class NormicAutonomyOperations implements AutonomyOperationsPort {
  constructor(
    readonly economy: NormicEconomy,
    readonly economyRepository: EconomyRepository,
    readonly services: NormicServiceNetwork,
    readonly finance: FinancialService,
    readonly trading: TradingService,
  ) {}

  private async agent(context: RequestContext) {
    const agent = await this.economyRepository.getAgent(
      context.principal.agentId,
    );
    if (!agent) throw new NotFoundError("Agent");
    return agent;
  }

  private async broadcastPrepared(
    context: RequestContext,
    prepared: { operation: { id: string } },
    key: string,
  ) {
    const actor = { kind: "agent" as const, context };
    await this.finance.simulate(
      actor,
      prepared.operation.id,
      `${key}:simulate`,
    );
    return this.finance.execute(
      actor,
      prepared.operation.id,
      `${key}:broadcast`,
    );
  }

  async inspect(
    context: RequestContext,
    action: AutonomyAction,
  ): Promise<ActionInspection> {
    const agent = await this.agent(context);
    let companyId = agent.companyId,
      amount = "0",
      notional = "0",
      financialKind: ActionInspection["financialKind"] = "NONE",
      stockTokenId: string | null = null,
      providerCompanyId: string | null = null,
      risk = allow(),
      cashBalanceUsdg: string | null = null,
      dailyInvestmentUsdg = "0",
      stockExposureUsdg = "0";

    if (action.type === "CREATE_SERVICE") companyId = action.input.companyId;
    if (action.type === "UPDATE_SERVICE") {
      const service = await this.economyRepository.getService(
        action.input.serviceId,
      );
      if (!service) throw new NotFoundError("Service");
      companyId = service.companyId;
    }
    if (
      action.type === "ACCEPT_JOB" ||
      action.type === "START_JOB" ||
      action.type === "SUBMIT_RESULT"
    ) {
      const jobId =
        action.type === "SUBMIT_RESULT" ? action.input.jobId : action.jobId;
      const job = await this.economyRepository.getJob(jobId);
      const paid = job
        ? null
        : await this.finance.repository.getInvocation(jobId);
      const provider = job
        ? await this.economyRepository.getAgent(job.providerAgentId)
        : paid
          ? await this.economyRepository.getAgent(paid.providerAgentId)
          : null;
      if (!provider) throw new NotFoundError("Job");
      companyId = provider.companyId;
    }
    if (action.type === "BUY_AGENT_SERVICE") {
      const service = await this.economyRepository.getService(
        action.input.serviceId,
      );
      if (!service || service.status !== "active")
        throw new NotFoundError("Active service");
      providerCompanyId = service.companyId;
      if (providerCompanyId === companyId)
        throw new PolicyDeniedError(
          "A company cannot autonomously buy its own service.",
        );
      if (
        service.pricingModel !== "fixed" ||
        service.quotedCurrency !== "USDG" ||
        !service.quotedPrice
      )
        risk = block(
          "SERVICE_PRICE_UNAVAILABLE",
          "Autonomous service purchases require a fixed USDG price.",
        );
      else amount = decimalToUnits(service.quotedPrice, 6);
      notional = amount;
      financialKind = "SERVICE_BUY";
      const capability = this.finance.capabilities();
      if (capability.state !== "ready" || !capability.autonomousExecution)
        risk = block(
          "PAYMENT_PROVIDER_UNAVAILABLE",
          "The verified autonomous USDG payment path is unavailable.",
        );
      const balance = await this.finance.getBalance(
        { kind: "agent", context },
        companyId,
      );
      cashBalanceUsdg =
        balance.state === "available" ? balance.usdg.units : null;
    }
    if (
      action.type === "BUY_STOCK_TOKEN" ||
      action.type === "SELL_STOCK_TOKEN"
    ) {
      const quote = await this.trading.repository.getQuote(action.quoteId);
      if (!quote) throw new NotFoundError("Trade quote");
      if (quote.side !== (action.type === "BUY_STOCK_TOKEN" ? "BUY" : "SELL"))
        throw new PolicyDeniedError(
          "The action side does not match the immutable quote.",
        );
      companyId = quote.companyId;
      amount = quote.side === "BUY" ? quote.amountIn : "0";
      notional =
        quote.side === "BUY" ? quote.amountIn : quote.expectedAmountOut;
      financialKind = quote.side === "BUY" ? "STOCK_BUY" : "STOCK_SELL";
      stockTokenId = quote.asset.assetId;
      const capability = this.trading.capabilities();
      if (capability.state !== "ready")
        risk = block(
          "TRADING_PROVIDER_UNAVAILABLE",
          "The complete verified Phase 5 trading path is unavailable.",
        );
      const [portfolio, daily] = await Promise.all([
        this.trading.getPortfolio({ kind: "agent", context }, companyId),
        this.trading.repository.dailyInvestment(companyId),
      ]);
      dailyInvestmentUsdg = daily;
      if (portfolio.state === "available") {
        cashBalanceUsdg = portfolio.usdgCash;
        stockExposureUsdg = portfolio.stockValueUsdg;
        if (quote.side === "BUY") {
          const usdg = await this.trading.assets.canonicalUsdg();
          stockExposureUsdg = (
            BigInt(stockExposureUsdg) +
            BigInt(
              stockValueInUsdg(
                quote.expectedAmountOut,
                quote.asset.decimals,
                quote.oracle,
                usdg.decimals,
              ),
            )
          ).toString();
        }
        if (portfolio.positions.some((position) => !position.reconciled))
          risk = block(
            "WALLET_RECONCILIATION",
            "The verified onchain portfolio does not reconcile with finalized lots.",
          );
      } else {
        risk = block(
          "WALLET_RECONCILIATION",
          "Verified portfolio reconciliation is unavailable.",
        );
      }
    }

    return {
      companyId,
      financialAmountUsdg: amount,
      notionalAmountUsdg: notional,
      financialKind,
      stockTokenId,
      providerCompanyId,
      cashBalanceUsdg,
      dailyInvestmentUsdg,
      stockExposureUsdg,
      risk,
    };
  }

  async execute(
    context: RequestContext,
    action: AutonomyAction,
    reasonSummary: string,
    key: string,
  ) {
    let result: unknown;
    switch (action.type) {
      case "CREATE_SERVICE":
        result = await this.economy.createService(context, action.input, key);
        break;
      case "UPDATE_SERVICE":
        result = await this.economy.updateService(context, action.input, key);
        break;
      case "ACCEPT_JOB":
        result = await this.services.action(
          context,
          action.jobId,
          "accept",
          key,
        );
        if (result && typeof result === "object" && "operation" in result)
          result = await this.broadcastPrepared(
            context,
            result as { operation: { id: string } },
            key,
          );
        break;
      case "START_JOB":
        result = await this.services.action(
          context,
          action.jobId,
          "start",
          key,
        );
        break;
      case "SUBMIT_RESULT":
        result = await this.services.submit(context, action.input, key);
        if (
          result &&
          typeof result === "object" &&
          "requiresOnchainSubmission" in result
        ) {
          const prepared = await this.finance.prepare(
            { kind: "agent", context },
            action.input.jobId,
            "submit",
            `${key}:prepare`,
          );
          result = await this.broadcastPrepared(context, prepared, key);
        }
        break;
      case "BUY_AGENT_SERVICE": {
        const invocation = await this.services.request(
          context,
          action.input,
          `${key}:request`,
        );
        if (!("terms" in invocation)) {
          result = invocation;
          break;
        }
        const prepared = await this.finance.prepare(
          { kind: "agent", context },
          invocation.id,
          "fund",
          `${key}:prepare`,
        );
        result = await this.broadcastPrepared(context, prepared, key);
        break;
      }
      case "BUY_STOCK_TOKEN":
      case "SELL_STOCK_TOKEN":
        result = await this.trading.execute(
          { kind: "agent", context },
          action.quoteId,
          {
            objective: "Execute an owner-mandated autonomous operation",
            reasonSummary,
            riskChecks: [
              "Phase 6 mandate and heartbeat",
              "Phase 5 eligibility, provenance, policy, oracle, venue, simulation, and wallet controls",
            ],
          },
          action.type === "BUY_STOCK_TOKEN" ? "BUY" : "SELL",
          key,
        );
        break;
      case "NO_ACTION":
        result = { action: "NO_ACTION", recorded: true };
        break;
    }
    const record = result as Record<string, unknown>;
    const reference = [
      record.transactionHash,
      record.providerCallId,
      record.operationId,
      record.id,
    ].find((value): value is string => typeof value === "string");
    return { result, transactionReference: reference ?? null };
  }

  async opportunities(
    context: RequestContext,
  ): Promise<OpportunityCandidate[]> {
    const agent = await this.agent(context);
    const [jobs, paid, capital] = await Promise.all([
      this.economyRepository.listJobs({
        providerAgentId: agent.id,
        status: "created",
        limit: 100,
      }),
      this.finance.repository.listInvocations({ providerAgentId: agent.id }),
      this.trading.repository.capital(agent.companyId),
    ]);
    const candidates: OpportunityCandidate[] = jobs.map((job) => ({
      companyId: agent.companyId,
      agentId: agent.id,
      kind: "AVAILABLE_SERVICE_JOB",
      sourceType: "service_job",
      sourceId: job.id,
      fingerprint: fingerprint("job", job.id, job.status),
      title: "Service job available",
      summary: "A real assigned Normic service job is ready for review.",
      priority: "HIGH",
      data: { jobId: job.id, status: job.status },
      expiresAt: null,
    }));
    for (const invocation of paid.filter((value) => value.state === "RELEASED"))
      candidates.push({
        companyId: agent.companyId,
        agentId: agent.id,
        kind: "COMPLETED_PAYMENT",
        sourceType: "paid_invocation",
        sourceId: invocation.id,
        fingerprint: fingerprint("payment", invocation.id, invocation.state),
        title: "Service payment completed",
        summary: "A finalized USDG service payment was released.",
        priority: "MEDIUM",
        data: { invocationId: invocation.id, state: invocation.state },
        expiresAt: null,
      });
    if (BigInt(capital.availableUsdg) > 0n)
      candidates.push({
        companyId: agent.companyId,
        agentId: agent.id,
        kind: "INVESTABLE_CAPITAL",
        sourceType: "verified_capital_projection",
        sourceId: agent.companyId,
        fingerprint: fingerprint(
          "capital",
          agent.companyId,
          capital.availableUsdg,
        ),
        title: "Verified earned capital available",
        summary:
          "Finalized earned-capital lineage has a positive investable balance.",
        priority: "MEDIUM",
        data: {
          availableUsdg: capital.availableUsdg,
          source: capital.source,
        },
        expiresAt: null,
      });
    return candidates;
  }

  async treasury(actor: FinancialActor, companyId: string) {
    const [balance, summary, portfolio] = await Promise.all([
      this.finance.getBalance(actor, companyId),
      this.finance.getSummary(actor, companyId),
      this.trading.getPortfolio(actor, companyId),
    ]);
    return { companyId, balance, accounting: summary, portfolio };
  }

  async capitalSources(actor: FinancialActor, companyId: string) {
    const investable = await this.trading.getInvestableCapital(
      actor,
      companyId,
    );
    const excluded = await this.trading.repository.capitalSources(companyId);
    return {
      ...investable,
      ...excluded,
      ownerCapitalInvestable: false,
      externalTransfersInvestable: false,
      unattributedTransfersInvestable: false,
    };
  }

  async capitalAvailable(companyId: string) {
    return (await this.trading.repository.capital(companyId)).availableUsdg;
  }

  async riskStatus(
    actor: FinancialActor,
    companyId: string,
  ): Promise<AutonomyRiskStatus> {
    const breakers: AutonomyRiskStatus["circuitBreakers"] = [];
    const tradingPolicy = await this.trading.getPolicy(actor, companyId);
    if (
      tradingPolicy.eligibility.state !== "ELIGIBLE" ||
      (tradingPolicy.eligibility.expiresAt &&
        new Date(tradingPolicy.eligibility.expiresAt) <= new Date())
    )
      breakers.push({
        code: "ELIGIBILITY",
        active: true,
        reason: "Owner trading eligibility is invalid or expired.",
        triggeredAt: new Date().toISOString(),
      });
    if (
      !tradingPolicy.session ||
      tradingPolicy.session.revokedAt ||
      new Date(tradingPolicy.session.expiresAt) <= new Date()
    )
      breakers.push({
        code: "SESSION",
        active: true,
        reason: "The owner-authorized trading session is invalid or expired.",
        triggeredAt: new Date().toISOString(),
      });
    const portfolio = await this.trading.getPortfolio(actor, companyId);
    if (
      portfolio.state !== "available" ||
      portfolio.positions.some((position) => !position.reconciled)
    )
      breakers.push({
        code: "WALLET_RECONCILIATION",
        active: true,
        reason:
          "Wallet and portfolio reconciliation is unavailable or discrepant.",
        triggeredAt: new Date().toISOString(),
      });
    if (this.trading.capabilities().state !== "ready")
      breakers.push({
        code: "PROVIDER",
        active: true,
        reason: "One or more verified trading providers are unavailable.",
        triggeredAt: new Date().toISOString(),
      });
    return {
      companyId,
      state: breakers.length ? "BLOCKED" : "CLEAR",
      circuitBreakers: breakers,
      checkedAt: new Date().toISOString(),
    };
  }
}
