import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AutonomyService,
  type ActionInspection,
  type AutonomyAction,
  type AutonomyOperationsPort,
  type AutonomyRiskStatus,
  type FinancialActor,
  type OpportunityCandidate,
  type OwnerMandate,
  type RequestContext,
} from "@normic/core";
import { PostgresAutonomyRepository } from "@normic/db";
import {
  TEST_ISSUER,
  createCredential,
  createIdentity,
  createTestRuntime,
} from "../support/runtime.js";

class IsolatedOperations implements AutonomyOperationsPort {
  capital = 10_000_000n;
  amount = 8_000_000n;
  blocked = false;
  executions = 0;
  companyId = "";

  async inspect(
    _context: RequestContext,
    action: AutonomyAction,
  ): Promise<ActionInspection> {
    return {
      companyId: this.companyId,
      financialAmountUsdg:
        action.type === "BUY_AGENT_SERVICE" ? this.amount.toString() : "0",
      notionalAmountUsdg:
        action.type === "BUY_AGENT_SERVICE" ? this.amount.toString() : "0",
      financialKind:
        action.type === "BUY_AGENT_SERVICE" ? "SERVICE_BUY" : "NONE",
      stockTokenId: null,
      providerCompanyId: crypto.randomUUID(),
      cashBalanceUsdg: this.capital.toString(),
      dailyInvestmentUsdg: "0",
      stockExposureUsdg: "0",
      risk: this.blocked
        ? {
            result: "BLOCK",
            code: "ISOLATED_RISK_BLOCK",
            summary: "The isolated risk engine blocked the action.",
          }
        : {
            result: "ALLOW",
            code: "ISOLATED_RISK_ALLOW",
            summary: "The isolated risk engine allowed the action.",
          },
    };
  }
  async execute() {
    this.executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      result: { status: "submitted" },
      transactionReference: `operation-${this.executions}`,
    };
  }
  async opportunities(): Promise<OpportunityCandidate[]> {
    return [];
  }
  async treasury() {
    return { state: "available", source: "isolated-test" };
  }
  async capitalSources() {
    return {
      availableUsdg: this.capital.toString(),
      ownerCapitalUsdg: "100000000",
      ownerCapitalInvestable: false,
    };
  }
  async capitalAvailable() {
    return this.capital.toString();
  }
  async riskStatus(
    _actor: FinancialActor,
    companyId: string,
  ): Promise<AutonomyRiskStatus> {
    return {
      companyId,
      state: this.blocked ? "BLOCKED" : "CLEAR",
      circuitBreakers: [],
      checkedAt: new Date().toISOString(),
    };
  }
}

