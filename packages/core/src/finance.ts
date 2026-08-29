import { createHash, randomBytes, randomUUID } from "node:crypto";
import { keccak256, toHex, erc20Abi, encodeFunctionData } from "viem";
import { z } from "zod";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  DomainError,
  NotFoundError,
  PolicyDeniedError,
} from "./errors.js";
import { AuthorizationPipeline } from "./policy.js";
import {
  requestServiceSchema,
  submitResultSchema,
  idempotencyKeySchema,
} from "./schemas.js";
import {
  addressSchema,
  positiveUnitsSchema,
  escrowCall,
  escrowInvocationId,
  decimalToUnits,
} from "./finance-protocol.js";
import {
  CANONICAL_USDG,
  type FinancialActor,
  type FinancialRepository,
  type FinancialChainPort,
  type FinancialWalletPort,
  type PaidInvocation,
  type FinancialAction,
  type PaymentOperation,
  type EvmHash,
  type EvmAddress,
  type SpendingPolicy,
  type VerifiedEscrowEvent,
  type FinancialSession,
  type SafeCall,
} from "./finance-types.js";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const hashSecret = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function fail(message: string): never {
  throw new DomainError(message, "FINANCIAL_UNAVAILABLE");
}
export const spendingPolicySchema = z
  .object({
    companyId: z.uuid(),
    enabled: z.boolean(),
    maxPerTransaction: positiveUnitsSchema,
    maxPerDay: positiveUnitsSchema,
    sessionExpiresAt: z.iso.datetime(),
    allowedToken: addressSchema,
    allowedContract: addressSchema,
    allowedActions: z
      .array(
        z.enum(["fund", "accept", "submit", "release", "dispute", "refund"]),
      )
      .min(1)
      .max(6),
  })
  .strict();

export class FinancialService {
  private readonly auth = new AuthorizationPipeline();
  constructor(
    readonly repository: FinancialRepository,
    readonly chain: FinancialChainPort,
    readonly wallets: FinancialWalletPort,
    private readonly options: {
      origin: string;
      acceptTimeoutSeconds: number;
      completionTimeoutSeconds: number;
      reviewWindowSeconds: number;
      eventSink?: (event: { name: string; resourceId: string | null }) => void;
    },
  ) {
    for (const n of [
      options.acceptTimeoutSeconds,
      options.completionTimeoutSeconds,
      options.reviewWindowSeconds,
    ])
      if (!Number.isSafeInteger(n) || n <= 0)
        throw new Error("Explicit positive payment deadlines are required.");
  }
  capabilities() {
    const chain = this.chain.capabilities();
    return {
      ...chain,
      state: (!this.wallets.autonomousAvailable ? "blocked" : chain.state) as
        "ready" | "blocked",
      missing: [
        ...chain.missing,
        ...(!this.wallets.available ? ["ALCHEMY_API_KEY"] : []),
        ...(!this.wallets.autonomousAvailable
          ? ["reviewed SessionCustodian integration"]
          : []),
      ],
      autonomousExecution:
        chain.autonomousExecution && this.wallets.autonomousAvailable,
    };
  }
  private actorId(a: FinancialActor) {
    return a.kind === "agent"
      ? `agent:${a.context.principal.agentId}`
      : a.kind === "owner"
        ? `owner:${hashSecret(`${a.owner.issuer}|${a.owner.subject}`)}`
        : `human:${a.wallet.toLowerCase()}`;
  }
  private async authorize(
    repo: FinancialRepository,
    a: FinancialActor,
    companyId?: string,
    spend = false,
  ) {
    if (a.kind === "agent") {
      await this.auth.assert(repo.economy, a.context, {
        scope: spend ? "economy:spend" : "company:read",
        ...(companyId ? { companyId } : {}),
      });
      const c = await repo.economy.getCredential(
        a.context.principal.credentialId,
      );
      if (
        !c ||
        c.agentId !== a.context.principal.agentId ||
        c.revokedAt ||
        (c.expiresAt && c.expiresAt <= new Date()) ||
        !c.scopes.includes(spend ? "economy:spend" : "company:read")
      )
        throw new AuthenticationError();
    } else if (a.kind === "owner") {
      if (!companyId)
        throw new AuthorizationError(
          "Company owner authorization is required.",
        );
      const c = await repo.economy.getCompany(companyId);
      const u = c ? await repo.economy.getUser(c.ownerUserId) : null;
      if (
        !u ||
        u.authIssuer !== a.owner.issuer ||
        u.authSubject !== a.owner.subject
      )
        throw new AuthorizationError(
          "The verified owner does not own this company.",
        );
    } else if (companyId)
      throw new AuthorizationError(
        "A buyer wallet session does not authorize company management.",
      );
  }
  private async scope(
    repo: FinancialRepository,
    a: FinancialActor,
    scope: "jobs:read" | "jobs:write" | "transactions:read",
  ) {
    if (a.kind === "agent")
      await this.auth.assert(repo.economy, a.context, { scope });
  }
  private async mutate<T>(
    a: FinancialActor,
    op: string,
    key: string,
    payload: unknown,
    companyId: string | null,
    run: (r: FinancialRepository) => Promise<T>,
  ): Promise<T> {
    idempotencyKeySchema.parse(key);
    try {
      return await this.repository.transaction(async (r) => {
        await this.authorize(r, a, companyId ?? undefined);
        if (companyId) await r.lockCompany(companyId);
        const claim = await r.claim(this.actorId(a), op, key, digest(payload));
        if (claim.replay) return claim.response as T;
        const result = await run(r);
        await r.audit(op, companyId, null, this.actorId(a));
        await r.complete(this.actorId(a), op, key, result);
        return result;
      });
    } catch (error) {
      if (
        error instanceof AuthorizationError ||
        error instanceof PolicyDeniedError
      ) {
        await this.repository.audit(
          "financial.authorization_denied",
          companyId,
          null,
          this.actorId(a),
        );
        this.options.eventSink?.({
          name: "authorization_denied",
          resourceId: null,
        });
      }
      throw error;
    }
  }
  async getWallet(a: FinancialActor, companyId: string) {
    z.uuid().parse(companyId);
    await this.authorize(this.repository, a, companyId);
    return this.repository.getWallet(companyId);
  }
  async getBalance(a: FinancialActor, companyId: string) {
    const w = await this.getWallet(a, companyId);
    if (!w)
      return {
        state: "unavailable" as const,
        reason: "No owner-verified smart wallet is connected.",
        chainId: 4663,
      };
    try {
      return await this.chain.balances(w.address);
    } catch {
      return {
        state: "unavailable" as const,
        reason: "Verified Robinhood Chain balance data is unavailable.",
        chainId: 4663,
      };
    }
  }
  async getPolicy(a: FinancialActor, companyId: string) {
    await this.authorize(this.repository, a, companyId);
    const p = await this.repository.getPolicy(companyId),
      s = await this.repository.getSession(companyId);
    return {
      policy: p,
      session: s
        ? {
            id: s.id,
            publicKey: s.publicKey,
            expiresAt: s.expiresAt,
            revokedAt: s.revokedAt,
            policyVersion: s.policyVersion,
          }
        : null,
      capabilities: this.capabilities(),
    };
  }
  async getSummary(a: FinancialActor, companyId: string) {
    await this.authorize(this.repository, a, companyId);
    await this.scope(this.repository, a, "transactions:read");
    return this.repository.summary(companyId);
  }
  async getTransactions(a: FinancialActor, companyId: string) {
    await this.authorize(this.repository, a, companyId);
    await this.scope(this.repository, a, "transactions:read");
    return this.repository.history(companyId);
  }
  async getPaymentStatus(a: FinancialActor, id: string) {
    const invocation = await this.getInvocation(a, id);
    const operations = (await this.repository.listOperations(id)).map(
      ({ calls: _, actor: __, ...safe }) => safe,
    );
    return {
      effect: "reads" as const,
      invocation,
      operations,
      financiallyFinalized: ["RELEASED", "REFUNDED"].includes(invocation.state),
    };
  }
  publicSummary(companyId: string) {
    z.uuid().parse(companyId);
    return this.repository.summary(companyId);
  }

