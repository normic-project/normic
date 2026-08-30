import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import nextConfig, { contentSecurityPolicy } from "../../apps/web/next.config";
import { GET } from "../../apps/web/src/app/api/route";

const requireFromWeb = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { getPathMatch } = requireFromWeb(
  "next/dist/shared/lib/router/utils/path-match",
) as { getPathMatch: (source: string) => (pathname: string) => unknown };

async function headersFor(path: string) {
  const rules = await nextConfig.headers!();
  return rules
    .filter(({ source }) =>
      getPathMatch(source)(new URL(path, "https://normic.tech").pathname),
    )
    .flatMap(({ headers }) => headers);
}

describe("public-beta web boundaries", () => {
  const expectedHeaders = [
    {
      key: "Content-Security-Policy",
      value: contentSecurityPolicy(process.env.NEXT_PUBLIC_SUPABASE_URL),
    },
    { key: "X-Frame-Options", value: "DENY" },
  ];

  it.each([
    "/owner",
    "/owner/",
    "/owner/settings",
    "/oauth/consent",
    "/oauth/consent/",
    "/oauth/consent?authorization_id=request",
  ])(
    "blocks framing of %s without restricting OAuth navigation",
    async (path) => {
      expect(await headersFor(path)).toEqual(expectedHeaders);
    },
  );

  it.each([
    "/",
    "/mcp",
    "/api",
    "/api/status",
    "/api/v1/identity",
    "/api/v1/onboarding/connect",
    "/health",
    "/.well-known/oauth-protected-resource/mcp",
    "/owner-other",
    "/oauth/consent-other",
  ])(
    "preserves routing while applying security headers to %s",
    async (path) => {
      expect(await headersFor(path)).toEqual(expectedHeaders);
      expect(nextConfig.redirects).toBeUndefined();
      expect(nextConfig.rewrites).toBeUndefined();
    },
  );

  it("allows only documented Privy resources and the configured Supabase origin", () => {
    const policy = contentSecurityPolicy(
      "https://project-ref.supabase.co/auth/v1",
    );
    expect(policy).toBe(
      "frame-ancestors 'none'; " +
        "child-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org; " +
        "frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org; " +
        "connect-src 'self' https://project-ref.supabase.co https://auth.privy.io wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org https://*.rpc.privy.systems https://explorer-api.walletconnect.com",
    );
    expect(policy).not.toContain("frame-ancestors *");
    expect(policy).not.toContain("frame-src *");
    expect(policy).not.toContain("connect-src *");
  });

  it("rejects unsafe Supabase origins before constructing a header", () => {
    expect(() => contentSecurityPolicy("http://supabase.example")).toThrow(
      "valid HTTPS origin",
    );
    expect(() =>
      contentSecurityPolicy("https://user:password@supabase.example"),
    ).toThrow("valid HTTPS origin");
  });

  it("serves only the public API index without exposing configuration", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      name: "Normic API",
      status: "online",
      version: "v1",
      routes: { status: "/api/status", v1: "/api/v1" },
    });
  });
});
