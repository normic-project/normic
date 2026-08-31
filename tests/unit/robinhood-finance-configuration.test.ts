import { describe, expect, it, vi } from "vitest";
import { financialCommandRequiresReadyCapability } from "@normic/core";
import { RobinhoodFinancialChain } from "@normic/payments";

describe("Robinhood financial configuration", () => {
  it("keeps owner configuration available while execution stays gated", () => {
    for (const command of [
      "begin_financial_passkey_registration",
      "prepare_financial_session",
      "register_financial_session",
    ] as const)
      expect(financialCommandRequiresReadyCapability(command)).toBe(false);
    for (const command of [
      "fund_service",
      "simulate_payment",
      "execute_payment",
    ] as const)
      expect(financialCommandRequiresReadyCapability(command)).toBe(true);
  });

  it("allows pinned escrow configuration checks while execution remains blocked", async () => {
    const escrow = "0xda3ea8cd849ff916aa0ee6b1088f151c2fa51c47";
    const chain = new RobinhoodFinancialChain({
      NODE_ENV: "production",
      ROBINHOOD_RPC_URL: "https://rpc.example.test/key",
      NORMIC_ESCROW_ADDRESS: escrow,
      NORMIC_ESCROW_RUNTIME_HASH:
        "0xd333884f2e515b5e1264ff8a0d508c0184c5c1bc29eb50169f7e72b1e83338da",
      NORMIC_ESCROW_DEPLOYMENT_BLOCK: "50271033",
      MAX_SERVICE_PAYMENT_USDG: "1000",
      ADMIN_ADDRESS: "0x0000000000000000000000000000000000000001",
      DISPUTE_RESOLVER_ADDRESS: "0x0000000000000000000000000000000000000002",
      NORMIC_FINANCIAL_EXECUTION_ENABLED: "false",
      NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED: "false",
    });
    const client = chain.client!;
    vi.spyOn(client, "getChainId").mockResolvedValue(4663);
    vi.spyOn(client, "getBlock").mockResolvedValue({ number: 1n } as never);
    vi.spyOn(client, "getCode").mockResolvedValue("0x01");
    vi.spyOn(client, "readContract").mockImplementation(
      async ({ functionName }) => {
        if (functionName === "decimals") return 6;
        if (functionName === "symbol") return "USDG";
        if (functionName === "totalSupply") return 1n;
        throw new Error("Unexpected test read.");
      },
    );

    expect(chain.capabilities().state).toBe("blocked");
    await expect(chain.validateEscrow()).rejects.toThrow(
      "Financial execution is blocked",
    );
    await expect(
      chain.validateEscrow({ requireExecution: false }),
    ).rejects.toThrow("Escrow runtime bytecode is not the pinned deployment");
    expect(client.getChainId).toHaveBeenCalledTimes(1);
  });
});
