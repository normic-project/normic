import {
  defineChain,
  http,
  toFunctionSelector,
  decodeFunctionData,
  verifyMessage,
  keccak256,
  toHex,
  type Hex,
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import {
  createModularAccountV2,
  predictModularAccountV2Address,
} from "@account-kit/smart-contracts";
import { accountFactoryAbi } from "@account-kit/smart-contracts/experimental";
import {
  CANONICAL_USDG,
  FINANCIAL_CHAIN_ID,
  DomainError,
  PolicyDeniedError,
  canonicalJson,
  escrowAbi,
  addressSchema,
  hashSchema,
  type FinancialWalletPort,
  type FinancialWallet,
  type FinancialSession,
  type SpendingPolicy,
  type PaymentOperation,
  type EvmAddress,
} from "@normic/core";
import type { RobinhoodFinancialChain } from "./robinhood-finance.js";

/** Deployment-owned integration. Implementations must validate the full user operation,
 * EIP-712 owner authorization and provider-created permission grant before signing.
 * It is intentionally not a generic signHash endpoint and never returns private keys. */
export interface SessionCustodian {
  createSigner(input: {
    companyId: string;
    policyVersion: number;
    idempotencyKey: string;
  }): Promise<{ publicKey: EvmAddress; signerRef: string }>;
  verifyAuthorization(input: {
    wallet: FinancialWallet;
    session: FinancialSession;
    policy: SpendingPolicy;
    selectors: string[];
  }): Promise<{ ownerAuthorization: Hex }>;
  approveOperation(input: {
    wallet: FinancialWallet;
    session: FinancialSession;
    operation: PaymentOperation;
    policy: SpendingPolicy;
    selectors: Hex[];
    chainId: 4663;
  }): Promise<{ approvalTicket: string }>;
  signApprovedOperation(input: {
    wallet: FinancialWallet;
    session: FinancialSession;
    operation: PaymentOperation;
    policy: SpendingPolicy;
    selectors: Hex[];
    approvalTicket: string;
    prepared: Record<string, unknown>;
  }): Promise<Hex>;
  revoke(session: FinancialSession): Promise<void>;
}
const signatures = {
  fund: "fundWithSession((bytes32,address,address,address,uint256,uint64,uint64,uint64))",
  accept: "accept(bytes32)",
  submit: "submitResult(bytes32,bytes32)",
  release: "acceptResult(bytes32)",
  dispute: "dispute(bytes32)",
  refund: "refund(bytes32)",
} as const;
const WEBAUTHN_MAV2_FACTORY =
  "0x55010E571dCf07e254994bfc88b9C1C8FAe31960" as const;
const WEBAUTHN_VALIDATION_MODULE =
  "0x0000000000001D9d34E07D9834274dF9ae575217" as const;
// Account Kit 4.88.5 getDefaultMAV2Address; the WebAuthn factory uses MA,
// not EOA-based SMA bytecode. Never label this root as a Privy/EOA SMA.
const WEBAUTHN_MAV2_IMPLEMENTATION =
  "0x00000000000002377B26b1EdA7b0BC371C60DD4f";
export function sessionSelectors(policy: SpendingPolicy): Hex[] {
  return [
    ...new Set(
      policy.allowedActions.map((a) => toFunctionSelector(signatures[a])),
    ),
  ].sort();
}
export function sessionPermissions(policy: SpendingPolicy) {
  if (
    policy.allowedToken.toLowerCase() !== CANONICAL_USDG.toLowerCase() ||
    BigInt(policy.maxPerTransaction) > BigInt(policy.maxPerDay)
  )
    throw new PolicyDeniedError("Invalid USDG session permission limits.");
  return [
    {
      type: "erc20-token-transfer" as const,
      data: {
        address: CANONICAL_USDG.toLowerCase() as EvmAddress,
        allowance: toHex(BigInt(policy.maxPerDay)),
      },
    },
    {
      type: "functions-on-contract" as const,
      data: {
        address: policy.allowedContract.toLowerCase() as EvmAddress,
        functions: sessionSelectors(policy),
      },
    },
  ];
}
export const sessionPermissionDigest = (policy: SpendingPolicy) =>
  keccak256(toHex(canonicalJson(sessionPermissions(policy))));
export class AlchemyFinancialWallet implements FinancialWalletPort {
  readonly available: boolean;
  readonly autonomousAvailable: boolean;
  constructor(
    private readonly chain: RobinhoodFinancialChain,
    private readonly apiKey?: string,
    private readonly custodian?: SessionCustodian,
    private readonly rpcUrl?: string,
  ) {
    this.available = !!apiKey && !!rpcUrl;
    this.autonomousAvailable = !!apiKey && !!custodian;
  }
  private async request(method: string, params: unknown[]): Promise<unknown> {
    if (!this.apiKey)
      throw new DomainError(
        "Alchemy Wallet API credentials are not configured.",
        "FINANCIAL_UNAVAILABLE",
      );
    try {
      const response = await fetch(
        `https://api.g.alchemy.com/v2/${encodeURIComponent(this.apiKey)}`,
        {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: crypto.randomUUID(),
            method,
            params,
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error();
      const data = (await response.json()) as {
        error?: unknown;
        result?: unknown;
      };
      if (data.error || data.result === undefined) throw new Error();
      return data.result;
    } catch {
      throw new DomainError(
        "The configured wallet provider could not complete this operation.",
        "FINANCIAL_UNAVAILABLE",
      );
    }
  }
  async provisionWebAuthnAccount(input: {
    credentialId: string;
    publicKey: Hex;
    rpId: "normic.tech";
    validationEntityId: 0;
    salt: "0";
  }) {
    if (!this.rpcUrl || !this.apiKey)
      throw new DomainError(
        "Alchemy wallet infrastructure is not configured.",
        "FINANCIAL_UNAVAILABLE",
      );
    await this.chain.validateChain();
    if (
      input.rpId !== "normic.tech" ||
      input.validationEntityId !== 0 ||
      input.salt !== "0" ||
      !/^0x[0-9a-fA-F]{128}$/.test(input.publicKey) ||
      !/^[A-Za-z0-9_-]{1,4096}$/.test(input.credentialId)
    )
      throw new PolicyDeniedError("Invalid WebAuthn MAv2 root parameters.");
    const client = this.chain.client!;
    const [factoryCode, validationCode, entryPointCode] = await Promise.all([
      client.getCode({ address: WEBAUTHN_MAV2_FACTORY }),
      client.getCode({ address: WEBAUTHN_VALIDATION_MODULE }),
      client.getCode({ address: entryPoint07Address }),
    ]);
    if (
      !factoryCode ||
      factoryCode === "0x" ||
      !validationCode ||
      validationCode === "0x" ||
      !entryPointCode ||
      entryPointCode === "0x"
    )
      throw new DomainError(
        "Required MAv2 WebAuthn contracts are unavailable on Robinhood Mainnet.",
        "FINANCIAL_UNAVAILABLE",
      );
    try {
      const [entryPoint, validationModule, implementation] = await Promise.all([
        client.readContract({
          address: WEBAUTHN_MAV2_FACTORY,
          abi: accountFactoryAbi,
          functionName: "ENTRY_POINT",
        }),
        client.readContract({
          address: WEBAUTHN_MAV2_FACTORY,
          abi: accountFactoryAbi,
          functionName: "WEBAUTHN_VALIDATION_MODULE",
        }),
        client.readContract({
          address: WEBAUTHN_MAV2_FACTORY,
          abi: accountFactoryAbi,
          functionName: "ACCOUNT_IMPL",
        }),
      ]);
      if (
        entryPoint.toLowerCase() !== entryPoint07Address.toLowerCase() ||
        validationModule.toLowerCase() !==
          WEBAUTHN_VALIDATION_MODULE.toLowerCase() ||
        implementation.toLowerCase() !==
          WEBAUTHN_MAV2_IMPLEMENTATION.toLowerCase()
      )
        throw new Error("Invalid WebAuthn factory configuration.");
      const implementationCode = await client.getCode({
        address: implementation,
      });
      if (!implementationCode || implementationCode === "0x")
        throw new Error("Missing MAv2 implementation.");
      const ownerPublicKey = {
        x: BigInt(input.publicKey.slice(0, 66)),
        y: BigInt(`0x${input.publicKey.slice(66)}`),
      };
      const predicted = predictModularAccountV2Address({
        type: "WebAuthn",
        factoryAddress: WEBAUTHN_MAV2_FACTORY,
        implementationAddress: implementation,
        ownerPublicKey,
        salt: 0n,
        entityId: 0,
      });
      const factoryAddress = await client.readContract({
        address: WEBAUTHN_MAV2_FACTORY,
        abi: accountFactoryAbi,
        functionName: "getAddressWebAuthn",
        args: [ownerPublicKey.x, ownerPublicKey.y, 0n, 0],
      });
      if (predicted.toLowerCase() !== factoryAddress.toLowerCase())
        throw new Error("WebAuthn address derivation mismatch.");
      const robinhoodMainnet = defineChain({
        id: FINANCIAL_CHAIN_ID,
        name: "Robinhood Chain Mainnet",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [this.rpcUrl] } },
      });
      const account = await createModularAccountV2({
        mode: "webauthn",
        chain: robinhoodMainnet,
        transport: http(this.rpcUrl, { retryCount: 0, timeout: 10_000 }),
        credential: {
          id: input.credentialId,
          publicKey: input.publicKey,
        },
        rpId: input.rpId,
        // The server receives public metadata only. It cannot perform a root ceremony.
        getFn: async () => {
          throw new PolicyDeniedError(
            "Root signing requires the owner's passkey device.",
          );
        },
        accountAddress: factoryAddress,
        salt: 0n,
        factoryAddress: WEBAUTHN_MAV2_FACTORY,
        signerEntity: { isGlobalValidation: true, entityId: 0 },
      });
      const address = addressSchema.parse(account.address);
      if (address !== predicted.toLowerCase())
        throw new Error("WebAuthn account mismatch.");
      const code = await client.getCode({ address });
      return { address, deployed: !!code && code !== "0x" };
    } catch (error) {
      if (error instanceof DomainError || error instanceof PolicyDeniedError)
        throw error;
      throw new DomainError(
        "Alchemy could not derive the WebAuthn MAv2 account.",
        "FINANCIAL_UNAVAILABLE",
      );
    }
  }
  async prepareSession(
    wallet: FinancialWallet,
    policy: SpendingPolicy,
    idempotencyKey: string,
  ) {
    if (wallet.rootBindingId)
      throw new DomainError(
        "This WebAuthn root must explicitly authorize onchain session installation with its passkey. EOA session authorization is not permitted.",
        "OWNER_ACTION_REQUIRED",
      );
    if (!this.custodian)
      throw new DomainError(
        "A reviewed secure session custodian integration is required.",
        "FINANCIAL_UNAVAILABLE",
      );
    const escrow = await this.chain.validateEscrow({
      requireExecution: false,
    });
    if (
      wallet.chainId !== FINANCIAL_CHAIN_ID ||
      policy.allowedToken.toLowerCase() !== CANONICAL_USDG.toLowerCase() ||
      policy.allowedContract.toLowerCase() !== escrow.address ||
      new Date(policy.sessionExpiresAt) <= new Date()
    )
      throw new PolicyDeniedError("Invalid financial session policy.");
    const { publicKey, signerRef } = await this.custodian.createSigner({
      companyId: wallet.companyId,
      policyVersion: policy.version,
      idempotencyKey,
    });
    if (
      wallet.ownerAddress &&
      publicKey.toLowerCase() === wallet.ownerAddress.toLowerCase()
    )
      throw new PolicyDeniedError("The session key cannot be the owner key.");
    const result = (await this.request("wallet_createSession", [
      {
        account: wallet.address,
        chainId: "0x1237",
        expirySec: Math.floor(
          new Date(policy.sessionExpiresAt).getTime() / 1000,
        ),
        key: { publicKey, type: "secp256k1" },
        permissions: sessionPermissions(policy),
      },
    ])) as {
      sessionId?: unknown;
      signatureRequest?: {
        type?: unknown;
        data?: unknown;
        rawPayload?: unknown;
      };
    };
    const request = result.signatureRequest;
    if (
      typeof result.sessionId !== "string" ||
      result.sessionId.length > 512 ||
      request?.type !== "eth_signTypedData_v4" ||
      !request.data ||
      typeof request.data !== "object" ||
      typeof request.rawPayload !== "string"
    )
      throw new DomainError(
        "The wallet provider returned an invalid session authorization.",
        "FINANCIAL_UNAVAILABLE",
      );
    const rawPayload = hashSchema.parse(request.rawPayload);
    return {
      publicKey,
      providerSessionId: result.sessionId,
      signerRef,
      ownerAuthorizationPayload: rawPayload,
      permissionDigest: sessionPermissionDigest(policy),
      ownerSignatureRequest: {
        type: "eth_signTypedData_v4" as const,
        data: request.data as Record<string, unknown>,
        rawPayload,
      },
    };
  }
  async validateSession(
    wallet: FinancialWallet,
    session: FinancialSession,
    policy: SpendingPolicy,
  ) {
    if (!this.custodian)
      throw new DomainError(
        "A reviewed secure session custodian integration is required. Autonomous execution is blocked.",
        "FINANCIAL_UNAVAILABLE",
      );
    const escrow = await this.chain.validateEscrow({
      requireExecution: false,
    });
    if (
      !policy.enabled ||
      session.revokedAt ||
      session.policyVersion !== policy.version ||
      new Date(session.expiresAt) <= new Date() ||
      escrow.address !== policy.allowedContract.toLowerCase()
    )
      throw new PolicyDeniedError("Financial session is not authorized.");
    if (session.permissionDigest !== sessionPermissionDigest(policy))
      throw new PolicyDeniedError(
        "Onchain session permissions do not match the owner policy.",
      );
    const onchain = (await this.chain.client!.readContract({
      address: escrow.address,
      abi: escrowAbi,
      functionName: "spendingPolicies",
      args: [wallet.address],
    })) as readonly [boolean, bigint, bigint, bigint];
    if (
      !onchain[0] ||
      onchain[1] !==
        BigInt(
          Math.floor(new Date(policy.sessionExpiresAt).getTime() / 1000),
        ) ||
      onchain[2] !== BigInt(policy.maxPerTransaction) ||
      onchain[3] !== BigInt(policy.maxPerDay)
    )
      throw new PolicyDeniedError(
        "Owner onchain escrow policy does not match the local policy.",
      );
    await this.custodian.verifyAuthorization({
      wallet,
      session,
      policy,
      selectors: sessionSelectors(policy),
    });
  }
  async execute(
    wallet: FinancialWallet,
    session: FinancialSession,
    operation: PaymentOperation,
    policy: SpendingPolicy,
  ) {
    if (!this.custodian)
      throw new DomainError(
        "Autonomous signing is unavailable.",
        "FINANCIAL_UNAVAILABLE",
      );
    const escrow = await this.chain.validateEscrow();
    if (operation.calls.length !== 1)
      throw new PolicyDeniedError(
        "Exactly one authorized escrow call is required.",
      );
    for (const c of operation.calls) {
      const decoded = decodeFunctionData({ abi: escrowAbi, data: c.data });
      if (
        c.to.toLowerCase() !== escrow.address ||
        c.value !== "0x0" ||
        decoded.functionName !== signatures[operation.action].split("(")[0]
      )
        throw new PolicyDeniedError("Unapproved autonomous calldata.");
    }
    // The custodian must retrieve the current verified policy itself as well; it
    // never accepts an arbitrary caller-provided signing request.
    const grant = await this.custodian.verifyAuthorization({
      wallet,
      session,
      policy,
      selectors: sessionSelectors(policy),
    });
    const approved = await this.custodian.approveOperation({
      wallet,
      session,
      operation,
      policy,
      selectors: sessionSelectors(policy),
      chainId: FINANCIAL_CHAIN_ID,
    });
    const permissions = {
      sessionId: session.providerSessionId,
      signature: grant.ownerAuthorization,
    };
    const prepared = (await this.request("wallet_prepareCalls", [
      {
        from: wallet.address,
        chainId: "0x1237",
        calls: operation.calls,
        capabilities: { permissions },
      },
    ])) as Record<string, unknown>;
    if (
      prepared.chainId !== "0x1237" ||
      prepared.type !== "user-operation-v070"
    )
      throw new Error("Unexpected wallet operation format or chain.");
    const request = prepared.signatureRequest as {
      type?: string;
      data?: { raw?: Hex };
    };
    if (request?.type !== "personal_sign" || !request.data?.raw)
      throw new Error("Unexpected wallet signature request.");
    await this.chain.validateChain();
    const preparedForSigning = structuredClone(prepared),
      preparedDigest = keccak256(toHex(canonicalJson(preparedForSigning)));
    const signature = await this.custodian.signApprovedOperation({
      wallet,
      session,
      operation,
      policy,
      selectors: sessionSelectors(policy),
      approvalTicket: approved.approvalTicket,
      prepared: preparedForSigning,
    });
    if (preparedDigest !== keccak256(toHex(canonicalJson(preparedForSigning))))
      throw new Error("Prepared wallet operation changed during signing.");
    if (
      !(await verifyMessage({
        address: session.publicKey,
        message: { raw: request.data.raw },
        signature,
      }))
    )
      throw new Error(
        "The secure signer returned an invalid session signature.",
      );
    await this.chain.validateChain();
    const result = await this.request("wallet_sendPreparedCalls", [
      {
        type: prepared.type,
        data: prepared.data,
        chainId: "0x1237",
        capabilities: { permissions },
        signature: { type: "secp256k1", data: signature },
      },
    ]);
    const id =
      typeof result === "string" ? result : (result as { id?: unknown }).id;
    if (typeof id !== "string" || id.length > 512)
      throw new Error("Unknown submission response. Do not resubmit.");
    return { callId: id };
  }
  async revoke(session: FinancialSession): Promise<void> {
    await this.custodian?.revoke(session);
    throw new DomainError(
      "Revoke wallet permissions with the owner wallet. Normic local execution is already blocked.",
      "OWNER_ACTION_REQUIRED",
    );
  }
  async status(callId: string) {
    if (!/^0x[0-9a-fA-F]+$/.test(callId))
      throw new DomainError("Invalid wallet call ID.", "INVALID_INPUT");
    const result = (await this.request("wallet_getCallsStatus", [callId])) as {
      id?: unknown;
      chainId?: unknown;
      status?: unknown;
      receipts?: { status?: unknown; transactionHash?: unknown }[];
    };
    if (
      result.id !== callId ||
      result.chainId !== "0x1237" ||
      typeof result.status !== "number"
    )
      throw new DomainError(
        "Wallet provider returned an unexpected call status.",
        "FINANCIAL_UNAVAILABLE",
      );
    if (result.status === 100)
      return { state: "pending" as const, transactionHash: null };
    if (result.status >= 400)
      return { state: "failed" as const, transactionHash: null };
    if (result.status === 200) {
      const receipt = result.receipts?.find(
        (r) => r.status === "0x1" && typeof r.transactionHash === "string",
      );
      if (!receipt)
        throw new DomainError(
          "Confirmed wallet call has no successful transaction receipt.",
          "FINANCIAL_UNAVAILABLE",
        );
      return {
        state: "confirmed" as const,
        transactionHash: hashSchema.parse(receipt.transactionHash),
      };
    }
    return { state: "unknown" as const, transactionHash: null };
  }
}
