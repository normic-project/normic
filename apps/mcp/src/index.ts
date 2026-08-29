import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import {
  OAuthError,
  OAuthErrorCode,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { createChainRegistryFromEnvironment } from "@normic/chains";
import { createHash, randomUUID } from "node:crypto";
import {
  API_SCOPES,
  ApiCredentialAuthenticator,
  DomainError,
  publicError,
  parseSafeJson,
  NormicEconomy,
  OAuthAgentAuthenticator,
  OAuthTokenVerifier,
  AuthenticationError,
  TradingService,
  AutonomyService,
  NormicAutonomyOperations,
  NormicServiceNetwork,
  type ApiScope,
  type RequestContext,
  assertProductionConfiguration,
  buildProductionReadiness,
  type ProductionReadiness,
} from "@normic/core";
import {
  PostgresEconomyRepository,
  PostgresFinancialRepository,
  PostgresTradingRepository,
  PostgresAutonomyRepository,
  createRuntimeDatabase,
} from "@normic/db";
import { AlchemyTradingWallet, createFinancialRuntime } from "@normic/payments";
import { handleFinancialRest } from "./finance-rest.js";
import {
  RobinhoodTradingAssetProvider,
  UnavailableEligibilityProvider,
  ZeroExTradingProvider,
  createRobinhoodMarketProviderFromEnvironment,
} from "@normic/markets";
import { handlePublicRestRequest, handleRestRequest } from "./rest.js";
import { createNormicMcpHandler } from "./tools.js";
import { handleTradingRest } from "./trading-rest.js";
import { handleAutonomyRest } from "./autonomy-rest.js";

assertProductionConfiguration(process.env);
const production = process.env.NODE_ENV === "production";
const serverless = process.env.VERCEL === "1";
const host = process.env.MCP_HOST ?? "127.0.0.1";
const port = Number(process.env.MCP_PORT ?? 3100);
const allowedHosts = commaSeparated(process.env.MCP_ALLOWED_HOSTS);
const allowedOriginHosts = commaSeparated(process.env.MCP_ALLOWED_ORIGIN_HOSTS);
if (
  !serverless &&
  host !== "127.0.0.1" &&
  host !== "localhost" &&
  allowedHosts.length === 0
) {
  throw new Error(
    "MCP_ALLOWED_HOSTS must contain an explicit hostname allow-list for a remote bind.",
  );
}

const publicOrigin =
  process.env.NORMIC_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
const audience = process.env.NORMIC_AUTH_AUDIENCE ?? `${publicOrigin}/mcp`;
const issuer = process.env.NORMIC_AUTH_ISSUER ?? `${publicOrigin}/dev-auth`;
if (production) {
  if (publicOrigin !== "https://normic.tech")
    throw new Error(
      "NORMIC_PUBLIC_ORIGIN must be https://normic.tech in production.",
    );
  if (
    process.env.NORMIC_REMOTE_MCP_URL !== "https://normic.tech/mcp" ||
    audience !== "https://normic.tech/mcp"
  )
    throw new Error(
      "NORMIC_REMOTE_MCP_URL and NORMIC_AUTH_AUDIENCE must be https://normic.tech/mcp in production.",
    );
}
const developmentAuthEnabled =
  process.env.NORMIC_DEV_AUTH_ENABLED === "true" ||
  process.env.NODE_ENV !== "production";
if (process.env.NODE_ENV === "production" && developmentAuthEnabled) {
  throw new Error("NORMIC_DEV_AUTH_ENABLED must be false in production.");
}

const database = await createRuntimeDatabase();
await database.query("SELECT 1");
const repository = new PostgresEconomyRepository(database);
const finance = createFinancialRuntime(
  new PostgresFinancialRepository(database),
  process.env,
);
const networks = createChainRegistryFromEnvironment();
let robinhoodRpcVerified = false;
if (process.env.NODE_ENV === "production") {
  await networks.get("robinhood-mainnet").getBlockNumber();
  robinhoodRpcVerified = true;
}
const markets = createRobinhoodMarketProviderFromEnvironment(
  process.env,
  (event) => structuredLog({ event: event.name, endpoint: event.endpoint }),
);
const trading = new TradingService(
  new PostgresTradingRepository(database),
  new RobinhoodTradingAssetProvider(markets, process.env),
  new ZeroExTradingProvider(process.env),
  new UnavailableEligibilityProvider(),
  new AlchemyTradingWallet(process.env.ALCHEMY_API_KEY),
  (event) => structuredLog({ event: event.name, resourceId: event.resourceId }),
);
const economy = new NormicEconomy({
  repository,
  networks,
  credentialIssuer: issuer,
  credentialAudience: audience,
  credentialEnvironment: developmentAuthEnabled ? "dev" : "live",
  eventSink: (event) =>
    structuredLog({
      event: event.name.replaceAll(".", "_"),
      outcome: event.outcome,
      actorAgentId: event.actorAgentId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
    }),
});
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
const authenticator = new ApiCredentialAuthenticator(repository, {
  issuer,
  audience,
  eventSink: (event) =>
    structuredLog({ event: event.name, reason: event.reason }),
});
function configuredVerifier(prefix: "NORMIC_AUTH" | "NORMIC_OWNER_AUTH") {
  const jwksUrl = process.env[`${prefix}_JWKS_URL`];
  const verifierIssuer = process.env[`${prefix}_ISSUER`];
  const verifierAudience = process.env[`${prefix}_AUDIENCE`];
  if (!jwksUrl || !verifierIssuer || !verifierAudience) {
    if (process.env.NODE_ENV === "production")
      throw new Error(
        `${prefix}_ISSUER, ${prefix}_AUDIENCE, and ${prefix}_JWKS_URL are required in production.`,
      );
    return null;
  }
  return new OAuthTokenVerifier({
    issuer: verifierIssuer,
    audience: verifierAudience,
    jwksUrl,
  });
}
const accessVerifier = configuredVerifier("NORMIC_AUTH");
const ownerVerifier = configuredVerifier("NORMIC_OWNER_AUTH");
if (process.env.NODE_ENV === "production") {
  await accessVerifier!.validateJwks();
  if (
    process.env.NORMIC_OWNER_AUTH_JWKS_URL !== process.env.NORMIC_AUTH_JWKS_URL
  )
    await ownerVerifier!.validateJwks();
}
const readiness = (): ProductionReadiness =>
  buildProductionReadiness(process.env, {
    database: { kind: database.kind, connected: true },
    robinhoodRpcVerified,
    payments: finance.capabilities(),
    trading: trading.capabilities(),
  });
const oauthAuthenticator = accessVerifier
  ? new OAuthAgentAuthenticator(repository, accessVerifier, {
      issuer,
      audience,
      eventSink: (event) => structuredLog({ event: event.name }),
    })
  : null;
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
  new URL(audience),
);
const oauthRequestScopes = developmentAuthEnabled
  ? API_SCOPES
  : (["openid", "profile", "email"] as const);
