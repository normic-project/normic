import { NetworkDisabledError, type NetworkCapability } from "@normic/core";

export const ROBINHOOD_MAINNET = {
  networkId: "robinhood-mainnet",
  displayName: "Robinhood Chain Mainnet",
  chainId: 4663,
  publicRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
} as const;

export type ChainReadResult<T> = {
  networkId: string;
  chainId: number;
  source: string;
  observedAt: string;
  data: T;
};
export interface ChainProvider {
  readonly key: string;
  readonly networkId: string;
  readonly chainId: number;
  readonly enabled: boolean;
  readonly executionAvailable: false;
  describe(): NetworkCapability;
  getBlockNumber(): Promise<ChainReadResult<string>>;
  getBlock(
    block: string,
  ): Promise<ChainReadResult<Record<string, unknown> | null>>;
  getTransaction(
    hash: string,
  ): Promise<ChainReadResult<Record<string, unknown> | null>>;
  getCode(address: string, block?: string): Promise<ChainReadResult<string>>;
  execute(): Promise<never>;
}

export class RobinhoodChainProvider implements ChainProvider {
  readonly key = "robinhood-read-only";
  readonly networkId = ROBINHOOD_MAINNET.networkId;
  readonly chainId = ROBINHOOD_MAINNET.chainId;
  readonly executionAvailable = false as const;
  private verifiedAt = 0;
  constructor(
    readonly enabled: boolean,
    private readonly rpcUrl: string | null,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  describe(): NetworkCapability {
    const available = this.enabled && Boolean(this.rpcUrl);
    return {
      id: this.networkId,
      displayName: ROBINHOOD_MAINNET.displayName,
      family: "evm",
      chainId: this.chainId,
      primary: true,
      enabled: this.enabled,
      executionAvailable: false,
      readOnlyAvailable: available,
      capabilities: [
        "chain-state",
        "stock-token-metadata",
        "stock-token-prices",
      ],
      status: available
        ? "read-only"
        : this.enabled
          ? "unavailable"
          : "inactive",
    };
  }
  async getBlockNumber() {
    const result = await this.read<string>("eth_blockNumber", []);
    if (typeof result.data !== "string" || !/^0x[0-9a-f]+$/i.test(result.data))
      throw new Error("Invalid RPC block number response.");
    return result;
  }
  async getBlock(block: string) {
    if (!/^(latest|safe|finalized|0x[0-9a-f]+)$/i.test(block))
      throw new Error("Invalid block identifier.");
    return this.read<Record<string, unknown> | null>("eth_getBlockByNumber", [
      block,
      false,
    ]);
  }
  async getTransaction(hash: string) {
    if (!/^0x[0-9a-f]{64}$/i.test(hash))
      throw new Error("Invalid transaction hash.");
    return this.read<Record<string, unknown> | null>(
      "eth_getTransactionByHash",
      [hash],
    );
  }
  async getCode(address: string, block = "latest") {
    if (!/^0x[0-9a-f]{40}$/i.test(address))
      throw new Error("Invalid EVM address.");
    if (!/^(latest|safe|finalized|0x[0-9a-f]+)$/i.test(block))
      throw new Error("Invalid block identifier.");
    const result = await this.read<string>("eth_getCode", [address, block]);
    if (
      typeof result.data !== "string" ||
      !/^0x(?:[0-9a-f]{2})*$/i.test(result.data)
    )
      throw new Error("Invalid RPC bytecode response.");
    return result;
  }
  async execute(): Promise<never> {
    throw new NetworkDisabledError(ROBINHOOD_MAINNET.displayName);
  }
  private async read<T>(
    method: string,
    params: unknown[],
  ): Promise<ChainReadResult<T>> {
    if (!this.enabled || !this.rpcUrl)
      throw new NetworkDisabledError(ROBINHOOD_MAINNET.displayName);
    if (Date.now() - this.verifiedAt > 60_000) {
      const chainId = await this.rpc<string>("eth_chainId", []);
      if (Number.parseInt(chainId, 16) !== this.chainId)
        throw new Error("The configured RPC is not Robinhood Chain mainnet.");
      this.verifiedAt = Date.now();
    }
    const data = await this.rpc<T>(method, params);
    return {
      networkId: this.networkId,
      chainId: this.chainId,
      source: new URL(this.rpcUrl).origin,
      observedAt: new Date().toISOString(),
      data,
    };
  }
  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    if (!this.rpcUrl) throw new NetworkDisabledError(this.networkId);
    const response = await this.fetcher(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`Robinhood Chain RPC returned HTTP ${response.status}.`);
    const payload = (await response.json()) as {
      result?: T;
      error?: { message?: string };
    };
    if (payload.error) throw new Error("Robinhood Chain RPC request failed.");
    if (!("result" in payload))
      throw new Error("Robinhood Chain RPC returned an invalid response.");
    return payload.result as T;
  }
}

export class ChainRegistry {
  constructor(private readonly providers: readonly ChainProvider[]) {}
  listCapabilities() {
    return this.providers.map((provider) => provider.describe());
  }
  get(networkId: string) {
    const provider = this.providers.find(
      (item) => item.networkId === networkId,
    );
    if (!provider) throw new Error(`Unsupported network: ${networkId}`);
    return provider;
  }
}

export function createChainRegistry(config: {
  robinhoodMainnetEnabled: boolean;
  robinhoodRpcUrl?: string | null;
  fetcher?: typeof fetch;
}) {
  return new ChainRegistry([
    new RobinhoodChainProvider(
      config.robinhoodMainnetEnabled,
      config.robinhoodRpcUrl ??
        (config.robinhoodMainnetEnabled
          ? ROBINHOOD_MAINNET.publicRpcUrl
          : null),
      config.fetcher,
    ),
  ]);
}
export function createChainRegistryFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const enabled = environment.ROBINHOOD_MAINNET_ENABLED === "true";
  if (environment.NODE_ENV === "production") {
    if (environment.NORMIC_NETWORK !== ROBINHOOD_MAINNET.networkId)
      throw new Error(
        "NORMIC_NETWORK must be robinhood-mainnet in production.",
      );
    if (!enabled)
      throw new Error("ROBINHOOD_MAINNET_ENABLED must be true in production.");
    if (!environment.ROBINHOOD_RPC_URL)
      throw new Error(
        "ROBINHOOD_RPC_URL is required in production; the public rate-limited RPC is development-only.",
      );
    if (
      environment.ROBINHOOD_RPC_URL === ROBINHOOD_MAINNET.publicRpcUrl ||
      new URL(environment.ROBINHOOD_RPC_URL).protocol !== "https:"
    )
      throw new Error(
        "Production requires a dedicated HTTPS Robinhood mainnet RPC provider.",
      );
  }
  return createChainRegistry({
    robinhoodMainnetEnabled: enabled,
    robinhoodRpcUrl:
      environment.ROBINHOOD_RPC_URL ??
      (enabled ? ROBINHOOD_MAINNET.publicRpcUrl : null),
  });
}
