import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import nextConfig from "../../apps/web/next.config";
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
      expect(await headersFor(path)).toEqual([
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
      ]);
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
  ])("does not change headers or routing for %s", async (path) => {
    expect(await headersFor(path)).toEqual([]);
    expect(nextConfig.redirects).toBeUndefined();
    expect(nextConfig.rewrites).toBeUndefined();
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
