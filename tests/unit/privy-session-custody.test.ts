import { describe, expect, it, vi } from "vitest";
import {
  CANONICAL_USDG,
  type EvmAddress,
  type EvmHash,
  type FinancialSession,
  type FinancialWallet,
  type PaymentOperation,
  type SpendingPolicy,
} from "@normic/core";
import {
  PrivySessionCustodian,
  createPrivySessionCustodianFromEnvironment,
  sessionPermissionDigest,
  sessionPermissions,
  sessionSelectors,
  type PrivySessionSignerTransport,
} from "@normic/payments";

const address = (n: number) =>
  `0x${n.toString(16).padStart(40, "0")}` as EvmAddress;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as EvmHash;

const ownerAddress = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a" as EvmAddress;
const ownerAuthorization =
  "0x25cd1a4c73ee0e49e998403f148bef46901067666cb550ad64e06e9197bc26371aa6b7afd4f86ed8e6d7d7c19281a38df1f0c9be52154b258b5930b48820dd901c" as const;
const policy: SpendingPolicy = {
  companyId: "10000000-0000-4000-8000-000000000001",
  enabled: true,
  maxPerTransaction: "1000000",
  maxPerDay: "5000000",
  sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  allowedToken: CANONICAL_USDG,
  allowedContract: address(99),
  allowedActions: ["fund", "release", "refund"],
  version: 1,
  updatedAt: new Date().toISOString(),
};
const wallet: FinancialWallet = {
  companyId: policy.companyId,
  agentId: "20000000-0000-4000-8000-000000000001",
  address: address(10),
  ownerAddress,
  chainId: 4663,
  provider: "alchemy-wallet-api",
  walletType: "erc4337-sma-b",
  authorizationStatus: "owner_verified",
  deployed: true,
  createdAt: new Date().toISOString(),
};
const operation: PaymentOperation = {
  id: "30000000-0000-4000-8000-000000000001",
  invocationId: "40000000-0000-4000-8000-000000000001",
  action: "fund",
  actor: "agent:test",
  status: "prepared",
  calls: [{ to: policy.allowedContract, data: hash(1), value: "0x0" }],
  providerCallId: null,
  transactionHash: null,
  failureCode: null,
  createdAt: new Date().toISOString(),
  sessionId: "50000000-0000-4000-8000-000000000001",
  policyVersion: 1,
};

async function fixture() {
  const ownerAuthorizationPayload = hash(7);
  const record = {
    id: "privy-wallet-session-1",
    address: address(55),
    chainType: "ethereum",
    exportedAt: null,
    importedAt: null,
    archivedAt: null,
  };
  const transport: PrivySessionSignerTransport = {
    createWallet: vi.fn(async () => record),
    getWallet: vi.fn(async () => record),
    personalSign: vi.fn(async () => `0x${"22".repeat(65)}` as const),
  };
  const session: FinancialSession = {
    id: operation.sessionId!,
    companyId: policy.companyId,
    publicKey: record.address,
    providerSessionId: "alchemy-session-1",
    authorizationRef: "60000000-0000-4000-8000-000000000001",
    signerRef: record.id,
    ownerAuthorization,
    ownerAuthorizationPayload,
    permissionDigest: sessionPermissionDigest(policy),
    expiresAt: policy.sessionExpiresAt,
    revokedAt: null,
    policyVersion: 1,
    createdAt: new Date().toISOString(),
  };
  return {
    transport,
    session,
    custodian: new PrivySessionCustodian(transport),
  };
}

describe("Privy-backed Alchemy session custody", () => {
  it("uses only cumulative USDG allowance and exact escrow functions", () => {
    const permissions = sessionPermissions(policy);
    expect(permissions).toEqual([
      {
        type: "erc20-token-transfer",
        data: {
          address: CANONICAL_USDG.toLowerCase(),
          allowance: "0x4c4b40",
        },
      },
      {
        type: "functions-on-contract",
        data: {
          address: policy.allowedContract,
          functions: sessionSelectors(policy),
        },
      },
    ]);
    expect(JSON.stringify(permissions)).not.toContain("root");
    expect(sessionSelectors(policy)).not.toContain("0x095ea7b3");
    expect(sessionSelectors(policy)).not.toContain("0xa9059cbb");
  });

  it("binds one Privy personal-sign request to one approved Normic action", async () => {
    const { custodian, session, transport } = await fixture();
    const selectors = sessionSelectors(policy);
    const approval = await custodian.approveOperation({
      wallet,
      session,
      operation,
      policy,
      selectors,
      chainId: 4663,
    });
    const prepared = {
      chainId: "0x1237",
      type: "user-operation-v070",
      signatureRequest: { type: "personal_sign", data: { raw: hash(9) } },
    };
    await expect(
      custodian.signApprovedOperation({
        wallet,
        session,
        operation: { ...operation, id: crypto.randomUUID() },
        policy,
        selectors,
        approvalTicket: approval.approvalTicket,
        prepared,
      }),
    ).rejects.toThrow("not bound");
    expect(transport.personalSign).not.toHaveBeenCalled();

    const second = await custodian.approveOperation({
      wallet,
      session,
      operation,
      policy,
      selectors,
      chainId: 4663,
    });
    await expect(
      custodian.signApprovedOperation({
        wallet,
        session,
        operation,
        policy,
        selectors,
        approvalTicket: second.approvalTicket,
        prepared,
      }),
    ).resolves.toMatch(/^0x[0-9a-f]{130}$/);
    expect(transport.getWallet).toHaveBeenCalledTimes(3);
    expect(transport.personalSign).toHaveBeenCalledTimes(1);
  });

  it("disables the local signer immediately on revocation", async () => {
    const { custodian, session } = await fixture();
    await custodian.revoke(session);
    await expect(
      custodian.verifyAuthorization({
        wallet,
        session,
        policy,
        selectors: sessionSelectors(policy),
      }),
    ).rejects.toThrow("not active");
  });

  it("does not create a production custodian from incomplete configuration", () => {
    expect(createPrivySessionCustodianFromEnvironment({})).toBeUndefined();
    expect(
      createPrivySessionCustodianFromEnvironment({
        NORMIC_CUSTODY_PROVIDER: "privy",
        PRIVY_APP_ID: "app-id",
        PRIVY_APP_SECRET: "secret",
        NORMIC_CUSTODY_CREDENTIAL_REF: "privy-app:different-app",
      }),
    ).toBeUndefined();
  });
});
