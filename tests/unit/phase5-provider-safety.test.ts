import { describe, expect, it, vi } from "vitest";
import {
  CANONICAL_USDG,
  deviationBps,
  stockValueInUsdg,
  type CanonicalStockToken,
  type EvmAddress,
  type OraclePrice,
} from "@normic/core";
import {
  RobinhoodTradingAssetProvider,
  ZeroExTradingProvider,
  type MarketDataProvider,
} from "@normic/markets";
import { AlchemyTradingWallet } from "@normic/payments";

const address = (value: number) =>
  `0x${value.toString(16).padStart(40, "0")}` as EvmAddress;
const asset: CanonicalStockToken = {
  assetId: `0x${"12".repeat(32)}`,
  symbol: "NVDA",
  name: "NVIDIA Stock Token",
  address: address(10),
  chainId: 4663,
  decimals: 6,
  status: "ASSET_STATUS_ACTIVE",
  tradingHalt: false,
  currentMultiplier: "1000000000000000000",
  pendingMultiplier: null,
  pendingMultiplierEffectiveAt: null,
  oraclePaused: false,
  registrySource: "official-test-fixture",
  verifiedAt: new Date().toISOString(),
  blockNumber: "1",
};

function environment(target = address(20), spender = address(20)) {
  return {
    ZEROX_API_KEY: "secret-not-logged",
    NORMIC_TRADING_ALLOWED_TARGETS: target,
    NORMIC_TRADING_ALLOWED_SPENDERS: spender,
    NORMIC_TRADING_ALLOWED_SOURCES: "0x_RFQ",
    NORMIC_TRADING_VENUE_CONFIG_VERSION: "test-v1",
    NORMIC_QUOTE_TTL_SECONDS: "15",
    NORMIC_TRADING_EXECUTION_ENABLED: "true",
  };
}

function response(overrides: Record<string, unknown> = {}) {
  const target = address(20);
  return {
    zid: "traceable-quote-id",
    sellToken: CANONICAL_USDG.toLowerCase(),
    buyToken: asset.address,
    sellAmount: "10000000",
    buyAmount: "5000000",
    minBuyAmount: "4950000",
    blockNumber: null,
    liquidityAvailable: true,
    allowanceTarget: target,
    issues: {
      allowance: { spender: target },
      simulationIncomplete: false,
    },
    route: {
      tokens: [
        { address: CANONICAL_USDG.toLowerCase() },
        { address: asset.address },
      ],
      fills: [
        {
          source: "0x_RFQ",
          from: CANONICAL_USDG.toLowerCase(),
          to: asset.address,
        },
      ],
    },
    transaction: {
      to: target,
      data: `0x${"ab".repeat(32)}`,
      value: "0",
    },
    ...overrides,
  };
}

