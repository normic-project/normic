import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  FinancialService,
  canonicalJson,
  decimalToUnits,
  CANONICAL_USDG,
  type FinancialChainPort,
  type FinancialWalletPort,
  type VerifiedEscrowEvent,
  type EvmAddress,
  type EvmHash,
  type FinancialActor,
} from "@normic/core";
import { PostgresFinancialRepository } from "@normic/db";
import {
  RobinhoodFinancialChain,
  AlchemyFinancialWallet,
  sessionSelectors,
} from "@normic/payments";
import {
  createTestRuntime,
  createIdentity,
  createCredential,
  serviceInput,
} from "../support/runtime.js";
const address = (n: number) =>
  `0x${n.toString(16).padStart(40, "0")}` as EvmAddress;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as EvmHash;
describe("Phase 4 isolated financial integration", () => {
  let rt: Awaited<ReturnType<typeof createTestRuntime>>,
    repo: PostgresFinancialRepository,
    f: FinancialService;
  let buyer: Awaited<ReturnType<typeof createIdentity>>,
    provider: Awaited<ReturnType<typeof createIdentity>>,
    a: FinancialActor,
    p: FinancialActor;
  let chain: FinancialChainPort,
    wallets: FinancialWalletPort,
    events: VerifiedEscrowEvent[],
    serviceId: string;
  beforeEach(async () => {
    rt = await createTestRuntime();
    repo = new PostgresFinancialRepository(rt.database);
    buyer = await createIdentity(rt.repository, "buyer4");
    provider = await createIdentity(rt.repository, "provider4");
    for (const [i, identity] of [buyer, provider].entries()) {
      const credential = await createCredential(
        rt.repository,
        identity.agentId,
        `nmc_test_${i}_isolatedonly`,
      );
      identity.context.principal.credentialId = credential.id;
      await repo.saveWallet({
        companyId: identity.companyId,
        agentId: identity.agentId,
        address: address(i + 1),
        ownerAddress: address(i + 11),
        chainId: 4663,
        provider: "alchemy-wallet-api",
        walletType: "erc4337-sma-b",
        authorizationStatus: "owner_verified",
        deployed: true,
        createdAt: new Date().toISOString(),
      });
      const policy = {
        companyId: identity.companyId,
        enabled: true,
        maxPerTransaction: "1000000",
        maxPerDay: "2000000",
        sessionExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        allowedToken: CANONICAL_USDG,
        allowedContract: address(99),
        allowedActions: [
          "fund",
          "accept",
          "submit",
          "release",
          "dispute",
          "refund",
        ] as const,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      await repo.savePolicy({
        ...policy,
        allowedActions: [...policy.allowedActions],
      });
      await repo.saveSession({
        id: crypto.randomUUID(),
        companyId: identity.companyId,
        publicKey: address(i + 21),
        providerSessionId: `isolated-${i}`,
        authorizationRef: `isolated/${i}`,
        signerRef: `privy-isolated-${i}`,
        ownerAuthorization: `0x${"11".repeat(65)}`,
        ownerAuthorizationPayload: hash(i + 200),
        permissionDigest: hash(i + 300),
        expiresAt: policy.sessionExpiresAt,
        revokedAt: null,
        policyVersion: 1,
        createdAt: new Date().toISOString(),
      });
    }
    a = { kind: "agent", context: buyer.context };
    p = { kind: "agent", context: provider.context };
    events = [];
    chain = {
      capabilities: () => ({
        state: "ready",
        missing: [],
        chainId: 4663,
        escrow: address(99),
        autonomousExecution: true,
        gasSponsorship: false,
      }),
      validateChain: vi.fn(async () => {}),
      validateToken: async () => ({
        address: CANONICAL_USDG,
        chainId: 4663,
        decimals: 6,
        symbol: "USDG",
        blockNumber: "1",
        source: "isolated-test",
      }),
      validateEscrow: async () => ({
        address: address(99),
        maxPayment: "10000000",
      }),
      balances: async (wallet) => ({
        state: "available",
        wallet,
        chainId: 4663,
        blockNumber: "1",
        blockHash: hash(1),
        timestamp: new Date().toISOString(),
        source: "isolated-test",
        eth: {
          units: "1000000000000000",
          decimals: 18,
          symbol: "ETH",
          tokenAddress: null,
        },
        usdg: {
          units: "10000000",
          decimals: 6,
          symbol: "USDG",
          tokenAddress: CANONICAL_USDG,
        },
      }),
      simulate: vi.fn(async () => {}),
      verifyReceipt: async (h) => events.filter((e) => e.transactionHash === h),
      finalizedEvents: async () => ({
        events: [...events],
        throughBlock: "100",
        blockHash: hash(100),
      }),
      verifyWalletSignature: async () => true,
      allowance: async () => "10000000",
      verifyCheckpoint: async () => {},
      incomingTransfers: async () => [],
    };
    wallets = {
      available: true,
      autonomousAvailable: true,
      requestAccount: async () => ({ address: address(1), deployed: true }),
      prepareSession: async () => ({
        publicKey: address(21),
        providerSessionId: "isolated-prepared-session",
        signerRef: "privy-isolated-prepared",
        ownerAuthorizationPayload: hash(201),
        permissionDigest: hash(301),
        ownerSignatureRequest: {
          type: "eth_signTypedData_v4",
          data: {},
          rawPayload: hash(201),
        },
      }),
      validateSession: async () => {},
      execute: vi.fn(async () => ({ callId: "isolated-call" })),
      revoke: async () => {},
      status: async () => ({ state: "pending", transactionHash: null }),
    };
    f = new FinancialService(repo, chain, wallets, {
      origin: "https://normic.test",
      acceptTimeoutSeconds: 3600,
      completionTimeoutSeconds: 86400,
      reviewWindowSeconds: 86400,
    });
    serviceId = (
      await rt.economy.createService(
        provider.context,
        {
          ...serviceInput(provider.companyId, "usd"),
          pricingModel: "fixed",
          quotedPrice: "0.50",
          quotedCurrency: "USDG",
        },
        "phase4-service-key",
      )
    ).id;
  });
  afterEach(async () => rt.database.close());
  const request = () =>
    f.requestService(
      a,
      { serviceId, input: { request: "test" } },
      "payment-request-key",
    );
  async function event(
    id: string,
    name: VerifiedEscrowEvent["name"],
    n: number,
    resultHash: EvmHash | null = null,
  ) {
    const i = (await repo.getInvocation(id))!;
    const e: VerifiedEscrowEvent = {
      chainId: 4663,
      contractAddress: address(99),
      invocationId: i.onchainId,
      transactionHash: hash(n),
      logIndex: 0,
      blockNumber: String(n),
      blockHash: hash(n + 1000),
      name,
      terms: i.terms,
      resultHash,
      observedAt: new Date().toISOString(),
    };
    events.push(e);
    return f.confirm(a, id, e.transactionHash, `confirm-payment-${n}`);
  }
  it("hides unfunded jobs, prevents legacy paid bypass, and starts with zero verified revenue", async () => {
    const i = await request();
    expect(i.state).toBe("payment_required");
    expect(await f.listJobs(p)).toEqual([]);
    await expect(f.getInvocation(p, i.id)).rejects.toThrow();
    await expect(
      rt.economy.requestService(
        buyer.context,
        { serviceId, input: {} },
        "bypass-paid-key",
      ),
    ).rejects.toThrow(/escrow/);
    expect(
      (await repo.summary(provider.companyId)).verifiedServiceRevenue,
    ).toBe("0");
  });
  it("idempotent concurrent request and conflicting payload protection", async () => {
    const [i, j] = await Promise.all([request(), request()]);
    expect(i.id).toBe(j.id);
    await expect(
      f.requestService(
        a,
        { serviceId, input: { changed: true } },
        "payment-request-key",
      ),
    ).rejects.toThrow(/different request/);
    expect(
      await rt.database.query("SELECT id FROM paid_invocations"),
    ).toHaveLength(1);
  });
  it("balances journals, recognizes only release revenue, and keeps results immutable", async () => {
    const i = await request();
    await event(i.id, "InvocationFunded", 1);
    expect((await repo.summary(buyer.companyId)).restrictedEscrow).toBe(
      "500000",
    );
    expect(await f.listJobs(p)).toHaveLength(1);
    await event(i.id, "InvocationAccepted", 2);
    await f.startJob(p, i.id, "start-paid-job");
    const result = await f.submitResult(
      p,
      { jobId: i.id, output: { answer: "done" } },
      "store-paid-result",
    );
    expect(
      (await repo.summary(provider.companyId)).verifiedServiceRevenue,
    ).toBe("0");
    await event(i.id, "ResultSubmitted", 3, result.invocation.resultHash);
    await event(i.id, "InvocationReleased", 4);
    await f.confirm(a, i.id, hash(4), "confirm-payment-4");
    expect(await repo.summary(provider.companyId)).toMatchObject({
      verifiedServiceRevenue: "500000",
      serviceExpenses: "0",
    });
    expect(await repo.summary(buyer.companyId)).toMatchObject({
      serviceExpenses: "500000",
      restrictedEscrow: "0",
    });
    expect(await repo.history(provider.companyId)).toHaveLength(4);
    const totals = await rt.database.query<{ difference: string }>(
      "SELECT sum(CASE WHEN direction='debit' THEN token_units ELSE -token_units END)::text difference FROM ledger_postings",
    );
    expect(totals[0]?.difference).toBe("0");
    await expect(
      rt.database.query("UPDATE ledger_postings SET token_units=1"),
    ).rejects.toThrow(/immutable/);
    await expect(
      rt.database.query("DELETE FROM escrow_events"),
    ).rejects.toThrow(/immutable/);
    expect(await repo.leaderboard()).toEqual([
      { companyId: provider.companyId, verifiedServiceRevenue: "500000" },
    ]);
  });
  it("refund clears restricted assets without generating service revenue or expense", async () => {
    const i = await request();
    await event(i.id, "InvocationFunded", 1);
    await event(i.id, "InvocationRefunded", 2);
    expect(await repo.summary(buyer.companyId)).toMatchObject({
      restrictedEscrow: "0",
      serviceExpenses: "0",
    });
    expect(
      (await repo.summary(provider.companyId)).verifiedServiceRevenue,
    ).toBe("0");
  });
  it("rejected, spoofed or unfinalized receipts never change financial state", async () => {
    const i = await request();
    await expect(
      f.confirm(a, i.id, hash(999), "unknown-receipt-key"),
    ).rejects.toThrow();
    chain.verifyReceipt = async () => {
      throw new Error("reverted receipt");
    };
    await expect(
      f.confirm(a, i.id, hash(1000), "reverted-receipt-key"),
    ).rejects.toThrow();
    expect((await repo.getInvocation(i.id))?.state).toBe("payment_required");
    expect(await repo.leaderboard()).toEqual([]);
  });
  it("denies IDOR, missing scope, revoked credential, and agent policy changes", async () => {
    await expect(f.getWallet(a, provider.companyId)).rejects.toThrow();
    await expect(
      f.revokeSession(a, buyer.companyId, "revoke-with-agent"),
    ).rejects.toThrow();
    buyer.context.principal.scopes = buyer.context.principal.scopes.filter(
      (x) => x !== "economy:spend",
    );
    const i = await request();
    await expect(
      f.prepare(a, i.id, "fund", "denied-spend-key"),
    ).rejects.toThrow();
    await rt.database.query(
      "UPDATE api_credentials SET revoked_at=now() WHERE id=$1",
      [buyer.context.principal.credentialId],
    );
    await expect(f.getWallet(a, buyer.companyId)).rejects.toThrow();
  });
  it("creates a session only from a trusted owner-prepared authorization", async () => {
    const issuer = "https://auth.normic.test",
      subject = crypto.randomUUID(),
      existing = (await repo.getSession(buyer.companyId))!;
    await rt.database.query(
      "UPDATE users SET auth_issuer=$2,auth_subject=$3 WHERE id=$1",
      [buyer.userId, issuer, subject],
    );
    await repo.saveSession({
      ...existing,
      revokedAt: new Date().toISOString(),
    });
    const owner: FinancialActor = {
      kind: "owner",
      owner: { issuer, subject, email: "owner@example.com" },
    };
    const prepared = await f.prepareSessionAuthorization(
      owner,
      buyer.companyId,
      "prepare-owner-session",
    );
    const registered = await f.registerSession(
      owner,
      {
        companyId: buyer.companyId,
        authorizationRef: prepared.authorizationRef,
        ownerAuthorization: `0x${"44".repeat(65)}`,
      },
      "register-owner-session",
    );
    const session = await repo.getSession(buyer.companyId),
      authorization = await repo.getSessionAuthorization(
        prepared.authorizationRef,
      );
    expect(registered.publicKey).toBe(address(21));
    expect(session).toMatchObject({
      signerRef: "privy-isolated-prepared",
      providerSessionId: "isolated-prepared-session",
      authorizationRef: prepared.authorizationRef,
      permissionDigest: hash(301),
    });
    expect(authorization?.consumedAt).not.toBeNull();
    await expect(
      f.registerSession(
        owner,
        {
          companyId: buyer.companyId,
          authorizationRef: prepared.authorizationRef,
          ownerAuthorization: `0x${"55".repeat(65)}`,
        },
        "replay-consumed-authorization",
      ),
    ).rejects.toThrow("invalid or expired");
  });
  it("simulation failure never broadcasts; ambiguous broadcast never retries", async () => {
    const i = await request(),
      prepared = await f.prepare(a, i.id, "fund", "prepare-payment-key");
    chain.simulate = async () => {
      throw new Error("simulation failed");
    };
    await expect(
      f.execute(a, prepared.operation.id, "execute-payment-key"),
    ).rejects.toThrow();
    expect(wallets.execute).not.toHaveBeenCalled();
    chain.simulate = async () => {};
    wallets.execute = vi.fn(async () => {
      throw new Error("timeout");
    });
    await expect(
      f.execute(a, prepared.operation.id, "execute-payment-key"),
    ).rejects.toThrow(/uncertain/);
    await expect(
      f.execute(a, prepared.operation.id, "execute-payment-key"),
    ).rejects.toThrow(/already attempted/);
    expect(wallets.execute).toHaveBeenCalledTimes(1);
    expect(
      (await repo.summary(provider.companyId)).verifiedServiceRevenue,
    ).toBe("0");
  });
  it("reconciles an Alchemy call ID to one finalized receipt without rebroadcast", async () => {
    const i = await request(),
      prepared = await f.prepare(a, i.id, "fund", "prepare-call-status-key");
    await f.execute(a, prepared.operation.id, "execute-call-status-key");
    expect(
      (
        await f.reconcileOperation(
          a,
          prepared.operation.id,
          "reconcile-pending-key",
        )
      ).state,
    ).toBe("pending");
    const current = (await repo.getInvocation(i.id))!;
    events.push({
      chainId: 4663,
      contractAddress: address(99),
      invocationId: current.onchainId,
      transactionHash: hash(88),
      logIndex: 0,
      blockNumber: "88",
      blockHash: hash(1088),
      name: "InvocationFunded",
      terms: current.terms,
      resultHash: null,
      observedAt: new Date().toISOString(),
    });
    wallets.status = async () => ({
      state: "confirmed",
      transactionHash: hash(88),
    });
    const result = await f.reconcileOperation(
      a,
      prepared.operation.id,
      "reconcile-final-key",
    );
    expect(result).toMatchObject({
      state: "confirmed",
      financiallyConfirmed: true,
    });
    expect((await repo.getInvocation(i.id))?.state).toBe("FUNDED");
    expect((await repo.getOperation(prepared.operation.id))?.status).toBe(
      "confirmed",
    );
    expect(wallets.execute).toHaveBeenCalledTimes(1);
  });
  it("reconciles duplicate events and stores direct capital separately", async () => {
    const i = await request();
    await event(i.id, "InvocationFunded", 1);
    chain.incomingTransfers = async (wallet) =>
      wallet === address(1)
        ? [
            {
              transactionHash: hash(99),
              logIndex: 0,
              from: address(11),
              units: "1000000000000",
              blockNumber: "99",
              blockHash: hash(100),
            },
          ]
        : [];
    await f.reconcile("1");
    await f.reconcile("1");
    expect(
      await rt.database.query("SELECT id FROM escrow_events"),
    ).toHaveLength(1);
    expect(
      await rt.database.query(
        "SELECT classification FROM wallet_transfer_observations",
      ),
    ).toEqual([{ classification: "capital" }]);
    expect(await repo.leaderboard()).toEqual([]);
  });
  it("session selectors exclude approvals, owner policy changes, arbitrary calls and trading", async () => {
    const policy = (await repo.getPolicy(buyer.companyId))!;
    const selectors = sessionSelectors(policy);
    expect(selectors).toHaveLength(6);
    expect(selectors).not.toContain("0x095ea7b3");
    expect(selectors).not.toContain("0xa9059cbb");
  });
  it("missing real infrastructure fails closed without fabricated balances or leaked secrets", async () => {
    const real = new RobinhoodFinancialChain({}),
      wallet = new AlchemyFinancialWallet(real);
    expect(real.capabilities().state).toBe("blocked");
    expect(wallet.autonomousAvailable).toBe(false);
    await expect(real.balances(address(1))).rejects.toThrow();
    const unsafe = "secret-token-value";
    chain.balances = async () => {
      throw new Error(unsafe);
    };
    expect(canonicalJson(await f.getBalance(a, buyer.companyId))).not.toContain(
      unsafe,
    );
  });
  it("integer parsing never rounds fractional amounts or overflows uint256", () => {
    expect(decimalToUnits("0.5", 6)).toBe("500000");
    expect(() => decimalToUnits("0.0000001", 6)).toThrow();
    expect(() => decimalToUnits("1e9", 6)).toThrow();
    expect(() => decimalToUnits("9".repeat(80), 6)).toThrow();
  });
  it("human wallet authentication is single-use, idempotent, hashed and auditable", async () => {
    const c = await f.walletChallenge(address(77), "human-challenge-key");
    expect(await f.walletChallenge(address(77), "human-challenge-key")).toEqual(
      c,
    );
    const auth = await f.authenticateWallet(c.id, "0xabcd", "human-signin-key");
    expect(auth.secret).toMatch(/^nmh_/);
    const replay = await f.authenticateWallet(
      c.id,
      "0xabcd",
      "human-signin-key",
    );
    expect(replay.secret).toBeNull();
    expect((await f.humanActor(auth.secret!)).kind).toBe("human");
    expect(
      JSON.stringify(
        await rt.database.query("SELECT * FROM financial_idempotency"),
      ),
    ).not.toContain(auth.secret);
    expect(
      JSON.stringify(await rt.database.query("SELECT * FROM audit_events")),
    ).not.toContain(auth.secret);
    await expect(
      f.authenticateWallet(c.id, "0xabcd", "another-signin-key"),
    ).rejects.toThrow();
  });
  it("re-preparing after owner approval reuses the existing payment operation", async () => {
    const i = await request();
    const one = await f.prepare(a, i.id, "fund", "prepare-first-key"),
      two = await f.prepare(a, i.id, "fund", "prepare-second-key");
    expect(one.operation.id).toBe(two.operation.id);
    expect(
      await rt.database.query("SELECT id FROM payment_operations"),
    ).toHaveLength(1);
  });
});
