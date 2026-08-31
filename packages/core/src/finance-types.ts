import type { EconomyRepository } from "./repository.js";
import type { RequestContext, JsonObject } from "./types.js";
import type { VerifiedOwner } from "./oauth.js";

export type EvmAddress = `0x${string}`;
export type EvmHash = `0x${string}`;
export const FINANCIAL_CHAIN_ID = 4663;
export const CANONICAL_USDG: EvmAddress =
  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export type FinancialActor =
  | { kind: "agent"; context: RequestContext }
  | { kind: "owner"; owner: VerifiedOwner }
  | { kind: "human"; wallet: EvmAddress; sessionId: string };
export type FinanceState =
  | "payment_required"
  | "FUNDED"
  | "ACCEPTED"
  | "SUBMITTED"
  | "DISPUTED"
  | "RELEASED"
  | "REFUNDED";
export type FinancialAction =
  "fund" | "accept" | "submit" | "release" | "dispute" | "refund";
export type EscrowTerms = {
  nonce: EvmHash;
  buyer: EvmAddress;
  provider: EvmAddress;
  providerOwner: EvmAddress;
  amount: string;
  acceptBy: string;
  completeBy: string;
  reviewPeriod: string;
};
export type FinancialWallet = {
  companyId: string;
  agentId: string;
  address: EvmAddress;
  ownerAddress: EvmAddress;
  chainId: 4663;
  provider: "alchemy-wallet-api";
  walletType: "erc4337-sma-b";
  authorizationStatus: "owner_verified";
  deployed: boolean;
  createdAt: string;
};
export type FinancialRootBinding = {
  id: string;
  companyId: string;
  ownerUserId: string;
  chainId: 4663;
  rootType: "webauthn-mav2";
  status: "pending_passkey" | "passkey_verified" | "provisioned" | "revoked";
  rootIdentity: `webauthn-p256:${string}` | null;
  smartAccountAddress: EvmAddress | null;
  accountSalt: "0";
  createdAt: string;
  updatedAt: string;
};
export type FinancialWebAuthnCredential = {
  id: string;
  rootBindingId: string;
  credentialId: string;
  publicKeyX: string;
  publicKeyY: string;
  algorithm: -7;
  rpId: string;
  transports: string[];
  validationEntityId: number;
  purpose: "primary" | "recovery";
  signCount: string;
  createdAt: string;
  revokedAt: string | null;
};
export type SpendingPolicy = {
  companyId: string;
  enabled: boolean;
  maxPerTransaction: string;
  maxPerDay: string;
  sessionExpiresAt: string;
  allowedToken: EvmAddress;
  allowedContract: EvmAddress;
  allowedActions: FinancialAction[];
  version: number;
  updatedAt: string;
};
export type FinancialSession = {
  id: string;
  companyId: string;
  publicKey: EvmAddress;
  providerSessionId: string;
  authorizationRef: string;
  signerRef: string;
  ownerAuthorization: `0x${string}`;
  ownerAuthorizationPayload: EvmHash;
  permissionDigest: EvmHash;
  expiresAt: string;
  revokedAt: string | null;
  policyVersion: number;
  createdAt: string;
};
export type FinancialSessionAuthorization = {
  id: string;
  companyId: string;
  publicKey: EvmAddress;
  providerSessionId: string;
  signerRef: string;
  ownerAuthorizationPayload: EvmHash;
  permissionDigest: EvmHash;
  expiresAt: string;
  policyVersion: number;
  consumedAt: string | null;
  createdAt: string;
};
export type PaidInvocation = {
  id: string;
  onchainId: EvmHash;
  serviceId: string;
  providerCompanyId: string;
  providerAgentId: string;
  buyerCompanyId: string | null;
  buyerAgentId: string | null;
  buyerWallet: EvmAddress;
  terms: EscrowTerms;
  tokenDecimals: number;
  input: JsonObject;
  output: JsonObject | null;
  resultHash: EvmHash | null;
  resultSalt?: EvmHash;
  state: FinanceState;
  jobStatus: "created" | "processing" | "completed" | "cancelled";
  serviceVersion: number;
  createdAt: string;
  updatedAt: string;
};
export type PaymentOperation = {
  id: string;
  invocationId: string;
  action: FinancialAction;
  actor: string;
  status:
    | "prepared"
    | "broadcasting"
    | "submitted"
    | "confirmed"
    | "failed"
    | "unknown";
  calls: SafeCall[];
  providerCallId: string | null;
  transactionHash: EvmHash | null;
  failureCode: string | null;
  createdAt: string;
  sessionId: string | null;
  policyVersion: number | null;
};
export type SafeCall = { to: EvmAddress; data: EvmHash; value: "0x0" };
export type VerifiedEscrowEvent = {
  chainId: 4663;
  transactionHash: EvmHash;
  logIndex: number;
  blockNumber: string;
  blockHash: EvmHash;
  contractAddress: EvmAddress;
  invocationId: EvmHash;
  name:
    | "InvocationFunded"
    | "InvocationAccepted"
    | "ResultSubmitted"
    | "InvocationReleased"
    | "InvocationRefunded"
    | "DisputeOpened"
    | "DisputeResolved";
  terms: EscrowTerms;
  resultHash: EvmHash | null;
  observedAt: string;
};
export type TokenMetadata = {
  address: EvmAddress;
  chainId: 4663;
  decimals: number;
  symbol: "USDG";
  blockNumber: string;
  source: string;
};
export type WalletBalances = {
  state: "available";
  wallet: EvmAddress;
  chainId: 4663;
  blockNumber: string;
  blockHash: EvmHash;
  timestamp: string;
  source: string;
  eth: { units: string; decimals: 18; symbol: "ETH"; tokenAddress: null };
  usdg: {
    units: string;
    decimals: number;
    symbol: "USDG";
    tokenAddress: EvmAddress;
  };
};
export type FinancialSummary = {
  companyId: string;
  tokenAddress: EvmAddress;
  chainId: 4663;
  unit: "token_base_units";
  verifiedServiceRevenue: string;
  serviceExpenses: string;
  restrictedEscrow: string;
  directTransfersAreRevenue: false;
  source: "finalized_escrow_events";
};
export type FinanceCapabilities = {
  state: "ready" | "blocked";
  missing: string[];
  chainId: 4663;
  escrow: EvmAddress | null;
  autonomousExecution: boolean;
  gasSponsorship: false;
};

