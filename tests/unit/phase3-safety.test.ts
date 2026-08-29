import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeDatabase, createPgliteDatabase } from "@normic/db";
import {
  createChainRegistryFromEnvironment,
  RobinhoodChainProvider,
} from "@normic/chains";
import {
  RobinhoodMarketDataProvider,
  createRobinhoodMarketProviderFromEnvironment,
} from "@normic/markets";
import {
  publicError,
  parseSafeJson,
  requestServiceSchema,
  submitResultSchema,
} from "@normic/core";

afterEach(() => vi.unstubAllEnvs());
describe("Production isolation and input safety", () => {
  it("cannot override production database requirements with a development option", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      createRuntimeDatabase({ databaseUrl: "", allowPglite: true }),
    ).rejects.toThrow(/DATABASE_URL/);
    await expect(createPgliteDatabase("memory://")).rejects.toThrow(/explicit/);
  });
  it("requires an explicit local environment and chooses the PostgreSQL adapter when configured", async () => {
    vi.stubEnv("NODE_ENV", "");
    await expect(createRuntimeDatabase({ databaseUrl: "" })).rejects.toThrow(
      /DATABASE_URL/,
    );
    vi.stubEnv("NODE_ENV", "production");
    const db = await createRuntimeDatabase({
      databaseUrl: "postgresql://user:password@127.0.0.1:65432/normic",
    });
    expect(db.kind).toBe("postgres");
    await db.close();
  });
  it("rejects missing production network configuration and unofficial market fallbacks", () => {
    expect(() =>
      createChainRegistryFromEnvironment({ NODE_ENV: "production" }),
    ).toThrow(/NORMIC_NETWORK/);
    expect(() =>
      createChainRegistryFromEnvironment({
        NODE_ENV: "production",
        NORMIC_NETWORK: "robinhood-mainnet",
        ROBINHOOD_MAINNET_ENABLED: "true",
      }),
    ).toThrow(/RPC/);
    expect(() =>
      createRobinhoodMarketProviderFromEnvironment({
        ROBINHOOD_MARKET_API_URL: "http://localhost/internal",
      }),
    ).toThrow(/official/);
  });
  it("rejects unsafe keys, deep data, non-finite numbers, and oversized output", () => {
    const serviceId = crypto.randomUUID();
    expect(() => parseSafeJson('{"__proto__":{"polluted":true}}')).toThrow(
      /Reserved JSON keys/,
    );
    expect(() =>
      parseSafeJson('{"nested":{"constructor":{"prototype":{}}}}'),
    ).toThrow(/Reserved JSON keys/);
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) nested = { nested };
    expect(
      requestServiceSchema.safeParse({ serviceId, input: nested }).success,
    ).toBe(false);
    expect(
      requestServiceSchema.safeParse({ serviceId, input: { value: Infinity } })
        .success,
    ).toBe(false);
    expect(
      submitResultSchema.safeParse({
        jobId: crypto.randomUUID(),
        output: { data: "x".repeat(270_000) },
      }).success,
    ).toBe(false);
  });
  it("never exposes internal SQL errors or tokens in transport errors", () => {
    expect(
      publicError(new Error("postgres password=nmc_live_DO_NOT_LOG")),
    ).toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
    expect(
      JSON.stringify(publicError(new Error("nmc_live_DO_NOT_LOG"))),
    ).not.toContain("DO_NOT_LOG");
  });
});

describe("Honest Robinhood upstream state", () => {
  const asset = {
    id: "asset",
    tokenSymbol: "CRM",
    tokenName: "Salesforce • Robinhood Token",
    currentMultiplier: "0.5",
    pendingMultiplier: "",
    status: "ASSET_STATUS_ACTIVE",
    deployments: [
      {
        chainId: 4663,
        contractAddress: "0xd95B44124e475743a7589e68F3D74008A5536D44",
      },
    ],
    tradingCapabilities: {
      fractionalTradability: null,
      allDayTradability: "untradable",
      extendedHoursFractionalTradability: false,
    },
  };
  it("preserves nullable trading capabilities, corporate action wrappers, and pending multiplier semantics", async () => {
    const provider = new RobinhoodMarketDataProvider({
      enabled: true,
      fetcher: vi.fn(
        async (url) =>
          new Response(
            JSON.stringify(
              String(url).endsWith("/assets")
                ? { assets: [asset] }
                : {
                    corpActions: [
                      {
                        tokenSymbol: "CRM",
                        type: "CORPORATE_ACTION_TYPE_FORWARD_SPLIT",
                        details: {
                          forwardSplit: { oldRate: "1", newRate: "2" },
                        },
                      },
                    ],
                  },
            ),
          ),
      ) as typeof fetch,
    });
    expect((await provider.getStockToken("CRM")).data).toMatchObject({
      pendingMultiplier: null,
      tradingCapabilities: asset.tradingCapabilities,
    });
    expect((await provider.listCorporateActions()).data).toHaveLength(1);
  });
  it("marks old upstream timestamps stale and rejects unknown halt state or mismatched symbol", async () => {
    let halt: unknown = true;
    let symbol = "CRM";
    const fetcher = vi.fn(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/assets")
              ? { assets: [asset] }
              : {
                  quotes: [
                    {
                      tokenSymbol: symbol,
                      deployments: asset.deployments,
                      bid: "100",
                      ask: "101",
                      currency: "USD",
                      isTradingHalt: halt,
                      generatedAt: "2020-01-01T00:00:00Z",
                      dailyTradingVolume: "0",
                    },
                  ],
                },
          ),
        ),
    ) as typeof fetch;
    expect(
      await new RobinhoodMarketDataProvider({
        enabled: true,
        fetcher,
      }).getStockPrice("CRM"),
    ).toMatchObject({
      state: "stale",
      stale: true,
      data: { effectiveBid: "50", isTradingHalt: true },
    });
    halt = "false";
    expect(
      (
        await new RobinhoodMarketDataProvider({
          enabled: true,
          fetcher,
        }).getStockPrice("CRM")
      ).data,
    ).toBeNull();
    halt = false;
    symbol = "WRONG";
    expect(
      (
        await new RobinhoodMarketDataProvider({
          enabled: true,
          fetcher,
        }).getStockPrice("CRM")
      ).data,
    ).toBeNull();
  });
  it("coalesces concurrent requests and respects upstream rate-limit backoff", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("{}", { status: 429, headers: { "retry-after": "60" } }),
    );
    const provider = new RobinhoodMarketDataProvider({
      enabled: true,
      fetcher: fetcher as typeof fetch,
    });
    const results = await Promise.all([
      provider.listStockTokens(),
      provider.listStockTokens(),
    ]);
    expect(
      results.every(
        (value) => value.data === null && value.state === "unavailable",
      ),
    ).toBe(true);
    await provider.listStockTokens();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never calls a disabled RPC or accepts a wrong-chain RPC", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ result: "0x1" })),
    );
    await expect(
      new RobinhoodChainProvider(
        false,
        "https://rpc.example",
        fetcher as typeof fetch,
      ).getBlockNumber(),
    ).rejects.toThrow(/disabled/);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      new RobinhoodChainProvider(
        true,
        "https://rpc.example",
        fetcher as typeof fetch,
      ).getBlockNumber(),
    ).rejects.toThrow(/not Robinhood Chain mainnet/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
