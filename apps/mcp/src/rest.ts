import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DomainError,
  publicError,
  parseSafeJson,
  bootstrapRegistrationSchema,
  cancelInvocationSchema,
  createCredentialSchema,
  createServiceSchema,
  failJobSchema,
  requestServiceSchema,
  searchServicesSchema,
  submitResultSchema,
  updateServiceSchema,
  type NormicEconomy,
  type RequestContext,
  type VerifiedOwner,
  NormicServiceNetwork,
  type FinancialService,
  type TradingService,
} from "@normic/core";
import type { MarketDataProvider } from "@normic/markets";
import { z } from "zod";

export async function handlePublicRestRequest(
  request: IncomingMessage,
  response: ServerResponse,
  economy: NormicEconomy,
  verifyOwner?: (token: string) => Promise<VerifiedOwner>,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const revokeMatch = url.pathname.match(
    /^\/v1\/onboarding\/credentials\/([0-9a-f-]+)\/revoke$/i,
  );
  const isRegistration =
    request.method === "POST" && url.pathname === "/v1/onboarding/register";
  const isConnection =
    request.method === "POST" && url.pathname === "/v1/onboarding/connect";
  const isConnectionState =
    request.method === "GET" && url.pathname === "/v1/onboarding/connection";
  const isOwnerRevoke = request.method === "POST" && Boolean(revokeMatch);
  if (!isRegistration && !isConnection && !isConnectionState && !isOwnerRevoke)
    return false;
  return guarded(response, async () => {
    const token =
      request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1] ?? "";
    const owner = verifyOwner ? await verifyOwner(token) : undefined;
    if (!isRegistration && !owner)
      throw new DomainError(
        "Verified owner authentication is required.",
        "UNAUTHENTICATED",
      );
    if (isConnectionState) {
      json(response, 200, await economy.getOwnerConnection(owner!));
      return;
    }
    const key = idempotencyKey(request);
    if (isOwnerRevoke) {
      json(
        response,
        200,
        await economy.revokeOwnerCredential(owner!, revokeMatch![1]!, key),
      );
      return;
    }
    json(
      response,
      201,
      isConnection
        ? await economy.connectExternalAgent(owner!, key)
        : await economy.bootstrapAgent(
            bootstrapRegistrationSchema.parse(await body(request)),
            key,
            owner,
          ),
    );
  });
}

