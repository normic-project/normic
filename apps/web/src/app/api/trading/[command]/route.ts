import {
  ApiCredentialAuthenticator,
  OAuthAgentAuthenticator,
  OAuthTokenVerifier,
  AuthenticationError,
  parseSafeJson,
  publicError,
  runTradingCommand,
  tradingEffect,
  tradingInputs,
  type FinancialActor,
  type TradingCommand,
} from "@normic/core";
import { getRuntime } from "@/lib/economy";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ command: string }> },
) {
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  try {
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    )
      throw new AuthenticationError(
        "Cross-origin trading requests are not allowed.",
      );
    const { trading, repository } = await getRuntime(),
      { command } = await params;
    if (!Object.hasOwn(tradingInputs, command))
      return Response.json(
        { error: { message: "Unknown trading operation." } },
        { status: 404, headers },
      );
    const rate = await repository.consumeRateLimit({
      bucket: "web-trading-requests",
      limit: 120,
      windowSeconds: 60,
      now: new Date(),
    });
    if (!rate.allowed)
      return Response.json(
        { error: { message: "Too many requests." } },
        { status: 429, headers },
      );
    const text = await request.text();
    if (Buffer.byteLength(text) > 262_144)
      return Response.json(
        { error: { message: "Request too large." } },
        { status: 413, headers },
      );
    const body = parseSafeJson(text),
      name = command as TradingCommand,
      key = request.headers.get("idempotency-key") ?? "";
    if (tradingEffect(name) !== "READ" && !key)
      throw new Error("Idempotency key required.");
    const token =
      request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1] ?? "";
    let actor: FinancialActor;
    if (request.headers.get("x-normic-auth-mode") === "owner") {
      const issuer = process.env.NORMIC_OWNER_AUTH_ISSUER,
        audience = process.env.NORMIC_OWNER_AUTH_AUDIENCE,
        jwksUrl = process.env.NORMIC_OWNER_AUTH_JWKS_URL;
      if (!issuer || !audience || !jwksUrl)
        throw new AuthenticationError(
          "The owner identity provider is not configured.",
        );
      actor = {
        kind: "owner",
        owner: await new OAuthTokenVerifier({
          issuer,
          audience,
          jwksUrl,
        }).verifyOwner(token),
      };
    } else {
      const origin =
          process.env.NORMIC_PUBLIC_ORIGIN ?? "http://127.0.0.1:3100",
        issuer = process.env.NORMIC_AUTH_ISSUER ?? `${origin}/dev-auth`,
        audience = process.env.NORMIC_AUTH_AUDIENCE ?? `${origin}/mcp`,
        jwksUrl = process.env.NORMIC_AUTH_JWKS_URL,
        auth = token.startsWith("nmc_")
          ? new ApiCredentialAuthenticator(repository, { issuer, audience })
          : jwksUrl
            ? new OAuthAgentAuthenticator(
                repository,
                new OAuthTokenVerifier({ issuer, audience, jwksUrl }),
                { issuer, audience },
              )
            : new ApiCredentialAuthenticator(repository, { issuer, audience });
      actor = {
        kind: "agent",
        context: { principal: await auth.authenticate(token) },
      };
    }
    return Response.json(
      await runTradingCommand(trading, actor, name, body, key),
      { headers },
    );
  } catch (error) {
    const { status, ...safe } = publicError(error);
    return Response.json({ error: safe }, { status, headers });
  }
}