/** All chain methods are implemented by a trusted production adapter, never client-supplied events. */
export interface FinancialChainPort {
  capabilities(): FinanceCapabilities;
  validateToken(): Promise<TokenMetadata>;
  validateEscrow(options?: {
    requireExecution?: boolean;
  }): Promise<{ address: EvmAddress; maxPayment: string }>;
  balances(address: EvmAddress): Promise<WalletBalances>;
  validateChain(): Promise<void>;
  verifyCheckpoint(block: string, hash: EvmHash): Promise<void>;
  simulate(from: EvmAddress, calls: SafeCall[], amount: string): Promise<void>;
  verifyReceipt(hash: EvmHash): Promise<VerifiedEscrowEvent[]>;
  finalizedEvents(
    fromBlock: string,
    limit: number,
  ): Promise<{
    events: VerifiedEscrowEvent[];
    throughBlock: string;
    blockHash: EvmHash;
  }>;
  verifyWalletSignature(
    address: EvmAddress,
    message: string,
    signature: EvmHash,
  ): Promise<boolean>;
  allowance(wallet: EvmAddress): Promise<string>;
  incomingTransfers(
    wallet: EvmAddress,
    from: string,
    to: string,
  ): Promise<
    {
      transactionHash: EvmHash;
      logIndex: number;
      from: EvmAddress;
      units: string;
      blockNumber: string;
      blockHash: EvmHash;
    }[]
  >;
}
export interface FinancialWalletPort {
  readonly available: boolean;
  readonly autonomousAvailable: boolean;
  requestAccount(
    ownerAddress: EvmAddress,
  ): Promise<{ address: EvmAddress; deployed: boolean }>;
  prepareSession(
    wallet: FinancialWallet,
    policy: SpendingPolicy,
    idempotencyKey: string,
  ): Promise<{
    publicKey: EvmAddress;
    providerSessionId: string;
    signerRef: string;
    ownerAuthorizationPayload: EvmHash;
    permissionDigest: EvmHash;
    ownerSignatureRequest: {
      type: "eth_signTypedData_v4";
      data: Record<string, unknown>;
      rawPayload: EvmHash;
    };
  }>;
  validateSession(
    wallet: FinancialWallet,
    session: FinancialSession,
    policy: SpendingPolicy,
  ): Promise<void>;
  execute(
    wallet: FinancialWallet,
    session: FinancialSession,
    operation: PaymentOperation,
    policy: SpendingPolicy,
  ): Promise<{ callId: string }>;
  status(callId: string): Promise<{
    state: "pending" | "confirmed" | "failed" | "unknown";
    transactionHash: EvmHash | null;
  }>;
  revoke(session: FinancialSession): Promise<void>;
}
export type FinanceClaim =
  { replay: false } | { replay: true; response: unknown };
