import { createHash, ECDH, randomBytes, randomUUID } from "node:crypto";
import { keccak256, toHex, erc20Abi, encodeFunctionData } from "viem";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  decodeCredentialPublicKey,
  isoCBOR,
} from "@simplewebauthn/server/helpers";
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
  type FinancialSessionAuthorization,
  type FinancialRootBinding,
  type FinancialWebAuthnCredential,
  type FinancialWebAuthnChallengePurpose,
  type FinancialWebAuthnRegistrationResponse,
  type FinancialWebAuthnAuthenticationResponse,
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
export const FINANCIAL_WEBAUTHN_RP_ID = "normic.tech" as const;
export const FINANCIAL_WEBAUTHN_ORIGIN = "https://normic.tech" as const;
const FINANCIAL_WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60_000;
const base64url = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+$/);
export const financialWebAuthnRegistrationResponseSchema = z
  .object({
    id: base64url,
    rawId: base64url,
    type: z.literal("public-key"),
    response: z
      .object({
        attestationObject: base64url,
        clientDataJSON: base64url,
        transports: z
          .array(
            z.enum([
              "ble",
              "cable",
              "hybrid",
              "internal",
              "nfc",
              "smart-card",
              "usb",
            ]),
          )
          .max(7)
          .optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: base64url.optional(),
        authenticatorData: base64url.optional(),
      })
      .strict(),
    clientExtensionResults: z.record(z.string(), z.unknown()),
    authenticatorAttachment: z.string().max(64).optional(),
  })
  .strict();
export const financialWebAuthnAuthenticationResponseSchema = z
  .object({
    id: base64url,
    rawId: base64url,
    type: z.literal("public-key"),
    response: z
      .object({
        authenticatorData: base64url,
        clientDataJSON: base64url,
        signature: base64url,
        userHandle: base64url.optional(),
      })
      .strict(),
    clientExtensionResults: z.record(z.string(), z.unknown()),
    authenticatorAttachment: z.string().max(64).optional(),
  })
  .strict();

function clientChallenge(clientDataJSON: string) {
  try {
    const parsed = JSON.parse(
      Buffer.from(clientDataJSON, "base64url").toString("utf8"),
    ) as unknown;
    return z
      .object({
        challenge: base64url,
        crossOrigin: z.literal(false).optional(),
        topOrigin: z.never().optional(),
      })
      .passthrough()
      .parse(parsed).challenge;
  } catch {
    throw new AuthenticationError("The passkey response is invalid.");
  }
}