  async walletChallenge(wallet: string, key: string) {
    idempotencyKeySchema.parse(key);
    const address = addressSchema.parse(wallet),
      id = randomUUID(),
      expiresAt = new Date(Date.now() + 300_000).toISOString();
    const message = `Normic wallet authentication\nOrigin: ${this.options.origin}\nWallet: ${address}\nChain ID: 4663\nNonce: ${id}\nExpires: ${expiresAt}\nThis signs in only. It authorizes no transactions or token approvals.`;
    return this.repository.transaction(async (r) => {
      const claim = await r.claim(
        `wallet:${address}`,
        "wallet.challenge",
        key,
        digest({ address }),
      );
      if (claim.replay)
        return claim.response as {
          id: string;
          message: string;
          expiresAt: string;
        };
      await r.createChallenge(id, address, message, expiresAt);
      const result = { id, message, expiresAt };
      await r.complete(`wallet:${address}`, "wallet.challenge", key, result);
      return result;
    });
  }
  async authenticateWallet(
    challengeId: string,
    signature: string,
    key: string,
  ) {
    idempotencyKeySchema.parse(key);
    z.uuid().parse(challengeId);
    z.string()
      .regex(/^0x[0-9a-fA-F]+$/)
      .max(16384)
      .parse(signature);
    try {
      return await this.repository.transaction(async (r) => {
        const claim = await r.claim(
          `challenge:${challengeId}`,
          "wallet.authenticate",
          key,
          digest({ challengeId, signature }),
        );
        if (claim.replay)
          return claim.response as {
            secret: string | null;
            expiresAt: string;
            wallet: EvmAddress;
          };
        const c = await r.consumeChallenge(challengeId);
        if (
          !c ||
          !(await this.chain.verifyWalletSignature(
            c.wallet,
            c.message,
            signature as EvmHash,
          ))
        )
          throw new AuthenticationError("Wallet authentication failed.");
        const id = randomUUID(),
          secret = `nmh_${randomBytes(32).toString("base64url")}`,
          expiresAt = new Date(Date.now() + 1800_000).toISOString();
        await r.createHumanSession(id, c.wallet, hashSecret(secret), expiresAt);
        await r.audit("wallet.authenticated", null, null, "human");
        await r.complete(
          `challenge:${challengeId}`,
          "wallet.authenticate",
          key,
          { secret: null, expiresAt, wallet: c.wallet },
        );
        return { secret, expiresAt, wallet: c.wallet };
      });
    } catch (error) {
      await this.repository.audit(
        "wallet.authentication_failed",
        null,
        null,
        "anonymous",
      );
      throw error;
    }
  }
  async humanActor(token: string): Promise<FinancialActor> {
    if (!/^nmh_[a-zA-Z0-9_-]{43}$/.test(token)) throw new AuthenticationError();
    const s = await this.repository.getHumanSession(hashSecret(token));
    if (!s || new Date(s.expiresAt) <= new Date())
      throw new AuthenticationError();
    return { kind: "human", wallet: s.wallet, sessionId: s.id };
  }
  async createWallet(
    a: FinancialActor,
    companyId: string,
    walletProofToken: string,
    key: string,
  ) {
    if (a.kind !== "owner")
      throw new AuthorizationError(
        "Only a verified human owner can connect a smart wallet.",
      );
    const proof = await this.humanActor(walletProofToken);
    if (proof.kind !== "human") throw new AuthenticationError();
    return this.mutate(
      a,
      "wallet.connected",
      key,
      { companyId, ownerAddress: proof.wallet },
      companyId,
      async (r) => {
        if (await r.getWallet(companyId))
          throw new ConflictError(
            "This company already has an immutable wallet identity.",
          );
        if (!this.wallets.available)
          fail("Alchemy Wallet API configuration is missing.");
        await this.chain.validateChain();
        const company = await r.economy.getCompany(companyId);
        if (!company) throw new NotFoundError("Company");
        const account = await this.wallets.requestAccount(proof.wallet);
        const w = {
          companyId,
          agentId: company.primaryAgentId,
          address: account.address.toLowerCase() as EvmAddress,
          ownerAddress: proof.wallet,
          chainId: 4663 as const,
          provider: "alchemy-wallet-api" as const,
          walletType: "erc4337-sma-b" as const,
          authorizationStatus: "owner_verified" as const,
          deployed: account.deployed,
          createdAt: new Date().toISOString(),
        };
        await r.saveWallet(w);
        return w;
      },
    );
  }
  async updatePolicy(
    a: FinancialActor,
    input: z.input<typeof spendingPolicySchema>,
    key: string,
  ) {
    if (a.kind !== "owner")
      throw new AuthorizationError(
        "Agent credentials cannot change financial policies.",
      );
    const p = spendingPolicySchema.parse(input);
    if (
      p.allowedToken.toLowerCase() !== CANONICAL_USDG.toLowerCase() ||
      BigInt(p.maxPerTransaction) > BigInt(p.maxPerDay) ||
      new Date(p.sessionExpiresAt) <= new Date()
    )
      throw new PolicyDeniedError(
        "Invalid token, limits, or session expiration.",
      );
    const escrow = await this.chain.validateEscrow();
    if (
      p.allowedContract.toLowerCase() !== escrow.address.toLowerCase() ||
      BigInt(p.maxPerTransaction) > BigInt(escrow.maxPayment)
    )
      throw new PolicyDeniedError(
        "Only the validated Normic escrow and deployment cap are allowed.",
      );
    return this.mutate(
      a,
      "financial.policy_changed",
      key,
      p,
      p.companyId,
      async (r) => {
        if (!(await r.getWallet(p.companyId)))
          throw new NotFoundError("Wallet");
        const old = await r.getPolicy(p.companyId),
          policy: SpendingPolicy = {
            ...p,
            version: (old?.version ?? 0) + 1,
            updatedAt: new Date().toISOString(),
          };
        await r.savePolicy(policy);
        const session = await r.getSession(p.companyId);
        if (session)
          await r.saveSession({
            ...session,
            revokedAt: new Date().toISOString(),
          });
        return {
          policy,
          requiresOwnerOnchainAuthorization: p.enabled,
          agentApprovalsAllowed: false,
        };
      },
    );
  }
  async registerSession(
    a: FinancialActor,
    input: {
      companyId: string;
      publicKey: string;
      providerSessionId: string;
      authorizationRef: string;
    },
    key: string,
  ) {
    if (a.kind !== "owner")
      throw new AuthorizationError(
        "A verified owner must authorize financial sessions.",
      );
    const p = z
      .object({
        companyId: z.uuid(),
        publicKey: addressSchema,
        providerSessionId: z.string().min(1).max(256),
        authorizationRef: z.string().regex(/^[a-zA-Z0-9_./:-]{1,256}$/),
      })
      .strict()
      .parse(input);
    return this.mutate(
      a,
      "financial.session_authorized",
      key,
      p,
      p.companyId,
      async (r) => {
        const wallet = await r.getWallet(p.companyId),
          policy = await r.getPolicy(p.companyId);
        if (!wallet || !policy?.enabled)
          throw new PolicyDeniedError(
            "Configure an enabled owner policy first.",
          );
        if (p.publicKey.toLowerCase() === wallet.ownerAddress.toLowerCase())
          throw new PolicyDeniedError(
            "The session key must not be the owner's root key.",
          );
        if (await r.getSession(p.companyId))
          throw new ConflictError(
            "Revoke the existing session before authorizing another.",
          );
        const session: FinancialSession = {
          ...p,
          id: randomUUID(),
          expiresAt: policy.sessionExpiresAt,
          revokedAt: null,
          policyVersion: policy.version,
          createdAt: new Date().toISOString(),
        };
        await this.wallets.validateSession(wallet, session, policy);
        await r.saveSession(session);
        return {
          id: session.id,
          publicKey: session.publicKey,
          expiresAt: session.expiresAt,
          policyVersion: session.policyVersion,
        };
      },
    );
  }
  async revokeSession(a: FinancialActor, companyId: string, key: string) {
    if (a.kind !== "owner")
      throw new AuthorizationError(
        "A verified owner must revoke the financial session.",
      );
    return this.mutate(
      a,
      "financial.session_revoked",
      key,
      { companyId },
      companyId,
      async (r) => {
        const p = await r.getPolicy(companyId),
          s = await r.getSession(companyId);
        if (p)
          await r.savePolicy({
            ...p,
            enabled: false,
            version: p.version + 1,
            updatedAt: new Date().toISOString(),
          });
        if (s)
          await r.saveSession({ ...s, revokedAt: new Date().toISOString() });
        return {
          localExecution: "blocked",
          onchainRevocation: "owner_action_required",
          warning:
            "Revoke onchain wallet permissions and escrow spending authorization. Already submitted transactions cannot be undone.",
        };
      },
    );
  }
  async requestService(
    a: FinancialActor,
    input: z.input<typeof requestServiceSchema>,
    key: string,
  ) {
    const p = requestServiceSchema.parse(input);
    if (!this.wallets.autonomousAvailable)
      fail(
        "Provider execution is blocked until a reviewed secure session custodian is connected.",
      );
    if (a.kind === "owner")
      throw new AuthorizationError(
        "Use a wallet-authenticated human buyer session or an agent credential.",
      );
    await this.scope(this.repository, a, "jobs:write");
    const agent =
      a.kind === "agent"
        ? await this.repository.economy.getAgent(a.context.principal.agentId)
        : null;
    const buyerCompanyId = agent?.companyId ?? null;
    return this.mutate(
      a,
      "payment.requested",
      key,
      p,
      buyerCompanyId,
      async (r) => {
        const service = await r.economy.lockServiceForUpdate(p.serviceId);
        if (a.kind === "agent")
          await this.auth.assert(r.economy, a.context, {
            scope: "jobs:write",
            companyId: buyerCompanyId!,
            action: "service:request",
          });
        if (!service || service.status !== "active")
          throw new NotFoundError("Active service");
        if (
          service.pricingModel !== "fixed" ||
          service.quotedCurrency !== "USDG" ||
          !service.quotedPrice
        )
          throw new PolicyDeniedError(
            "Paid services require an explicit fixed USDG price.",
          );
        const provider = await r.getWallet(service.companyId),
          providerCompany = await r.economy.getCompany(service.companyId);
        const buyer = buyerCompanyId ? await r.getWallet(buyerCompanyId) : null;
        const buyerWallet = a.kind === "human" ? a.wallet : buyer?.address;
        if (!provider || !buyerWallet)
          fail(
            "An owner-verified provider wallet and an authenticated buyer wallet are required.",
          );
        if (
          buyerCompanyId === service.companyId ||
          agent?.userId === providerCompany?.ownerUserId ||
          buyerWallet.toLowerCase() === provider.address.toLowerCase() ||
          buyerWallet.toLowerCase() === provider.ownerAddress.toLowerCase() ||
          buyer?.ownerAddress.toLowerCase() ===
            provider.ownerAddress.toLowerCase()
        )
          throw new PolicyDeniedError(
            "Self-payments and same-owner service payments are not allowed.",
          );
        const token = await this.chain.validateToken(),
          escrow = await this.chain.validateEscrow();
        const amount = decimalToUnits(service.quotedPrice, token.decimals);
        if (BigInt(amount) <= 0n || BigInt(amount) > BigInt(escrow.maxPayment))
          throw new PolicyDeniedError(
            "The payment is outside the explicit deployment risk cap.",
          );
        const now = Math.floor(Date.now() / 1000),
          terms = {
            nonce: toHex(randomBytes(32)),
            buyer: buyerWallet,
            provider: provider.address,
            providerOwner: provider.ownerAddress,
            amount,
            acceptBy: String(now + this.options.acceptTimeoutSeconds),
            completeBy: String(
              now +
                this.options.acceptTimeoutSeconds +
                this.options.completionTimeoutSeconds,
            ),
            reviewPeriod: String(this.options.reviewWindowSeconds),
          };
        const i: PaidInvocation = {
          id: randomUUID(),
          onchainId: escrowInvocationId(escrow.address, terms),
          serviceId: service.id,
          providerCompanyId: service.companyId,
          providerAgentId: service.agentId,
          buyerCompanyId,
          buyerAgentId: agent?.id ?? null,
          buyerWallet,
          terms,
          tokenDecimals: token.decimals,
          input: p.input,
          output: null,
          resultHash: null,
          state: "payment_required",
          jobStatus: "created",
          serviceVersion: service.version,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await r.createInvocation(i);
        return i;
      },
    );
  }
  private async party(
    r: FinancialRepository,
    a: FinancialActor,
    i: PaidInvocation,
    role?: "buyer" | "provider",
  ) {
    await this.authorize(
      r,
      a,
      a.kind === "owner" ? i.providerCompanyId : undefined,
    );
    const buyer =
      a.kind === "human"
        ? a.wallet.toLowerCase() === i.buyerWallet.toLowerCase()
        : a.kind === "agent"
          ? a.context.principal.agentId === i.buyerAgentId
          : false;
    const provider =
      a.kind === "agent"
        ? a.context.principal.agentId === i.providerAgentId
        : a.kind === "owner";
    if (
      role === "buyer"
        ? !buyer
        : role === "provider"
          ? !provider
          : !buyer && !provider
    )
      throw new AuthorizationError(
        "This payment is private to its authorized buyer and provider.",
      );
    if (provider && !buyer && i.state === "payment_required")
      throw new AuthorizationError(
        "Providers cannot access paid jobs until funding is finalized.",
      );
  }
  async getInvocation(a: FinancialActor, id: string) {
    z.uuid().parse(id);
    await this.scope(this.repository, a, "jobs:read");
    const i = await this.repository.getInvocation(id);
    if (!i) throw new NotFoundError("Paid invocation");
    await this.party(this.repository, a, i);
    return i;
  }
  async listJobs(a: FinancialActor, role: "buyer" | "provider" = "provider") {
    await this.authorize(this.repository, a);
    await this.scope(this.repository, a, "jobs:read");
    if (a.kind === "owner")
      throw new AuthorizationError("Use the company agent's job queue.");
    return this.repository.listInvocations(
      a.kind === "human"
        ? { buyerWallet: a.wallet }
        : role === "provider"
          ? { providerAgentId: a.context.principal.agentId }
          : { buyerAgentId: a.context.principal.agentId },
    );
  }
  private async spending(
    r: FinancialRepository,
    a: FinancialActor,
    i: PaidInvocation,
    action: FinancialAction,
    reserved = true,
  ) {
    if (a.kind !== "agent") return null;
    const companyId = ["accept", "submit"].includes(action)
      ? i.providerCompanyId
      : i.buyerCompanyId;
    if (!companyId)
      throw new AuthorizationError("Company authorization is required.");
    await this.authorize(r, a, companyId, true);
    await r.lockCompany(companyId);
    const wallet = await r.getWallet(companyId),
      policy = await r.getPolicy(companyId),
      session = await r.getSession(companyId);
    if (
      !wallet ||
      !policy?.enabled ||
      !session ||
      session.revokedAt ||
      session.policyVersion !== policy.version ||
      new Date(session.expiresAt) <= new Date() ||
      new Date(policy.sessionExpiresAt) <= new Date() ||
      !policy.allowedActions.includes(action)
    )
      throw new PolicyDeniedError(
        "An active owner-authorized financial policy and session are required.",
      );
    const amount = action === "fund" ? BigInt(i.terms.amount) : 0n;
    if (
      amount > BigInt(policy.maxPerTransaction) ||
      (reserved &&
        action === "fund" &&
        BigInt(await r.reservedToday(companyId)) + amount >
          BigInt(policy.maxPerDay))
    )
      throw new PolicyDeniedError(
        "The payment exceeds the owner per-transaction or daily limit.",
      );
    await this.wallets.validateSession(wallet, session, policy);
    return { wallet, policy, session };
  }
  async prepare(
    a: FinancialActor,
    id: string,
    action: FinancialAction,
    key: string,
  ) {
    const i = await this.getInvocation(a, id);
    await this.scope(this.repository, a, "jobs:write");
    const role = ["accept", "submit"].includes(action) ? "provider" : "buyer";
    await this.party(this.repository, a, i, role);
    const companyId =
      a.kind === "agent"
        ? role === "provider"
          ? i.providerCompanyId
          : i.buyerCompanyId
        : null;
    // Re-check policy on a replay as well as on the eventual broadcast.
    if (a.kind === "agent")
      await this.repository.transaction((r) =>
        this.spending(r, a, i, action, false),
      );
    return this.mutate(
      a,
      `payment.${action}_prepared`,
      key,
      { id, action },
      companyId,
      async (r) => {
        const current = await r.getInvocation(id, true);
        if (!current) throw new NotFoundError("Paid invocation");
        await this.party(r, a, current, role);
        const expected: Record<FinancialAction, string[]> = {
          fund: ["payment_required"],
          accept: ["FUNDED"],
          submit: ["ACCEPTED"],
          release: ["SUBMITTED"],
          dispute: ["SUBMITTED"],
          refund: ["FUNDED", "ACCEPTED"],
        };
        if (!expected[action].includes(current.state))
          throw new ConflictError(
            "The finalized escrow state does not allow this action.",
          );
        const previous = await r.getActionOperation(id, action);
        if (
          previous &&
          (previous.actor !== this.actorId(a) || previous.status !== "prepared")
        )
          throw new ConflictError(
            "An operation already exists. Reconcile it instead of creating another.",
          );
        const escrow = await this.chain.validateEscrow(),
          auth = await this.spending(r, a, current, action, !previous);
        const from =
          role === "provider" ? current.terms.provider : current.buyerWallet;
        const approvals: SafeCall[] = [];
        if (action === "fund") {
          const balance = await this.chain.balances(from);
          if (BigInt(balance.usdg.units) < BigInt(current.terms.amount))
            throw new PolicyDeniedError(
              "The verified USDG wallet balance is insufficient.",
            );
          const allowance = BigInt(await this.chain.allowance(from));
          if (allowance < BigInt(current.terms.amount)) {
            if (a.kind === "agent")
              fail(
                "Owner approval to the verified escrow is required. Agent sessions cannot approve tokens.",
              );
            if (allowance > 0n)
              approvals.push({
                to: CANONICAL_USDG,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [escrow.address, 0n],
                }),
                value: "0x0",
              });
            approvals.push({
              to: CANONICAL_USDG,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "approve",
                args: [escrow.address, BigInt(current.terms.amount)],
              }),
              value: "0x0",
            });
          }
        }
        const operation: PaymentOperation = previous ?? {
          id: randomUUID(),
          invocationId: id,
          action,
          actor: this.actorId(a),
          status: "prepared",
          calls: [
            escrowCall(
              escrow.address,
              action,
              current.onchainId,
              current.terms,
              a.kind === "agent",
              current.resultHash,
            ),
          ],
          providerCallId: null,
          transactionHash: null,
          failureCode: null,
          createdAt: new Date().toISOString(),
          sessionId: auth?.session.id ?? null,
          policyVersion: auth?.policy.version ?? null,
        };
        await r.saveOperation(operation);
        return {
          effect: "prepares" as const,
          operation,
          ownerApprovalCalls: approvals,
          chainId: 4663,
          from,
          requiresSimulation: true,
          warning:
            "Prepared calls are not payments. Only finalized escrow events change accounting.",
        };
      },
    );
  }
  async simulate(a: FinancialActor, operationId: string, key: string) {
    const op = await this.repository.getOperation(z.uuid().parse(operationId));
    if (!op) throw new NotFoundError("Payment operation");
    const i = await this.getInvocation(a, op.invocationId);
    if (op.actor !== this.actorId(a) || op.status !== "prepared")
      throw new AuthorizationError(
        "Only the preparing actor can simulate this pending operation.",
      );
    const from = ["accept", "submit"].includes(op.action)
      ? i.terms.provider
      : i.buyerWallet;
    await this.mutate(
      a,
      "payment.simulation_requested",
      key,
      { operationId },
      null,
      async () => ({ operationId }),
    );
    try {
      await this.chain.simulate(
        from,
        op.calls,
        op.action === "fund" ? i.terms.amount : "0",
      );
    } catch {
      await this.repository.audit(
        "payment.simulation_failed",
        i.buyerCompanyId,
        i.id,
        this.actorId(a),
      );
      fail("Simulation failed. Nothing was broadcast.");
    }
    return {
      effect: "simulates",
      operationId,
      success: true,
      chainId: 4663,
      warning: "Simulation is not a confirmation or a guarantee of inclusion.",
    };
  }
  async execute(a: FinancialActor, operationId: string, key: string) {
    if (a.kind !== "agent")
      throw new AuthorizationError(
        "Human buyers sign prepared calls in their own wallet.",
      );
    if (!this.wallets.available)
      fail("The production wallet/session signer is not configured.");
    const op = await this.repository.getOperation(z.uuid().parse(operationId));
    if (!op) throw new NotFoundError("Payment operation");
    const i = await this.getInvocation(a, op.invocationId);
    await this.mutate(
      a,
      "payment.broadcast_requested",
      key,
      { operationId },
      null,
      async () => ({ operationId }),
    );
    await this.repository.transaction(async (r) => {
      const locked = await r.getOperation(op.id, true);
      if (!locked || locked.actor !== this.actorId(a))
        throw new AuthorizationError("Only the preparing agent can broadcast.");
      if (locked.status !== "prepared")
        throw new ConflictError(
          "This operation was already attempted. Reconcile its existing submission; never broadcast it again.",
        );
      await this.spending(r, a, i, op.action, false);
      await this.chain.simulate(
        ["accept", "submit"].includes(op.action)
          ? i.terms.provider
          : i.buyerWallet,
        op.calls,
        op.action === "fund" ? i.terms.amount : "0",
      );
      await r.saveOperation({ ...locked, status: "broadcasting" });
    });
    try {
      return await this.repository.transaction(async (r) => {
        const authorization = await this.spending(r, a, i, op.action, false);
        if (!authorization)
          throw new AuthorizationError(
            "An active financial session is required.",
          );
        if (
          authorization.session.id !== op.sessionId ||
          authorization.policy.version !== op.policyVersion
        )
          throw new PolicyDeniedError(
            "Financial authorization changed after preparation.",
          );
        await this.chain.validateChain();
        const submission = await this.wallets.execute(
          authorization.wallet,
          authorization.session,
          op,
          authorization.policy,
        );
        await r.saveOperation({
          ...op,
          status: "submitted",
          providerCallId: submission.callId,
        });
        await r.audit(
          "payment.submitted",
          authorization.wallet.companyId,
          i.id,
          this.actorId(a),
        );
        return {
          effect: "broadcasts",
          operationId: op.id,
          status: "submitted",
          providerCallId: submission.callId,
          financiallyConfirmed: false,
        };
      });
    } catch {
      await this.repository.saveOperation({
        ...op,
        status: "unknown",
        failureCode: "SUBMISSION_UNCERTAIN",
      });
      fail(
        "Submission status is uncertain. Reconcile this operation before any further attempt.",
      );
    }
  }
  async reconcileOperation(
    a: FinancialActor,
    operationId: string,
    key: string,
  ) {
    const op = await this.repository.getOperation(z.uuid().parse(operationId));
    if (!op) throw new NotFoundError("Payment operation");
    const invocation = await this.getInvocation(a, op.invocationId);
    if (op.actor !== this.actorId(a))
      throw new AuthorizationError(
        "Only the submitting actor can reconcile this operation.",
      );
    if (!op.providerCallId)
      return {
        effect: "waits for finality" as const,
        operationId,
        state: op.status,
        transactionHash: op.transactionHash,
        financiallyConfirmed: false,
        operatorAction:
          op.status === "unknown"
            ? "Investigate wallet nonce and provider history. Never rebroadcast blindly."
            : null,
      };
    await this.mutate(
      a,
      "payment.reconciliation_requested",
      key,
      { operationId },
      null,
      async () => ({ operationId }),
    );
    const status = await this.wallets.status(op.providerCallId);
    if (status.state === "pending" || status.state === "unknown")
      return {
        effect: "waits for finality" as const,
        operationId,
        ...status,
        financiallyConfirmed: false,
      };
    if (status.state === "failed") {
      await this.repository.transaction(async (r) => {
        const locked = await r.getOperation(op.id, true);
        if (locked && !locked.transactionHash)
          await r.saveOperation({
            ...locked,
            status: "failed",
            failureCode: "PROVIDER_CONFIRMED_FAILURE",
          });
        await r.audit(
          "payment.failed",
          invocation.buyerCompanyId,
          invocation.id,
          this.actorId(a),
        );
      });
      return {
        effect: "waits for finality" as const,
        operationId,
        ...status,
        financiallyConfirmed: false,
      };
    }
    if (!status.transactionHash)
      fail("The wallet provider did not return a transaction hash.");
    const events = await this.chain.verifyReceipt(status.transactionHash);
    if (!events.some((e) => e.invocationId === invocation.onchainId))
      throw new ConflictError(
        "The finalized wallet receipt does not match this invocation.",
      );
    await this.ingest(events);
    return {
      effect: "waits for finality" as const,
      operationId,
      state: "confirmed" as const,
      transactionHash: status.transactionHash,
      financiallyConfirmed: true,
    };
  }
  async startJob(a: FinancialActor, id: string, key: string) {
    const i = await this.getInvocation(a, id);
    await this.party(this.repository, a, i, "provider");
    await this.scope(this.repository, a, "jobs:write");
    return this.mutate(
      a,
      "paid_job.started",
      key,
      { id },
      i.providerCompanyId,
      async (r) => {
        const current = await r.getInvocation(id, true);
        if (
          !current ||
          current.state !== "ACCEPTED" ||
          current.jobStatus !== "created"
        )
          throw new ConflictError("An onchain-accepted job is required.");
        const next = {
          ...current,
          jobStatus: "processing" as const,
          updatedAt: new Date().toISOString(),
        };
        await r.saveInvocation(next);
        return next;
      },
    );
  }
  async submitResult(
    a: FinancialActor,
    input: z.input<typeof submitResultSchema>,
    key: string,
  ) {
    const p = submitResultSchema.parse(input),
      i = await this.getInvocation(a, p.jobId);
    await this.party(this.repository, a, i, "provider");
    await this.scope(this.repository, a, "jobs:write");
    return this.mutate(
      a,
      "paid_job.result_stored",
      key,
      p,
      i.providerCompanyId,
      async (r) => {
        const current = await r.getInvocation(i.id, true);
        if (
          !current ||
          current.state !== "ACCEPTED" ||
          current.jobStatus !== "processing" ||
          current.output !== null
        )
          throw new ConflictError(
            "A processing job without a previous result is required.",
          );
        const resultSalt = toHex(randomBytes(32)),
          resultHash = keccak256(
            toHex(canonicalJson({ salt: resultSalt, output: p.output })),
          );
        const next = {
          ...current,
          output: p.output,
          resultHash,
          resultSalt,
          jobStatus: "completed" as const,
          updatedAt: new Date().toISOString(),
        };
        await r.saveInvocation(next);
        return {
          invocation: next,
          requiresOnchainSubmission: true,
          financiallySettled: false,
        };
      },
    );
  }
  async confirm(a: FinancialActor, id: string, hash: EvmHash, key: string) {
    await this.getInvocation(a, id);
    await this.mutate(
      a,
      "payment.confirmation_requested",
      key,
      { id, hash },
      null,
      async () => ({ id, hash }),
    );
    const events = await this.chain.verifyReceipt(hash);
    const i = await this.repository.getInvocation(id);
    if (!i || !events.some((e) => e.invocationId === i.onchainId))
      throw new ConflictError(
        "The finalized receipt does not match this invocation.",
      );
    await this.ingest(events);
    return this.getInvocation(a, id);
  }
  /** Worker-only entry: never expose arbitrary events as a public endpoint. */
  private async ingest(
    events: VerifiedEscrowEvent[],
    repository = this.repository,
  ) {
    const configured = await this.chain.validateEscrow();
    await repository.transaction(async (r) => {
      for (const e of events) {
        if (
          e.chainId !== 4663 ||
          e.contractAddress.toLowerCase() !== configured.address.toLowerCase()
        )
          throw new ConflictError("Escrow event provenance mismatch.");
        const i = await r.getInvocationByOnchainId(e.invocationId);
        if (!i) {
          await r.audit("payment.unattributed_event", null, null, "indexer");
          continue;
        }
        if (digest(i.terms) !== digest(e.terms))
          throw new ConflictError(
            "Onchain terms differ from the immutable service agreement.",
          );
        if (!(await r.insertEvent(e))) continue;
        let state = i.state;
        if (e.name === "InvocationFunded") {
          state = "FUNDED";
          if (i.buyerCompanyId)
            await r.postJournal(
              e,
              i.buyerCompanyId,
              "restricted_escrow",
              "cash",
              i.terms.amount,
            );
        }
        if (e.name === "InvocationAccepted") state = "ACCEPTED";
        if (e.name === "ResultSubmitted") {
          if (!i.resultHash || i.resultHash !== e.resultHash)
            throw new ConflictError(
              "The onchain result commitment is not the stored result.",
            );
          state = "SUBMITTED";
        }
        if (e.name === "DisputeOpened") state = "DISPUTED";
        if (e.name === "InvocationReleased") {
          state = "RELEASED";
          await r.postJournal(
            e,
            i.providerCompanyId,
            "cash",
            "service_revenue",
            i.terms.amount,
          );
          if (i.buyerCompanyId)
            await r.postJournal(
              e,
              i.buyerCompanyId,
              "service_expense",
              "restricted_escrow",
              i.terms.amount,
            );
        }
        if (e.name === "InvocationRefunded") {
          state = "REFUNDED";
          if (i.buyerCompanyId)
            await r.postJournal(
              e,
              i.buyerCompanyId,
              "cash",
              "restricted_escrow",
              i.terms.amount,
            );
        }
        if (state !== i.state)
          await r.saveInvocation({ ...i, state, updatedAt: e.observedAt });
        const action = (
          {
            InvocationFunded: "fund",
            InvocationAccepted: "accept",
            ResultSubmitted: "submit",
            InvocationReleased: "release",
            InvocationRefunded: "refund",
            DisputeOpened: "dispute",
          } as const
        )[e.name as Exclude<VerifiedEscrowEvent["name"], "DisputeResolved">];
        if (action) {
          const op = await r.getActionOperation(i.id, action);
          if (op)
            await r.saveOperation({
              ...op,
              status: "confirmed",
              transactionHash: e.transactionHash,
              failureCode: null,
            });
        }
        await r.audit(
          `escrow.${e.name}`,
          i.providerCompanyId,
          i.id,
          "indexer",
          { transactionHash: e.transactionHash },
        );
      }
    });
  }
  async reconcile(fromBlock: string) {
    return this.repository.transaction(async (r) => {
      await r.lockIndexer();
      const checkpoint = await r.getCheckpoint();
      if (checkpoint)
        await this.chain.verifyCheckpoint(checkpoint.block, checkpoint.hash);
      const from = checkpoint
        ? (BigInt(checkpoint.block) + 1n).toString()
        : fromBlock;
      const batch = await this.chain.finalizedEvents(from, 250);
      // Events are idempotent. A crash before checkpoint advancement safely replays the batch.
      await this.ingest(batch.events, r);
      for (const wallet of await r.listWallets()) {
        for (const t of await this.chain.incomingTransfers(
          wallet.address,
          from,
          batch.throughBlock,
        )) {
          const settlement = batch.events.some(
            (e) =>
              e.transactionHash === t.transactionHash &&
              e.terms.amount === t.units &&
              ((e.name === "InvocationReleased" &&
                e.terms.provider === wallet.address) ||
                (e.name === "InvocationRefunded" &&
                  e.terms.buyer === wallet.address)),
          );
          if (!settlement)
            await r.observeTransfer(
              wallet.companyId,
              t,
              t.from.toLowerCase() === wallet.ownerAddress.toLowerCase()
                ? "capital"
                : "unattributed",
            );
        }
      }
      if (!checkpoint || BigInt(batch.throughBlock) >= BigInt(checkpoint.block))
        await r.setCheckpoint(batch.throughBlock, batch.blockHash);
      this.options.eventSink?.({ name: "escrow.reconciled", resourceId: null });
      return { events: batch.events.length, throughBlock: batch.throughBlock };
    });
  }
}
