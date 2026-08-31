import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../apps/web/src/app/api/finance/[command]/route";
const mocks = vi.hoisted(() => ({
  getWallet: vi.fn(),
  query: vi.fn(),
  consumeRateLimit: vi.fn(),
}));
vi.mock("../../apps/web/src/lib/economy", () => ({
  getRuntime: async () => ({
    finance: { getWallet: mocks.getWallet },
    repository: { consumeRateLimit: mocks.consumeRateLimit },
    database: { query: mocks.query },
  }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("wallet owner REST authentication", () => {
  it("accepts standard verified Supabase owners and rejects unverified, expired and MCP-audience sessions", async () => {
    const issuer = "https://auth.test.normic/auth/v1",
      subject = crypto.randomUUID(),
      email = "verified@example.test",
      companyId = crypto.randomUUID();
    vi.stubEnv("NORMIC_OWNER_AUTH_ISSUER", issuer);
    vi.stubEnv("NORMIC_OWNER_AUTH_AUDIENCE", "authenticated");
    vi.stubEnv("NORMIC_OWNER_AUTH_JWKS_URL", `${issuer}/.well-known/jwks.json`);
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          keys: [{ ...jwk, kid: "test-key", alg: "ES256", use: "sig" }],
        }),
      ),
    );
    mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
    mocks.getWallet.mockResolvedValue(null);
    mocks.query.mockImplementation(async (sql: string, args: unknown[]) => {
      expect(sql).toContain("email_confirmed_at IS NOT NULL");
      expect(args).toEqual([subject, email]);
      return [{ verified: true }];
    });
    async function token(extra: Record<string, unknown> = {}) {
      const h = Buffer.from(
        JSON.stringify({ alg: "ES256", kid: "test-key" }),
      ).toString("base64url");
      const p = Buffer.from(
        JSON.stringify({
          iss: issuer,
          aud: "authenticated",
          sub: subject,
          email,
          role: "authenticated",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
          ...extra,
        }),
      ).toString("base64url");
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        new TextEncoder().encode(`${h}.${p}`),
      );
      return `${h}.${p}.${Buffer.from(signature).toString("base64url")}`;
    }
    async function request(
      accessToken: string,
      origin = "https://normic.tech",
    ) {
      return POST(
        new Request("https://normic.tech/api/finance/get_wallet", {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "x-normic-auth-mode": "owner",
            origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({ companyId }),
        }),
        { params: Promise.resolve({ command: "get_wallet" }) },
      );
    }
    const valid = await token();
    expect((await request(valid)).status).toBe(200);
    expect(mocks.getWallet).toHaveBeenCalledWith(
      { kind: "owner", owner: { issuer, subject, email } },
      companyId,
    );
    mocks.getWallet.mockClear();
    for (const bad of [
      { aud: "https://normic.tech/mcp" },
      { exp: 1 },
      { iss: "https://wrong.test" },
      { sub: "" },
      { role: "anon" },
    ])
      expect((await request(await token(bad))).status).toBe(401);
    mocks.query.mockResolvedValue([{ verified: false }]);
    expect((await request(valid)).status).toBe(401);
    expect((await request(valid, "https://evil.test")).status).toBe(401);
    expect(mocks.getWallet).not.toHaveBeenCalled();
  });
});