function p256PublicKey(credentialPublicKey: Uint8Array) {
  const key: unknown = decodeCredentialPublicKey(
    Uint8Array.from(credentialPublicKey),
  );
  if (!(key instanceof Map))
    throw new AuthenticationError("A P-256 passkey is required.");
  if (
    key.get(1) !== 2 ||
    key.get(3) !== -7 ||
    key.get(-1) !== 1 ||
    [...key.keys()].some((field) => ![1, 3, -1, -2, -3].includes(field))
  )
    throw new AuthenticationError("A P-256 passkey is required.");
  const rawX = key.get(-2),
    rawY = key.get(-3);
  if (
    !(rawX instanceof Uint8Array) ||
    !(rawY instanceof Uint8Array) ||
    rawX.length !== 32 ||
    rawY.length !== 32
  )
    throw new AuthenticationError("A P-256 passkey is required.");
  const x = Buffer.from(rawX),
    y = Buffer.from(rawY);
  // Reject off-curve points, not just correctly sized untrusted coordinates.
  try {
    ECDH.convertKey(Buffer.concat([Buffer.from([4]), x, y]), "prime256v1");
  } catch {
    throw new AuthenticationError("A valid P-256 passkey is required.");
  }
  return {
    x: x.toString("base64url"),
    y: y.toString("base64url"),
    publicKey: `0x${x.toString("hex")}${y.toString("hex")}` as EvmHash,
    rootIdentity: `webauthn-p256:${createHash("sha256")
      .update(Buffer.concat([x, y]))
      .digest("hex")}` as const,
  };
}
function credentialCose(credential: FinancialWebAuthnCredential) {
  // Reconstruct only the public COSE fields; never persist arbitrary attestation key material.
  return isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(credential.publicKeyX, "base64url")],
      [-3, Buffer.from(credential.publicKeyY, "base64url")],
    ]),
  );
}
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
    persistResponse = true,
  ): Promise<T> {
    idempotencyKeySchema.parse(key);
    try {
      return await this.repository.transaction(async (r) => {
        await this.authorize(r, a, companyId ?? undefined);
        if (companyId) await r.lockCompany(companyId);
        const claim = await r.claim(this.actorId(a), op, key, digest(payload));
        if (claim.replay) {
          if (!persistResponse)
            throw new ConflictError(
              "Request a new passkey challenge to retry.",
            );
          return claim.response as T;
        }
        const result = await run(r);
        await r.audit(op, companyId, null, this.actorId(a));
        await r.complete(
          this.actorId(a),
          op,
          key,
          persistResponse ? result : { challengeIssued: true },
        );
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
  private async requireWalletAgent(r: FinancialRepository, a: FinancialActor) {
    if (a.kind !== "agent")
      throw new AuthorizationError("An authenticated MCP agent is required.");
    await this.authorize(r, a);
    const p = a.context.principal;
    const agent = await r.economy.getAgent(p.agentId);
    const company = agent ? await r.economy.getCompany(agent.companyId) : null;
    const owner = company ? await r.economy.getUser(company.ownerUserId) : null;
    const credential = await r.economy.getCredential(p.credentialId);
    if (
      !agent ||
      !company ||
      !owner?.authSubject ||
      !owner.authIssuer ||
      company.primaryAgentId !== agent.id ||
      company.ownerUserId !== p.userId ||
      agent.userId !== owner.id ||
      owner.authIssuer !== p.issuer ||
      !credential ||
      credential.audience !== p.audience ||
      !(await r.economy.hasDynamicOAuthGrant({
        audience: credential.audience,
        ownerSubject: owner.authSubject,
        agentId: agent.id,
        credentialId: credential.id,
      }))
    )
      throw new AuthorizationError(
        "A connected agent with a trusted owner grant is required.",
      );
    return { company, agent, credential };
  }
  async prepareWallet(a: FinancialActor, requestId: string) {
    // A UUID is an idempotency handle, not an owner authorization or passkey challenge.
    z.uuid().parse(requestId);
    const { company, agent, credential } = await this.requireWalletAgent(
      this.repository,
      a,
    );
    const wallet = await this.getWallet(a, company.id);
    if (wallet)
      return {
        state: "READY",
        companyId: company.id,
        chainId: wallet.chainId,
        address: wallet.address,
        deployed: wallet.deployed,
      };
    const approval = await this.mutate(
      a,
      "financial.wallet_owner_approval_requested",
      requestId,
      { companyId: company.id, credentialId: credential.id },
      company.id,
      async (r) => {
        await this.requireWalletAgent(r, a);
        await this.reserveFinancialRoot(r, company.id, company.ownerUserId);
        return {
          companyId: company.id,
          agentId: agent.id,
          credentialId: credential.id,
          ownerUserId: company.ownerUserId,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        };
      },
    );
    if (Date.parse(approval.expiresAt) <= Date.now())
      throw new DomainError(
        "Ask your agent for a new wallet approval link.",
        "WALLET_APPROVAL_EXPIRED",
      );
    const url = new URL("/wallet", FINANCIAL_WEBAUTHN_ORIGIN);
    url.searchParams.set("approval", requestId);
    url.searchParams.set("agent", agent.id);
    return {
      state: "OWNER_APPROVAL_REQUIRED",
      companyId: company.id,
      chainId: 4663,
      approvalUrl: url.href,
      expiresAt: approval.expiresAt,
      ownerPasskeyRequired: true,
    };
  }
  async getAgentWallet(a: FinancialActor, companyId?: string) {
    const { company } = await this.requireWalletAgent(this.repository, a);
    if (companyId !== undefined && z.uuid().parse(companyId) !== company.id)
      throw new AuthorizationError("The wallet belongs to another company.");
    const wallet = await this.getWallet(a, company.id);
    return wallet
      ? {
          state: "READY",
          companyId: company.id,
          chainId: wallet.chainId,
          address: wallet.address,
          deployed: wallet.deployed,
        }
      : {
          state: "NOT_CREATED",
          companyId: company.id,
          chainId: 4663,
          address: null,
        };
  }
  async getWalletOwnerApproval(
    a: FinancialActor,
    companyId: string,
    agentId: string,
    requestId: string,
  ) {
    if (a.kind !== "owner")
      throw new AuthorizationError(
        "A verified owner must review wallet preparation.",
      );
    z.uuid().parse(companyId);
    z.uuid().parse(agentId);
    z.uuid().parse(requestId);
    await this.authorize(this.repository, a, companyId);
    const approval = await this.repository.getWalletOwnerApproval(
      agentId,
      requestId,
    );
    const company = await this.repository.economy.getCompany(companyId);
    if (
      !approval ||
      approval.companyId !== companyId ||
      approval.agentId !== agentId ||
      approval.ownerUserId !== company?.ownerUserId
    )
      throw new AuthorizationError(
        "This wallet request does not belong to this owner and company.",
      );
    if (
      Date.parse(approval.expiresAt) <= Date.now() ||
      !Number.isFinite(Date.parse(approval.expiresAt))
    )
      throw new DomainError(
        "Ask your agent for a new wallet approval link.",
        "WALLET_APPROVAL_EXPIRED",
      );
    const credential = await this.repository.economy.getCredential(
      approval.credentialId,
    );
    if (
      !credential ||
      credential.agentId !== agentId ||
      credential.revokedAt ||
      (credential.expiresAt && credential.expiresAt <= new Date())
    )
      throw new AuthorizationError(
        "The requesting MCP credential is no longer active.",
      );
    await this.requireWalletAgent(this.repository, {
      kind: "agent",
      context: {
        principal: {
          agentId,
          userId: approval.ownerUserId,
          credentialId: credential.id,
          scopes: credential.scopes,
          issuer: a.owner.issuer,
          audience: credential.audience,
          expiresAt: credential.expiresAt,
        },
      },
    });
    return {
      companyId,
      state: "OWNER_APPROVAL_REQUIRED",
      expiresAt: approval.expiresAt,
    };
  }
  private async reserveFinancialRoot(
    r: FinancialRepository,
    companyId: string,
    ownerUserId: string,
  ) {
    let binding = await r.getRootBinding(companyId);
    if (binding) {
      if (
        binding.ownerUserId !== ownerUserId ||
        binding.rootType !== "webauthn-mav2" ||
        binding.chainId !== 4663 ||
        binding.status === "revoked"
      )
        throw new ConflictError(
          "The existing financial root binding is invalid or disabled.",
        );
    } else {
      const now = new Date().toISOString();
      binding = {
        id: randomUUID(),
        companyId,
        ownerUserId,
        chainId: 4663,
        rootType: "webauthn-mav2",
        status: "pending_passkey",
        rootIdentity: null,
        smartAccountAddress: null,
        accountSalt: "0",
        createdAt: now,
        updatedAt: now,
      };
      await r.saveRootBinding(binding);
    }
    return {
      companyId,
      chainId: binding.chainId,
      rootType: binding.rootType,
      state: binding.status,
      passkeyEnrollmentRequired: binding.status === "pending_passkey",
      smartAccountAddress: binding.smartAccountAddress,
    };
  }
  async getFinancialIdentity(a: FinancialActor, companyId: string) {
    z.uuid().parse(companyId);
    await this.authorize(this.repository, a, companyId);
    const [root, wallet] = await Promise.all([
      this.repository.getRootBinding(companyId),
      this.repository.getWallet(companyId),
    ]);
    return {
      companyId,
      chainId: 4663 as const,
      rootType: "webauthn-mav2" as const,
      state: root?.status ?? ("uninitialized" as const),
      passkeyEnrollmentRequired: !root || root.status === "pending_passkey",
      smartAccountAddress: root?.smartAccountAddress ?? wallet?.address ?? null,
      counterfactual: wallet ? !wallet.deployed : null,
    };
  }
  async prepareFinancialIdentity(
    a: FinancialActor,
    companyId: string,
    key: string,
  ) {
    if (a.kind !== "owner")
      throw new AuthorizationError(
        "A verified owner must initialize the financial identity.",
      );
    z.uuid().parse(companyId);
    return this.mutate(
      a,
      "financial.root_binding_reserved",
      key,
      { companyId, rootType: "webauthn-mav2", chainId: 4663 },
      companyId,
      async (r) => {
        const company = await r.economy.getCompany(companyId),
          agent = company
            ? await r.economy.getAgent(company.primaryAgentId)
            : null;
        if (!company || !agent || agent.status !== "active")
          throw new PolicyDeniedError(
            "Complete verified owner and agent onboarding first.",
          );
        const credentials = await r.economy.listCredentials(agent.id);
        let authenticatedMcpConnection = false;
        for (const credential of credentials) {
          if (
            !credential.lastUsedAt ||
            credential.revokedAt ||
            (credential.expiresAt && credential.expiresAt <= new Date())
          )
            continue;
          if (
            await r.economy.hasDynamicOAuthGrant({
              audience: credential.audience,
              ownerSubject: a.owner.subject,
              agentId: agent.id,
              credentialId: credential.id,
            })
          ) {
            authenticatedMcpConnection = true;
            break;
          }
        }
        if (!authenticatedMcpConnection)
          throw new PolicyDeniedError(
            "A real authenticated MCP connection is required before financial identity initialization.",
          );
        return this.reserveFinancialRoot(r, companyId, company.ownerUserId);
      },
    );
  }
  async beginPasskeyRegistration(
    a: FinancialActor,
    companyId: string,
    purpose: "primary" | "recovery",
    key: string,
  ) {
    if (a.kind !== "owner")
      throw new AuthorizationError(
        "A verified owner must create the financial passkey.",
      );
    return this.mutate(
      a,
      `financial.passkey_${purpose}_challenge`,
      key,
      { companyId, purpose },
      companyId,
      async (r) => {
        await this.requireConnectedOwner(r, a, companyId);
        const root = await r.getRootBinding(companyId);
        const company = await r.economy.getCompany(companyId);
        if (!root || !company || root.ownerUserId !== company.ownerUserId)
          throw new NotFoundError("Financial root binding");
        if (
          (purpose === "primary" && root.status !== "pending_passkey") ||
          purpose === "recovery"
        )
          throw new PolicyDeniedError(
            purpose === "recovery"
              ? "Authorize recovery enrollment with an active passkey first."
              : "The primary financial passkey cannot be replaced.",
          );
        const credentials = await r.listWebAuthnCredentials(root.id);
        const options = await generateRegistrationOptions({
          rpName: "Normic",
          rpID: FINANCIAL_WEBAUTHN_RP_ID,
          userID: Buffer.from(company.id, "utf8"),
          userName: company.slug,
          userDisplayName: company.name,
          attestationType: "none",
          authenticatorSelection: {
            residentKey: "required",
            userVerification: "required",
          },
          supportedAlgorithmIDs: [-7],
          timeout: FINANCIAL_WEBAUTHN_CHALLENGE_TTL_MS,
          excludeCredentials: credentials.map((credential) => ({
            id: credential.credentialId,
            transports: credential.transports as never,
          })),
        });
        await r.createWebAuthnChallenge({
          id: randomUUID(),
          rootBindingId: root.id,
          ownerUserId: root.ownerUserId,
          challengeHash: hashSecret(options.challenge),
          purpose: `register_${purpose}`,
          expiresAt: new Date(
            Date.now() + FINANCIAL_WEBAUTHN_CHALLENGE_TTL_MS,
          ).toISOString(),
        });
        return options;
      },
      false,
    );
  }
  async completePasskeyRegistration(
    a: FinancialActor,
    companyId: string,
    purpose: "primary" | "recovery",
    rawResponse: FinancialWebAuthnRegistrationResponse,
    key: string,
  ) {
    if (a.kind !== "owner")
      throw new AuthorizationError(
        "A verified owner must create the financial passkey.",
      );
    const response =
      financialWebAuthnRegistrationResponseSchema.parse(rawResponse);
    const challenge = clientChallenge(response.response.clientDataJSON);
    return this.mutate(
      a,
      `financial.passkey_${purpose}_registered`,
      key,
      { companyId, purpose, response },
      companyId,
      async (r) => {
        await this.requireConnectedOwner(r, a, companyId);
        const root = await r.getRootBinding(companyId);
        const company = await r.economy.getCompany(companyId);
        if (!root || !company || root.ownerUserId !== company.ownerUserId)
          throw new NotFoundError("Financial root binding");
        if (
          (purpose === "primary" && root.status !== "pending_passkey") ||
          (purpose === "recovery" && root.status !== "provisioned")
        )
          throw new ConflictError(
            purpose === "primary"
              ? "This company already has an immutable financial root."
              : "The financial root is not active.",
          );
        const challengePurpose: FinancialWebAuthnChallengePurpose = `register_${purpose}`;
        if (
          !(await r.consumeWebAuthnChallenge({
            rootBindingId: root.id,
            ownerUserId: root.ownerUserId,
            challengeHash: hashSecret(challenge),
            purpose: challengePurpose,
          }))
        )
          throw new AuthenticationError(
            "The passkey challenge is expired or already used.",
          );
        const verification = await verifyRegistrationResponse({
          response: response as RegistrationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: FINANCIAL_WEBAUTHN_ORIGIN,
          expectedRPID: FINANCIAL_WEBAUTHN_RP_ID,
          requireUserPresence: true,
          requireUserVerification: true,
          supportedAlgorithmIDs: [-7],
        }).catch(() => {
          throw new AuthenticationError(
            "The passkey registration could not be verified. Request a new challenge.",
          );
        });
        if (
          !verification.verified ||
          !verification.registrationInfo.userVerified ||
          verification.registrationInfo.rpID !== FINANCIAL_WEBAUTHN_RP_ID ||
          verification.registrationInfo.origin !== FINANCIAL_WEBAUTHN_ORIGIN
        )
          throw new AuthenticationError(
            "The passkey registration could not be verified.",
          );
        const info = verification.registrationInfo;
        if (info.credential.id !== response.id)
          throw new AuthenticationError(
            "The passkey credential identity does not match.",
          );
        if (await r.getWebAuthnCredential(info.credential.id, true))
          throw new ConflictError(
            "This passkey is already bound to a Normic financial root.",
          );
        const publicKey = p256PublicKey(info.credential.publicKey);
        const now = new Date().toISOString();
        const credential: FinancialWebAuthnCredential = {
          id: randomUUID(),
          rootBindingId: root.id,
          credentialId: info.credential.id,
          publicKeyX: publicKey.x,
          publicKeyY: publicKey.y,
          algorithm: -7,
          rpId: FINANCIAL_WEBAUTHN_RP_ID,
          transports: response.response.transports ?? [],
          validationEntityId: 0,
          purpose,
          signCount: String(info.credential.counter),
          createdAt: now,
          revokedAt: null,
        };
        await r.saveWebAuthnCredential(credential);
        if (purpose === "recovery") {
          await r.audit(
            "financial.recovery_passkey_registered",
            companyId,
            credential.id,
            this.actorId(a),
          );
          // This is an owner-authorized recovery candidate, NOT installed root authority.
          // Activating it requires an explicit root-signed onchain installValidation.
          return {
            state: "recovery_prepared" as const,
            onchainAuthorizationRequired: true,
          };
        }
        const verifiedRoot: FinancialRootBinding = {
          ...root,
          status: "passkey_verified",
          rootIdentity: publicKey.rootIdentity,
          updatedAt: now,
        };
        await r.updateRootBinding(verifiedRoot);
        return { state: "passkey_verified" as const, companyId };
      },
    );
  }
  private async requireConnectedOwner(
    r: FinancialRepository,
    a: FinancialActor,
    companyId: string,
  ) {
    if (a.kind !== "owner")
      throw new AuthorizationError("A verified owner is required.");
    const company = await r.economy.getCompany(companyId);
    const agent = company
      ? await r.economy.getAgent(company.primaryAgentId)
      : null;
    if (
      !company ||
      !agent ||
      agent.status !== "active" ||
      agent.companyId !== companyId ||
      agent.userId !== company.ownerUserId
    )
      throw new PolicyDeniedError(
        "Complete verified owner and agent onboarding first.",
      );
    for (const credential of await r.economy.listCredentials(agent.id)) {
      if (
        credential.lastUsedAt &&
        !credential.revokedAt &&
        (!credential.expiresAt || credential.expiresAt > new Date()) &&
        (await r.economy.hasDynamicOAuthGrant({
          audience: credential.audience,
          ownerSubject: a.owner.subject,
          agentId: agent.id,
          credentialId: credential.id,
        }))
      )
        return company;
    }
    throw new PolicyDeniedError(
      "A real authenticated MCP connection is required before financial identity initialization.",
    );
  }
  async provisionFinancialWallet(
    a: FinancialActor,
    companyId: string,
    key: string,
  ) {
    if (a.kind !== "owner")
      throw new AuthorizationError(
        "A verified owner must initialize the financial wallet.",
      );
    return this.mutate(
      a,
      "financial.wallet_provisioned",
      key,
      { companyId },
      companyId,
      async (r) => {
        const root = await r.getRootBinding(companyId);
        if (!root || !["passkey_verified", "provisioned"].includes(root.status))
          throw new PolicyDeniedError("Verify your financial passkey first.");
        const existingWallet = await r.getWallet(companyId);
        if (existingWallet) {
          if (
            existingWallet.rootBindingId !== root.id ||
            existingWallet.address !== root.smartAccountAddress
          )
            throw new ConflictError(
              "The existing company financial wallet does not match this root.",
            );
          return existingWallet;
        }
        const company = await this.requireConnectedOwner(r, a, companyId);
        const credential = (await r.listWebAuthnCredentials(root.id)).find(
          (c) => c.purpose === "primary" && !c.revokedAt,
        );
        if (
          !credential ||
          credential.rpId !== FINANCIAL_WEBAUTHN_RP_ID ||
          credential.validationEntityId !== 0
        )
          throw new PolicyDeniedError(
            "The verified financial root is unavailable.",
          );
        const publicKey = p256PublicKey(credentialCose(credential));
        if (publicKey.rootIdentity !== root.rootIdentity)
          throw new PolicyDeniedError(
            "The financial root binding does not match.",
          );
        if (!this.wallets.available)
          fail("Alchemy wallet infrastructure is not configured.");
        await this.chain.validateChain();
        const account = await this.wallets.provisionWebAuthnAccount({
          credentialId: credential.credentialId,
          publicKey: publicKey.publicKey,
          rpId: FINANCIAL_WEBAUTHN_RP_ID,
          validationEntityId: 0,
          salt: "0",
        });
        const now = new Date().toISOString();
        const wallet = {
          companyId,
          agentId: company.primaryAgentId,
          address: addressSchema.parse(account.address),
          ownerAddress: addressSchema.parse(account.address),
          rootBindingId: root.id,
          chainId: 4663 as const,
          provider: "alchemy-wallet-api" as const,
          walletType: "erc4337-mav2-webauthn" as const,
          authorizationStatus: "owner_verified" as const,
          deployed: account.deployed,
          createdAt: now,
        };
        const provisionedRoot: FinancialRootBinding = {
          ...root,
          status: "provisioned",
          smartAccountAddress: wallet.address,
          updatedAt: now,
        };
        await r.updateRootBinding(provisionedRoot);
        await r.saveWallet(wallet);
        return wallet;
      },
    );
  }
  async beginRecoveryAuthorization(
    a: FinancialActor,
    companyId: string,
    key: string,
  ) {
    if (a.kind !== "owner")
      throw new AuthorizationError(
        "A verified owner must authorize recovery enrollment.",
      );
    return this.mutate(
      a,
      "financial.recovery_authorization_challenge",
      key,
      { companyId },
      companyId,
      async (r) => {
        const root = await r.getRootBinding(companyId);
        if (!root || root.status !== "provisioned")
          throw new PolicyDeniedError("The financial root is not active.");
        const credentials = (await r.listWebAuthnCredentials(root.id)).filter(
          (credential) =>
            credential.purpose === "primary" && !credential.revokedAt,
        );
        if (!credentials.length)
          throw new PolicyDeniedError(
            "An active root passkey is required for recovery enrollment.",
          );
        const options = await generateAuthenticationOptions({
          rpID: FINANCIAL_WEBAUTHN_RP_ID,
          userVerification: "required",
          allowCredentials: credentials.map((credential) => ({
            id: credential.credentialId,
            transports: credential.transports as never,
          })),
        });
        await r.createWebAuthnChallenge({
          id: randomUUID(),
          rootBindingId: root.id,
          ownerUserId: root.ownerUserId,
          challengeHash: hashSecret(options.challenge),
          purpose: "root_assertion",
          expiresAt: new Date(
            Date.now() + FINANCIAL_WEBAUTHN_CHALLENGE_TTL_MS,
          ).toISOString(),
        });
        return options;
      },
      false,
    );
  }
  async authorizeRecoveryRegistration(
    a: FinancialActor,
    companyId: string,
    rawResponse: FinancialWebAuthnAuthenticationResponse,
    key: string,
  ) {
    if (a.kind !== "owner")
      throw new AuthorizationError(
        "A verified owner must authorize recovery enrollment.",
      );
    const response =
      financialWebAuthnAuthenticationResponseSchema.parse(rawResponse);
    const challenge = clientChallenge(response.response.clientDataJSON);
    return this.mutate(
      a,
      "financial.recovery_authorized",
      key,
      { companyId, response },
      companyId,
      async (r) => {
        const root = await r.getRootBinding(companyId);
        if (!root || root.status !== "provisioned")
          throw new PolicyDeniedError("The financial root is not active.");
        const credential = await r.getWebAuthnCredential(response.id, true);
        if (
          !credential ||
          credential.purpose !== "primary" ||
          credential.rootBindingId !== root.id ||
          credential.revokedAt
        )
          throw new AuthenticationError(
            "An active root passkey is required for recovery enrollment.",
          );
        if (
          !(await r.consumeWebAuthnChallenge({
            rootBindingId: root.id,
            ownerUserId: root.ownerUserId,
            challengeHash: hashSecret(challenge),
            purpose: "root_assertion",
          }))
        )
          throw new AuthenticationError(
            "The passkey challenge is expired or already used.",
          );
        const verification = await verifyAuthenticationResponse({
          response: response as AuthenticationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: FINANCIAL_WEBAUTHN_ORIGIN,
          expectedRPID: FINANCIAL_WEBAUTHN_RP_ID,
          requireUserVerification: true,
          credential: {
            id: credential.credentialId,
            publicKey: credentialCose(credential),
            counter: Number(credential.signCount),
            transports: credential.transports as never,
          },
        }).catch(() => {
          throw new AuthenticationError(
            "The root passkey assertion could not be verified.",
          );
        });
        if (!verification.verified)
          throw new AuthenticationError(
            "The root passkey assertion could not be verified.",
          );
        await r.updateWebAuthnSignCount(
          credential.credentialId,
          String(verification.authenticationInfo.newCounter),
        );
        const company = await r.economy.getCompany(companyId);
        if (!company) throw new NotFoundError("Company");
        const existing = await r.listWebAuthnCredentials(root.id);
        const options = await generateRegistrationOptions({
          rpName: "Normic",
          rpID: FINANCIAL_WEBAUTHN_RP_ID,
          userID: Buffer.from(company.id, "utf8"),
          userName: company.slug,
          userDisplayName: company.name,
          attestationType: "none",
          authenticatorSelection: {
            residentKey: "required",
            userVerification: "required",
          },
          supportedAlgorithmIDs: [-7],
          excludeCredentials: existing.map((item) => ({
            id: item.credentialId,
            transports: item.transports as never,
          })),
        });
        await r.createWebAuthnChallenge({
          id: randomUUID(),
          rootBindingId: root.id,
          ownerUserId: root.ownerUserId,
          challengeHash: hashSecret(options.challenge),
          purpose: "register_recovery",
          expiresAt: new Date(
            Date.now() + FINANCIAL_WEBAUTHN_CHALLENGE_TTL_MS,
          ).toISOString(),
        });
        return options;
      },
      false,
    );
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
    const escrow = await this.chain.validateEscrow({
      requireExecution: false,
    });
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
      authorizationRef: string;
      ownerAuthorization: string;
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
        authorizationRef: z.uuid(),
        ownerAuthorization: z
          .string()
          .regex(/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/),
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
          policy = await r.getPolicy(p.companyId),
          authorization = await r.getSessionAuthorization(
            p.authorizationRef,
            true,
          );
        if (!wallet || !policy?.enabled)
          throw new PolicyDeniedError(
            "Configure an enabled owner policy first.",
          );
        if (
          !authorization ||
          authorization.companyId !== p.companyId ||
          authorization.consumedAt ||
          authorization.policyVersion !== policy.version ||
          authorization.expiresAt !== policy.sessionExpiresAt ||
          new Date(authorization.expiresAt) <= new Date()
        )
          throw new PolicyDeniedError(
            "The trusted session authorization is invalid or expired.",
          );
        if (
          authorization.publicKey.toLowerCase() ===
          wallet.ownerAddress.toLowerCase()
        )
          throw new PolicyDeniedError(
            "The session key must not be the owner's root key.",
          );
        if (await r.getSession(p.companyId))
          throw new ConflictError(
            "Revoke the existing session before authorizing another.",
          );
        const session: FinancialSession = {
          id: randomUUID(),
          companyId: p.companyId,
          publicKey: authorization.publicKey,
          providerSessionId: authorization.providerSessionId,
          authorizationRef: authorization.id,
          signerRef: authorization.signerRef,
          ownerAuthorization: p.ownerAuthorization as `0x${string}`,
          ownerAuthorizationPayload: authorization.ownerAuthorizationPayload,
          permissionDigest: authorization.permissionDigest,
          expiresAt: policy.sessionExpiresAt,
          revokedAt: null,
          policyVersion: policy.version,
          createdAt: new Date().toISOString(),
        };
        await this.wallets.validateSession(wallet, session, policy);
        await r.saveSession(session);
        await r.saveSessionAuthorization({
          ...authorization,
          consumedAt: new Date().toISOString(),
        });
        return {
          id: session.id,
          publicKey: session.publicKey,
          expiresAt: session.expiresAt,
          policyVersion: session.policyVersion,
        };
      },
    );
  }

  async prepareSessionAuthorization(
    a: FinancialActor,
    companyId: string,
    key: string,
  ) {
    if (a.kind !== "owner")
      throw new AuthorizationError(
        "A verified owner must prepare financial sessions.",
      );
    z.uuid().parse(companyId);
    return this.mutate(
      a,
      "financial.session_prepared",
      key,
      { companyId },
      companyId,
      async (r) => {
        const wallet = await r.getWallet(companyId),
          policy = await r.getPolicy(companyId);
        if (!wallet || !policy?.enabled)
          throw new PolicyDeniedError(
            "Configure an enabled owner policy first.",
          );
        if (await r.getSession(companyId))
          throw new ConflictError(
            "Revoke the existing session before authorizing another.",
          );
        const prepared = await this.wallets.prepareSession(wallet, policy, key);
        const authorization: FinancialSessionAuthorization = {
          id: randomUUID(),
          companyId,
          publicKey: prepared.publicKey,
          providerSessionId: prepared.providerSessionId,
          signerRef: prepared.signerRef,
          ownerAuthorizationPayload: prepared.ownerAuthorizationPayload,
          permissionDigest: prepared.permissionDigest,
          expiresAt: policy.sessionExpiresAt,
          policyVersion: policy.version,
          consumedAt: null,
          createdAt: new Date().toISOString(),
        };
        await r.saveSessionAuthorization(authorization);
        return {
          authorizationRef: authorization.id,
          publicKey: authorization.publicKey,
          expiresAt: authorization.expiresAt,
          ownerSignatureRequest: prepared.ownerSignatureRequest,
        };
      },
    );
  }
  async revokeSession(a: FinancialActor, companyId: string, key: string) {
    if (a.kind !== "owner")
      throw new AuthorizationError(
        "A verified owner must revoke the financial session.",
      );
    let revokedSession: FinancialSession | null = null;
    const result = await this.mutate(
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
        if (s) {
          revokedSession = s;
          await r.saveSession({ ...s, revokedAt: new Date().toISOString() });
        }
        return {
          localExecution: "blocked",
          onchainRevocation: "owner_action_required",
          warning:
            "Revoke onchain wallet permissions and escrow spending authorization. Already submitted transactions cannot be undone.",
        };
      },
    );
    if (revokedSession)
      try {
        await this.wallets.revoke(revokedSession);
      } catch (error) {
        if (!(
          error instanceof DomainError && error.code === "OWNER_ACTION_REQUIRED"
        ))
          throw error;
      }
    return result;
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