export async function handleRestRequest(
  request: IncomingMessage,
  response: ServerResponse,
  economy: NormicEconomy,
  markets: MarketDataProvider,
  context: RequestContext,
  finance?: FinancialService,
  trading?: TradingService,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const serviceNetwork = finance
    ? new NormicServiceNetwork(economy, finance)
    : null;
  try {
    if (request.method === "GET" && url.pathname === "/v1/identity")
      return ok(response, await economy.getIdentity(context));
    if (request.method === "GET" && url.pathname === "/v1/permissions")
      return ok(response, await economy.getPermissions(context));
    if (request.method === "GET" && url.pathname === "/v1/networks")
      return ok(response, {
        networks: await economy.getSupportedNetworks(context),
        financialExecution: finance?.capabilities() ?? {
          state: "blocked",
          missing: ["financial runtime"],
        },
        stockTokenTrading: trading?.capabilities() ?? {
          state: "blocked",
          execution: "disabled",
          chainId: 4663,
          missing: ["trading runtime"],
        },
      });
    if (request.method === "GET" && url.pathname === "/v1/audit")
      return ok(
        response,
        await economy.getAuditActivity(context, numberParam(url, "limit", 20)),
      );
    if (request.method === "POST" && url.pathname === "/v1/register")
      return created(
        response,
        await economy.registerAgent(
          context,
          bootstrapRegistrationSchema
            .omit({ credentialLabel: true })
            .parse(await body(request)),
          idempotencyKey(request),
        ),
      );
    if (request.method === "GET" && url.pathname === "/v1/leaderboard")
      return ok(
        response,
        await economy.getLeaderboard(context, numberParam(url, "limit", 20)),
      );
    if (request.method === "GET" && url.pathname === "/v1/activity") {
      const companyId = url.searchParams.get("company_id");
      return ok(
        response,
        await economy.getActivity(context, {
          ...(companyId ? { companyId } : {}),
          limit: numberParam(url, "limit", 20),
        }),
      );
    }
    if (request.method === "GET" && url.pathname === "/v1/services") {
      return ok(
        response,
        await economy.searchServices(context, serviceSearchFromUrl(url)),
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/services")
      return created(
        response,
        await economy.createService(
          context,
          createServiceSchema.parse(await body(request)),
          idempotencyKey(request),
        ),
      );
    const serviceMatch = url.pathname.match(/^\/v1\/services\/([^/]+)$/);
    if (serviceMatch?.[1] && request.method === "GET")
      return ok(
        response,
        await economy.getService(context, decodeURIComponent(serviceMatch[1])),
      );
    if (serviceMatch?.[1] && request.method === "PATCH")
      return ok(
        response,
        await economy.updateService(
          context,
          updateServiceSchema.parse({
            ...(await body(request)),
            serviceId: decodeURIComponent(serviceMatch[1]),
          }),
          idempotencyKey(request),
        ),
      );

    if (request.method === "POST" && url.pathname === "/v1/invocations")
      return created(
        response,
        await (
          serviceNetwork
            ? serviceNetwork.request.bind(serviceNetwork)
            : economy.requestService.bind(economy)
        )(
          context,
          requestServiceSchema.parse(await body(request)),
          idempotencyKey(request),
        ),
      );
    const invocationMatch = url.pathname.match(/^\/v1\/invocations\/([^/]+)$/);
    if (invocationMatch?.[1] && request.method === "GET")
      return ok(
        response,
        await (
          serviceNetwork
            ? serviceNetwork.invocation.bind(serviceNetwork)
            : economy.getInvocation.bind(economy)
        )(context, decodeURIComponent(invocationMatch[1])),
      );
    const cancelMatch = url.pathname.match(
      /^\/v1\/invocations\/([^/]+)\/cancel$/,
    );
    if (cancelMatch?.[1] && request.method === "POST")
      return ok(
        response,
        await economy.cancelInvocation(
          context,
          cancelInvocationSchema.parse({
            ...(await body(request)),
            invocationId: decodeURIComponent(cancelMatch[1]),
          }),
          idempotencyKey(request),
        ),
      );
    if (request.method === "GET" && url.pathname === "/v1/jobs") {
      const rawStatus = url.searchParams.get("status");
      const status = isJobStatus(rawStatus) ? rawStatus : undefined;
      const role =
        url.searchParams.get("role") === "buyer"
          ? ("buyer" as const)
          : ("provider" as const);
      return ok(
        response,
        await economy.listJobs(context, {
          ...(status ? { status } : {}),
          role,
          limit: numberParam(url, "limit", 50),
        }),
      );
    }
    const jobAction = url.pathname.match(
      /^\/v1\/jobs\/([^/]+)\/(accept|start|result|fail)$/,
    );
    if (jobAction?.[1] && jobAction[2] && request.method === "POST") {
      const jobId = z.uuid().parse(decodeURIComponent(jobAction[1])),
        input = await body(request),
        key = idempotencyKey(request);
      const value =
        jobAction[2] === "accept"
          ? await (serviceNetwork
              ? serviceNetwork.action(context, jobId, "accept", key)
              : economy.acceptJob(context, jobId, key))
          : jobAction[2] === "start"
            ? await (serviceNetwork
                ? serviceNetwork.action(context, jobId, "start", key)
                : economy.startJob(context, jobId, key))
            : jobAction[2] === "result"
              ? await (
                  serviceNetwork
                    ? serviceNetwork.submit.bind(serviceNetwork)
                    : economy.submitResult.bind(economy)
                )(context, submitResultSchema.parse({ ...input, jobId }), key)
              : await economy.failJob(
                  context,
                  failJobSchema.parse({ ...input, jobId }),
                  key,
                );
      return ok(response, value);
    }

    if (request.method === "GET" && url.pathname === "/v1/credentials")
      return ok(response, await economy.getCredentials(context));
    if (request.method === "POST" && url.pathname === "/v1/credentials")
      return created(
        response,
        await economy.createCredential(
          context,
          createCredentialSchema.parse(await body(request)),
          idempotencyKey(request),
        ),
      );
    const credentialMatch = url.pathname.match(
      /^\/v1\/credentials\/([^/]+)\/(rotate|revoke)$/,
    );
    if (
      credentialMatch?.[1] &&
      credentialMatch[2] &&
      request.method === "POST"
    ) {
      const id = z.uuid().parse(decodeURIComponent(credentialMatch[1])),
        key = idempotencyKey(request);
      return ok(
        response,
        credentialMatch[2] === "rotate"
          ? await economy.rotateCredential(context, id, key)
          : await economy.revokeCredential(context, id, key),
      );
    }
    const companyMatch = url.pathname.match(
      /^\/v1\/companies\/([^/]+)(?:\/(balance|services))?$/,
    );
    if (companyMatch?.[1] && request.method === "GET") {
      const id = decodeURIComponent(companyMatch[1]);
      return ok(
        response,
        companyMatch[2] === "balance"
          ? finance
            ? await finance.getBalance(
                { kind: "agent", context },
                (await economy.getCompany(context, id)).company.id,
              )
            : await economy.getBalance(context, id)
          : companyMatch[2] === "services"
            ? await economy.getServices(context, id)
            : await economy.getCompany(context, id),
      );
    }

    if (
      request.method === "GET" &&
      url.pathname === "/v1/markets/stock-tokens"
    ) {
      await economy.assertScope(context, "markets:read");
      return market(response, await markets.listStockTokens());
    }
    if (
      request.method === "GET" &&
      url.pathname === "/v1/markets/corporate-actions"
    ) {
      await economy.assertScope(context, "markets:read");
      return market(response, await markets.listCorporateActions());
    }
    const tokenMatch = url.pathname.match(
      /^\/v1\/markets\/stock-tokens\/([^/]+)(?:\/(price))?$/,
    );
    if (tokenMatch?.[1] && request.method === "GET") {
      await economy.assertScope(context, "markets:read");
      const symbol = z
        .string()
        .regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/i)
        .parse(decodeURIComponent(tokenMatch[1]));
      return market(
        response,
        tokenMatch[2]
          ? await markets.getStockPrice(symbol)
          : await markets.getStockToken(symbol),
      );
    }
    return false;
  } catch (error) {
    if (publicError(error).status === 403)
      await economy.recordAuthorizationDenied(context);
    return sendError(response, error);
  }
}

async function guarded(
  response: ServerResponse,
  operation: () => Promise<void>,
): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    return sendError(response, error);
  }
}
async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (contentLength > 262_144)
    throw new DomainError("Request body exceeds 256 KiB.", "PAYLOAD_TOO_LARGE");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > 262_144)
      throw new DomainError(
        "Request body exceeds 256 KiB.",
        "PAYLOAD_TOO_LARGE",
      );
    chunks.push(part);
  }
  return chunks.length
    ? (parseSafeJson(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >)
    : {};
}
function serviceSearchFromUrl(url: URL) {
  const value: Record<string, unknown> = {};
  for (const [query, field] of [
    ["q", "keyword"],
    ["category", "category"],
    ["company_id", "companyId"],
    ["provider_agent_id", "providerAgentId"],
    ["status", "status"],
    ["pricing_model", "pricingModel"],
    ["cursor", "cursor"],
    ["sort", "sort"],
  ] as const) {
    const entry = url.searchParams.get(query);
    if (entry) value[field] = entry;
  }
  value.limit = numberParam(url, "limit", 20);
  return searchServicesSchema.parse(value);
}
function idempotencyKey(request: IncomingMessage) {
  const value = request.headers["idempotency-key"];
  if (
    typeof value !== "string" ||
    value.trim().length < 8 ||
    value.length > 128
  )
    throw new DomainError(
      "A valid Idempotency-Key header is required for every mutation.",
      "INVALID_IDEMPOTENCY_KEY",
    );
  return value.trim();
}
function numberParam(url: URL, name: string, fallback: number) {
  const value = Number(url.searchParams.get(name));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
function isJobStatus(
  value: string | null,
): value is
  "created" | "accepted" | "processing" | "completed" | "failed" | "cancelled" {
  return [
    "created",
    "accepted",
    "processing",
    "completed",
    "failed",
    "cancelled",
  ].includes(value ?? "");
}
function sendError(response: ServerResponse, error: unknown) {
  const { status, ...safe } = publicError(error);
  json(response, status, { error: safe });
  return true;
}
function ok(response: ServerResponse, value: unknown) {
  json(response, 200, value);
  return true;
}
function created(response: ServerResponse, value: unknown) {
  json(response, 201, value);
  return true;
}
function market(response: ServerResponse, value: { state: string }) {
  json(response, value.state === "unavailable" ? 503 : 200, value, {
    "x-normic-data-state": value.state,
  });
  return true;
}
function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
}
