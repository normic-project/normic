import { describe, expect, it, vi } from "vitest";
import { NetworkDisabledError } from "@normic/core";
import {
  ROBINHOOD_MAINNET,
  RobinhoodChainProvider,
  createChainRegistry,
} from "@normic/chains";
import { RobinhoodMarketDataProvider } from "@normic/markets";
import { UnavailablePaymentProvider } from "@normic/payments";
import { createRuntimeDatabase } from "@normic/db";

const assets = [
  {
    id: "asset-1",
    tokenSymbol: "AAPL",
    tokenName: "Apple Stock Token",
    deployments: [
      {
        contractAddress: "0x1111111111111111111111111111111111111111",
        chainId: 4663,
      },
    ],
    currentMultiplier: "0.01",
    pendingMultiplier: null,
    logoUrl: null,
    tradingCapabilities: {
      market: {
        whole: "TRADING_STATUS_TRADABLE",
        fractional: "TRADING_STATUS_TRADABLE",
      },
    },
    status: "active",
  },
];
const price = {
  tokenSymbol: "AAPL",
  deployments: assets[0]!.deployments,
  bid: "201.25",
  ask: "201.50",
  currency: "USD",
  dailyTradingVolume: "100",
  isTradingHalt: true,
  generatedAt: "2026-08-28T00:00:00Z",
};

describe("Robinhood mainnet providers", () => {
  it("exposes only Robinhood mainnet chain ID 4663 and rejects every execution", async () => {
    const registry = createChainRegistry({
      robinhoodMainnetEnabled: true,
      robinhoodRpcUrl: "https://rpc.example",
    });
    expect(registry.listCapabilities()).toEqual([
      expect.objectContaining({
        id: "robinhood-mainnet",
        chainId: 4663,
        primary: true,
        enabled: true,
        readOnlyAvailable: true,
        executionAvailable: false,
      }),
    ]);
    expect(() => registry.get("base")).toThrow(/unsupported/i);
    await expect(
      registry.get("robinhood-mainnet").execute(),
    ).rejects.toBeInstanceOf(NetworkDisabledError);
  });

  it("uses allow-listed JSON-RPC read methods and validates user-controlled identifiers", async () => {
    const fetcher = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result:
              request.method === "eth_chainId"
                ? "0x1237"
                : request.method === "eth_blockNumber"
                  ? "0x10"
                  : null,
          }),
          { status: 200 },
        );
      },
    );
    const provider = new RobinhoodChainProvider(
      true,
      "https://rpc.example",
      fetcher as typeof fetch,
    );
    expect((await provider.getBlockNumber()).data).toBe("0x10");
    await expect(
      provider.getTransaction("https://evil.example"),
    ).rejects.toThrow(/invalid transaction hash/i);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ROBINHOOD_MAINNET.chainId).toBe(4663);
  });

  it("returns live, cached, and stale market states without fabricating a fallback", async () => {
    let now = Date.parse(price.generatedAt);
    let fail = false;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (fail) throw new Error("upstream offline");
      return new Response(
        JSON.stringify(
          String(url).includes("/prices/") ? { quotes: [price] } : { assets },
        ),
        { status: 200 },
      );
    });
    const provider = new RobinhoodMarketDataProvider({
      enabled: true,
      fetcher: fetcher as typeof fetch,
      clock: () => now,
      freshTtlMs: 15_000,
      staleTtlMs: 60_000,
    });
    const live = await provider.getStockPrice("aapl");
    expect(live).toMatchObject({
      state: "live",
      stale: false,
      data: {
        isTradingHalt: true,
        effectiveBid: "2.0125",
        effectiveAsk: "2.015",
      },
    });
    expect((await provider.getStockPrice("AAPL")).state).toBe("cached");
    now += 20_000;
    fail = true;
    const stale = await provider.getStockPrice("AAPL");
    expect(stale).toMatchObject({
      state: "stale",
      stale: true,
      error: expect.stringMatching(/unavailable or rate-limited/),
    });
    const empty = new RobinhoodMarketDataProvider({
      enabled: true,
      fetcher: vi.fn(async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    expect(await empty.listStockTokens()).toEqual(
      expect.objectContaining({
        state: "unavailable",
        data: null,
        stale: false,
      }),
    );
  });

  it("blocks URL-shaped symbols before fetching and rejects disabled providers", async () => {
    const fetcher = vi.fn();
    const markets = new RobinhoodMarketDataProvider({
      enabled: true,
      fetcher: fetcher as typeof fetch,
    });
    await expect(
      markets.getStockPrice("https://evil.example/x"),
    ).rejects.toThrow(/invalid/i);
    expect(fetcher).not.toHaveBeenCalled();
    const disabled = new RobinhoodMarketDataProvider({ enabled: false });
    expect(await disabled.listStockTokens()).toEqual(
      expect.objectContaining({ state: "unavailable", data: null }),
    );
    await expect(
      new UnavailablePaymentProvider().execute({
        payerCompanyId: "a",
        payeeCompanyId: "b",
        reference: "c",
      }),
    ).rejects.toThrow(/cannot execute payments/i);
  });

  it("forbids the PGlite fallback when production persistence is required", async () => {
    await expect(
      createRuntimeDatabase({ databaseUrl: "", allowPglite: false }),
    ).rejects.toThrow(/DATABASE_URL is required in production/i);
  });
});
