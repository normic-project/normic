import { describe, expect, it } from "vitest";
import {
  CapabilityBlockedError,
  assertProductionConfiguration,
  buildProductionReadiness,
  publicError,
  runFinancialCommand,
  runTradingCommand,
  type FinancialService,
  type TradingService,
} from "@normic/core";

const productionEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://database.internal/normic",
  NORMIC_DEV_AUTH_ENABLED: "false",
  NORMIC_PUBLIC_ORIGIN: "https://api.normic.example",
  NORMIC_REMOTE_MCP_URL: "https://api.normic.example/mcp",
  NORMIC_AUTH_ISSUER: "https://identity.normic.example",
  NORMIC_AUTH_AUDIENCE: "https://api.normic.example/mcp",
  NORMIC_AUTH_JWKS_URL: "https://identity.normic.example/jwks.json",
  NORMIC_OWNER_AUTH_ISSUER: "https://owners.normic.example",
  NORMIC_OWNER_AUTH_AUDIENCE: "authenticated",
  NORMIC_OWNER_AUTH_JWKS_URL: "https://owners.normic.example/jwks.json",
  NORMIC_NETWORK: "robinhood-mainnet",
  ROBINHOOD_MAINNET_ENABLED: "true",
  ROBINHOOD_RPC_URL: "https://dedicated-rpc.normic.example",
});

describe("Phase 6.5 production readiness", () => {
  it("fails production startup without core infrastructure", () => {
    expect(() =>
      assertProductionConfiguration({ NODE_ENV: "production" }),
    ).toThrow(/DATABASE_URL/);
  });

  it("rejects the public Robinhood RPC in production", () => {
    const env = productionEnvironment();
    env.ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
    expect(() => assertProductionConfiguration(env)).toThrow(
      /ROBINHOOD_RPC_URL/,
    );
  });

  it("requires the standard Supabase audience for owner sessions", () => {
    const env = productionEnvironment();
    env.NORMIC_OWNER_AUTH_AUDIENCE = env.NORMIC_AUTH_AUDIENCE;
    expect(() => assertProductionConfiguration(env)).toThrow(
      /NORMIC_OWNER_AUTH_AUDIENCE/,
    );
  });

  it("allows public beta while financial capabilities remain blocked", () => {
    const readiness = buildProductionReadiness(productionEnvironment(), {
      database: { kind: "postgres", connected: true },
      robinhoodRpcVerified: true,
      payments: { state: "blocked", missing: ["escrow contract"] },
      trading: { state: "blocked", missing: ["eligibility provider"] },
    });
    expect(readiness.publicBeta).toBe("READY");
    expect(readiness.capabilities.CORE_API.status).toBe("READY");
    expect(readiness.capabilities.USDG_PAYMENTS.status).toBe("BLOCKED");
    expect(readiness.capabilities.STOCK_TOKEN_TRADING.status).toBe("BLOCKED");
    expect(readiness.capabilities.AUTONOMY.status).toBe("BLOCKED");
  });

  it("rejects blocked execution commands with a machine-readable 503", async () => {
    const payments = {
      capabilities: () => ({ state: "blocked" as const, missing: ["custody"] }),
    } as FinancialService;
    const trading = {
      capabilities: () => ({ state: "blocked" as const, missing: ["oracle"] }),
    } as TradingService;
    const actor = {} as Parameters<typeof runFinancialCommand>[1];
    await expect(
      runFinancialCommand(payments, actor, "execute_payment", {}, "key"),
    ).rejects.toBeInstanceOf(CapabilityBlockedError);
    await expect(
      runTradingCommand(trading, actor, "quote_stock_token", {}, "key"),
    ).rejects.toBeInstanceOf(CapabilityBlockedError);
    expect(
      publicError(new CapabilityBlockedError("USDG_PAYMENTS", ["custody"])),
    ).toMatchObject({
      status: 503,
      code: "CAPABILITY_BLOCKED",
      capability: "USDG_PAYMENTS",
      blockers: ["custody"],
    });
  });
});
