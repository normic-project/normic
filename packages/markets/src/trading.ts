import {
  createPublicClient,
  erc20Abi,
  http,
  parseAbi,
  type Hex,
  type PublicClient,
} from "viem";
import {
  CANONICAL_USDG,
  DomainError,
  PolicyDeniedError,
  addressSchema,
  positiveUnitsSchema,
  type CanonicalStockToken,
  type EligibilityProvider,
  type EvmAddress,
  type OraclePrice,
  type SafeCall,
  type Trade,
  type TradeQuote,
  type TradingAssetPort,
  type TradingEligibility,
  type TradingVenueCapabilities,
  type TradingVenueProvider,
  type VenueQuote,
  type VenueQuoteRequest,
  type VerifiedTradeSettlement,
} from "@normic/core";
import type { MarketDataProvider, StockToken } from "./index.js";

const stockTokenAbi = parseAbi([
  "function uid() view returns (bytes32)",
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function oraclePaused() view returns (bool)",
]);
const aggregatorAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);
const hexData = (value: unknown): Hex => {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value))
    throw new Error("Venue returned malformed transaction data.");
  return value.toLowerCase() as Hex;
};
const lowerAddress = (value: unknown) => addressSchema.parse(value);

type OracleConfiguration = {
  version: string;
  source: string;
  feeds: Record<string, { address: EvmAddress; heartbeatSeconds: number }>;
};

function parseOracleConfiguration(value?: string): OracleConfiguration | null {
  if (!value) return null;
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (
    typeof parsed.version !== "string" ||
    !parsed.version ||
    typeof parsed.source !== "string" ||
    !parsed.source.startsWith("https://docs.chain.link/") ||
    !parsed.feeds ||
    typeof parsed.feeds !== "object" ||
    Array.isArray(parsed.feeds)
  )
    throw new Error("Invalid explicit Chainlink oracle configuration.");
  const feeds: OracleConfiguration["feeds"] = {};
  for (const [id, raw] of Object.entries(
    parsed.feeds as Record<string, unknown>,
  )) {
    if (!/^0x[0-9a-f]{64}$/.test(id) || !raw || typeof raw !== "object")
      throw new Error("Oracle feeds must be keyed by canonical asset UID.");
    const record = raw as Record<string, unknown>,
      heartbeat = Number(record.heartbeatSeconds);
    if (
      !Number.isSafeInteger(heartbeat) ||
      heartbeat <= 0 ||
      heartbeat > 604800
    )
      throw new Error("Each oracle feed requires an explicit heartbeat.");
    feeds[id] = {
      address: lowerAddress(record.address),
      heartbeatSeconds: heartbeat,
    };
  }
  return { version: parsed.version, source: parsed.source, feeds };
}

export class RobinhoodTradingAssetProvider implements TradingAssetPort {
  readonly client: PublicClient | null;
  private readonly oracleConfiguration: OracleConfiguration | null;
  private readonly sequencerFeed: EvmAddress | null;
  private readonly sequencerGraceSeconds: number | null;

