export const PRODUCTION_CAPABILITIES = [
  "CORE_API",
  "MCP",
  "SERVICE_NETWORK",
  "ROBINHOOD_READS",
  "USDG_PAYMENTS",
  "STOCK_TOKEN_TRADING",
  "AUTONOMY",
] as const;

export type ProductionCapability = (typeof PRODUCTION_CAPABILITIES)[number];
export type ReadinessState = "READY" | "BLOCKED";
export type ReadinessBlocker = {
  code: string;
  dependency: string;
  message: string;
};
export type CapabilityReadiness = {
  status: ReadinessState;
  blockers: ReadinessBlocker[];
};
export type ProductionReadiness = {
  environment: string;
  chainId: 4663;
  publicBeta: ReadinessState;
  capabilities: Record<ProductionCapability, CapabilityReadiness>;
  components: Record<
    "DATABASE" | "OAUTH" | "ROBINHOOD_RPC",
    CapabilityReadiness
  >;
};

type RuntimeCapability = {
  state: "ready" | "blocked";
  missing: readonly string[];
};
export type ReadinessRuntime = {
  database?: { kind: string; connected: boolean };
  robinhoodRpcVerified?: boolean;
  payments?: RuntimeCapability;
  trading?: RuntimeCapability;
};

const blocker = (
  code: string,
  dependency: string,
  message: string,
): ReadinessBlocker => ({
  code,
  dependency,
  message,
});
const result = (blockers: ReadinessBlocker[]): CapabilityReadiness => ({
  status: blockers.length === 0 ? "READY" : "BLOCKED",
  blockers,
});
const missing = (env: NodeJS.ProcessEnv, name: string) =>
  env[name]?.trim()
    ? []
    : [blocker("MISSING_CONFIGURATION", name, `${name} is required.`)];
const invalidUrl = (
  env: NodeJS.ProcessEnv,
  name: string,
  options: { https: boolean; rejectPublicRobinhood?: boolean } = {
    https: true,
  },
) => {
  const value = env[name]?.trim();
  if (!value) return [];
  try {
    const url = new URL(value);
    if (
      (options.https && url.protocol !== "https:") ||
      url.username ||
      url.password
    )
      throw new Error();
    if (
      options.rejectPublicRobinhood &&
      url.origin === "https://rpc.mainnet.chain.robinhood.com"
    )
      return [
        blocker(
          "PUBLIC_RPC_NOT_ALLOWED",
          name,
          "A dedicated Robinhood Chain Mainnet RPC is required in production.",
        ),
      ];
    return [];
  } catch {
    return [
      blocker(
        "INVALID_URL",
        name,
        `${name} must be a credential-free HTTPS URL.`,
      ),
    ];
  }
};

export function productionConfigurationBlockers(env: NodeJS.ProcessEnv) {
  if (env.NODE_ENV !== "production") return [];
  const blockers = [
    ...missing(env, "DATABASE_URL"),
    ...missing(env, "NORMIC_PUBLIC_ORIGIN"),
    ...missing(env, "NORMIC_REMOTE_MCP_URL"),
    ...missing(env, "NORMIC_AUTH_ISSUER"),
    ...missing(env, "NORMIC_AUTH_AUDIENCE"),
    ...missing(env, "NORMIC_AUTH_JWKS_URL"),
    ...missing(env, "NORMIC_OWNER_AUTH_ISSUER"),
    ...missing(env, "NORMIC_OWNER_AUTH_AUDIENCE"),
    ...missing(env, "NORMIC_OWNER_AUTH_JWKS_URL"),
    ...missing(env, "NORMIC_NETWORK"),
    ...missing(env, "ROBINHOOD_MAINNET_ENABLED"),
    ...missing(env, "ROBINHOOD_RPC_URL"),
    ...invalidUrl(env, "NORMIC_PUBLIC_ORIGIN"),
    ...invalidUrl(env, "NORMIC_REMOTE_MCP_URL"),
    ...invalidUrl(env, "NORMIC_AUTH_ISSUER"),
    ...invalidUrl(env, "NORMIC_AUTH_AUDIENCE"),
    ...invalidUrl(env, "NORMIC_AUTH_JWKS_URL"),
    ...invalidUrl(env, "NORMIC_OWNER_AUTH_ISSUER"),
    ...invalidUrl(env, "NORMIC_OWNER_AUTH_JWKS_URL"),
    ...invalidUrl(env, "ROBINHOOD_RPC_URL", {
      https: true,
      rejectPublicRobinhood: true,
    }),
  ];
  if (env.NORMIC_DEV_AUTH_ENABLED === "true")
    blockers.push(
      blocker(
        "DEVELOPMENT_AUTH_ENABLED",
        "NORMIC_DEV_AUTH_ENABLED",
        "Development authentication must be disabled.",
      ),
    );
  if (env.NORMIC_OWNER_AUTH_AUDIENCE !== "authenticated")
    blockers.push(
      blocker(
        "WRONG_OWNER_AUTH_AUDIENCE",
        "NORMIC_OWNER_AUTH_AUDIENCE",
        'Supabase owner sessions must use audience "authenticated".',
      ),
    );
  if (env.NORMIC_NETWORK !== "robinhood-mainnet")
    blockers.push(
      blocker(
        "WRONG_NETWORK",
        "NORMIC_NETWORK",
        "Robinhood Chain Mainnet is required.",
      ),
    );
  if (env.ROBINHOOD_MAINNET_ENABLED !== "true")
    blockers.push(
      blocker(
        "MAINNET_DISABLED",
        "ROBINHOOD_MAINNET_ENABLED",
        "Robinhood Chain Mainnet must be enabled.",
      ),
    );
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) {
    try {
      const protocol = new URL(databaseUrl).protocol;
      if (protocol !== "postgres:" && protocol !== "postgresql:")
        throw new Error();
    } catch {
      blockers.push(
        blocker(
          "INVALID_DATABASE_URL",
          "DATABASE_URL",
          "DATABASE_URL must use PostgreSQL.",
        ),
      );
    }
  }
  return blockers;
}