describe("Phase 6 autonomous operations", () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  let repository: PostgresAutonomyRepository;
  let operations: IsolatedOperations;
  let autonomy: AutonomyService;
  let identity: Awaited<ReturnType<typeof createIdentity>>;
  let agent: FinancialActor;
  let owner: FinancialActor;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    repository = new PostgresAutonomyRepository(runtime.database);
    operations = new IsolatedOperations();
    autonomy = new AutonomyService(repository, operations);
    identity = await createIdentity(runtime.repository, "autonomy6");
    const credential = await createCredential(
      runtime.repository,
      identity.agentId,
      "nmc_test_phase6_autonomy",
    );
    identity.context.principal.credentialId = credential.id;
    operations.companyId = identity.companyId;
    await runtime.database.query(
      "UPDATE users SET auth_issuer=$2,auth_subject=$3 WHERE id=$1",
      [identity.userId, TEST_ISSUER, `owner-${identity.userId}`],
    );
    agent = { kind: "agent", context: identity.context };
    owner = {
      kind: "owner",
      owner: {
        issuer: TEST_ISSUER,
        subject: `owner-${identity.userId}`,
        email: "owner@example.com",
      },
    };
  });

  afterEach(async () => runtime.database.close());

  function mandate(
    mode: OwnerMandate["mode"],
    overrides: Partial<Parameters<AutonomyService["updateMandate"]>[1]> = {},
  ) {
    return {
      companyId: identity.companyId,
      mode,
      allowServiceOperations: true,
      allowServiceBuying: true,
      maxServiceSpendUsdg: "10000000",
      allowStockTokenTrading: false,
      maxTradeUsdg: null,
      maxDailyInvestmentUsdg: null,
      maxStockTokenExposureUsdg: null,
      minimumCashReserveUsdg: null,
      allowedStockTokenIds: [],
      maxTotalDailySpendUsdg: "100000000",
      sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      killSwitches: {
        pauseAll: false,
        pauseTrading: false,
        pauseServiceBuying: false,
        pauseJobAcceptance: false,
      },
      ...overrides,
    };
  }

  async function configure(mode: OwnerMandate["mode"], suffix: string) {
    const value = await autonomy.updateMandate(
      owner,
      mandate(mode),
      `mandate-${suffix}`,
    );
    await autonomy.heartbeat(
      agent,
      {
        companyId: identity.companyId,
        sessionId: `session-${suffix}`,
        status: "ONLINE",
        currentJobId: null,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
      `heartbeat-${suffix}`,
    );
    return value;
  }

  const action = () => ({
    type: "BUY_AGENT_SERVICE" as const,
    input: { serviceId: crypto.randomUUID(), input: { objective: "real job" } },
  });

  const plan = (_suffix: string) => ({
    companyId: identity.companyId,
    opportunityId: null,
    action: action(),
    reasonSummary: "Purchase a bounded service under the exact owner mandate.",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });

  it("rejects agent autonomy increases and lets the owner enable or pause", async () => {
    await expect(
      autonomy.updateMandate(agent, mandate("AUTONOMOUS"), "agent-enable-mode"),
    ).rejects.toThrow(/verified human owner/i);
    const enabled = await configure("AUTONOMOUS", "owner-enable");
    expect(enabled.mode).toBe("AUTONOMOUS");
    const paused = await autonomy.pauseAutonomy(
      owner,
      identity.companyId,
      "owner-pause-mode",
    );
    expect(paused).toMatchObject({
      mode: "MANUAL",
      killSwitches: { pauseAll: true },
    });
  });

  it("binds supervised approval to the exact immutable action payload", async () => {
    await configure("SUPERVISED", "supervised");
    const pending = await autonomy.submitActionPlan(
      agent,
      plan("supervised"),
      "submit-supervised",
    );
    expect(pending.status).toBe("PENDING_APPROVAL");
    await expect(
      repository.savePlan({
        ...pending,
        action: {
          type: "BUY_AGENT_SERVICE",
          input: { serviceId: crypto.randomUUID(), input: {} },
        },
      }),
    ).rejects.toThrow(/approved action identity is immutable/i);
    const approved = await autonomy.decideActionPlan(
      owner,
      pending.id,
      "APPROVED",
      "approve-exact-supervised",
    );
    expect(approved.status).toBe("EXECUTED");
    expect(operations.executions).toBe(1);
  });

  it("blocks RiskEngine decisions and active kill switches", async () => {
    await configure("AUTONOMOUS", "risk");
    operations.blocked = true;
    const riskBlocked = await autonomy.submitActionPlan(
      agent,
      plan("risk"),
      "submit-risk-block",
    );
    expect(riskBlocked).toMatchObject({
      status: "BLOCKED",
      riskResult: { result: "BLOCK", code: "ISOLATED_RISK_BLOCK" },
    });
    expect(operations.executions).toBe(0);
    operations.blocked = false;
    await autonomy.updateMandate(
      owner,
      mandate("AUTONOMOUS", {
        killSwitches: {
          pauseAll: false,
          pauseTrading: false,
          pauseServiceBuying: true,
          pauseJobAcceptance: false,
        },
      }),
      "enable-service-kill-switch",
    );
    const killed = await autonomy.submitActionPlan(
      agent,
      plan("kill"),
      "submit-kill-switch",
    );
    expect(killed).toMatchObject({
      status: "BLOCKED",
      policyResult: { code: "SERVICE_BUYING_PAUSED" },
    });
  });

  it("serializes concurrent spending so only one eight-unit action uses ten units", async () => {
    await configure("AUTONOMOUS", "concurrency");
    const results = await Promise.all([
      autonomy.submitActionPlan(agent, plan("one"), "concurrent-action-one"),
      autonomy.submitActionPlan(agent, plan("two"), "concurrent-action-two"),
    ]);
    expect(results.map((value) => value.status).sort()).toEqual([
      "BLOCKED",
      "EXECUTED",
    ]);
    expect(operations.executions).toBe(1);
  });

  it("keeps owner capital non-investable and permits verified earned capital", async () => {
    await configure("AUTONOMOUS", "provenance");
    operations.capital = 0n;
    const ownerOnly = await autonomy.submitActionPlan(
      agent,
      plan("owner-capital"),
      "owner-capital-blocked",
    );
    expect(ownerOnly).toMatchObject({
      status: "BLOCKED",
      riskResult: { code: "INSUFFICIENT_VERIFIED_CAPITAL" },
    });
    operations.capital = 10_000_000n;
    const earned = await autonomy.submitActionPlan(
      agent,
      plan("earned-capital"),
      "earned-capital-allowed",
    );
    expect(earned.status).toBe("EXECUTED");
  });

  it("fails closed when the heartbeat session is expired", async () => {
    await configure("AUTONOMOUS", "offline");
    await repository.saveHeartbeat({
      agentId: identity.agentId,
      companyId: identity.companyId,
      sessionId: "expired-session",
      status: "ONLINE",
      currentJobId: null,
      connectedAt: new Date(Date.now() - 120_000).toISOString(),
      lastHeartbeatAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const offline = await autonomy.submitActionPlan(
      agent,
      plan("offline"),
      "offline-action-blocked",
    );
    expect(offline).toMatchObject({
      status: "BLOCKED",
      policyResult: { code: "AGENT_OFFLINE" },
    });
    expect(operations.executions).toBe(0);
  });
});
