export const ROBINHOOD_MARKET_API = "https://api.robinhood.com/rhj";
export * from "./trading.js";
export type StockTokenDeployment = {
  contractAddress: string;
  chainId: string | number;
};
export type StockToken = {
  id: string;
  tokenSymbol: string;
  tokenName: string;
  deployments: StockTokenDeployment[];
  currentMultiplier: string;
  pendingMultiplier: string | null;
  pendingMultiplierEffectiveAt: string | null;
  logoUrl: string | null;
  tradingCapabilities: Record<string, unknown> | null;
  status: string;
};
export type StockTokenPrice = {
  tokenSymbol: string;
  deployments: StockTokenDeployment[];
  bid: string;
  ask: string;
  currency: string;
  volume: string | null;
  dailyTradingVolume: string | null;
  isTradingHalt: boolean;
  generatedAt: string;
  currentMultiplier: string;
  effectiveBid: string;
  effectiveAsk: string;
};
export type CorporateAction = Record<string, unknown>;
export type MarketDataResult<T> = {
  state: "live" | "cached" | "stale" | "unavailable";
  data: T | null;
  source: string;
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
};
export interface AssetProvider<TAsset, TPrice, TAction> {
  listStockTokens(): Promise<MarketDataResult<TAsset[]>>;
  getStockToken(symbol: string): Promise<MarketDataResult<TAsset>>;
  getStockPrice(symbol: string): Promise<MarketDataResult<TPrice>>;
  listCorporateActions(): Promise<MarketDataResult<TAction[]>>;
}
export interface MarketDataProvider extends AssetProvider<
  StockToken,
  StockTokenPrice,
  CorporateAction
> {
  listStockTokens(): Promise<MarketDataResult<StockToken[]>>;
  getStockToken(symbol: string): Promise<MarketDataResult<StockToken>>;
  getStockPrice(symbol: string): Promise<MarketDataResult<StockTokenPrice>>;
  listCorporateActions(): Promise<MarketDataResult<CorporateAction[]>>;
}
export interface TradingProvider {
  readonly executionAvailable: false;
  execute(): Promise<never>;
}
type CacheEntry = { data: unknown; fetchedAt: number };