const makeAuthGate = (allowApiCredential: boolean) =>
  requireBearerAuth({
    resourceMetadataUrl,
    verifier: {
      async verifyAccessToken(token): Promise<AuthInfo> {
        try {
          const principal =
            token.startsWith("nmc_") && allowApiCredential
              ? await authenticator.authenticate(token)
              : oauthAuthenticator
                ? await oauthAuthenticator.authenticate(token)
                : await authenticator.authenticate(null);
          return {
            token,
            clientId: principal.agentId,
            scopes: principal.scopes,
            expiresAt: principal.expiresAt
              ? Math.floor(principal.expiresAt.getTime() / 1000)
              : 253402300799,
            resource: new URL(principal.audience),
            extra: {
              userId: principal.userId,
              credentialId: principal.credentialId,
              issuer: principal.issuer,
              audience: principal.audience,
            },
          };
        } catch (error) {
          throw new OAuthError(
            OAuthErrorCode.InvalidToken,
            error instanceof Error
              ? error.message
              : "Invalid bearer credential.",
          );
        }
      },
    },
  });
const mcpAuthGate = makeAuthGate(developmentAuthEnabled);
const restAuthGate = makeAuthGate(true);
const mcpHandler = createNormicMcpHandler(
  economy,
  markets,
  finance,
  trading,
  autonomy,
  readiness,
);
const nodeHandler = toNodeHandler(mcpHandler, {
  onerror: () =>
    console.error(
      "Normic MCP request failed without exposing request credentials.",
    ),
});
const validateHost =
  allowedHosts.length > 0
    ? hostHeaderValidation(allowedHosts)
    : localhostHostValidation();
