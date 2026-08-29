import {
  ApiCredentialAuthenticator,
  OAuthTokenVerifier,
  OAuthAgentAuthenticator,
  AuthenticationError,
  financialInputs,
  financialEffect,
  runFinancialCommand,
  parseSafeJson,
  publicError,
  type FinancialCommand,
  type FinancialActor,
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
        "Cross-origin financial requests are not allowed.",
      );
    const { finance, repository } = await getRuntime(),
      { command } = await params;
    const rate = await repository.consumeRateLimit({
      bucket: "web-financial-requests",
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
    if (Buffer.byteLength(text) > 262144)
      return Response.json(
        { error: { message: "Request too large." } },
        { status: 413, headers },
      );
    const body = parseSafeJson(text) as Record<string, unknown>,
      key = request.headers.get("idempotency-key") ?? "";
    if (command === "wallet_challenge")
      return Response.json(
        await finance.walletChallenge(String(body.wallet), key),
        {
          headers,
        },
      );
    if (command === "wallet_authenticate")
      return Response.json(
        await finance.authenticateWallet(
          String(body.challengeId),
          String(body.signature),
          key,
        ),
        { headers },
      );
    if (!Object.hasOwn(financialInputs, command))
      return Response.json(
        { error: { message: "Unknown financial operation." } },
        { status: 404, headers },
      );
    const name = command as FinancialCommand;
    if (financialEffect(name) !== "reads" && !key)
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
    } else if (token.startsWith("nmh_"))
      actor = await finance.humanActor(token);
    else {
      const origin =
          process.env.NORMIC_PUBLIC_ORIGIN ?? "http://127.0.0.1:3100",
        issuer = process.env.NORMIC_AUTH_ISSUER ?? `${origin}/dev-auth`,
        audience = process.env.NORMIC_AUTH_AUDIENCE ?? `${origin}/mcp`,
        jwksUrl = process.env.NORMIC_AUTH_JWKS_URL;
      const auth = token.startsWith("nmc_")
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
      await runFinancialCommand(finance, actor, name, body, key),
      { headers },
    );
  } catch (error) {
    const { status, ...safe } = publicError(error);
    return Response.json({ error: safe }, { status, headers });
  }
}