export class RobinhoodMarketDataProvider
  implements MarketDataProvider, TradingProvider
{
  readonly executionAvailable = false as const;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<MarketDataResult<unknown>>
  >();
  private readonly retryAt = new Map<string, number>();
  private nextUpstreamRequestAt = 0;
  constructor(
    private readonly options: {
      enabled: boolean;
      baseUrl?: string;
      fetcher?: typeof fetch;
      clock?: () => number;
      freshTtlMs?: number;
      staleTtlMs?: number;
      eventSink?: (event: {
        name: "robinhood_api_failure" | "robinhood_data_stale";
        endpoint: string;
      }) => void;
    },
  ) {}
  listStockTokens(): Promise<MarketDataResult<StockToken[]>> {
    return this.cached("assets", "/assets", parseAssets);
  }
  async getStockToken(symbol: string): Promise<MarketDataResult<StockToken>> {
    const target = normalizedSymbol(symbol);
    const assets = await this.listStockTokens();
    if (!assets.data) return { ...assets, data: null };
    const asset = assets.data.find(
      (item) => item.tokenSymbol.toUpperCase() === target,
    );
    return asset
      ? { ...assets, data: asset }
      : {
          state: "unavailable",
          data: null,
          source: assets.source,
          fetchedAt: assets.fetchedAt,
          stale: assets.stale,
          error: `Stock token ${target} was not found.`,
        };
  }
  async getStockPrice(
    symbol: string,
  ): Promise<MarketDataResult<StockTokenPrice>> {
    const target = normalizedSymbol(symbol);
    const [price, asset] = await Promise.all([
      this.cached(
        `price:${target}`,
        `/prices/${encodeURIComponent(target)}`,
        (value) => parsePrice(value, target),
      ),
      this.getStockToken(target),
    ]);
    if (!price.data) return price as MarketDataResult<StockTokenPrice>;
    if (!asset.data)
      return {
        state: "unavailable",
        data: null,
        source: price.source,
        fetchedAt: price.fetchedAt,
        stale: price.stale || asset.stale,
        error: asset.error ?? "Multiplier metadata is unavailable.",
      };
    const data = {
      ...price.data,
      currentMultiplier: asset.data.currentMultiplier,
      effectiveBid: multiplyDecimal(
        price.data.bid,
        asset.data.currentMultiplier,
      ),
      effectiveAsk: multiplyDecimal(
        price.data.ask,
        asset.data.currentMultiplier,
      ),
    };
    const now = (this.options.clock ?? Date.now)();
    const age = now - Date.parse(data.generatedAt);
    const stale =
      price.stale || asset.stale || age > (this.options.freshTtlMs ?? 15_000);
    if (stale)
      this.options.eventSink?.({
        name: "robinhood_data_stale",
        endpoint: "price",
      });
    return {
      ...price,
      state: stale
        ? "stale"
        : price.state === "cached" || asset.state === "cached"
          ? "cached"
          : "live",
      stale,
      error:
        price.error ??
        asset.error ??
        (stale
          ? "The upstream quote or multiplier exceeded its freshness threshold."
          : null),
      data,
    };
  }
  listCorporateActions(): Promise<MarketDataResult<CorporateAction[]>> {
    return this.cached(
      "corporate-actions",
      "/corporate-actions",
      parseCorporateActions,
    );
  }
  async execute(): Promise<never> {
    throw new Error(
      "The Robinhood market-data adapter is read-only and cannot execute Stock Token trades.",
    );
  }

  private async cached<T>(
    key: string,
    path: string,
    parser: (value: unknown) => T,
  ): Promise<MarketDataResult<T>> {
    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<MarketDataResult<T>>;
    const request = this.refresh(key, path, parser);
    this.inFlight.set(key, request);
    try {
      return await request;
    } finally {
      this.inFlight.delete(key);
    }
  }
  private async refresh<T>(
    key: string,
    path: string,
    parser: (value: unknown) => T,
  ): Promise<MarketDataResult<T>> {
    const source = `${this.options.baseUrl ?? ROBINHOOD_MARKET_API}${path}`;
    const now = (this.options.clock ?? Date.now)();
    const cached = this.cache.get(key),
      freshTtl =
        this.options.freshTtlMs ??
        (key === "corporate-actions" ? 3_600_000 : 15_000);
    if (cached && now - cached.fetchedAt <= freshTtl)
      return result("cached", cached.data as T, source, cached.fetchedAt, null);
    if (!this.options.enabled)
      return result<T>(
        "unavailable",
        null,
        source,
        null,
        "Robinhood mainnet market data is disabled by configuration.",
      );
    try {
      if ((this.retryAt.get(key) ?? 0) > now) throw new Error("retry_later");
      // Serialize start times to at most 20 upstream requests/second per process.
      const wait = Math.max(0, this.nextUpstreamRequestAt - Date.now());
      this.nextUpstreamRequestAt = Date.now() + wait + 50;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const response = await (this.options.fetcher ?? fetch)(source, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
        redirect: "error",
      });
      if (response.status === 429) {
        const retry = response.headers.get("retry-after");
        const seconds = Number(retry);
        this.retryAt.set(
          key,
          now +
            (retry && Number.isFinite(seconds)
              ? Math.max(1, Math.min(seconds, 3600)) * 1000
              : 60_000),
        );
      }
      if (!response.ok)
        throw new Error(
          `Robinhood market API returned HTTP ${response.status}.`,
        );
      const text = await response.text();
      if (text.length > 5_242_880) throw new Error("response_too_large");
      const data = parser(JSON.parse(text));
      if (this.cache.size >= 256 && !this.cache.has(key))
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { data, fetchedAt: now });
      return result("live", data, source, now, null);
    } catch {
      this.options.eventSink?.({
        name: "robinhood_api_failure",
        endpoint: key.startsWith("price:") ? "price" : key,
      });
      if ((this.retryAt.get(key) ?? 0) <= now)
        this.retryAt.set(key, now + 5_000);
      if (this.retryAt.size > 512)
        this.retryAt.delete(this.retryAt.keys().next().value!);
      const message =
        "Robinhood market data is unavailable or rate-limited. Retry after the backoff window.";
      const staleTtl = this.options.staleTtlMs ?? 300_000;
      if (cached && now - cached.fetchedAt <= staleTtl)
        return result(
          "stale",
          cached.data as T,
          source,
          cached.fetchedAt,
          message,
        );
      return result<T>("unavailable", null, source, null, message);
    }
  }
}

export function createRobinhoodMarketProviderFromEnvironment(
  environment: Record<string, string | undefined> = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env ?? {},
  eventSink?: (event: {
    name: "robinhood_api_failure" | "robinhood_data_stale";
    endpoint: string;
  }) => void,
) {
  if (
    environment.ROBINHOOD_MARKET_API_URL &&
    environment.ROBINHOOD_MARKET_API_URL.replace(/\/$/, "") !==
      ROBINHOOD_MARKET_API
  )
    throw new Error(
      "Production and local runtime use only the official Robinhood Stock Token API.",
    );
  return new RobinhoodMarketDataProvider({
    enabled: environment.ROBINHOOD_MAINNET_ENABLED === "true",
    ...(eventSink ? { eventSink } : {}),
  });
}

