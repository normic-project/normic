import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import {
  API_SCOPES,
  publicError,
  cancelInvocationSchema,
  createServiceSchema,
  getServiceSchema,
  failJobSchema,
  idempotencyKeySchema,
  registerAgentSchema,
  requestServiceSchema,
  searchServicesSchema,
  submitResultSchema,
  updateServiceSchema,
  type ApiScope,
  type NormicEconomy,
  type RequestContext,
  NormicServiceNetwork,
  financialInputs,
  financialEffect,
  runFinancialCommand,
  type FinancialService,
  type FinancialCommand,
  type VerifiedOwner,
  tradingInputs,
  tradingEffect,
  runTradingCommand,
  type TradingCommand,
  type TradingService,
  autonomyInputs,
  autonomyEffect,
  runAutonomyCommand,
  type AutonomyCommand,
  type AutonomyService,
  financialCommandRequiresReadyCapability,
  tradingCommandRequiresReadyCapability,
  type ProductionReadiness,
} from "@normic/core";
import type { MarketDataProvider } from "@normic/markets";
import { z } from "zod";

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: JSON.parse(JSON.stringify(value)) as Record<
      string,
      unknown
    >,
  };
}
function errorResult(error: unknown) {
  const { message, code, capability, blockers } = publicError(error);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: {
            code,
            message,
            ...(capability ? { capability, blockers } : {}),
          },
        }),
      },
    ],
  };
}
function safelyWithAudit<TInput extends Record<string, unknown>>(
  operation: (input: TInput) => Promise<unknown>,
  onError: (error: unknown) => Promise<void>,
) {
  return async (input: TInput) => {
    try {
      return result(await operation(input));
    } catch (error) {
      await onError(error);
      return errorResult(error);
    }
  };
}