  constructor(
    private readonly market: MarketDataProvider,
    private readonly env: Record<string, string | undefined>,
  ) {
    const rpc = env.ROBINHOOD_RPC_URL;
    if (rpc) {
      const url = new URL(rpc);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        (env.NODE_ENV === "production" &&
          url.hostname === "rpc.mainnet.chain.robinhood.com")
      )
        throw new Error(
          "A dedicated HTTPS Robinhood Chain production RPC is required.",
        );
    }
    this.client = rpc
      ? createPublicClient({
          transport: http(rpc, { retryCount: 0, timeout: 10_000 }),
        })
      : null;
    this.oracleConfiguration = parseOracleConfiguration(
      env.NORMIC_STOCK_ORACLE_CONFIG_JSON,
    );
    this.sequencerFeed = env.NORMIC_SEQUENCER_UPTIME_FEED
      ? lowerAddress(env.NORMIC_SEQUENCER_UPTIME_FEED)
      : null;
    const grace = Number(env.NORMIC_SEQUENCER_GRACE_SECONDS);
    this.sequencerGraceSeconds =
      Number.isSafeInteger(grace) && grace > 0 ? grace : null;
  }

  capabilities() {
    const missing = [
      ...(this.env.ROBINHOOD_MAINNET_ENABLED !== "true"
        ? ["ROBINHOOD_MAINNET_ENABLED=true"]
        : []),
      ...(!this.client ? ["ROBINHOOD_RPC_URL"] : []),
      ...(!this.oracleConfiguration ? ["NORMIC_STOCK_ORACLE_CONFIG_JSON"] : []),
      ...(!this.sequencerFeed ? ["NORMIC_SEQUENCER_UPTIME_FEED"] : []),
      ...(!this.sequencerGraceSeconds
        ? ["NORMIC_SEQUENCER_GRACE_SECONDS"]
        : []),
    ];
    return { state: missing.length ? "blocked" : "ready", missing } as const;
  }

  private rpc() {
    if (!this.client)
      throw new DomainError(
        "Robinhood Chain production RPC is not configured.",
        "TRADING_UNAVAILABLE",
      );
    return this.client;
  }

  async validateChain() {
    if (this.env.ROBINHOOD_MAINNET_ENABLED !== "true")
      throw new DomainError(
        "Robinhood Chain Mainnet is not enabled for this deployment.",
        "TRADING_UNAVAILABLE",
      );
    if ((await this.rpc().getChainId()) !== 4663)
      throw new DomainError(
        "Wrong chain: Robinhood Chain Mainnet (4663) is required.",
        "TRADING_UNAVAILABLE",
      );
  }

  async canonicalUsdg() {
    await this.validateChain();
    const rpc = this.rpc(),
      block = await rpc.getBlock({ blockTag: "finalized" }),
      code = await rpc.getCode({
        address: CANONICAL_USDG,
        blockNumber: block.number,
      });
    if (!code || code === "0x")
      throw new DomainError(
        "Canonical USDG bytecode is unavailable.",
        "TRADING_UNAVAILABLE",
      );
    const [decimals, symbol] = await Promise.all([
      rpc.readContract({
        address: CANONICAL_USDG,
        abi: erc20Abi,
        functionName: "decimals",
        blockNumber: block.number,
      }),
      rpc.readContract({
        address: CANONICAL_USDG,
        abi: erc20Abi,
        functionName: "symbol",
        blockNumber: block.number,
      }),
    ]);
    if (symbol !== "USDG" || decimals > 36)
      throw new DomainError(
        "Canonical USDG metadata is invalid.",
        "TRADING_UNAVAILABLE",
      );
    return {
      address: CANONICAL_USDG,
      decimals,
      blockNumber: block.number.toString(),
    };
  }

  private deployment(asset: StockToken) {
    const candidates = asset.deployments.filter(
      (deployment) => Number(deployment.chainId) === 4663,
    );
    if (candidates.length !== 1)
      throw new DomainError(
        "The official registry did not return one canonical Robinhood Chain deployment.",
        "TRADING_UNAVAILABLE",
      );
    return lowerAddress(candidates[0]!.contractAddress);
  }

  async resolveAsset(symbol: string): Promise<CanonicalStockToken> {
    await this.validateChain();
    const [assetResult, priceResult] = await Promise.all([
      this.market.getStockToken(symbol),
      this.market.getStockPrice(symbol),
    ]);
    if (
      !assetResult.data ||
      assetResult.stale ||
      !priceResult.data ||
      priceResult.stale
    )
      throw new DomainError(
        "Fresh official Robinhood Stock Token registry and halt data are required.",
        "TRADING_UNAVAILABLE",
      );
    const asset = assetResult.data,
      address = this.deployment(asset),
      priceAddress = priceResult.data.deployments.find(
        (deployment) => Number(deployment.chainId) === 4663,
      );
    if (
      !priceAddress ||
      lowerAddress(priceAddress.contractAddress) !== address ||
      !/^0x[0-9a-f]{64}$/.test(asset.id)
    )
      throw new DomainError(
        "Official Stock Token identity sources disagree.",
        "TRADING_UNAVAILABLE",
      );
    const rpc = this.rpc(),
      block = await rpc.getBlock({ blockTag: "finalized" }),
      code = await rpc.getCode({ address, blockNumber: block.number });
    if (!code || code === "0x")
      throw new DomainError(
        "Canonical Stock Token bytecode is unavailable.",
        "TRADING_UNAVAILABLE",
      );
    const [
      decimals,
      tokenSymbol,
      uid,
      multiplier,
      pending,
      effectiveAt,
      paused,
    ] = await Promise.all([
      rpc.readContract({
        address,
        abi: erc20Abi,
        functionName: "decimals",
        blockNumber: block.number,
      }),
      rpc.readContract({
        address,
        abi: erc20Abi,
        functionName: "symbol",
        blockNumber: block.number,
      }),
      rpc.readContract({
        address,
        abi: stockTokenAbi,
        functionName: "uid",
        blockNumber: block.number,
      }),
      rpc.readContract({
        address,
        abi: stockTokenAbi,
        functionName: "uiMultiplier",
        blockNumber: block.number,
      }),
      rpc.readContract({
        address,
        abi: stockTokenAbi,
        functionName: "newUIMultiplier",
        blockNumber: block.number,
      }),
      rpc.readContract({
        address,
        abi: stockTokenAbi,
        functionName: "effectiveAt",
        blockNumber: block.number,
      }),
      rpc.readContract({
        address,
        abi: stockTokenAbi,
        functionName: "oraclePaused",
        blockNumber: block.number,
      }),
    ]);
    // The official API serializes the UI multiplier as an 18-decimal value.
    const [whole, fraction = ""] = asset.currentMultiplier.split(".");
    if (fraction.length > 18)
      throw new DomainError(
        "The official Stock Token multiplier has unsupported precision.",
        "TRADING_UNAVAILABLE",
      );
    const normalizedRest =
      BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
    if (
      decimals !== 18 ||
      tokenSymbol.toUpperCase() !== asset.tokenSymbol.toUpperCase() ||
      uid.toLowerCase() !== asset.id ||
      multiplier !== normalizedRest
    )
      throw new DomainError(
        "Onchain Stock Token metadata does not match the official registry.",
        "TRADING_UNAVAILABLE",
      );
    return {
      assetId: asset.id,
      symbol: asset.tokenSymbol,
      name: asset.tokenName,
      address,
      chainId: 4663,
      decimals,
      status: asset.status,
      tradingHalt: priceResult.data.isTradingHalt,
      currentMultiplier: multiplier.toString(),
      pendingMultiplier: pending === multiplier ? null : pending.toString(),
      pendingMultiplierEffectiveAt:
        pending === multiplier || effectiveAt === 0n
          ? null
          : new Date(Number(effectiveAt) * 1000).toISOString(),
      oraclePaused: paused,
      registrySource: assetResult.source,
      verifiedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
      blockNumber: block.number.toString(),
    };
  }

  async oracle(asset: CanonicalStockToken): Promise<OraclePrice> {
    await this.validateChain();
    const config = this.oracleConfiguration?.feeds[asset.assetId];
    if (!config || !this.sequencerFeed || !this.sequencerGraceSeconds)
      throw new DomainError(
        "A versioned Chainlink feed and sequencer configuration is required for this asset.",
        "TRADING_UNAVAILABLE",
      );
    if (asset.oraclePaused)
      throw new PolicyDeniedError(
        "The Stock Token oracle is paused for a corporate action.",
      );
    const rpc = this.rpc(),
      block = await rpc.getBlock({ blockTag: "finalized" });
    for (const address of [config.address, this.sequencerFeed]) {
      const code = await rpc.getCode({ address, blockNumber: block.number });
      if (!code || code === "0x")
        throw new DomainError(
          "Configured Chainlink feed bytecode is unavailable.",
          "TRADING_UNAVAILABLE",
        );
    }
    const [decimals, round, sequencer] = await Promise.all([
      rpc.readContract({
        address: config.address,
        abi: aggregatorAbi,
        functionName: "decimals",
        blockNumber: block.number,
      }),
      rpc.readContract({
        address: config.address,
        abi: aggregatorAbi,
        functionName: "latestRoundData",
        blockNumber: block.number,
      }),
      rpc.readContract({
        address: this.sequencerFeed,
        abi: aggregatorAbi,
        functionName: "latestRoundData",
        blockNumber: block.number,
      }),
    ]);
    const [roundId, answer, , updatedAt, answeredInRound] = round,
      [, sequencerStatus, sequencerStartedAt] = sequencer;
    if (
      decimals > 36 ||
      answer <= 0n ||
      updatedAt <= 0n ||
      answeredInRound < roundId ||
      block.timestamp - updatedAt > BigInt(config.heartbeatSeconds) ||
      sequencerStatus !== 0n ||
      block.timestamp - sequencerStartedAt <= BigInt(this.sequencerGraceSeconds)
    )
      throw new PolicyDeniedError(
        "Chainlink oracle or Robinhood Chain sequencer data is unsafe or stale.",
      );
    return {
      assetId: asset.assetId,
      token: asset.address,
      feed: config.address,
      priceUnits: answer.toString(),
      decimals,
      roundId: roundId.toString(),
      updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
      heartbeatSeconds: config.heartbeatSeconds,
      sequencerChecked: true,
      source: "chainlink-robinhood-mainnet",
      blockNumber: block.number.toString(),
    };
  }

  async tokenBalance(wallet: EvmAddress, token: EvmAddress) {
    await this.validateChain();
    const block = await this.rpc().getBlock({ blockTag: "finalized" }),
      units = await this.rpc().readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet],
        blockNumber: block.number,
      });
    return {
      units: units.toString(),
      blockNumber: block.number.toString(),
      timestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
    };
  }

  async allowance(wallet: EvmAddress, token: EvmAddress, spender: EvmAddress) {
    await this.validateChain();
    return (
      await this.rpc().readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [wallet, spender],
        blockTag: "finalized",
      })
    ).toString();
  }

  async simulate(wallet: EvmAddress, calls: SafeCall[]) {
    await this.validateChain();
    if (calls.length !== 1 || calls[0]!.value !== "0x0")
      throw new PolicyDeniedError(
        "Exactly one zero-native-value venue call is required.",
      );
    await this.rpc().call({
      account: wallet,
      to: calls[0]!.to,
      data: calls[0]!.data,
      value: 0n,
      blockTag: "latest",
    });
    await this.validateChain();
  }

  private async balanceAt(
    token: EvmAddress,
    wallet: EvmAddress,
    block: bigint,
  ) {
    return this.rpc().readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet],
      blockNumber: block,
    });
  }

  async verifySettlement(
    trade: Trade,
    quote: TradeQuote,
  ): Promise<VerifiedTradeSettlement> {
    if (!trade.transactionHash)
      throw new DomainError("A transaction hash is required.", "INVALID_STATE");
    await this.validateChain();
    const rpc = this.rpc(),
      receipt = await rpc.getTransactionReceipt({
        hash: trade.transactionHash,
      }),
      transaction = await rpc.getTransaction({ hash: trade.transactionHash }),
      finalized = await rpc.getBlock({ blockTag: "finalized" });
    if (receipt.status !== "success" || receipt.blockNumber > finalized.number)
      throw new DomainError(
        "Trade is reverted or not finalized.",
        "TRADE_NOT_FINALIZED",
      );
    if (
      transaction.chainId !== 4663 ||
      transaction.from.toLowerCase() !== trade.wallet ||
      transaction.to?.toLowerCase() !== quote.transaction.to ||
      transaction.input.toLowerCase() !== quote.transaction.data ||
      transaction.value !== 0n
    )
      throw new DomainError(
        "Finalized transaction does not match the immutable venue quote.",
        "TRADING_UNAVAILABLE",
      );
    const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash || block.number === 0n)
      throw new DomainError(
        "Trade receipt is not canonical.",
        "TRADING_UNAVAILABLE",
      );
    const [inputBefore, inputAfter, outputBefore, outputAfter] =
      await Promise.all([
        this.balanceAt(quote.inputToken, trade.wallet, block.number - 1n),
        this.balanceAt(quote.inputToken, trade.wallet, block.number),
        this.balanceAt(quote.outputToken, trade.wallet, block.number - 1n),
        this.balanceAt(quote.outputToken, trade.wallet, block.number),
      ]);
    if (inputBefore < inputAfter || outputAfter < outputBefore)
      throw new DomainError(
        "Finalized wallet deltas do not match the trade direction.",
        "TRADING_UNAVAILABLE",
      );
    const actualIn = inputBefore - inputAfter,
      actualOut = outputAfter - outputBefore;
    if (
      actualIn !== BigInt(quote.amountIn) ||
      actualOut < BigInt(quote.minimumAmountOut)
    )
      throw new DomainError(
        "Finalized token deltas violate the immutable quote.",
        "TRADING_UNAVAILABLE",
      );
    return {
      chainId: 4663,
      transactionHash: receipt.transactionHash,
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      wallet: trade.wallet,
      inputToken: quote.inputToken,
      outputToken: quote.outputToken,
      actualAmountIn: actualIn.toString(),
      actualAmountOut: actualOut.toString(),
      confirmedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    };
  }
}

