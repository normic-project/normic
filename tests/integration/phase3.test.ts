import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApiCredentialAuthenticator,
  AuthenticationError,
  AuthorizationError,
  IdempotencyConflictError,
} from "@normic/core";
import {
  TEST_AUDIENCE,
  TEST_ISSUER,
  createCredential,
  createIdentity,
  createTestRuntime,
  serviceInput,
} from "../support/runtime.js";

describe("Phase 3 persistent service network", () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  let provider: Awaited<ReturnType<typeof createIdentity>>;
  let buyer: Awaited<ReturnType<typeof createIdentity>>;
  let outsider: Awaited<ReturnType<typeof createIdentity>>;
  beforeEach(async () => {
    runtime = await createTestRuntime();
    provider = await createIdentity(runtime.repository, "provider");
    buyer = await createIdentity(runtime.repository, "buyer");
    outsider = await createIdentity(runtime.repository, "outsider");
  });
  afterEach(async () => runtime.database.close());

  it("denies cross-company and cross-invocation IDOR access", async () => {
    await expect(
      runtime.economy.getCompany(provider.context, buyer.companyId),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const service = await runtime.economy.createService(
      provider.context,
      serviceInput(provider.companyId, "idor"),
      "service-idor-key",
    );
    const view = await runtime.economy.requestService(
      buyer.context,
      { serviceId: service.id, input: { request: "private" } },
      "request-idor-key",
    );
    await expect(
      runtime.economy.getInvocation(outsider.context, view.invocation.id),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("denies revoked, expired, and insufficiently scoped credentials", async () => {
    const auth = new ApiCredentialAuthenticator(runtime.repository, {
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });
    const revoked = "nmc_test_revoked_secret",
      expired = "nmc_test_expired_secret",
      scoped = "nmc_test_scoped_secret";
    await createCredential(runtime.repository, provider.agentId, revoked, {
      revokedAt: new Date(),
    });
    await createCredential(runtime.repository, provider.agentId, expired, {
      expiresAt: new Date(Date.now() - 1000),
    });
    await createCredential(runtime.repository, provider.agentId, scoped, {
      scopes: ["services:read"],
    });
    await expect(auth.authenticate(revoked)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    await expect(auth.authenticate(expired)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    const principal = await auth.authenticate(scoped);
    await expect(
      runtime.economy.createService(
        { principal },
        serviceInput(provider.companyId, "denied"),
        "scope-denied-key",
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("allows valid scopes and protects idempotency including payload conflicts", async () => {
    const first = await runtime.economy.createService(
      provider.context,
      serviceInput(provider.companyId, "idempotent"),
      "service-repeat-key",
    );
    const replay = await runtime.economy.createService(
      provider.context,
      serviceInput(provider.companyId, "idempotent"),
      "service-repeat-key",
    );
    expect(replay.id).toBe(first.id);
    await expect(
      runtime.economy.createService(
        provider.context,
        serviceInput(provider.companyId, "changed"),
        "service-repeat-key",
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("serializes a concurrent duplicate mutation into one service", async () => {
    const values = await Promise.allSettled([
      runtime.economy.createService(
        provider.context,
        serviceInput(provider.companyId, "race"),
        "concurrent-service-key",
      ),
      runtime.economy.createService(
        provider.context,
        serviceInput(provider.companyId, "race"),
        "concurrent-service-key",
      ),
    ]);
    const ids = values
      .filter(
        (
          value,
        ): value is PromiseFulfilledResult<
          Awaited<ReturnType<typeof runtime.economy.createService>>
        > => value.status === "fulfilled",
      )
      .map((value) => value.value.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(1);
    expect(
      (
        await runtime.repository.listServices({ companyId: provider.companyId })
      ).filter((service) => service.slug === "service-race"),
    ).toHaveLength(1);
  });

  it("completes the agent-to-agent lifecycle without financial side effects", async () => {
    const service = await runtime.economy.createService(
      provider.context,
      serviceInput(provider.companyId, "lifecycle"),
      "service-lifecycle-key",
    );
    const requested = await runtime.economy.requestService(
      buyer.context,
      { serviceId: service.id, input: { request: "prepare report" } },
      "request-lifecycle-key",
    );
    await runtime.economy.acceptJob(
      provider.context,
      requested.job.id,
      "accept-lifecycle-key",
    );
    await runtime.economy.startJob(
      provider.context,
      requested.job.id,
      "start-lifecycle-key",
    );
    const completed = await runtime.economy.submitResult(
      provider.context,
      { jobId: requested.job.id, output: { answer: "complete" } },
      "result-lifecycle-key",
    );
    expect(completed.invocation.status).toBe("completed");
    expect(completed.result?.output).toEqual({ answer: "complete" });
    expect(await runtime.repository.getMetrics(provider.companyId)).toEqual({
      revenueCents: 0,
      expensesCents: 0,
      pnlCents: 0,
      cashCents: 0,
      assetsCents: 0,
      liabilitiesCents: 0,
      netWorthCents: 0,
    });
    const [{ count: transactions }, { count: entries }] = await Promise.all([
      runtime.database.query<{ count: number }>(
        "SELECT count(*)::int count FROM transactions",
      ),
      runtime.database.query<{ count: number }>(
        "SELECT count(*)::int count FROM ledger_entries",
      ),
    ]).then(([a, b]) => [a[0]!, b[0]!]);
    expect(transactions).toBe(0);
    expect(entries).toBe(0);
    await expect(
      runtime.database.query(
        "UPDATE service_results SET output='{}'::jsonb WHERE id=$1",
        [completed.result!.id],
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it("enforces invalid transitions, provider ownership, failure, and buyer cancellation", async () => {
    const service = await runtime.economy.createService(
      provider.context,
      serviceInput(provider.companyId, "states"),
      "service-states-key",
    );
    const first = await runtime.economy.requestService(
      buyer.context,
      { serviceId: service.id, input: {} },
      "request-state-one",
    );
    await expect(
      runtime.economy.acceptJob(
        outsider.context,
        first.job.id,
        "outsider-accept-key",
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await runtime.economy.acceptJob(
      provider.context,
      first.job.id,
      "provider-accept-key",
    );
    const cancelled = await runtime.economy.cancelInvocation(
      buyer.context,
      { invocationId: first.invocation.id, reason: "No longer needed" },
      "buyer-cancel-key",
    );
    expect(cancelled.job.status).toBe("cancelled");
    const second = await runtime.economy.requestService(
      buyer.context,
      { serviceId: service.id, input: {} },
      "request-state-two",
    );
    await runtime.economy.acceptJob(
      provider.context,
      second.job.id,
      "accept-state-two",
    );
    await runtime.economy.startJob(
      provider.context,
      second.job.id,
      "start-state-two",
    );
    const failed = await runtime.economy.failJob(
      provider.context,
      { jobId: second.job.id, failureReason: "Upstream source unavailable" },
      "fail-state-two",
    );
    expect(failed.invocation.status).toBe("failed");
  });

  it("creates redacted audit events and never records service payloads in activity metadata", async () => {
    const service = await runtime.economy.createService(
      provider.context,
      serviceInput(provider.companyId, "audit"),
      "service-audit-key",
    );
    await runtime.economy.requestService(
      buyer.context,
      { serviceId: service.id, input: { secret: "DO_NOT_LOG" } },
      "request-audit-key",
    );
    const serialized =
      JSON.stringify(await runtime.repository.listAuditEvents({ limit: 100 })) +
      JSON.stringify(await runtime.repository.listActivities({ limit: 100 }));
    expect(serialized).not.toContain("DO_NOT_LOG");
    expect(serialized).toContain("service.requested");
  });

  it("bootstraps once, stores only a hash, and never replays the raw credential", async () => {
    const input = {
      creatorEmail: `owner-${crypto.randomUUID()}@example.com`,
      creatorName: "Owner Name",
      agentName: "Bootstrap Agent",
      handle: `bootstrap_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
      framework: "custom" as const,
      companyName: "Bootstrap Company",
      companySlug: `bootstrap-${crypto.randomUUID()}`,
      description: "A real company created through the onboarding flow.",
      industry: "Agent services",
      website: null,
      credentialLabel: "Primary credential",
    };
    const first = await runtime.economy.bootstrapAgent(
      input,
      "bootstrap-once-key",
    );
    const replay = await runtime.economy.bootstrapAgent(
      input,
      "bootstrap-once-key",
    );
    expect(first.secret).toMatch(/^nmc_test_/);
    expect(replay).toMatchObject({ secret: null, secretShown: false });
    const rows = await runtime.database.query<{ secret_hash: string }>(
      "SELECT secret_hash FROM api_credentials WHERE id=$1",
      [first.credential.id],
    );
    expect(rows[0]?.secret_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(first.secret!);
  });
});
