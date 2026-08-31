import { createHash, randomUUID } from "node:crypto";
import { PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import { keccak256, recoverAddress, toHex, type Hex } from "viem";
import {
  CANONICAL_USDG,
  FINANCIAL_CHAIN_ID,
  DomainError,
  PolicyDeniedError,
  canonicalJson,
  hashSchema,
  addressSchema,
  type FinancialSession,
  type FinancialWallet,
  type PaymentOperation,
  type SpendingPolicy,
} from "@normic/core";
import {
  sessionPermissionDigest,
  type SessionCustodian,
} from "./alchemy-wallet.js";

type PrivyWalletRecord = {
  id: string;
  address: string;
  chainType: string;
  exportedAt: number | null;
  importedAt: number | null;
  archivedAt: number | null;
};

export interface PrivySessionSignerTransport {
  createWallet(input: {
    idempotencyKey: string;
    externalId: string;
  }): Promise<PrivyWalletRecord>;
  getWallet(walletId: string): Promise<PrivyWalletRecord>;
  personalSign(wallet: PrivyWalletRecord, payload: Hex): Promise<Hex>;
}

class PrivySdkSessionSignerTransport implements PrivySessionSignerTransport {
  constructor(private readonly client: PrivyClient) {}

  private record(wallet: {
    id: string;
    address: string;
    chain_type: string;
    exported_at: number | null;
    imported_at: number | null;
    archived_at?: number | null;
  }): PrivyWalletRecord {
    return {
      id: wallet.id,
      address: wallet.address,
      chainType: wallet.chain_type,
      exportedAt: wallet.exported_at,
      importedAt: wallet.imported_at,
      archivedAt: wallet.archived_at ?? null,
    };
  }

  async createWallet(input: { idempotencyKey: string; externalId: string }) {
    return this.record(
      await this.client.wallets().create({
        chain_type: "ethereum",
        display_name: "Normic USDG session signer",
        external_id: input.externalId,
        idempotency_key: input.idempotencyKey,
      }),
    );
  }

  async getWallet(walletId: string) {
    return this.record(await this.client.wallets().get(walletId));
  }

  async personalSign(wallet: PrivyWalletRecord, payload: Hex) {
    const account = createViemAccount(this.client, {
      walletId: wallet.id,
      address: addressSchema.parse(wallet.address),
    });
    return account.signMessage({ message: { raw: payload } });
  }
}

type Approval = {
  digest: Hex;
  expiresAt: number;
};

const operationDigest = (input: {
  wallet: FinancialWallet;
  session: FinancialSession;
  operation: PaymentOperation;
  policy: SpendingPolicy;
  selectors: Hex[];
  chainId: 4663;
}) =>
  keccak256(
    toHex(
      canonicalJson({
        chainId: input.chainId,
        wallet: {
          companyId: input.wallet.companyId,
          address: input.wallet.address,
          ownerAddress: input.wallet.ownerAddress,
        },
        session: {
          id: input.session.id,
          publicKey: input.session.publicKey,
          providerSessionId: input.session.providerSessionId,
          signerRef: input.session.signerRef,
          policyVersion: input.session.policyVersion,
          expiresAt: input.session.expiresAt,
          permissionDigest: input.session.permissionDigest,
        },
        operation: {
          id: input.operation.id,
          invocationId: input.operation.invocationId,
          action: input.operation.action,
          actor: input.operation.actor,
          calls: input.operation.calls,
          sessionId: input.operation.sessionId,
          policyVersion: input.operation.policyVersion,
        },
        policy: input.policy,
        selectors: [...input.selectors].sort(),
      }),
    ),
  );

export class PrivySessionCustodian implements SessionCustodian {
  private readonly approvals = new Map<string, Approval>();
  private readonly revokedSignerRefs = new Set<string>();

  constructor(
    private readonly transport: PrivySessionSignerTransport,
    private readonly now: () => number = Date.now,
  ) {}

  private async signer(session: FinancialSession) {
    if (
      session.revokedAt ||
      this.revokedSignerRefs.has(session.signerRef) ||
      new Date(session.expiresAt).getTime() <= this.now()
    )
      throw new PolicyDeniedError("The financial session is not active.");
    try {
      const wallet = await this.transport.getWallet(session.signerRef);
      if (
        wallet.id !== session.signerRef ||
        wallet.chainType !== "ethereum" ||
        wallet.address.toLowerCase() !== session.publicKey.toLowerCase() ||
        wallet.exportedAt !== null ||
        wallet.importedAt !== null ||
        wallet.archivedAt !== null
      )
        throw new Error();
      return wallet;
    } catch {
      throw new DomainError(
        "The configured secure session signer is unavailable.",
        "FINANCIAL_UNAVAILABLE",
      );
    }
  }

  async createSigner(input: {
    companyId: string;
    policyVersion: number;
    idempotencyKey: string;
  }) {
    const providerKey = createHash("sha256")
      .update(
        `normic:privy-session:${input.companyId}:${input.policyVersion}:${input.idempotencyKey}`,
      )
      .digest("hex");
    try {
      const wallet = await this.transport.createWallet({
        idempotencyKey: providerKey,
        externalId: `normic_${input.companyId.replaceAll("-", "")}_${input.policyVersion}`,
      });
      if (
        wallet.chainType !== "ethereum" ||
        wallet.exportedAt !== null ||
        wallet.importedAt !== null ||
        wallet.archivedAt !== null
      )
        throw new Error();
      return {
        publicKey: addressSchema.parse(wallet.address),
        signerRef: wallet.id,
      };
    } catch {
      throw new DomainError(
        "The secure session signer could not be created.",
        "FINANCIAL_UNAVAILABLE",
      );
    }
  }

  async verifyAuthorization(input: {
    wallet: FinancialWallet;
    session: FinancialSession;
    policy: SpendingPolicy;
    selectors: string[];
  }) {
    if (input.wallet.rootBindingId)
      throw new PolicyDeniedError(
        "The WebAuthn root owner must authorize this session directly.",
      );
    if (
      input.wallet.chainId !== FINANCIAL_CHAIN_ID ||
      input.policy.allowedToken.toLowerCase() !==
        CANONICAL_USDG.toLowerCase() ||
      input.policy.allowedContract.toLowerCase() ===
        CANONICAL_USDG.toLowerCase() ||
      input.session.companyId !== input.wallet.companyId ||
      input.session.policyVersion !== input.policy.version ||
      input.session.permissionDigest !==
        sessionPermissionDigest(input.policy) ||
      input.selectors.length === 0
    )
      throw new PolicyDeniedError("Financial session binding is invalid.");
    await this.signer(input.session);
    let recovered: string;
    try {
      recovered = await recoverAddress({
        hash: input.session.ownerAuthorizationPayload,
        signature: input.session.ownerAuthorization,
      });
    } catch {
      throw new PolicyDeniedError(
        "The owner did not authorize this financial session.",
      );
    }
    if (recovered.toLowerCase() !== input.wallet.ownerAddress.toLowerCase())
      throw new PolicyDeniedError(
        "The owner did not authorize this financial session.",
      );
    return { ownerAuthorization: input.session.ownerAuthorization };
  }

  async approveOperation(input: {
    wallet: FinancialWallet;
    session: FinancialSession;
    operation: PaymentOperation;
    policy: SpendingPolicy;
    selectors: Hex[];
    chainId: 4663;
  }) {
    await this.verifyAuthorization(input);
    const approvalTicket = randomUUID();
    this.approvals.set(approvalTicket, {
      digest: operationDigest(input),
      expiresAt: Math.min(
        this.now() + 30_000,
        new Date(input.session.expiresAt).getTime(),
      ),
    });
    return { approvalTicket };
  }

  async signApprovedOperation(input: {
    wallet: FinancialWallet;
    session: FinancialSession;
    operation: PaymentOperation;
    policy: SpendingPolicy;
    selectors: Hex[];
    approvalTicket: string;
    prepared: Record<string, unknown>;
  }) {
    const approval = this.approvals.get(input.approvalTicket);
    this.approvals.delete(input.approvalTicket);
    if (
      !approval ||
      approval.expiresAt <= this.now() ||
      approval.digest !==
        operationDigest({ ...input, chainId: FINANCIAL_CHAIN_ID })
    )
      throw new PolicyDeniedError(
        "The prepared call is not bound to an approved Normic action.",
      );
    if (
      input.prepared.chainId !== "0x1237" ||
      input.prepared.type !== "user-operation-v070"
    )
      throw new PolicyDeniedError("The prepared wallet operation is invalid.");
    const request = input.prepared.signatureRequest as {
      type?: unknown;
      data?: { raw?: unknown };
    };
    if (
      request?.type !== "personal_sign" ||
      typeof request.data?.raw !== "string"
    )
      throw new PolicyDeniedError("The wallet signature request is invalid.");
    const payload = hashSchema.parse(request.data.raw);
    const signer = await this.signer(input.session);
    try {
      return await this.transport.personalSign(signer, payload);
    } catch {
      throw new DomainError(
        "The secure session signer could not sign the approved operation.",
        "FINANCIAL_UNAVAILABLE",
      );
    }
  }

  async revoke(session: FinancialSession) {
    this.revokedSignerRefs.add(session.signerRef);
    for (const ticket of this.approvals.keys()) this.approvals.delete(ticket);
  }
}

export function createPrivySessionCustodianFromEnvironment(
  env: Record<string, string | undefined>,
) {
  if (env.NORMIC_CUSTODY_PROVIDER !== "privy") return undefined;
  const appId = env.PRIVY_APP_ID?.trim(),
    appSecret = env.PRIVY_APP_SECRET?.trim(),
    credentialRef = env.NORMIC_CUSTODY_CREDENTIAL_REF?.trim();
  if (!appId || !appSecret || credentialRef !== `privy-app:${appId}`)
    return undefined;
  return new PrivySessionCustodian(
    new PrivySdkSessionSignerTransport(new PrivyClient({ appId, appSecret })),
  );
}
