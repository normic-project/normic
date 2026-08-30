import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApiCredentialAuthenticator,
  AuthorizationError,
  IdempotencyConflictError,
  PolicyDeniedError,
  OAuthAgentAuthenticator,
  OAuthTokenVerifier,
} from "@normic/core";
import {
  createCredential,
  createIdentity,
  createTestRuntime,
  serviceInput,
  TEST_ISSUER,
  TEST_AUDIENCE,
} from "../support/runtime.js";

describe("Phase 3 authorization, agreements, and operational truth", () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  let provider: Awaited<ReturnType<typeof createIdentity>>;
  let buyer: Awaited<ReturnType<typeof createIdentity>>;
  beforeEach(async () => {
    runtime = await createTestRuntime();
    provider = await createIdentity(runtime.repository, "provider");
    buyer = await createIdentity(runtime.repository, "buyer");
  });
  afterEach(async () => runtime.database.close());

  it("renders an empty network from the database without inventing jobs or balances", async () => {
    expect(await runtime.economy.discoverServices({})).toEqual({
      items: [],
      nextCursor: null,
    });
    const ranking = await runtime.economy.getPublicLeaderboard();
    expect(
      ranking.every(
        (entry) =>
          entry.operations.totalJobs === 0 &&
          entry.operations.jobsCompleted === 0,
      ),
    ).toBe(true);
    expect(
      ranking.every((entry) => !("treasury" in entry) && !("metrics" in entry)),
    ).toBe(true);
  });

  it("registers another owned agent with a one-time scoped credential", async () => {
    const input = {
      creatorEmail: "unused-profile-email@example.com",
      creatorName: "Existing owner",
      agentName: "Second agent",
      handle: "second_agent",
      framework: "custom" as const,
      companyName: "Second company",
      companySlug: "second-company",
      description: "Another real identity under the same authenticated owner.",
      industry: "Services",
    };
    const registration = await runtime.economy.registerAgent(
      provider.context,
      input,
      "second-agent-key",
    );
    expect(registration.company.ownerUserId).toBe(provider.userId);
    const auth = new ApiCredentialAuthenticator(runtime.repository, {
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });
    expect((await auth.authenticate(registration.secret)).agentId).toBe(
      registration.agent.id,
    );
    const replay = await runtime.economy.registerAgent(
      provider.context,
      input,
      "second-agent-key",
    );
    expect(replay.secret).toBeNull();
    expect(replay.agent.createdAt).toBeInstanceOf(Date);
    expect(
      JSON.stringify(
        await runtime.database.query(
          "SELECT response_json FROM idempotency_records",
        ),
      ),
    ).not.toContain(registration.secret!);
  });

  it("binds multiple onboarded agents to the same verified human identity", async () => {
    const owner = {
      issuer: TEST_ISSUER,
      subject: "verified-human-1",
      email: "human@example.com",
    };
    const input = {
      creatorEmail: owner.email,
      creatorName: "Verified human",
      agentName: "First agent",
      handle: "human_first",
      framework: "custom" as const,
      companyName: "First company",
      companySlug: "human-first",
      description: "Registered through a verified owner session.",
      industry: "Services",
    };
    const first = await runtime.economy.bootstrapAgent(
      input,
      "human-first-key",
      owner,
    );
    const second = await runtime.economy.bootstrapAgent(
      { ...input, handle: "human_second", companySlug: "human-second" },
      "human-second-key",
      owner,
    );
    expect(first.identity.company.ownerUserId).toBe(
      second.identity.company.ownerUserId,
    );
    await expect(
      runtime.economy.bootstrapAgent(input, "human-wrong-email-key", {
        ...owner,
        email: "someone-else@example.com",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("keeps draft services private, enforces ownership, and paginates stably", async () => {
    const draft = await runtime.economy.createService(
      provider.context,
      { ...serviceInput(provider.companyId, "draft"), status: "draft" },
      "create-draft-key",
    );
    expect(
      (await runtime.economy.searchServices(buyer.context, {})).items,
    ).toHaveLength(0);
    await expect(
      runtime.economy.getService(buyer.context, draft.id),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(
      (
        await runtime.economy.searchServices(provider.context, {
          status: "draft",
        })
      ).items,
    ).toHaveLength(1);
    await expect(
      runtime.economy.updateService(
        buyer.context,
        { serviceId: draft.id, status: "active" },
        "invalid-owner-key",
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await runtime.economy.updateService(
      provider.context,
      { serviceId: draft.id, status: "active" },
      "publish-draft-key",
    );
    await runtime.economy.createService(
      provider.context,
      serviceInput(provider.companyId, "second"),
      "create-second-key",
    );
    const first = await runtime.economy.searchServices(buyer.context, {
      sort: "name_asc",
      limit: 1,
    });
    const second = await runtime.economy.searchServices(buyer.context, {
      sort: "name_asc",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(second.nextCursor).toBeNull();
    expect(
      (
        await runtime.economy.searchServices(buyer.context, {
          keyword: "' OR 1=1 --",
        })
      ).items,
    ).toHaveLength(0);
  });

  it("re-evaluates scopes and policy before returning an idempotent replay", async () => {
    const input = serviceInput(provider.companyId, "replay-auth");
    await runtime.economy.createService(
      provider.context,
      input,
      "replay-policy-key",
    );
    await expect(
      runtime.economy.createService(
        {
          principal: {
            ...provider.context.principal,
            scopes: ["services:read"],
          },
        },
        input,
        "replay-policy-key",
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await runtime.database.query(
      "UPDATE permissions SET decision='deny' WHERE company_id=$1 AND action='service:create'",
      [provider.companyId],
    );
    await expect(
      runtime.economy.createService(
        provider.context,
        input,
        "replay-policy-key",
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it("preserves pricing snapshots and returns a single immutable result across duplicate submissions", async () => {
    const service = await runtime.economy.createService(
      provider.context,
      {
        ...serviceInput(provider.companyId, "snapshot"),
        pricingModel: "quote",
        quotedPrice: "25.00",
        quotedCurrency: "USD",
      },
      "snapshot-service-key",
    );
    const [a, b] = await Promise.all(
      [1, 2].map(() =>
        runtime.economy.requestService(
          buyer.context,
          { serviceId: service.id, input: { request: "report" } },
          "snapshot-request-key",
        ),
      ),
    );
    expect(a.job.id).toBe(b.job.id);
    await runtime.economy.updateService(
      provider.context,
      { serviceId: service.id, quotedPrice: "99.00" },
      "new-quote-service-key",
    );
    await runtime.economy.acceptJob(
      provider.context,
      a.job.id,
      "snapshot-accept-key",
    );
    await runtime.economy.startJob(
      provider.context,
      a.job.id,
      "snapshot-start-key",
    );
    const results = await Promise.all(
      [1, 2].map(() =>
        runtime.economy.submitResult(
          provider.context,
          { jobId: a.job.id, output: { answer: "done" } },
          "snapshot-result-key",
        ),
      ),
    );
    expect(results[0]?.result?.id).toBe(results[1]?.result?.id);
    const retrieved = await runtime.economy.getInvocation(
      buyer.context,
      a.invocation.id,
    );
    expect(retrieved.invocation.pricingSnapshot).toMatchObject({
      quotedPrice: "25.00",
      serviceVersion: 1,
      paymentExecution: "unavailable",
    });
    expect(retrieved.result?.output).toEqual({ answer: "done" });
    await expect(
      runtime.economy.submitResult(
        provider.context,
        { jobId: a.job.id, output: { answer: "changed" } },
        "snapshot-result-key",
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(
      (await runtime.economy.listJobs(provider.context)).map((job) => job.id),
    ).toEqual([a.job.id]);
    expect(await runtime.economy.listJobs(buyer.context)).toHaveLength(0);
    expect(
      await runtime.economy.listJobs(buyer.context, { role: "buyer" }),
    ).toHaveLength(1);
    expect(
      (await runtime.economy.getPublicLeaderboard())[0]?.operations,
    ).toMatchObject({
      jobsCompleted: 1,
      totalJobs: 1,
      uniqueBuyers: 1,
      completionRate: 1,
    });
    for (const owner of [provider, buyer])
      expect(
        Object.values(await runtime.economy.getBalance(owner.context)),
      ).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(
      await runtime.database.query("SELECT id FROM ledger_entries"),
    ).toHaveLength(0);
    await expect(
      runtime.database.query(
        "UPDATE service_invocations SET pricing_snapshot='{}'::jsonb WHERE id=$1",
        [a.invocation.id],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("supports created-to-failed and prevents all terminal transitions", async () => {
    const service = await runtime.economy.createService(
      provider.context,
      serviceInput(provider.companyId, "fail"),
      "failed-service-key",
    );
    const view = await runtime.economy.requestService(
      buyer.context,
      { serviceId: service.id, input: {} },
      "failed-request-key",
    );
    await runtime.economy.failJob(
      provider.context,
      { jobId: view.job.id, failureReason: "Unable to accept this task" },
      "failed-result-key",
    );
    await expect(
      runtime.economy.acceptJob(
        provider.context,
        view.job.id,
        "failed-accept-key",
      ),
    ).rejects.toThrow(/must be created/);
    expect((await runtime.economy.getBalance(provider.context)).cashCents).toBe(
      0,
    );
    expect(
      (await runtime.economy.getPublicCompany(provider.companyId)).operations
        .jobsFailed,
    ).toBe(1);
  });

  it("hashes credentials, restricts rotation scopes, and invalidates rotated credentials", async () => {
    const issued = await runtime.economy.createCredential(
      provider.context,
      {
        label: "Scoped runtime",
        scopes: ["company:read", "company:write", "jobs:read"],
      },
      "scoped-credential-key",
    );
    const auth = new ApiCredentialAuthenticator(runtime.repository, {
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });
    const principal = await auth.authenticate(issued.secret);
    await expect(
      runtime.economy.rotateCredential(
        { principal: { ...principal, scopes: ["company:write"] } },
        issued.credential.id,
        "bad-rotate-key",
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const rotated = await runtime.economy.rotateCredential(
      { principal },
      issued.credential.id,
      "good-rotate-key",
    );
    await expect(auth.authenticate(issued.secret)).rejects.toThrow(/revoked/);
    expect((await auth.authenticate(rotated.secret)).scopes).toEqual(
      principal.scopes,
    );
    const replay = await runtime.economy.rotateCredential(
      provider.context,
      issued.credential.id,
      "good-rotate-key",
    );
    expect(replay.secret).toBeNull();
    const serialized = JSON.stringify(
      await runtime.database.query(
        "SELECT response_json FROM idempotency_records",
      ),
    );
    expect(serialized).not.toContain(rotated.secret!);
    await expect(
      runtime.database.query("DELETE FROM audit_events"),
    ).rejects.toThrow(/immutable/);
  });

  it("verifies signed OAuth issuer, audience, credential binding, and current revocation", async () => {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const verifier = new OAuthTokenVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwksUrl: `${TEST_ISSUER}/jwks`,
      keyResolver: async () => keys.publicKey,
    });
    const credential = await createCredential(
      runtime.repository,
      provider.agentId,
      "nmc_test_oauth_secret",
      { scopes: ["company:read"] },
    );
    const auth = new OAuthAgentAuthenticator(runtime.repository, verifier, {
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });
    const subject = crypto.randomUUID();
    await runtime.database.query(
      "UPDATE users SET auth_issuer=$2, auth_subject=$3 WHERE id=$1",
      [provider.userId, TEST_ISSUER, subject],
    );
    const policyId = crypto.randomUUID();
    await runtime.database.query(
      `INSERT INTO normic_oauth_clients
       (client_id,audience,enabled,allow_dynamic_clients)
       VALUES($1,$2,true,true)`,
      [policyId, TEST_AUDIENCE],
    );
    await runtime.database.query(
      `INSERT INTO normic_oauth_agent_grants
       (oauth_client_id,supabase_user_id,agent_id,credential_id)
       VALUES($1,$2,$3,$4)`,
      [policyId, subject, provider.agentId, credential.id],
    );
    expect(
      await runtime.repository.hasDynamicOAuthGrant({
        audience: TEST_AUDIENCE,
        ownerSubject: subject,
        agentId: provider.agentId,
        credentialId: credential.id,
      }),
    ).toBe(true);
    const claims = {
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: subject,
      role: "authenticated",
      is_anonymous: false,
      client_id: crypto.randomUUID(),
      normic_agent_id: provider.agentId,
      normic_credential_id: credential.id,
      normic_scopes: ["company:read", "services:write"],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const sign = async (overrides = {}) => {
      const header = Buffer.from(
        JSON.stringify({ alg: "ES256", typ: "at+jwt" }),
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({ ...claims, ...overrides }),
      ).toString("base64url");
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
      );
      return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
    };
    const token = await sign();
    expect((await auth.authenticate(token)).scopes).toEqual(["company:read"]);
    for (const overrides of [
      { iss: "https://attacker.test" },
      { aud: "wrong" },
      { sub: crypto.randomUUID() },
      { normic_agent_id: buyer.agentId },
      { client_id: undefined },
      { exp: 1 },
    ])
      await expect(auth.authenticate(await sign(overrides))).rejects.toThrow(
        /invalid or expired/,
      );
    await runtime.repository.revokeCredential(credential.id, new Date());
    await expect(auth.authenticate(token)).rejects.toThrow(
      /invalid or expired/,
    );
    expect(
      JSON.stringify(await runtime.repository.listAuditEvents()),
    ).not.toContain(token);
  });

  it("onboards a verified standard Supabase owner session without MCP claims", async () => {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const verifier = new OAuthTokenVerifier({
      issuer: TEST_ISSUER,
      audience: "authenticated",
      jwksUrl: `${TEST_ISSUER}/jwks`,
      keyResolver: async () => keys.publicKey,
    });
    const subject = crypto.randomUUID();
    const claims = {
      iss: TEST_ISSUER,
      aud: "authenticated",
      sub: subject,
      role: "authenticated",
      is_anonymous: false,
      email: "first-owner@example.com",
      email_verified: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const sign = async (overrides = {}) => {
      const header = Buffer.from(
        JSON.stringify({ alg: "ES256", typ: "JWT" }),
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({ ...claims, ...overrides }),
      ).toString("base64url");
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
      );
      return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
    };

    const owner = await verifier.verifyOwner(await sign());
    expect(owner).toEqual({
      issuer: TEST_ISSUER,
      subject,
      email: claims.email,
    });
    const registration = await runtime.economy.bootstrapAgent(
      {
        creatorEmail: claims.email,
        creatorName: "First owner",
        agentName: "First production agent",
        handle: "first_production_agent",
        framework: "custom",
        companyName: "First production company",
        companySlug: "first-production-company",
        description: "A legitimate company created by verified onboarding.",
        industry: "Services",
      },
      "verified-owner-onboarding",
      owner,
    );
    const [mapped] = await runtime.database.query<{
      auth_issuer: string;
      auth_subject: string;
    }>("SELECT auth_issuer,auth_subject FROM users WHERE id=$1", [
      registration.identity.company.ownerUserId,
    ]);
    expect(mapped).toEqual({
      auth_issuer: TEST_ISSUER,
      auth_subject: subject,
    });
    expect(registration.identity.agent.status).toBe("active");
    expect(registration.credential.scopes).toEqual([
      "company:read",
      "company:write",
      "services:read",
      "services:write",
      "jobs:read",
      "jobs:write",
      "transactions:read",
      "markets:read",
    ]);
    expect(registration.secretShown).toBe(true);

    for (const overrides of [
      { aud: TEST_AUDIENCE },
      { email_verified: false },
      { exp: 1 },
    ])
      await expect(verifier.verifyOwner(await sign(overrides))).rejects.toThrow(
        /verified owner session/,
      );
  });
});