const validateOrigin =
  allowedOriginHosts.length > 0
    ? originValidation(allowedOriginHosts)
    : localhostOriginValidation();

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    const { status, ...safe } = publicError(error);
    structuredLog({ event: "http.request_failed", statusCode: status });
    if (!response.headersSent) sendJson(response, status, { error: safe });
    else response.end();
  });
});
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const requestId = randomUUID();
  response.setHeader("x-request-id", requestId);
  response.setHeader("x-content-type-options", "nosniff");
  if (!validateHost(request, response) || !validateOrigin(request, response))
    return;
  response.once("finish", () =>
    structuredLog({
      event: "http.request",
      requestId,
      method: request.method,
      route: routeLabel(url.pathname),
      statusCode: response.statusCode,
    }),
  );
  if (Number(request.headers["content-length"] ?? 0) > 262_144) {
    sendJson(response, 413, {
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body exceeds 256 KiB.",
      },
    });
    return;
  }
  const rate = await repository.consumeRateLimit({
    bucket: rateBucket(request, url.pathname),
    limit: Number(process.env.NORMIC_RATE_LIMIT_PER_MINUTE ?? 120),
    windowSeconds: 60,
    now: new Date(),
  });
  response.setHeader("x-ratelimit-remaining", String(rate.remaining));
  if (!rate.allowed) {
    response.setHeader("retry-after", String(rate.retryAfterSeconds));
    sendJson(response, 429, {
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Retry later.",
      },
    });
    return;
  }
  if (url.pathname === "/status") {
    sendJson(response, 200, readiness());
    return;
  }
  if (url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "normic-mcp",
      persistence: database.kind,
      product: "live-service-network",
      environment: process.env.NODE_ENV ?? "unspecified",
      ...(process.env.NODE_ENV === "test"
        ? { testRunId: process.env.NORMIC_TEST_RUN_ID ?? null }
        : {}),
      network: networks.listCapabilities()[0],
      stockTokenTrading: trading.capabilities(),
      publicBeta: readiness().publicBeta,
    });
    return;
  }
  if (serveAuthorizationMetadata(url, response)) return;
  if (
    await handleAutonomyRest(
      request,
      response,
      autonomy,
      async () => {
        const auth = await authenticateRequest(request, restAuthGate);
        if (auth instanceof Response) throw new AuthenticationError();
        return { kind: "agent", context: requestContext(auth) };
      },
      ownerVerifier ? (token) => ownerVerifier.verifyOwner(token) : undefined,
    )
  )
    return;
  if (
    await handleTradingRest(
      request,
      response,
      trading,
      async () => {
        const auth = await authenticateRequest(request, restAuthGate);
        if (auth instanceof Response) throw new AuthenticationError();
        return { kind: "agent", context: requestContext(auth) };
      },
      ownerVerifier ? (token) => ownerVerifier.verifyOwner(token) : undefined,
    )
  )
    return;
  if (
    await handleFinancialRest(
      request,
      response,
      finance,
      async () => {
        const auth = await authenticateRequest(request, restAuthGate);
        if (auth instanceof Response) throw new AuthenticationError();
        return { kind: "agent", context: requestContext(auth) };
      },
      ownerVerifier ? (token) => ownerVerifier.verifyOwner(token) : undefined,
    )
  )
    return;

  if (
    url.pathname.startsWith("/v1/") &&
    (await handlePublicRestRequest(
      request,
      response,
      economy,
      ownerVerifier
        ? async (token) => {
            try {
              return await ownerVerifier.verifyOwner(token);
            } catch {
              await repository.createAuditEvent({
                id: randomUUID(),
                type: "authentication.failed",
                actorAgentId: null,
                companyId: null,
                resourceType: "authentication",
                resourceId: null,
                action: "onboard",
                metadata: { reason: "invalid_owner_session" },
                createdAt: new Date(),
              });
              structuredLog({
                event: "authentication_failure",
                reason: "invalid_owner_session",
              });
              throw new AuthenticationError(
                "A verified owner session is required.",
              );
            }
          }
        : undefined,
    ))
  )
    return;

  if (url.pathname === "/mcp") {
    if (!validateHost(request, response) || !validateOrigin(request, response))
      return;
    const auth = await authenticateRequest(request, mcpAuthGate);
    if (auth instanceof Response) {
      await sendWebResponse(response, auth);
      return;
    }
    (request as IncomingMessage & { auth?: AuthInfo }).auth = auth;
    const ownerToken = request.headers["x-normic-owner-authorization"];
    if (ownerToken) {
      if (!ownerVerifier || typeof ownerToken !== "string")
        throw new AuthenticationError("Owner verification is unavailable.");
      const token = ownerToken.match(/^Bearer (\S+)$/i)?.[1];
      if (!token) throw new AuthenticationError();
      auth.extra = {
        ...auth.extra,
        verifiedOwner: await ownerVerifier.verifyOwner(token),
      };
    }
    await nodeHandler(
      request as unknown as Parameters<typeof nodeHandler>[0],
      response as unknown as Parameters<typeof nodeHandler>[1],
      request.method === "POST" ? await readMcpBody(request) : undefined,
    );
    return;
  }

  if (url.pathname.startsWith("/v1/")) {
    const auth = await authenticateRequest(request, restAuthGate);
    if (auth instanceof Response) {
      await sendWebResponse(response, auth);
      return;
    }
    if (
      await handleRestRequest(
        request,
        response,
        economy,
        markets,
        requestContext(auth),
        finance,
        trading,
      )
    )
      return;
  }

  sendJson(response, 404, {
    error: { code: "NOT_FOUND", message: "Route not found." },
  });
}

