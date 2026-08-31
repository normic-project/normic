import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FinancialService,
  type FinancialActor,
  type FinancialChainPort,
  type FinancialWalletPort,
} from "@normic/core";
import {
  PostgresFinancialRepository,
  type RuntimeDatabase,
  type SqlExecutor,
} from "@normic/db";
import {
  createTestRuntime,
  createIdentity,
  createCredential,
  TEST_ISSUER,
  TEST_AUDIENCE,
} from "../support/runtime.js";
import { testPasskey } from "../support/webauthn.js";

const requireDb = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
);
// No connection is opened. Use the installed production driver's real codec:
// PostgreSQL describes $n::jsonb as JSONB; PGlite alone skips this wire step.
const serializeJsonb = requireDb("postgres")().options.serializers[3802] as (
  value: unknown,
) => string;
function postgresJsonParameters(database: RuntimeDatabase): RuntimeDatabase {
  const wrap = (db: SqlExecutor): SqlExecutor => ({
    query: (sql, parameters = []) => {
      const encoded = [...parameters];
      for (const match of sql.matchAll(/\$(\d+)::jsonb/g)) {
        const index = Number(match[1]) - 1;
        if (encoded[index] !== null)
          encoded[index] = serializeJsonb(encoded[index]);
      }
      return db.query(sql, encoded);
    },
  });
  return {
    ...database,
    ...wrap(database),
    transaction: (run) => database.transaction((tx) => run(wrap(tx))),
  };
}