function addressList(value?: string): EvmAddress[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map(lowerAddress),
    ),
  ];
}

export class ZeroExTradingProvider implements TradingVenueProvider {
  private readonly allowedTargets: EvmAddress[];
  private readonly allowedSpenders: EvmAddress[];
  private readonly allowedSources: string[];
  private readonly ttlSeconds: number | null;

  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.allowedTargets = addressList(env.NORMIC_TRADING_ALLOWED_TARGETS);
    this.allowedSpenders = addressList(env.NORMIC_TRADING_ALLOWED_SPENDERS);
    this.allowedSources = (env.NORMIC_TRADING_ALLOWED_SOURCES ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const ttl = Number(env.NORMIC_QUOTE_TTL_SECONDS);
    this.ttlSeconds =
      Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 60 ? ttl : null;
  }

  capabilities(): TradingVenueCapabilities {
    const missing = [
      ...(!this.env.ZEROX_API_KEY ? ["ZEROX_API_KEY"] : []),
      ...(!this.allowedTargets.length
        ? ["NORMIC_TRADING_ALLOWED_TARGETS"]
        : []),
      ...(!this.allowedSpenders.length
        ? ["NORMIC_TRADING_ALLOWED_SPENDERS"]
        : []),
      ...(!this.allowedSources.length
        ? ["NORMIC_TRADING_ALLOWED_SOURCES"]
        : []),
      ...(!this.env.NORMIC_TRADING_VENUE_CONFIG_VERSION
        ? ["NORMIC_TRADING_VENUE_CONFIG_VERSION"]
        : []),
      ...(!this.ttlSeconds ? ["NORMIC_QUOTE_TTL_SECONDS"] : []),
      ...(this.env.NORMIC_TRADING_EXECUTION_ENABLED !== "true"
        ? ["NORMIC_TRADING_EXECUTION_ENABLED=true"]
        : []),
      ...(this.env.NODE_ENV === "production" &&
      this.env.NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED !== "true"
        ? ["NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED=true"]
        : []),
    ];
    return {
      venue: "0x-swap-api",
      state: missing.length ? "blocked" : "ready",
      missing,
      chainId: 4663,
      executionEnabled: missing.length === 0,
      configVersion: this.env.NORMIC_TRADING_VENUE_CONFIG_VERSION ?? null,
      allowedTargets: this.allowedTargets,
      allowedSpenders: this.allowedSpenders,
      allowedSources: this.allowedSources,
    };
  }