export function assertProductionConfiguration(
  env: NodeJS.ProcessEnv = process.env,
) {
  const blockers = productionConfigurationBlockers(env);
  if (blockers.length)
    throw new Error(
      `Production configuration is incomplete: ${[...new Set(blockers.map((item) => item.dependency))].join(", ")}.`,
    );
}

const runtimeBlockers = (
  capability: RuntimeCapability | undefined,
  dependency: string,
) =>
  capability?.state === "ready"
    ? []
    : (capability?.missing.length ? capability.missing : [dependency]).map(
        (item) =>
          blocker(
            "DEPENDENCY_UNAVAILABLE",
            item,
            "Required production dependency is unavailable.",
          ),
      );

export function buildProductionReadiness(
  env: NodeJS.ProcessEnv,
  runtime: ReadinessRuntime = {},
): ProductionReadiness {
  const production = env.NODE_ENV === "production";
  const configuration = productionConfigurationBlockers(env);
  const forDependencies = (...dependencies: string[]) =>
    configuration.filter((item) => dependencies.includes(item.dependency));
  const database = result([
    ...forDependencies("DATABASE_URL"),
    ...(runtime.database?.connected && runtime.database.kind === "postgres"
      ? []
      : [
          blocker(
            "DATABASE_UNAVAILABLE",
            "PostgreSQL",
            "Production PostgreSQL is not connected.",
          ),
        ]),
  ]);
  const oauth = result(
    forDependencies(
      "NORMIC_PUBLIC_ORIGIN",
      "NORMIC_AUTH_ISSUER",
      "NORMIC_AUTH_AUDIENCE",
      "NORMIC_AUTH_JWKS_URL",
      "NORMIC_OWNER_AUTH_ISSUER",
      "NORMIC_OWNER_AUTH_AUDIENCE",
      "NORMIC_OWNER_AUTH_JWKS_URL",
      "NORMIC_DEV_AUTH_ENABLED",
    ),
  );
  const rpc = result([
    ...forDependencies(
      "NORMIC_NETWORK",
      "ROBINHOOD_MAINNET_ENABLED",
      "ROBINHOOD_RPC_URL",
    ),
    ...(runtime.robinhoodRpcVerified
      ? []
      : [
          blocker(
            "RPC_NOT_VERIFIED",
            "ROBINHOOD_RPC_URL",
            "Robinhood Chain ID 4663 has not been verified.",
          ),
        ]),
  ]);
  const coreBlockers = [...database.blockers, ...oauth.blockers];
  const mcpBlockers = [
    ...coreBlockers,
    ...forDependencies("NORMIC_REMOTE_MCP_URL"),
  ];
  const paymentsBlockers = [
    ...coreBlockers,
    ...rpc.blockers,
    ...runtimeBlockers(runtime.payments, "USDG payments"),
    ...(env.NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED === "true"
      ? []
      : [
          blocker(
            "OWNER_AUTHORIZATION_REQUIRED",
            "NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED",
            "Explicit production owner authorization is required.",
          ),
        ]),
  ];
  const tradingBlockers = [
    ...paymentsBlockers,
    ...runtimeBlockers(runtime.trading, "Stock Token trading"),
  ];
  const capabilities = {
    CORE_API: result(coreBlockers),
    MCP: result(mcpBlockers),
    SERVICE_NETWORK: result(coreBlockers),
    ROBINHOOD_READS: result([...coreBlockers, ...rpc.blockers]),
    USDG_PAYMENTS: result(paymentsBlockers),
    STOCK_TOKEN_TRADING: result(tradingBlockers),
    AUTONOMY: result([
      ...tradingBlockers,
      ...(env.NORMIC_AUTONOMOUS_FINANCIAL_EXECUTION_ENABLED === "true"
        ? []
        : [
            blocker(
              "AUTONOMY_NOT_AUTHORIZED",
              "NORMIC_AUTONOMOUS_FINANCIAL_EXECUTION_ENABLED",
              "Autonomous financial execution is not authorized.",
            ),
          ]),
    ]),
  } satisfies Record<ProductionCapability, CapabilityReadiness>;
  const publicBeta = [
    "CORE_API",
    "MCP",
    "SERVICE_NETWORK",
    "ROBINHOOD_READS",
  ].every(
    (name) => capabilities[name as ProductionCapability].status === "READY",
  )
    ? "READY"
    : "BLOCKED";
  return {
    environment: env.NODE_ENV ?? "unspecified",
    chainId: 4663,
    publicBeta,
    capabilities,
    components: { DATABASE: database, OAUTH: oauth, ROBINHOOD_RPC: rpc },
  };
}
