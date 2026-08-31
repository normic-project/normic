import { describe, expect, it, vi } from "vitest";
import {
  PrivySdkSessionSignerTransport,
  assertPrivySessionPolicy,
  privySessionRules,
} from "@normic/payments";

const policy = {
  id: "test-policy",
  chain_type: "ethereum",
  version: "1.0",
  rules: privySessionRules.map((rule, i) => ({ ...rule, id: `rule-${i}` })),
} as const;
const stored = {
  id: "test-session",
  address: `0x${"12".repeat(20)}`,
  external_id: "normic_test_1",
  chain_type: "ethereum",
  policy_ids: [policy.id],
  owner_id: null,
  exported_at: null,
  imported_at: null,
  archived_at: null,
};
function fixture(existing: boolean, allowCreation = true) {
  const wallets = {
    list: vi.fn(async function* () {
      if (existing) yield stored;
    }),
    create: vi.fn(async () => stored),
    get: vi.fn(async () => stored),
  };
  const policies = {
    create: vi.fn(async () => policy),
    get: vi.fn(async () => policy),
  };
  const client = {
    wallets: () => wallets,
    policies: () => policies,
  } as unknown as ConstructorParameters<
    typeof PrivySdkSessionSignerTransport
  >[0];
  return {
    wallets,
    policies,
    transport: new PrivySdkSessionSignerTransport(client, allowCreation),
  };
}
describe("production scoped signer export policy", () => {
  it("permits only personal_sign with both export routes denied and no wildcard", () => {
    expect(() => assertPrivySessionPolicy(policy)).not.toThrow();
    expect(() =>
      assertPrivySessionPolicy({
        ...policy,
        rules: [
          ...policy.rules,
          {
            id: "broad",
            name: "broad",
            method: "*",
            action: "ALLOW",
            conditions: [],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      assertPrivySessionPolicy({
        ...policy,
        rules: policy.rules.filter((r) => r.method !== "exportSeedPhrase"),
      }),
    ).toThrow();
  });
  it("attaches protection atomically at creation and reads it back without signing/exporting", async () => {
    const f = fixture(false);
    await f.transport.createWallet({
      externalId: stored.external_id,
      idempotencyKey: "stable-test-key",
    });
    expect(f.policies.create).toHaveBeenCalledWith(
      expect.objectContaining({ rules: privySessionRules }),
    );
    expect(f.wallets.create).toHaveBeenCalledWith(
      expect.objectContaining({
        external_id: stored.external_id,
        policy_ids: [policy.id],
      }),
    );
    expect(f.wallets.get).toHaveBeenCalledWith(stored.id);
    expect(f.policies.get).toHaveBeenCalledWith(policy.id);
  });
  it("reuses the external-ID binding after provider idempotency TTL", async () => {
    const f = fixture(true);
    await f.transport.createWallet({
      externalId: stored.external_id,
      idempotencyKey: "another-day",
    });
    expect(f.wallets.create).not.toHaveBeenCalled();
    expect(f.policies.create).not.toHaveBeenCalled();
  });
  it("makes inspection read-only even if no signer exists", async () => {
    const f = fixture(false, false);
    await expect(
      f.transport.createWallet({
        externalId: stored.external_id,
        idempotencyKey: "read-only",
      }),
    ).rejects.toThrow("preparation required");
    expect(f.wallets.create).not.toHaveBeenCalled();
    expect(f.policies.create).not.toHaveBeenCalled();
  });
  it("fails closed instead of replacing an existing unprotected signer", async () => {
    const f = fixture(true);
    f.policies.get.mockResolvedValueOnce({ ...policy, rules: [] });
    await expect(
      f.transport.createWallet({
        externalId: stored.external_id,
        idempotencyKey: "unchanged",
      }),
    ).rejects.toThrow("invalid");
    expect(f.wallets.create).not.toHaveBeenCalled();
  });
});