  async quote(input: VenueQuoteRequest): Promise<VenueQuote> {
    const capabilities = this.capabilities();
    if (
      capabilities.state !== "ready" ||
      !this.env.ZEROX_API_KEY ||
      !this.ttlSeconds
    )
      throw new DomainError(
        "The verified 0x Robinhood Chain venue is not fully configured.",
        "TRADING_UNAVAILABLE",
      );
    const sellToken =
        input.side === "BUY" ? input.usdg.address : input.asset.address,
      buyToken =
        input.side === "BUY" ? input.asset.address : input.usdg.address,
      params = new URLSearchParams({
        chainId: "4663",
        sellToken,
        buyToken,
        sellAmount: positiveUnitsSchema.parse(input.amountIn),
        taker: input.wallet,
        recipient: input.wallet,
        txOrigin: input.owner,
        slippageBps: String(input.slippageBps),
        excludedSources: "",
      });
    params.delete("excludedSources");
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.0x.org/swap/allowance-holder/quote?${params.toString()}`,
        {
          headers: {
            accept: "application/json",
            "0x-api-key": this.env.ZEROX_API_KEY,
            "0x-version": "v2",
          },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new DomainError(
        "The configured 0x quote provider is unavailable.",
        "TRADING_UNAVAILABLE",
      );
    }
    if (!response.ok)
      throw new DomainError(
        `The 0x quote provider returned HTTP ${response.status}.`,
        "TRADING_UNAVAILABLE",
      );
    const text = await response.text();
    if (text.length > 1_048_576)
      throw new DomainError(
        "Venue response exceeded the safe limit.",
        "TRADING_UNAVAILABLE",
      );
    const data = JSON.parse(text) as Record<string, unknown>,
      transaction = data.transaction as Record<string, unknown>,
      issues = data.issues as Record<string, unknown>,
      allowanceIssue = issues?.allowance as Record<string, unknown> | null,
      route = data.route as Record<string, unknown>,
      fills = Array.isArray(route?.fills) ? route.fills : [],
      tokens = Array.isArray(route?.tokens) ? route.tokens : [];
    const returnedSell = lowerAddress(data.sellToken),
      returnedBuy = lowerAddress(data.buyToken),
      target = lowerAddress(transaction?.to),
      allowanceTarget = lowerAddress(data.allowanceTarget),
      spender = allowanceIssue?.spender
        ? lowerAddress(allowanceIssue.spender)
        : allowanceTarget,
      sellAmount = positiveUnitsSchema.parse(data.sellAmount),
      buyAmount = positiveUnitsSchema.parse(data.buyAmount),
      minimum = positiveUnitsSchema.parse(data.minBuyAmount),
      blockNumber =
        data.blockNumber === null || data.blockNumber === undefined
          ? null
          : positiveUnitsSchema.parse(data.blockNumber),
      zid =
        typeof data.zid === "string" && data.zid.length <= 256
          ? data.zid
          : null;
    if (
      !zid ||
      returnedSell !== sellToken ||
      returnedBuy !== buyToken ||
      sellAmount !== input.amountIn ||
      data.liquidityAvailable !== true ||
      issues?.simulationIncomplete !== false ||
      !this.allowedTargets.includes(target) ||
      !this.allowedSpenders.includes(spender) ||
      target !== allowanceTarget ||
      spender !== allowanceTarget ||
      String(transaction?.value ?? "0") !== "0" ||
      BigInt(minimum) > BigInt(buyAmount) ||
      BigInt(minimum) * 10_000n <
        BigInt(buyAmount) * BigInt(10_000 - input.slippageBps)
    )
      throw new PolicyDeniedError(
        "The venue quote failed token, simulation, target, or spender validation.",
      );
    const allowedTokens = new Set([sellToken, buyToken]);
    if (
      tokens.some((token) => {
        const address = (token as Record<string, unknown>).address;
        return !allowedTokens.has(lowerAddress(address));
      })
    )
      throw new PolicyDeniedError(
        "Multi-hop or unknown quote tokens are forbidden.",
      );
    const parsedRoute = fills.map((fill) => {
      const record = fill as Record<string, unknown>,
        source = typeof record.source === "string" ? record.source : "";
      if (!this.allowedSources.includes(source))
        throw new PolicyDeniedError(
          "The quote uses an unapproved liquidity source.",
        );
      const from = lowerAddress(record.from),
        to = lowerAddress(record.to);
      if (from !== sellToken || to !== buyToken)
        throw new PolicyDeniedError(
          "Only direct USDG/Stock Token routes are allowed.",
        );
      return { source, from, to };
    });
    if (!parsedRoute.length)
      throw new PolicyDeniedError("The venue returned no executable route.");
    const now = Date.now();
    return {
      providerQuoteId: zid,
      venue: "0x-swap-api",
      inputToken: sellToken,
      outputToken: buyToken,
      amountIn: sellAmount,
      expectedAmountOut: buyAmount,
      minimumAmountOut: minimum,
      blockNumber,
      route: parsedRoute,
      allowance: {
        token: sellToken,
        spender,
        amount: sellAmount,
      },
      transaction: {
        to: target,
        data: hexData(transaction?.data),
        value: "0x0",
      },
      quotedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlSeconds * 1000).toISOString(),
      venueConfigVersion: capabilities.configVersion!,
    };
  }
}

export class UnavailableEligibilityProvider implements EligibilityProvider {
  capabilities() {
    return {
      state: "blocked" as const,
      provider: null,
      missing: ["production EligibilityProvider integration"],
    };
  }
  async assess(): Promise<
    Omit<TradingEligibility, "companyId" | "ownerUserId" | "version">
  > {
    throw new DomainError(
      "A production-grade owner eligibility provider is not configured.",
      "TRADING_UNAVAILABLE",
    );
  }
}
