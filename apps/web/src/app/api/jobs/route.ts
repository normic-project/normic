import { ApiCredentialAuthenticator, publicError } from "@normic/core";
import { getRuntime } from "@/lib/economy";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  try {
    const { repository, economy } = await getRuntime();
    const rate = await repository.consumeRateLimit({
      bucket: "web-private-jobs",
      limit: 120,
      windowSeconds: 60,
      now: new Date(),
    });
    if (!rate.allowed)
      return Response.json(
        { error: { message: "Too many requests. Retry later." } },
        { status: 429, headers },
      );
    const origin = process.env.NORMIC_PUBLIC_ORIGIN ?? "http://127.0.0.1:3100";
    const authenticator = new ApiCredentialAuthenticator(repository, {
      issuer: process.env.NORMIC_AUTH_ISSUER ?? `${origin}/dev-auth`,
      audience: process.env.NORMIC_AUTH_AUDIENCE ?? `${origin}/mcp`,
    });
    const token =
      request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1] ??
      null;
    const context = { principal: await authenticator.authenticate(token) };
    const url = new URL(request.url);
    const invocationId = url.searchParams.get("invocation_id");
    if (invocationId && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(invocationId))
      return Response.json(
        { error: { message: "Invalid invocation ID." } },
        { status: 400, headers },
      );
    try {
      const data = invocationId
        ? await economy.getInvocation(context, invocationId)
        : await economy.listJobs(context, {
            role:
              url.searchParams.get("role") === "buyer" ? "buyer" : "provider",
          });
      return Response.json(data, { headers });
    } catch (error) {
      if (publicError(error).status === 403)
        await economy.recordAuthorizationDenied(context);
      throw error;
    }
  } catch (error) {
    const { status, ...safe } = publicError(error);
    return Response.json({ error: safe }, { status, headers });
  }
}