export async function handleVercelRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const requestId = randomUUID();
  try {
    if (
      process.env.VERCEL_ENV === "production" &&
      url.hostname !== "normic.tech"
    )
      return webJson(403, {
        error: { code: "HOST_NOT_ALLOWED", message: "Host is not allowed." },
      });
    const origin = request.headers.get("origin");
    if (origin && origin !== "https://normic.tech")
      return webJson(403, {
        error: {
          code: "ORIGIN_NOT_ALLOWED",
          message: "Origin is not allowed.",
        },
      });
    if (request.method === "OPTIONS")
      return withWebHeaders(
        new Response(null, { status: 204 }),
        requestId,
        origin,
      );

    const forwardedFor = request.headers.get("x-forwarded-for") ?? "unknown";
    const rate = await repository.consumeRateLimit({
      bucket: createHash("sha256")
        .update(
          `${forwardedFor.split(",")[0]?.trim()}:${routeLabel(url.pathname)}`,
        )
        .digest("hex"),
      limit: Number(process.env.NORMIC_RATE_LIMIT_PER_MINUTE ?? 120),
      windowSeconds: 60,
      now: new Date(),
    });
    if (!rate.allowed) {
      const response = webJson(429, {
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests. Retry later.",
        },
      });
      response.headers.set("retry-after", String(rate.retryAfterSeconds));
      return withWebHeaders(response, requestId, origin, rate.remaining);
    }

    if (url.pathname === "/health")
      return withWebHeaders(
        webJson(200, { status: "ok", service: "normic-vercel" }),
        requestId,
        origin,
        rate.remaining,
      );
    if (url.pathname === "/status" || url.pathname === "/api/status")
      return withWebHeaders(
        webJson(200, readiness()),
        requestId,
        origin,
        rate.remaining,
      );
    if (
      url.pathname === new URL(resourceMetadataUrl).pathname ||
      url.pathname === "/.well-known/oauth-protected-resource"
    )
      return withWebHeaders(
        webJson(200, {
          resource: audience,
          authorization_servers: [issuer],
          bearer_methods_supported: ["header"],
          scopes_supported: oauthRequestScopes,
        }),
        requestId,
        origin,
        rate.remaining,
      );

    if (url.pathname === "/mcp") {
      const auth = await authenticateWebRequest(request, mcpAuthGate);
      if (auth instanceof Response)
        return withWebHeaders(auth, requestId, origin, rate.remaining);
      const ownerHeader = request.headers.get("x-normic-owner-authorization");
      if (ownerHeader) {
        if (!ownerVerifier)
          throw new AuthenticationError("Owner verification is unavailable.");
        const token = ownerHeader.match(/^Bearer (\S+)$/i)?.[1];
        if (!token) throw new AuthenticationError();
        auth.extra = {
          ...auth.extra,
          verifiedOwner: await ownerVerifier.verifyOwner(token),
        };
      }
      return withWebHeaders(
        await mcpHandler.fetch(request, { authInfo: auth }),
        requestId,
        origin,
        rate.remaining,
      );
    }

    if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
      const nodeRequest = await webToNodeRequest(
        request,
        `${url.pathname.slice("/api".length)}${url.search}`,
      );
      const nodeResponse = new CapturedServerResponse();
      const ownerCheck = ownerVerifier
        ? async (token: string) => ownerVerifier.verifyOwner(token)
        : undefined;
      let handled =
        (await handleAutonomyRest(
          nodeRequest,
          nodeResponse.response,
          autonomy,
          async () => webAgentActor(request),
          ownerCheck,
        )) ||
        (await handleTradingRest(
          nodeRequest,
          nodeResponse.response,
          trading,
          async () => webAgentActor(request),
          ownerCheck,
        )) ||
        (await handleFinancialRest(
          nodeRequest,
          nodeResponse.response,
          finance,
          async () => webAgentActor(request),
          ownerCheck,
        ));
      if (!handled)
        handled = await handlePublicRestRequest(
          nodeRequest,
          nodeResponse.response,
          economy,
          ownerCheck,
        );
      if (!handled) {
        const auth = await authenticateWebRequest(request, restAuthGate);
        if (auth instanceof Response)
          return withWebHeaders(auth, requestId, origin, rate.remaining);
        handled = await handleRestRequest(
          nodeRequest,
          nodeResponse.response,
          economy,
          markets,
          requestContext(auth),
          finance,
          trading,
        );
      }
      return withWebHeaders(
        handled
          ? nodeResponse.toResponse()
          : webJson(404, {
              error: { code: "NOT_FOUND", message: "Route not found." },
            }),
        requestId,
        origin,
        rate.remaining,
      );
    }

    return withWebHeaders(
      webJson(404, {
        error: { code: "NOT_FOUND", message: "Route not found." },
      }),
      requestId,
      origin,
      rate.remaining,
    );
  } catch (error) {
    const { status, ...safe } = publicError(error);
    structuredLog({ event: "vercel.request_failed", statusCode: status });
    return withWebHeaders(webJson(status, { error: safe }), requestId, null);
  }
}