export function createNormicMcpHandler(
  economy: NormicEconomy,
  markets: MarketDataProvider,
  finance?: FinancialService,
  trading?: TradingService,
  autonomy?: AutonomyService,
  readiness?: () => ProductionReadiness,
) {
  return createMcpHandler(({ authInfo }) => {
    const context = requestContext(authInfo);
    const serviceNetwork = finance
      ? new NormicServiceNetwork(economy, finance)
      : null;
    const safely = <TInput extends Record<string, unknown>>(
      operation: (input: TInput) => Promise<unknown>,
    ) =>
      safelyWithAudit(operation, async (error) => {
        if (publicError(error).status === 403)
          await economy.recordAuthorizationDenied(context);
      });
    const server = new McpServer(
      {
        name: "normic",
        version: "0.6.0",
        description:
          "Owner-mandated autonomous agent operations, live service coordination, guarded USDG escrow, and fail-closed Robinhood Stock Token portfolio operations.",
      },
      {
        instructions:
          "Normic uses Robinhood Chain Mainnet only. Autonomous actions require a current heartbeat and exact owner mandate. READ, QUOTE, EXECUTE, and CONFIRM are distinct operations. Quotes never execute. Only finalized onchain settlement affects portfolio accounting. Stock Token execution remains blocked unless every eligibility, policy, custody, venue, oracle, and chain control is ready. Owner actions require an independently verified owner authorization header.",
      },
    );

    if (readiness)
      server.registerTool(
        "normic_get_readiness",
        {
          description:
            "Read machine-readable production and public-beta capability status without exposing secrets.",
          inputSchema: z.object({}).strict(),
        },
        safely(async () => readiness()),
      );

    server.registerTool(
      "normic_register",
      {
        description:
          "Register another existing AI agent and company for the authenticated human owner. The company starts with a zero ledger balance.",
        inputSchema: registerAgentSchema.extend({
          idempotencyKey: idempotencyKeySchema,
        }),
      },
      safely(async ({ idempotencyKey, ...input }) =>
        economy.registerAgent(context, input, idempotencyKey),
      ),
    );
    server.registerTool(
      "normic_get_company",
      {
        description:
          "Get an authorized company profile and operational metrics.",
        inputSchema: z.object({ identifier: z.string().min(1) }),
      },
      safely(async ({ identifier }) => economy.getCompany(context, identifier)),
    );
    server.registerTool(
      "normic_get_balance",
      {
        description:
          "Read real finalized Robinhood Mainnet ETH/USDG wallet balances, or an explicit unavailable state.",
        inputSchema: z.object({ identifier: z.string().min(1) }),
      },
      safely(async ({ identifier }) =>
        finance
          ? finance.getBalance(
              { kind: "agent", context },
              (await economy.getCompany(context, identifier)).company.id,
            )
          : economy.getBalance(context, identifier),
      ),
    );
    server.registerTool(
      "normic_get_activity",
      {
        description:
          "Read authorized operational activity without service inputs or result payloads.",
        inputSchema: z.object({
          companyId: z.uuid().optional(),
          limit: z.number().int().min(1).max(100).default(20),
        }),
      },
      safely(async ({ companyId, limit }) =>
        economy.getActivity(context, {
          ...(companyId ? { companyId } : {}),
          limit,
        }),
      ),
    );
    server.registerTool(
      "normic_get_leaderboard",
      {
        description:
          "Rank companies by completed jobs, completion rate, and unique buyers. Financial metrics are not used.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(100).default(20),
        }),
      },
      safely(async ({ limit }) => economy.getLeaderboard(context, limit)),
    );
    for (const name of ["normic_list_services", "normic_search_services"])
      server.registerTool(
        name,
        {
          description:
            "Discover persisted services with stable cursor pagination and filters.",
          inputSchema: searchServicesSchema,
        },
        safely(async (input) => economy.searchServices(context, input)),
      );
    server.registerTool(
      "normic_get_service",
      {
        description:
          "Read a published service or an authorized private service.",
        inputSchema: getServiceSchema,
      },
      safely(async ({ serviceId }) => economy.getService(context, serviceId)),
    );
    server.registerTool(
      "normic_create_service",
      {
        description:
          "Publish a service after identity, scope, ownership, and policy checks. Fixed USDG services require the verified escrow path; free and quote services do not move money.",
        inputSchema: createServiceSchema.safeExtend({
          idempotencyKey: idempotencyKeySchema,
        }),
      },
      safely(async ({ idempotencyKey, ...input }) =>
        economy.createService(context, input, idempotencyKey),
      ),
    );
    server.registerTool(
      "normic_update_service",
      {
        description: "Update a service owned by the authenticated provider.",
        inputSchema: updateServiceSchema.safeExtend({
          idempotencyKey: idempotencyKeySchema,
        }),
      },
      safely(async ({ idempotencyKey, ...input }) =>
        economy.updateService(context, input, idempotencyKey),
      ),
    );
    server.registerTool(
      "normic_get_services",
      {
        description: "Get services owned by an authorized company.",
        inputSchema: z.object({ identifier: z.string().min(1) }),
      },
      safely(async ({ identifier }) =>
        economy.getServices(context, identifier),
      ),
    );

    server.registerTool(
      "normic_request_service",
      {
        description:
          "Prepare a service request. Fixed-price USDG services require finalized escrow funding before the provider receives a job. This tool does not broadcast.",
        inputSchema: requestServiceSchema.extend({
          idempotencyKey: idempotencyKeySchema,
        }),
      },
      safely(async ({ idempotencyKey, ...input }) =>
        serviceNetwork
          ? serviceNetwork.request(context, input, idempotencyKey)
          : economy.requestService(context, input, idempotencyKey),
      ),
    );
    server.registerTool(
      "normic_get_invocation",
      {
        description: "Get an invocation visible to its buyer or provider.",
        inputSchema: z.object({ invocationId: z.uuid() }),
      },
      safely(async ({ invocationId }) =>
        serviceNetwork
          ? serviceNetwork.invocation(context, invocationId)
          : economy.getInvocation(context, invocationId),
      ),
    );
    for (const name of ["normic_get_my_jobs", "normic_get_jobs"])
      server.registerTool(
        name,
        {
          description:
            "List jobs where the authenticated agent is the provider or buyer.",
          inputSchema: z.object({
            role: z.enum(["provider", "buyer"]).default("provider"),
            status: z
              .enum([
                "created",
                "accepted",
                "processing",
                "completed",
                "failed",
                "cancelled",
              ])
              .optional(),
            limit: z.number().int().min(1).max(100).default(50),
          }),
        },
        safely(async ({ role, status, limit }) =>
          economy.listJobs(context, {
            role,
            ...(status ? { status } : {}),
            limit,
          }),
        ),
      );
    for (const [name, description, action] of [
      [
        "normic_accept_job",
        "Accept a created job owned by the authenticated provider.",
        "accept",
      ],
      [
        "normic_start_job",
        "Start an accepted job owned by the authenticated provider.",
        "start",
      ],
    ] as const)
      server.registerTool(
        name,
        {
          description,
          inputSchema: z.object({
            jobId: z.uuid(),
            idempotencyKey: idempotencyKeySchema,
          }),
        },
        safely(async ({ jobId, idempotencyKey }) =>
          serviceNetwork
            ? serviceNetwork.action(context, jobId, action, idempotencyKey)
            : action === "accept"
              ? economy.acceptJob(context, jobId, idempotencyKey)
              : economy.startJob(context, jobId, idempotencyKey),
        ),
      );
    server.registerTool(
      "normic_submit_result",
      {
        description: "Submit the immutable output of a processing job.",
        inputSchema: submitResultSchema.extend({
          idempotencyKey: idempotencyKeySchema,
        }),
      },
      safely(async ({ idempotencyKey, ...input }) =>
        serviceNetwork
          ? serviceNetwork.submit(context, input, idempotencyKey)
          : economy.submitResult(context, input, idempotencyKey),
      ),
    );
    server.registerTool(
      "normic_fail_job",
      {
        description:
          "Mark a non-terminal provider job as failed with an explicit reason.",
        inputSchema: failJobSchema.extend({
          idempotencyKey: idempotencyKeySchema,
        }),
      },
      safely(async ({ idempotencyKey, ...input }) =>
        economy.failJob(context, input, idempotencyKey),
      ),
    );
    for (const name of ["normic_cancel_job", "normic_cancel_invocation"])
      server.registerTool(
        name,
        {
          description:
            "Cancel a created or accepted invocation as its requesting agent.",
          inputSchema: cancelInvocationSchema.extend({
            idempotencyKey: idempotencyKeySchema,
          }),
        },
        safely(async ({ idempotencyKey, ...input }) =>
          economy.cancelInvocation(context, input, idempotencyKey),
        ),
      );

    if (finance) {
      server.registerTool(
        "normic_get_wallet",
        {
          description:
            "Read your authenticated company's Normic financial wallet address and deployment state. If NOT_CREATED, call normic_prepare_wallet and ask the owner to complete the returned approval link. Does not create a wallet, reveal passkey metadata or grant spending authority.",
          inputSchema: z.object({ companyId: z.uuid().optional() }).strict(),
        },
        safely(async ({ companyId }) =>
          finance.getAgentWallet({ kind: "agent", context }, companyId),
        ),
      );
      server.registerTool(
        "normic_prepare_wallet",
        {
          description:
            "Prepare your authenticated company's Normic wallet. Returns an existing wallet or a 10-minute owner approval URL. The owner must sign in and personally complete passkey enrollment in their browser. Never ask for passwords, passkey responses or root signatures in chat. Grants no spending authority and sends no transaction. Reuse the UUID idempotencyKey for retries; use a new UUID after expiry. Query normic_get_wallet with the returned companyId after owner completion.",
          inputSchema: z.object({ idempotencyKey: z.uuid() }).strict(),
        },
        safely(async ({ idempotencyKey }) =>
          finance.prepareWallet({ kind: "agent", context }, idempotencyKey),
        ),
      );
      const existing = new Set([
        "get_wallet",
        "prepare_wallet",
        "get_wallet_owner_approval",
        "get_balance",
        "request_service",
        "get_invocation",
        "accept_job",
        "start_job",
        "submit_result",
      ]);
      for (const [name, schema] of Object.entries(financialInputs)) {
        if (
          existing.has(name) ||
          name === "prepare_financial_identity" ||
          name === "provision_financial_wallet" ||
          name.includes("financial_passkey") ||
          name.includes("financial_recovery")
        )
          continue;
        const command = name as FinancialCommand,
          effect = financialEffect(command);
        const inputSchema = (
          effect === "reads"
            ? schema
            : schema.extend({ idempotencyKey: idempotencyKeySchema })
        ) as z.ZodObject;
        server.registerTool(
          `normic_${name}`,
          {
            description: `${financialCommandRequiresReadyCapability(command) && finance.capabilities().state !== "ready" ? "BLOCKED — USDG_PAYMENTS production dependencies are unavailable. " : ""}${effect[0]!.toUpperCase() + effect.slice(1)}: ${name.replaceAll("_", " ")}. Robinhood Mainnet USDG only. No implicit settlement. Owner policy changes require separately verified owner identity.`,
            inputSchema,
          },
          safely<Record<string, unknown>>(
            async ({ idempotencyKey, ...input }) => {
              const owner = authInfo?.extra?.verifiedOwner as
                VerifiedOwner | undefined;
              return runFinancialCommand(
                finance,
                owner ? { kind: "owner", owner } : { kind: "agent", context },
                command,
                input,
                String(idempotencyKey ?? ""),
              );
            },
          ),
        );
      }
    }
    if (trading) {
      for (const [name, schema] of Object.entries(tradingInputs)) {
        const command = name as TradingCommand,
          effect = tradingEffect(command),
          inputSchema = (
            effect === "READ"
              ? schema
              : schema.extend({ idempotencyKey: idempotencyKeySchema })
          ) as z.ZodObject;
        server.registerTool(
          `normic_${name}`,
          {
            description: `${tradingCommandRequiresReadyCapability(command) && trading.capabilities().state !== "ready" ? "BLOCKED — STOCK_TOKEN_TRADING production dependencies are unavailable. " : ""}${effect}: ${name.replaceAll("_", " ")}. Robinhood Chain Mainnet and canonical USDG/Robinhood Stock Tokens only. No fallback, leverage, bridging, or implicit execution.`,
            inputSchema,
          },
          safely<Record<string, unknown>>(
            async ({ idempotencyKey, ...input }) => {
              const owner = authInfo?.extra?.verifiedOwner as
                VerifiedOwner | undefined;
              return runTradingCommand(
                trading,
                owner ? { kind: "owner", owner } : { kind: "agent", context },
                command,
                input,
                String(idempotencyKey ?? ""),
              );
            },
          ),
        );
      }
    }
    if (autonomy) {
      for (const [name, schema] of Object.entries(autonomyInputs)) {
        const command = name as AutonomyCommand,
          effect = autonomyEffect(command),
          inputSchema = (
            effect === "READ"
              ? schema
              : schema.extend({ idempotencyKey: idempotencyKeySchema })
          ) as z.ZodObject;
        server.registerTool(
          `normic_${name}`,
          {
            description: `${effect}: ${name.replaceAll("_", " ")}. Uses the exact owner mandate, current heartbeat, verified capital lineage, and existing policy/risk controls. No arbitrary calldata or hidden reasoning.`,
            inputSchema,
          },
          safely<Record<string, unknown>>(
            async ({ idempotencyKey, ...input }) => {
              const owner = authInfo?.extra?.verifiedOwner as
                VerifiedOwner | undefined;
              return runAutonomyCommand(
                autonomy,
                owner ? { kind: "owner", owner } : { kind: "agent", context },
                command,
                input,
                String(idempotencyKey ?? ""),
              );
            },
          ),
        );
      }
    }
    server.registerTool(
      "normic_list_corporate_actions",
      {
        description:
          "Read official Robinhood corporate actions with source and freshness metadata.",
        inputSchema: z.object({}),
      },
      safely(async () => {
        await economy.assertScope(context, "markets:read");
        return markets.listCorporateActions();
      }),
    );

    server.registerTool(
      "normic_get_identity",
      {
        description:
          "Return the permanent agent identity, company binding, credential ID, and scopes.",
        inputSchema: z.object({}),
      },
      safely(async () => economy.getIdentity(context)),
    );
    server.registerTool(
      "normic_get_permissions",
      {
        description: "Return centralized policy decisions for this company.",
        inputSchema: z.object({}),
      },
      safely(async () => economy.getPermissions(context)),
    );
    server.registerTool(
      "normic_get_supported_networks",
      {
        description:
          "Return Robinhood Chain mainnet capability and activation state without executing a blockchain transaction.",
        inputSchema: z.object({}),
      },
      safely(async () => ({
        networks: await economy.getSupportedNetworks(context),
        financialExecution: finance?.capabilities() ?? {
          state: "blocked",
          missing: ["financial runtime"],
        },
        stockTokenTrading: trading?.capabilities() ?? {
          state: "blocked",
          missing: ["trading runtime"],
        },
      })),
    );

    server.registerTool(
      "normic_list_stock_tokens",
      {
        description:
          "List live Robinhood Stock Token metadata. The response declares live, cached, stale, or unavailable state.",
        inputSchema: z.object({}),
      },
      safely(async () => {
        await economy.assertScope(context, "markets:read");
        return markets.listStockTokens();
      }),
    );
    server.registerTool(
      "normic_get_stock_token",
      {
        description:
          "Get Robinhood Stock Token metadata by symbol. No trading is performed.",
        inputSchema: z.object({
          symbol: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/i),
        }),
      },
      safely(async ({ symbol }) => {
        await economy.assertScope(context, "markets:read");
        return markets.getStockToken(symbol);
      }),
    );
    for (const name of [
      "normic_get_stock_price",
      "normic_get_stock_token_price",
    ])
      server.registerTool(
        name,
        {
          description:
            "Get live or explicitly cached/stale Robinhood price data, including raw underlying prices, multiplier-adjusted values, and trading-halt state.",
          inputSchema: z.object({
            symbol: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/i),
          }),
        },
        safely(async ({ symbol }) => {
          await economy.assertScope(context, "markets:read");
          return markets.getStockPrice(symbol);
        }),
      );
    return server;
  });
}

function requestContext(authInfo: AuthInfo | undefined): RequestContext {
  if (!authInfo) throw new Error("MCP authentication context is missing.");
  const userId = authInfo.extra?.userId,
    credentialId = authInfo.extra?.credentialId,
    issuer = authInfo.extra?.issuer,
    audience = authInfo.extra?.audience;
  if (
    [userId, credentialId, issuer, audience].some(
      (value) => typeof value !== "string",
    )
  )
    throw new Error("MCP authentication context is incomplete.");
  return {
    principal: {
      agentId: authInfo.clientId,
      userId: userId as string,
      credentialId: credentialId as string,
      scopes: authInfo.scopes.filter((scope): scope is ApiScope =>
        (API_SCOPES as readonly string[]).includes(scope),
      ),
      issuer: issuer as string,
      audience: audience as string,
      expiresAt: authInfo.expiresAt
        ? new Date(authInfo.expiresAt * 1000)
        : null,
    },
  };
}
