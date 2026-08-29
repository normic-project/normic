import "server-only";
import { createChainRegistryFromEnvironment } from "@normic/chains";
import {
  AutonomyService,
  NormicAutonomyOperations,
  NormicEconomy,
  NormicServiceNetwork,
  TradingService,
  assertProductionConfiguration,
  buildProductionReadiness,
} from "@normic/core";
import {
  PostgresEconomyRepository,
  PostgresFinancialRepository,
  PostgresTradingRepository,
  PostgresAutonomyRepository,
  createRuntimeDatabase,
} from "@normic/db";
import { AlchemyTradingWallet, createFinancialRuntime } from "@normic/payments";
import {
  RobinhoodTradingAssetProvider,
  UnavailableEligibilityProvider,
  ZeroExTradingProvider,
  createRobinhoodMarketProviderFromEnvironment,
} from "@normic/markets";

const runtimeState = globalThis as typeof globalThis & {
  normicRuntimePromise?: ReturnType<typeof createRuntime>;
};

async function createRuntime() {
  assertProductionConfiguration(process.env);
  const database = await createRuntimeDatabase();
  await database.query("SELECT 1");
  const repository = new PostgresEconomyRepository(database);
  const networks = createChainRegistryFromEnvironment();
  let robinhoodRpcVerified = false;
  if (process.env.NODE_ENV === "production") {
    await networks.get("robinhood-mainnet").getBlockNumber();
    robinhoodRpcVerified = true;
  }
  const economy = new NormicEconomy({ repository, networks });
  const finance = createFinancialRuntime(
    new PostgresFinancialRepository(database),
    process.env,
  );
  const markets = createRobinhoodMarketProviderFromEnvironment(
    process.env,
    (event) => {
      console.info(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          service: "normic-web",
          event: event.name,
          endpoint: event.endpoint,
        }),
      );
    },
  );
  const trading = new TradingService(
    new PostgresTradingRepository(database),
    new RobinhoodTradingAssetProvider(markets, process.env),
    new ZeroExTradingProvider(process.env),
    new UnavailableEligibilityProvider(),
    new AlchemyTradingWallet(process.env.ALCHEMY_API_KEY),
  );
  const autonomy = new AutonomyService(
    new PostgresAutonomyRepository(database),
    new NormicAutonomyOperations(
      economy,
      repository,
      new NormicServiceNetwork(economy, finance),
      finance,
      trading,
    ),
  );
  return {
    database,
    repository,
    networks,
    economy,
    markets,
    finance,
    trading,
    autonomy,
    readiness: buildProductionReadiness(process.env, {
      database: { kind: database.kind, connected: true },
      robinhoodRpcVerified,
      payments: finance.capabilities(),
      trading: trading.capabilities(),
    }),
  };
}

export async function getRuntime() {
  runtimeState.normicRuntimePromise ??= createRuntime();
  return runtimeState.normicRuntimePromise;
}
export async function getEconomy() {
  return (await getRuntime()).economy;
}
export async function getMarkets() {
  return (await getRuntime()).markets;
}
export async function getReadiness() {
  return (await getRuntime()).readiness;
}