export async function closeVercelRuntimeForTest(): Promise<void> {
  if (process.env.NODE_ENV !== "test")
    throw new Error("The Vercel runtime close hook is test-only.");
  await mcpHandler.close();
  await database.close();
}

async function authenticateWebRequest(
  request: Request,
  gate: ReturnType<typeof makeAuthGate>,
): Promise<AuthInfo | Response> {
  const authorization = request.headers.get("authorization") ?? undefined;
  return gate(
    new Request(audience, {
      headers: authorization ? { authorization } : {},
    }),
  );
}

async function webAgentActor(request: Request) {
  const auth = await authenticateWebRequest(request, restAuthGate);
  if (auth instanceof Response) throw new AuthenticationError();
  return { kind: "agent" as const, context: requestContext(auth) };
}

if (!serverless)
  server.listen(port, host, () => {
    console.log(`Normic authenticated MCP server listening at ${audience}`);
  });

async function authenticateRequest(
  request: IncomingMessage,
  gate: ReturnType<typeof makeAuthGate>,
): Promise<AuthInfo | Response> {
  const header = request.headers.authorization;
  const authorization = Array.isArray(header) ? header[0] : header;
  if (!authorization?.match(/^Bearer \S+$/i)) {
    try {
      await authenticator.authenticate(null);
    } catch {
      /* The auth gate produces the standard challenge. */
    }
  }
  return gate(
    new Request(audience, { headers: authorization ? { authorization } : {} }),
  );
}

function requestContext(auth: AuthInfo): RequestContext {
  return {
    principal: {
      agentId: auth.clientId,
      userId: String(auth.extra?.userId),
      credentialId: String(auth.extra?.credentialId),
      scopes: auth.scopes.filter((scope): scope is ApiScope =>
        (API_SCOPES as readonly string[]).includes(scope),
      ),
      issuer: String(auth.extra?.issuer),
      audience: String(auth.extra?.audience),
      expiresAt: auth.expiresAt ? new Date(auth.expiresAt * 1000) : null,
    },
  };
}

