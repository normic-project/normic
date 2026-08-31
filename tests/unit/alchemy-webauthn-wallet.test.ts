import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlchemyFinancialWallet,
  RobinhoodFinancialChain,
  type SessionCustodian,
} from "@normic/payments";
import {
  type EvmAddress,
  type FinancialWallet,
  type SpendingPolicy,
} from "@normic/core";
import { testPasskey } from "../support/webauthn.js";
const requirePayments = createRequire(
  new URL("../../packages/payments/package.json", import.meta.url),
);
const { predictModularAccountV2Address } = requirePayments(
  "@account-kit/smart-contracts",
);
const factory = "0x55010E571dCf07e254994bfc88b9C1C8FAe31960",
  validationModule = "0x0000000000001D9d34E07D9834274dF9ae575217",
  implementation = "0x00000000000002377B26b1EdA7b0BC371C60DD4f";
const rpc = "https://rpc.example.test",
  key = "isolated-test-key";
describe("Alchemy direct WebAuthn MAv2 public-only provisioning", () => {
  let chain: RobinhoodFinancialChain, wallet: AlchemyFinancialWallet;
  const read = vi.fn(),
    code = vi.fn(),
    createSigner = vi.fn();
  beforeEach(() => {
    chain = new RobinhoodFinancialChain({ ROBINHOOD_RPC_URL: rpc });
    vi.spyOn(chain.client!, "getChainId").mockResolvedValue(4663);
    code
      .mockReset()
      .mockImplementation(async ({ address }: { address: string }) =>
        [
          factory,
          validationModule,
          implementation,
          "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
        ].some((a) => a.toLowerCase() === address.toLowerCase())
          ? "0x6000"
          : "0x",
      );
    read
      .mockReset()
      .mockImplementation(
        async ({
          functionName,
          args,
        }: {
          functionName: string;
          args: readonly bigint[];
        }) => {
          if (functionName === "ENTRY_POINT")
            return "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
          if (functionName === "WEBAUTHN_VALIDATION_MODULE")
            return validationModule;
          if (functionName === "ACCOUNT_IMPL") return implementation;
          if (functionName === "getAddressWebAuthn")
            return predictModularAccountV2Address({
              type: "WebAuthn",
              factoryAddress: factory,
              implementationAddress: implementation,
              ownerPublicKey: { x: args[0], y: args[1] },
              salt: args[2],
              entityId: Number(args[3]),
            });
          throw new Error("Unexpected provider call");
        },
      );
    vi.spyOn(chain.client!, "getCode").mockImplementation(code);
    vi.spyOn(chain.client!, "readContract").mockImplementation(read);
    createSigner.mockReset();
    wallet = new AlchemyFinancialWallet(
      chain,
      key,
      { createSigner } as unknown as SessionCustodian,
      rpc,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          "Unexpected network call: no broadcast or signer allowed",
        );
      }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const input = () => ({
    credentialId: testPasskey().credentialId,
    publicKey: testPasskey().publicKey,
    rpId: "normic.tech" as const,
    validationEntityId: 0 as const,
    salt: "0" as const,
  });
  it("derives the same root/salt address across retries without Privy, session creation, signing or network submission", async () => {
    const root = input(),
      first = await wallet.provisionWebAuthnAccount(root),
      again = await wallet.provisionWebAuthnAccount(root);
    expect(first).toEqual(again);
    expect(first.deployed).toBe(false);
    expect(
      await wallet.provisionWebAuthnAccount({
        ...root,
        publicKey: testPasskey().publicKey,
      }),
    ).not.toEqual(first);
    expect(createSigner).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(Object.keys(first).sort()).toEqual(["address", "deployed"]);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "getAddressWebAuthn",
        args: expect.arrayContaining([0n, 0]),
      }),
    );
  });
  it("rejects wrong chain, unavailable code, substituted factory address and unsupported parameters", async () => {
    const root = input();
    vi.spyOn(chain.client!, "getChainId").mockResolvedValueOnce(1);
    await expect(wallet.provisionWebAuthnAccount(root)).rejects.toThrow(
      "Wrong chain",
    );
    code.mockResolvedValueOnce("0x");
    await expect(wallet.provisionWebAuthnAccount(root)).rejects.toThrow(
      "unavailable",
    );
    read.mockResolvedValueOnce(`0x${"01".repeat(20)}`);
    await expect(wallet.provisionWebAuthnAccount(root)).rejects.toThrow(
      "could not derive",
    );
    for (const invalid of [
      { salt: "1" },
      { rpId: "evil.test" },
      { validationEntityId: 1 },
      { publicKey: "0x01" },
    ])
      await expect(
        wallet.provisionWebAuthnAccount({ ...root, ...invalid } as never),
      ).rejects.toThrow("Invalid WebAuthn");
    expect(createSigner).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("blocks the EOA session path before creating any Privy signer for a passkey root", async () => {
    await expect(
      wallet.prepareSession(
        {
          rootBindingId: crypto.randomUUID(),
          address: factory as EvmAddress,
        } as FinancialWallet,
        {} as SpendingPolicy,
        "session-test",
      ),
    ).rejects.toThrow("passkey");
    expect(createSigner).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