function result<T>(
  state: MarketDataResult<T>["state"],
  data: T | null,
  source: string,
  fetchedAt: number | null,
  error: string | null,
): MarketDataResult<T> {
  return {
    state,
    data,
    source,
    fetchedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString(),
    stale: state === "stale",
    error,
  };
}
function parseAssets(value: unknown): StockToken[] {
  const array = arrayPayload(value, ["assets", "results", "data"]);
  return array
    .map((item) => {
      const row = object(item);
      return {
        id: required(row.id, "asset id"),
        tokenSymbol: required(row.tokenSymbol, "token symbol"),
        tokenName: required(row.tokenName, "token name"),
        deployments: deployments(row.deployments),
        currentMultiplier: decimal(row.currentMultiplier, "current multiplier"),
        pendingMultiplier: nullable(row.pendingMultiplier),
        pendingMultiplierEffectiveAt: nullable(
          row.pendingMultiplierEffectiveAt ??
            row.pendingMultiplierEffectiveTime,
        ),
        logoUrl: nullable(row.logoUrl),
        tradingCapabilities:
          row.tradingCapabilities == null
            ? null
            : object(row.tradingCapabilities),
        status: required(row.status, "asset status"),
      };
    })
    .filter((asset) =>
      asset.deployments.some(
        (deployment) => Number(deployment.chainId) === 4663,
      ),
    );
}
function parsePrice(
  value: unknown,
  symbol: string,
): Omit<
  StockTokenPrice,
  "currentMultiplier" | "effectiveBid" | "effectiveAsk"
> {
  const wrapped = object(value);
  const row = Array.isArray(wrapped.quotes)
    ? object(
        wrapped.quotes.find(
          (quote: unknown) => object(quote).tokenSymbol === symbol,
        ),
      )
    : object(unwrap(value, ["price", "data"]));
  if (row.tokenSymbol !== symbol)
    throw new Error("Robinhood quote symbol mismatch.");
  if (typeof row.isTradingHalt !== "boolean")
    throw new Error("Robinhood halt state is invalid.");
  const generatedAt = required(row.generatedAt, "generated time");
  if (!Number.isFinite(Date.parse(generatedAt)))
    throw new Error("Robinhood quote timestamp is invalid.");
  const tokenDeployments = deployments(row.deployments);
  if (
    !tokenDeployments.some((deployment) => Number(deployment.chainId) === 4663)
  )
    throw new Error("The quote has no Robinhood mainnet deployment.");
  return {
    tokenSymbol: required(row.tokenSymbol, "token symbol"),
    deployments: tokenDeployments,
    bid: decimal(row.bid, "bid"),
    ask: decimal(row.ask, "ask"),
    currency: required(row.currency, "currency"),
    volume: nullable(row.dailyTradingVolume ?? row.volume),
    dailyTradingVolume: nullable(row.dailyTradingVolume ?? row.volume),
    isTradingHalt: row.isTradingHalt,
    generatedAt,
  };
}
function parseCorporateActions(value: unknown) {
  return arrayPayload(value, [
    "corpActions",
    "corporateActions",
    "results",
    "data",
  ]).map(object);
}
function arrayPayload(value: unknown, keys: string[]) {
  if (Array.isArray(value)) return value;
  const row = object(value);
  for (const key of keys)
    if (Array.isArray(row[key])) return row[key] as unknown[];
  throw new Error("Robinhood market API returned an invalid list response.");
}
function unwrap(value: unknown, keys: string[]) {
  const row = object(value);
  for (const key of keys)
    if (row[key] && typeof row[key] === "object") return row[key];
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Robinhood market API returned invalid data.");
  return value as Record<string, unknown>;
}
function required(value: unknown, label: string) {
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error(`Robinhood ${label} is invalid.`);
  return String(value);
}
function decimal(value: unknown, label: string) {
  const text = required(value, label);
  if (!/^\d{1,40}(?:\.\d{1,36})?$/.test(text))
    throw new Error(`Robinhood ${label} is invalid.`);
  return text;
}
function nullable(value: unknown): string | null {
  return value === null || value === undefined || value === ""
    ? null
    : String(value);
}
function deployments(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => {
        const row = object(entry);
        return {
          contractAddress: required(row.contractAddress, "contract address"),
          chainId:
            typeof row.chainId === "number"
              ? row.chainId
              : required(row.chainId, "chain id"),
        };
      })
    : [];
}
function normalizedSymbol(symbol: string) {
  const value = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(value))
    throw new Error("Invalid Stock Token symbol.");
  return value;
}
function multiplyDecimal(left: string, right: string): string {
  const parse = (value: string) => {
    const negative = value.startsWith("-");
    const clean = negative ? value.slice(1) : value;
    const [whole = "0", fraction = ""] = clean.split(".");
    return {
      value: BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n),
      scale: fraction.length,
    };
  };
  const a = parse(left),
    b = parse(right),
    scale = a.scale + b.scale,
    raw = (a.value * b.value).toString();
  const negative = raw.startsWith("-"),
    digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(scale + 1, "0"),
    split = padded.length - scale;
  const value = scale
    ? `${padded.slice(0, split)}.${padded.slice(split).replace(/0+$/, "")}`.replace(
        /\.$/,
        "",
      )
    : padded;
  return `${negative ? "-" : ""}${value}`;
}
