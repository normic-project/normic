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
import { assertWebAuthnWalletConfiguration } from "@normic/payments";
import { getRuntime } from "@/lib/economy";
const walletStages = {
  get_financial_identity: "IDENTITY_LOOKUP",
  get_wallet: "WALLET_LOOKUP",
  prepare_financial_identity: "ROOT_BINDING",
  begin_financial_passkey_registration: "PASSKEY_CHALLENGE",
  complete_financial_passkey_registration: "PASSKEY_VERIFICATION",
  provision_financial_wallet: "WALLET_PROVISIONING",
} as const;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ command: string }> },
) {
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  const requestId = crypto.randomUUID();
  let walletStage: string | undefined;
  let stage = "REQUEST";
  try {
    const { command } = await params;
    if (Object.hasOwn(walletStages, command))
      walletStage = walletStages[command as keyof typeof walletStages];
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    )
      throw new AuthenticationError(
        "Cross-origin financial requests are not allowed.",
      );
    stage = "RUNTIME";
    const { finance, repository, database } = await getRuntime();
    stage = "RATE_LIMIT";
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
    stage = "REQUEST";
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
    stage = "AUTHENTICATION";
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
          ownerIdentityResolver: async (owner) => {
            const [user] = await database.query<{ verified: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM auth.users WHERE id=$1
               AND email_confirmed_at IS NOT NULL AND lower(email)=lower($2)) AS verified`,
              [owner.subject, owner.email],
            );
            return user?.verified === true;
          },
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
    if (
      [
        "prepare_financial_identity",
        "begin_financial_passkey_registration",
        "provision_financial_wallet",
      ].includes(name)
    ) {
      stage = "CONFIGURATION";
      assertWebAuthnWalletConfiguration(process.env);
    }
    stage = walletStage ?? "COMMAND";
    return Response.json(
      await runFinancialCommand(finance, actor, name, body, key),
      { headers },
    );
  } catch (error) {
    const { status, ...safe } = publicError(error);
    if (walletStage) {
      const databaseCode =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      // Only fixed stages/codes and a server-generated reference. Never log the
      // error object, message, request, JWT, SQL parameters or provider URL.
      console.error("FINANCIAL_WALLET_SETUP_FAILED", {
        requestId,
        stage,
        code: safe.code,
        ...(typeof databaseCode === "string" &&
        [
          "P0001",
          "23514",
          "23505",
          "22P02",
          "42P01",
          "42703",
          "42501",
          "57014",
          "53300",
          "08006",
        ].includes(databaseCode)
          ? { databaseCode }
          : {}),
      });
    }
    return Response.json(
      { error: { ...safe, ...(walletStage ? { stage, requestId } : {}) } },
      { status, headers },
    );
  }
}