export interface FinancialRepository {
  readonly economy: EconomyRepository;
  transaction<T>(
    operation: (tx: FinancialRepository) => Promise<T>,
  ): Promise<T>;
  lockCompany(companyId: string): Promise<void>;
  lockIndexer(): Promise<void>;
  getRootBinding(companyId: string): Promise<FinancialRootBinding | null>;
  saveRootBinding(binding: FinancialRootBinding): Promise<void>;
  listWallets(): Promise<FinancialWallet[]>;
  observeTransfer(
    companyId: string,
    transfer: {
      transactionHash: EvmHash;
      logIndex: number;
      from: EvmAddress;
      units: string;
      blockNumber: string;
      blockHash: EvmHash;
    },
    kind: "capital" | "unattributed",
  ): Promise<void>;
  claim(
    actor: string,
    operation: string,
    key: string,
    hash: string,
  ): Promise<FinanceClaim>;
  complete(
    actor: string,
    operation: string,
    key: string,
    response: unknown,
  ): Promise<void>;
  getWallet(companyId: string): Promise<FinancialWallet | null>;
  saveWallet(wallet: FinancialWallet): Promise<void>;
  getPolicy(companyId: string): Promise<SpendingPolicy | null>;
  savePolicy(policy: SpendingPolicy): Promise<void>;
  getSession(companyId: string): Promise<FinancialSession | null>;
  saveSession(session: FinancialSession): Promise<void>;
  getSessionAuthorization(
    id: string,
    lock?: boolean,
  ): Promise<FinancialSessionAuthorization | null>;
  saveSessionAuthorization(
    authorization: FinancialSessionAuthorization,
  ): Promise<void>;
  createInvocation(invocation: PaidInvocation): Promise<void>;
  getInvocation(id: string, lock?: boolean): Promise<PaidInvocation | null>;
  getInvocationByOnchainId(id: EvmHash): Promise<PaidInvocation | null>;
  saveInvocation(invocation: PaidInvocation): Promise<void>;
  listInvocations(filter: {
    providerAgentId?: string;
    buyerAgentId?: string;
    buyerWallet?: EvmAddress;
  }): Promise<PaidInvocation[]>;
  saveOperation(operation: PaymentOperation): Promise<void>;
  getOperation(id: string, lock?: boolean): Promise<PaymentOperation | null>;
  getActionOperation(
    invocationId: string,
    action: FinancialAction,
  ): Promise<PaymentOperation | null>;
  listOperations(invocationId: string): Promise<PaymentOperation[]>;
  reservedToday(companyId: string): Promise<string>;
  insertEvent(event: VerifiedEscrowEvent): Promise<boolean>;
  postJournal(
    event: VerifiedEscrowEvent,
    companyId: string,
    debit: string,
    credit: string,
    units: string,
  ): Promise<void>;
  summary(companyId: string): Promise<FinancialSummary>;
  history(companyId: string): Promise<Record<string, unknown>[]>;
  leaderboard(): Promise<
    { companyId: string; verifiedServiceRevenue: string }[]
  >;
  audit(
    type: string,
    companyId: string | null,
    resourceId: string | null,
    actor: string,
    details?: Record<string, string>,
  ): Promise<void>;
  getCheckpoint(): Promise<{ block: string; hash: EvmHash } | null>;
  setCheckpoint(block: string, hash: EvmHash): Promise<void>;
  createChallenge(
    id: string,
    wallet: EvmAddress,
    message: string,
    expiresAt: string,
  ): Promise<void>;
  consumeChallenge(
    id: string,
  ): Promise<{ wallet: EvmAddress; message: string; expiresAt: string } | null>;
  createHumanSession(
    id: string,
    wallet: EvmAddress,
    hash: string,
    expiresAt: string,
  ): Promise<void>;
  getHumanSession(
    hash: string,
  ): Promise<{ id: string; wallet: EvmAddress; expiresAt: string } | null>;
}