describe("financial WebAuthn enrollment and provisioning", () => {
  let rt: Awaited<ReturnType<typeof createTestRuntime>>,
    repo: PostgresFinancialRepository,
    service: FinancialService;
  let owner: Extract<FinancialActor, { kind: "owner" }>,
    companyId: string,
    agent: Awaited<ReturnType<typeof createIdentity>>,
    credentialId: string;
  const provision = vi.fn();
  beforeEach(async () => {
    rt = await createTestRuntime();
    repo = new PostgresFinancialRepository(postgresJsonParameters(rt.database));
    agent = await createIdentity(rt.repository, "passkey-owner");
    companyId = agent.companyId;
    owner = {
      kind: "owner",
      owner: {
        issuer: TEST_ISSUER,
        subject: crypto.randomUUID(),
        email: "owner@example.test",
      },
    };
    await rt.database.query(
      "UPDATE users SET auth_issuer=$2,auth_subject=$3 WHERE id=$1",
      [agent.userId, TEST_ISSUER, owner.owner.subject],
    );
    const credential = await createCredential(
      rt.repository,
      agent.agentId,
      "nmc_test_passkey_only",
    );
    credentialId = credential.id;
    await rt.database.query(
      "INSERT INTO normic_oauth_clients(client_id,audience,enabled,allow_dynamic_clients) VALUES($1,$2,true,true)",
      [crypto.randomUUID(), TEST_AUDIENCE],
    );
    await rt.repository.ensureDynamicOAuthGrant({
      audience: TEST_AUDIENCE,
      ownerSubject: owner.owner.subject,
      agentId: agent.agentId,
      credentialId,
      createdAt: new Date(),
    });
    await rt.repository.touchCredential(credentialId, new Date());
    provision.mockReset().mockResolvedValue({
      address: "0x0000000000000000000000000000000000000042",
      deployed: false,
    });
    service = new FinancialService(
      repo,
      { validateChain: async () => {} } as FinancialChainPort,
      {
        available: true,
        autonomousAvailable: false,
        provisionWebAuthnAccount: provision,
      } as unknown as FinancialWalletPort,
      {
        origin: "https://normic.tech",
        acceptTimeoutSeconds: 60,
        completionTimeoutSeconds: 60,
        reviewWindowSeconds: 60,
      },
    );
    await service.prepareFinancialIdentity(
      owner,
      companyId,
      crypto.randomUUID(),
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rt?.database.close();
  });
  const begin = () =>
    service.beginPasskeyRegistration(
      owner,
      companyId,
      "primary",
      crypto.randomUUID(),
    );
  const finish = async (passkey = testPasskey()) => {
    const options = await begin();
    const response = passkey.registration(options.challenge),
      key = crypto.randomUUID();
    await service.completePasskeyRegistration(
      owner,
      companyId,
      "primary",
      response,
      key,
    );
    return { passkey, response, key };
  };

  it("uses production RP/origin, hashes challenges everywhere, and binds one immutable wallet idempotently", async () => {
    const options = await begin();
    expect(options).toMatchObject({
      rp: { id: "normic.tech" },
      authenticatorSelection: {
        userVerification: "required",
        residentKey: "required",
      },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
    });
    const [challenge] = await rt.database.query<{ challenge_hash: string }>(
      "SELECT challenge_hash FROM financial_webauthn_challenges WHERE consumed_at IS NULL",
    );
    expect(challenge!.challenge_hash).toMatch(/^[a-f0-9]{64}$/);
    const records = await rt.database.query(
      "SELECT response FROM financial_idempotency",
    );
    expect(JSON.stringify(records)).not.toContain(options.challenge);
    const passkey = testPasskey(),
      response = passkey.registration(options.challenge),
      key = crypto.randomUUID();
    const result = await service.completePasskeyRegistration(
      owner,
      companyId,
      "primary",
      response,
      key,
    );
    expect(result.state).toBe("passkey_verified");
    expect(provision).not.toHaveBeenCalled();
    expect(
      await service.completePasskeyRegistration(
        owner,
        companyId,
        "primary",
        response,
        key,
      ),
    ).toEqual(result);
    const [wallet, retry] = await Promise.all([
      service.provisionFinancialWallet(owner, companyId, "provision-a"),
      service.provisionFinancialWallet(owner, companyId, "provision-b"),
    ]);
    expect(wallet).toEqual(retry);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledWith({
      credentialId: passkey.credentialId,
      publicKey: passkey.publicKey,
      rpId: "normic.tech",
      validationEntityId: 0,
      salt: "0",
    });
    expect(wallet).toMatchObject({
      walletType: "erc4337-mav2-webauthn",
      ownerAddress: wallet.address,
      chainId: 4663,
      deployed: false,
    });
    await expect(
      service.completePasskeyRegistration(
        owner,
        companyId,
        "primary",
        response,
        "replay-new-key",
      ),
    ).rejects.toThrow("immutable");
    await expect(
      rt.database.query(
        "UPDATE financial_root_bindings SET root_identity=$2 WHERE company_id=$1",
        [companyId, `webauthn-p256:${"a".repeat(64)}`],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      rt.database.query(
        "UPDATE financial_wallets SET address=$2 WHERE company_id=$1",
        [companyId, `0x${"b".repeat(40)}`],
      ),
    ).rejects.toThrow();
    await expect(
      rt.database.query(
        "UPDATE financial_webauthn_credentials SET public_key_x=$2 WHERE credential_id=$1",
        [passkey.credentialId, "A".repeat(43)],
      ),
    ).rejects.toThrow("immutable");
    expect(
      await rt.database.query("SELECT * FROM financial_sessions"),
    ).toHaveLength(0);
    expect(
      await rt.database.query("SELECT * FROM spending_policies"),
    ).toHaveLength(0);
  });
  it.each([
    ["origin", { origin: "https://evil.test" }],
    ["RP", { rpId: "evil.test" }],
    ["UV", { flags: 0x41 }],
    ["presence", { flags: 0x44 }],
    ["cross-origin", { crossOrigin: true }],
    ["curve", { curve: 2 }],
    ["private field", { privateField: true }],
    ["off-curve", { offCurve: true }],
  ])(
    "rejects invalid %s before binding or provisioning",
    async (_label, input) => {
      const options = await begin();
      await expect(
        service.completePasskeyRegistration(
          owner,
          companyId,
          "primary",
          testPasskey().registration(options.challenge, input as never),
          crypto.randomUUID(),
        ),
      ).rejects.toThrow();
      expect(
        await repo.listWebAuthnCredentials(
          (await repo.getRootBinding(companyId))!.id,
        ),
      ).toHaveLength(0);
      expect(provision).not.toHaveBeenCalled();
    },
  );
  it("rejects wrong user, agents, stale challenges and expired challenges", async () => {
    const first = await begin(),
      second = await begin(),
      passkey = testPasskey();
    await expect(
      service.completePasskeyRegistration(
        owner,
        companyId,
        "primary",
        passkey.registration(first.challenge),
        "stale-challenge",
      ),
    ).rejects.toThrow("expired or already used");
    await expect(
      service.completePasskeyRegistration(
        { ...owner, owner: { ...owner.owner, subject: crypto.randomUUID() } },
        companyId,
        "primary",
        passkey.registration(second.challenge),
        "other-owner",
      ),
    ).rejects.toThrow("does not own");
    await expect(
      service.beginPasskeyRegistration(
        { kind: "agent", context: agent.context },
        companyId,
        "primary",
        "agent",
      ),
    ).rejects.toThrow("verified owner");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 600_000);
    const expired = await begin();
    clock.mockRestore();
    await expect(
      service.completePasskeyRegistration(
        owner,
        companyId,
        "primary",
        passkey.registration(expired.challenge),
        "expired-challenge",
      ),
    ).rejects.toThrow("expired or already used");
    expect(provision).not.toHaveBeenCalled();
  });
  it("rechecks revoked MCP credentials and resumes provider failures without replacing the passkey", async () => {
    const { passkey } = await finish();
    provision.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(
      service.provisionFinancialWallet(owner, companyId, "provision"),
    ).rejects.toThrow();
    expect((await service.getFinancialIdentity(owner, companyId)).state).toBe(
      "passkey_verified",
    );
    await service.provisionFinancialWallet(owner, companyId, "provision");
    expect(
      await repo.getWebAuthnCredential(passkey.credentialId),
    ).not.toBeNull();
    await rt.database.query(
      "UPDATE api_credentials SET revoked_at=now() WHERE id=$1",
      [credentialId],
    );
    expect(await service.getWallet(owner, companyId)).not.toBeNull();
    expect(
      await service.provisionFinancialWallet(owner, companyId, "existing"),
    ).not.toBeNull();
  });
  it("requires a signed active root assertion before preparing any recovery candidate; candidate has no root authority", async () => {
    const { passkey } = await finish();
    await service.provisionFinancialWallet(owner, companyId, "provision");
    await expect(
      service.beginPasskeyRegistration(
        owner,
        companyId,
        "recovery",
        "unapproved",
      ),
    ).rejects.toThrow("active passkey");
    const authorization = await service.beginRecoveryAuthorization(
      owner,
      companyId,
      "recover-challenge",
    );
    await expect(
      service.authorizeRecoveryRegistration(
        owner,
        companyId,
        testPasskey().assertion(authorization.challenge),
        "wrong-key",
      ),
    ).rejects.toThrow("active root");
    const options = await service.authorizeRecoveryRegistration(
      owner,
      companyId,
      passkey.assertion(authorization.challenge),
      "authorize",
    );
    const candidate = testPasskey();
    expect(
      await service.completePasskeyRegistration(
        owner,
        companyId,
        "recovery",
        candidate.registration(options.challenge),
        "recovery-register",
      ),
    ).toEqual({
      state: "recovery_prepared",
      onchainAuthorizationRequired: true,
    });
    const next = await service.beginRecoveryAuthorization(
      owner,
      companyId,
      "recover-next",
    );
    expect(next.allowCredentials?.map((c) => c.id)).toEqual([
      passkey.credentialId,
    ]);
    await expect(
      service.authorizeRecoveryRegistration(
        owner,
        companyId,
        candidate.assertion(next.challenge),
        "candidate-root",
      ),
    ).rejects.toThrow("active root");
  });
});