describe("Phase 5 venue and wallet safety", () => {
  it("keeps venue execution blocked until every explicit configuration exists", () => {
    const provider = new ZeroExTradingProvider({});
    expect(provider.capabilities()).toMatchObject({
      state: "blocked",
      chainId: 4663,
      executionEnabled: false,
    });
    expect(provider.capabilities().missing).toContain("ZEROX_API_KEY");
  });

  it("accepts only a direct allowlisted real quote and binds txOrigin to the owner", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get("chainId")).toBe("4663");
      expect(parsed.searchParams.get("taker")).toBe(address(1));
      expect(parsed.searchParams.get("recipient")).toBe(address(1));
      expect(parsed.searchParams.get("txOrigin")).toBe(address(2));
      return new Response(JSON.stringify(response()), { status: 200 });
    });
    const provider = new ZeroExTradingProvider(
      environment(),
      fetcher as typeof fetch,
    );
    const quote = await provider.quote({
      wallet: address(1),
      owner: address(2),
      side: "BUY",
      asset,
      usdg: {
        address: CANONICAL_USDG.toLowerCase() as EvmAddress,
        decimals: 6,
      },
      amountIn: "10000000",
      slippageBps: 100,
    });
    expect(quote).toMatchObject({
      venue: "0x-swap-api",
      blockNumber: null,
      amountIn: "10000000",
      expectedAmountOut: "5000000",
      allowance: { amount: "10000000", spender: address(20) },
    });
  });

  it("rejects unverified routers, wrong spenders, multi-hop tokens and sources", async () => {
    for (const unsafe of [
      response({ transaction: { to: address(21), data: "0xab", value: "0" } }),
      response({
        issues: {
          allowance: { spender: address(22) },
          simulationIncomplete: false,
        },
      }),
      response({
        route: {
          tokens: [
            { address: CANONICAL_USDG.toLowerCase() },
            { address: address(99) },
            { address: asset.address },
          ],
          fills: [],
        },
      }),
      response({
        route: {
          tokens: [
            { address: CANONICAL_USDG.toLowerCase() },
            { address: asset.address },
          ],
          fills: [
            {
              source: "unknown",
              from: CANONICAL_USDG.toLowerCase(),
              to: asset.address,
            },
          ],
        },
      }),
    ]) {
      const provider = new ZeroExTradingProvider(
        environment(),
        vi.fn(
          async () => new Response(JSON.stringify(unsafe), { status: 200 }),
        ) as typeof fetch,
      );
      await expect(
        provider.quote({
          wallet: address(1),
          owner: address(2),
          side: "BUY",
          asset,
          usdg: {
            address: CANONICAL_USDG.toLowerCase() as EvmAddress,
            decimals: 6,
          },
          amountIn: "10000000",
          slippageBps: 100,
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects a venue minimum output that weakens the requested slippage limit", async () => {
    const unsafe = response({ minBuyAmount: "4800000" });
    const provider = new ZeroExTradingProvider(
      environment(),
      vi.fn(
        async () => new Response(JSON.stringify(unsafe), { status: 200 }),
      ) as typeof fetch,
    );
    await expect(
      provider.quote({
        wallet: address(1),
        owner: address(2),
        side: "BUY",
        asset,
        usdg: {
          address: CANONICAL_USDG.toLowerCase() as EvmAddress,
          decimals: 6,
        },
        amountIn: "10000000",
        slippageBps: 100,
      }),
    ).rejects.toThrow(/validation/);
  });

  it("blocks autonomous signing without a reviewed trading custodian", async () => {
    const wallet = new AlchemyTradingWallet("configured-api-key");
    expect(wallet.available).toBe(true);
    expect(wallet.autonomousAvailable).toBe(false);
    await expect(
      wallet.validateSession(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      ),
    ).rejects.toThrow(/TradingSessionCustodian/);
  });

  it("uses exact integer oracle valuation and deviation math", () => {
    const oracle: OraclePrice = {
      assetId: asset.assetId,
      token: asset.address,
      feed: address(30),
      priceUnits: "2000000",
      decimals: 6,
      roundId: "1",
      updatedAt: new Date().toISOString(),
      heartbeatSeconds: 60,
      sequencerChecked: true,
      source: "chainlink-robinhood-mainnet",
      blockNumber: "1",
    };
    expect(stockValueInUsdg("5000000", 6, oracle, 6)).toBe("10000000");
    expect(deviationBps("9900000", "10000000")).toBe(100);
  });

  it("rejects the wrong chain before canonical asset reads", async () => {
    const provider = assetProvider();
    setClient(provider, { getChainId: vi.fn(async () => 1) });
    await expect(provider.validateChain()).rejects.toThrow(/4663/);
  });

  it("resolves only the canonical registry deployment and verifies onchain metadata", async () => {
    const provider = assetProvider();
    setClient(provider, canonicalClient());
    await expect(provider.resolveAsset("NVDA")).resolves.toMatchObject({
      assetId: asset.assetId,
      address: asset.address,
      chainId: 4663,
      decimals: 18,
      currentMultiplier: "1000000000000000000",
    });
  });

  it("rejects a lookalike token and unexpected Stock Token decimals", async () => {
    const lookalike = assetProvider(address(99));
    setClient(lookalike, canonicalClient());
    await expect(lookalike.resolveAsset("NVDA")).rejects.toThrow(/disagree/);

    const wrongDecimals = assetProvider();
    setClient(wrongDecimals, canonicalClient(6));
    await expect(wrongDecimals.resolveAsset("NVDA")).rejects.toThrow(
      /metadata does not match/i,
    );
  });
});

function assetProvider(priceAddress = asset.address) {
  const now = new Date().toISOString();
  const result = <T>(data: T) => ({
    state: "live" as const,
    data,
    source: "https://api.robinhood.com/rhj",
    fetchedAt: now,
    stale: false,
    error: null,
  });
  const market = {
    getStockToken: vi.fn(async () =>
      result({
        id: asset.assetId,
        tokenSymbol: asset.symbol,
        tokenName: asset.name,
        deployments: [{ chainId: 4663, contractAddress: asset.address }],
        currentMultiplier: "1",
        pendingMultiplier: null,
        pendingMultiplierEffectiveAt: null,
        logoUrl: null,
        tradingCapabilities: null,
        status: "ASSET_STATUS_ACTIVE",
      }),
    ),
    getStockPrice: vi.fn(async () =>
      result({
        tokenSymbol: asset.symbol,
        deployments: [{ chainId: 4663, contractAddress: priceAddress }],
        bid: "2",
        ask: "2",
        currency: "USD",
        volume: null,
        dailyTradingVolume: null,
        isTradingHalt: false,
        generatedAt: now,
        currentMultiplier: "1",
        effectiveBid: "2",
        effectiveAsk: "2",
      }),
    ),
  } as unknown as MarketDataProvider;
  return new RobinhoodTradingAssetProvider(market, {
    NODE_ENV: "test",
    ROBINHOOD_MAINNET_ENABLED: "true",
    ROBINHOOD_RPC_URL: "https://rpc.example.invalid",
  });
}

function setClient(
  provider: RobinhoodTradingAssetProvider,
  client: Record<string, unknown>,
) {
  (provider as unknown as { client: Record<string, unknown> }).client = client;
}

function canonicalClient(decimals = 18) {
  return {
    getChainId: vi.fn(async () => 4663),
    getBlock: vi.fn(async () => ({
      number: 10n,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
    })),
    getCode: vi.fn(async () => "0x01"),
    readContract: vi.fn(async (input: { functionName: string }) => {
      switch (input.functionName) {
        case "decimals":
          return decimals;
        case "symbol":
          return "NVDA";
        case "uid":
          return asset.assetId;
        case "uiMultiplier":
        case "newUIMultiplier":
          return 1_000_000_000_000_000_000n;
        case "effectiveAt":
          return 0n;
        case "oraclePaused":
          return false;
        default:
          throw new Error(`Unexpected contract read ${input.functionName}.`);
      }
    }),
  };
}