function serveAuthorizationMetadata(
  url: URL,
  response: ServerResponse,
): boolean {
  if (
    url.pathname === new URL(resourceMetadataUrl).pathname ||
    url.pathname === "/.well-known/oauth-protected-resource"
  ) {
    sendJson(response, 200, {
      resource: audience,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: oauthRequestScopes,
    });
    return true;
  }
  if (developmentAuthEnabled && url.pathname.startsWith("/dev-auth")) {
    sendJson(response, 501, {
      error: "development_provider_only",
      message:
        "Development uses one-time opaque credentials from onboarding. Configure a production OAuth 2.1 issuer before deployment.",
    });
    return true;
  }
  return false;
}

async function sendWebResponse(
  response: ServerResponse,
  webResponse: Response,
): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });
  response.writeHead(webResponse.status, headers);
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}
function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
async function shutdown(): Promise<void> {
  await mcpHandler.close();
  await database.close();
  server.close(() => process.exit(0));
}
if (!serverless) {
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
function commaSeparated(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function rateBucket(request: IncomingMessage, pathname: string): string {
  const subject = `${request.socket.remoteAddress ?? "unknown"}:${routeLabel(pathname)}`;
  return createHash("sha256").update(subject).digest("hex");
}
function routeLabel(pathname: string): string {
  const parts = pathname.split("/");
  const known = new Set([
    "",
    "v1",
    "health",
    "mcp",
    "onboarding",
    "register",
    "identity",
    "permissions",
    "networks",
    "audit",
    "leaderboard",
    "activity",
    "services",
    "jobs",
    "credentials",
    "companies",
    "balance",
    "rotate",
    "revoke",
    "accept",
    "start",
    "result",
    "fail",
    "cancel",
    "invocations",
    "markets",
    "stock-tokens",
    "price",
    "corporate-actions",
    "trading",
  ]);
  return parts
    .map((part) => (known.has(part) ? part : ":id"))
    .slice(0, 6)
    .join("/");
}
async function readMcpBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 262_144)
      throw new DomainError(
        "Request body exceeds 256 KiB.",
        "PAYLOAD_TOO_LARGE",
      );
    chunks.push(bytes);
  }
  return parseSafeJson(Buffer.concat(chunks).toString("utf8"));
}
function structuredLog(fields: Record<string, unknown>): void {
  const safe = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: "normic-mcp",
      ...safe,
    }),
  );
}

async function webToNodeRequest(
  request: Request,
  path: string,
): Promise<IncomingMessage> {
  const bytes =
    request.method === "GET" || request.method === "HEAD"
      ? new Uint8Array()
      : new Uint8Array(await request.arrayBuffer());
  const headers = Object.fromEntries(request.headers.entries());
  return {
    method: request.method,
    url: path,
    headers,
    async *[Symbol.asyncIterator]() {
      if (bytes.byteLength) yield bytes;
    },
  } as unknown as IncomingMessage;
}

class CapturedServerResponse {
  private status = 200;
  private readonly headers = new Headers();
  private body = new Uint8Array();
  readonly response = {
    writeHead: (
      status: number,
      headers: Record<string, string | number | readonly string[]> = {},
    ) => {
      this.status = status;
      for (const [name, value] of Object.entries(headers))
        this.headers.set(
          name,
          Array.isArray(value) ? value.join(", ") : String(value),
        );
      return this.response;
    },
    end: (value?: string | Uint8Array) => {
      if (typeof value === "string")
        this.body = new TextEncoder().encode(value);
      else if (value) {
        const copy = new Uint8Array(value.byteLength);
        copy.set(value);
        this.body = copy;
      } else this.body = new Uint8Array();
      return this.response;
    },
  } as unknown as ServerResponse;

  toResponse(): Response {
    return new Response(this.body, {
      status: this.status,
      headers: this.headers,
    });
  }
}

function webJson(status: number, value: unknown): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function withWebHeaders(
  response: Response,
  requestId: string,
  origin: string | null,
  rateRemaining?: number,
): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-content-type-options", "nosniff");
  if (rateRemaining !== undefined)
    headers.set("x-ratelimit-remaining", String(rateRemaining));
  if (origin === "https://normic.tech") {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
    headers.set(
      "access-control-allow-methods",
      "GET, POST, PATCH, DELETE, OPTIONS",
    );
    headers.set(
      "access-control-allow-headers",
      "Authorization, Content-Type, Idempotency-Key, MCP-Protocol-Version, MCP-Session-Id, X-Normic-Owner-Authorization",
    );
    headers.set(
      "access-control-expose-headers",
      "MCP-Session-Id, X-Request-Id, X-RateLimit-Remaining",
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
