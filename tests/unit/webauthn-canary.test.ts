import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type * as Viem from "../../packages/payments/node_modules/viem";
import { CANONICAL_USDG, escrowAbi } from "@normic/core";
import {
  canaryOwnerCalls,
  canaryGasFailureReason,
  canarySessionInstall,
  CANARY_ESCROW,
  CANARY_LIFECYCLE,
} from "@normic/payments";

const preparedAt = 1_800_000_000;
const {
  decodeAbiParameters,
  decodeFunctionData,
  erc20Abi,
  toFunctionSelector,
} = createRequire(
  new URL("../../packages/payments/package.json", import.meta.url),
)("viem") as typeof Viem;
const wallet = `0x${"12".repeat(20)}` as const,
  signer = `0x${"34".repeat(20)}` as const;
describe("unsigned WebAuthn first canary", () => {
  it("reports only safe gas failure categories, never RPC credentials or payloads", () => {
    const secret = "test-only-private-rpc-url-and-payload";
    expect(
      canaryGasFailureReason({ message: secret, cause: { status: 429 } }),
    ).toBe("RPC_RATE_LIMITED");
    expect(
      canaryGasFailureReason({ name: "TimeoutError", message: secret }),
    ).toBe("RPC_TIMEOUT");
    expect(canaryGasFailureReason({ status: 401, message: secret })).toBe(
      "RPC_AUTHENTICATION_FAILED",
    );
    expect(canaryGasFailureReason(new Error(secret))).toBe(
      "OWNER_USEROP_ESTIMATE_UNAVAILABLE",
    );
  });
  it("encodes only the approved spending cap and exact bounded USDG approval", () => {
    const input = {
      allowance: 0n,
      preparedAt,
      escrow: CANARY_ESCROW,
      chainId: 4663,
    };
    const plan = canaryOwnerCalls(input);
    expect(plan.expiry).toBe(preparedAt + 3600);
    expect(plan.calls.every((c) => c.value === "0x0")).toBe(true);
    expect(
      decodeFunctionData({ abi: escrowAbi, data: plan.calls[0]!.data }),
    ).toMatchObject({
      functionName: "configureSpending",
      args: [true, BigInt(plan.expiry), 10000n, 10000n],
    });
    expect(plan.calls[1]!.to).toBe(CANONICAL_USDG);
    expect(
      decodeFunctionData({ abi: erc20Abi, data: plan.calls[1]!.data }),
    ).toMatchObject({
      functionName: "approve",
      args: [expect.any(String), 10000n],
    });
    expect(plan.calls[0]!.to).toBe(CANARY_ESCROW);
    expect(
      canaryOwnerCalls({ ...input, allowance: 10000n }).calls,
    ).toHaveLength(1);
    expect(
      canaryOwnerCalls({ ...input, allowance: 10001n })
        .allowanceReductionRequired,
    ).toBe(true);
    expect(() => canaryOwnerCalls({ ...input, chainId: 1 })).toThrow();
    expect(() => canaryOwnerCalls({ ...input, escrow: wallet })).toThrow();
    expect(canaryOwnerCalls(input)).toEqual(plan);
    expect(canaryOwnerCalls({ ...input, role: "provider" })).toMatchObject({
      calls: [],
      approvalRequired: false,
    });
  });
  it.each(["buyer", "provider"] as const)(
    "encodes a non-global %s session with exact selector, token, expiry and zero-native hooks",
    (role) => {
      const input = {
        publicKey: signer,
        wallet,
        preparedAt,
        expiry: preparedAt + 3600,
        role,
      };
      const plan = canarySessionInstall(input);
      expect(plan.validationConfig).toMatchObject({
        entityId: 1,
        isGlobal: false,
        isSignatureValidation: false,
        isUserOpValidation: true,
      });
      const expected =
        role === "buyer"
          ? [
              "fundWithSession((bytes32,address,address,address,uint256,uint64,uint64,uint64))",
              "acceptResult(bytes32)",
            ]
          : ["accept(bytes32)", "submitResult(bytes32,bytes32)"];
      expect(plan.selectors).toEqual(
        expected.map((x) => toFunctionSelector(x)).sort(),
      );
      const allowlist = decodeAbiParameters(
        [
          { type: "uint32" },
          {
            type: "tuple[]",
            components: [
              { type: "address" },
              { type: "bool" },
              { type: "bool" },
              { type: "uint256" },
              { type: "bytes4[]" },
            ],
          },
        ],
        plan.hooks[0]!.initData,
      );
      expect(allowlist[1]).toHaveLength(1);
      expect(allowlist[1][0]![0].toLowerCase()).toBe(CANARY_ESCROW);
      expect(allowlist[1][0]![1]).toBe(true);
      expect(allowlist[1][0]![4]).toEqual(plan.selectors);
      expect(plan.hooks[2]!.hookConfig.hasPreHooks).toBe(true);
      expect(
        decodeAbiParameters(
          [{ type: "uint32" }, { type: "uint48" }, { type: "uint48" }],
          plan.hooks[2]!.initData,
        ),
      ).toEqual([1, preparedAt + 3600, preparedAt]);
      expect(
        decodeAbiParameters(
          [{ type: "uint32" }, { type: "uint256" }],
          plan.hooks[3]!.initData,
        )[1],
      ).toBe(0n);
      expect(plan.call.to).toBe(wallet);
      expect(plan.call.value).toBe("0x0");
      expect(plan.revokeCall.to).toBe(wallet);
      expect(plan.revokeCall.value).toBe("0x0");
      expect(plan.revokeCall.data.slice(0, 10)).toBe(
        toFunctionSelector("uninstallValidation(bytes24,bytes,bytes[])"),
      );
      const removal = decodeAbiParameters(
        [{ type: "bytes24" }, { type: "bytes" }, { type: "bytes[]" }],
        `0x${plan.revokeCall.data.slice(10)}`,
      );
      expect(removal[0].slice(-8)).toBe("00000001"); // never the root entity zero
      expect(removal[2][1]).toBe(plan.hooks[0]!.initData);
      expect(removal[2][3]).toBe(plan.hooks[1]!.initData);
      expect(plan.tokenAllowance).toBe(role === "buyer" ? "10000" : "0");
      expect(canarySessionInstall(input).call.data).toBe(plan.call.data);
      expect(() =>
        canarySessionInstall({ ...input, publicKey: wallet }),
      ).toThrow();
      expect(() =>
        canarySessionInstall({ ...input, expiry: preparedAt + 7200 }),
      ).toThrow();
    },
  );
  it("plans finalized accounting and revocation without producing a payment", () => {
    expect(CANARY_LIFECYCLE.slice(0, 4)).toEqual([
      "buyer:fundWithSession",
      "provider:accept",
      "provider:submitResult",
      "buyer:acceptResult",
    ]);
    expect(CANARY_LIFECYCLE.at(-2)).toContain("revoke buyer");
    expect(CANARY_LIFECYCLE.at(-1)).toContain("provider owner revoke");
  });
});
