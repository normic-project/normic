import { afterEach, describe, expect, it } from "vitest";
import {
  FinancialService,
  runFinancialCommand,
  type FinancialActor,
  type FinancialChainPort,
  type FinancialWalletPort,
} from "@normic/core";
import { PostgresFinancialRepository } from "@normic/db";
import {
  createCredential,
  createIdentity,
  createTestRuntime,
  TEST_AUDIENCE,
  TEST_ISSUER,
} from "../support/runtime.js";

describe("direct WebAuthn financial root groundwork", () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>> | undefined;

  afterEach(async () => runtime?.database.close());

  it("reserves one root binding only after real MCP authentication", async () => {
    runtime = await createTestRuntime();
    const identity = await createIdentity(runtime.repository, "webauthn-root"),
      subject = crypto.randomUUID(),
      credential = await createCredential(
        runtime.repository,
        identity.agentId,
        "nmc_test_webauthn_root",
      ),
      repository = new PostgresFinancialRepository(runtime.database),
      service = new FinancialService(
        repository,
        {} as FinancialChainPort,
        {} as FinancialWalletPort,
        {
          origin: "https://normic.tech",
          acceptTimeoutSeconds: 60,
          completionTimeoutSeconds: 60,
          reviewWindowSeconds: 60,
        },
      ),
      owner: FinancialActor = {
        kind: "owner",
        owner: {
          issuer: TEST_ISSUER,
          subject,
          email: "webauthn-root@example.com",
        },
      };
    await runtime.database.query(
      "UPDATE users SET email=$2,auth_issuer=$3,auth_subject=$4 WHERE id=$1",
      [
        identity.userId,
        owner.owner.email,
        owner.owner.issuer,
        owner.owner.subject,
      ],
    );

    await expect(
      runFinancialCommand(
        service,
        owner,
        "prepare_financial_identity",
        { companyId: identity.companyId },
        "before-mcp",
      ),
    ).rejects.toThrow("authenticated MCP connection");

    await runtime.database.query(
      "INSERT INTO normic_oauth_clients(client_id,audience,enabled,allow_dynamic_clients) VALUES($1,$2,true,true)",
      [crypto.randomUUID(), TEST_AUDIENCE],
    );
    expect(
      await runtime.repository.ensureDynamicOAuthGrant({
        audience: TEST_AUDIENCE,
        ownerSubject: subject,
        agentId: identity.agentId,
        credentialId: credential.id,
        createdAt: new Date(),
      }),
    ).toBe("ready");
    await runtime.repository.touchCredential(credential.id, new Date());

    const agentActor: FinancialActor = {
      kind: "agent",
      context: {
        principal: {
          ...identity.context.principal,
          credentialId: credential.id,
        },
      },
    };
    const requestId = crypto.randomUUID();
    const prepared = await service.prepareWallet(agentActor, requestId);
    expect(prepared).toMatchObject({
      state: "OWNER_APPROVAL_REQUIRED",
      companyId: identity.companyId,
      chainId: 4663,
    });
    expect(new URL(prepared.approvalUrl!).origin).toBe("https://normic.tech");
    expect(await service.prepareWallet(agentActor, requestId)).toEqual(
      prepared,
    );
    expect(JSON.stringify(prepared)).not.toContain(credential.id);
    expect(JSON.stringify(prepared)).not.toMatch(/challenge|secret|publicKey/);
    await expect(
      service.getWalletOwnerApproval(
        owner,
        identity.companyId,
        identity.agentId,
        requestId,
      ),
    ).resolves.toMatchObject({ state: "OWNER_APPROVAL_REQUIRED" });

    const first = await runFinancialCommand(
      service,
      owner,
      "prepare_financial_identity",
      { companyId: identity.companyId },
      "root-first",
    );
    const retry = await runFinancialCommand(
      service,
      owner,
      "prepare_financial_identity",
      { companyId: identity.companyId },
      "root-retry",
    );
    expect(first).toEqual(retry);
    expect(first).toMatchObject({
      companyId: identity.companyId,
      chainId: 4663,
      rootType: "webauthn-mav2",
      state: "pending_passkey",
      passkeyEnrollmentRequired: true,
      smartAccountAddress: null,
    });
    const [counts] = await runtime.database.query<{
      roots: number;
      passkeys: number;
      wallets: number;
    }>(`SELECT
      (SELECT count(*)::int FROM financial_root_bindings) roots,
      (SELECT count(*)::int FROM financial_webauthn_credentials) passkeys,
      (SELECT count(*)::int FROM financial_wallets) wallets`);
    expect(counts).toEqual({ roots: 1, passkeys: 0, wallets: 0 });
    await expect(
      service.getFinancialIdentity(owner, identity.companyId),
    ).resolves.toMatchObject({
      state: "pending_passkey",
      smartAccountAddress: null,
      counterfactual: null,
    });
  });
});
