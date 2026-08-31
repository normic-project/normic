import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthTokenVerifier } from "@normic/core";
import { POST } from "../../apps/web/src/app/api/finance/[command]/route";
const mocks = vi.hoisted(() => ({
  getWallet: vi.fn(),
  query: vi.fn(),
  consumeRateLimit: vi.fn(),
  prepareFinancialIdentity: vi.fn(),
}));
vi.mock("../../apps/web/src/lib/economy", () => ({
  getRuntime: async () => ({
    finance: {
      getWallet: mocks.getWallet,
      prepareFinancialIdentity: mocks.prepareFinancialIdentity,
    },
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
    vi.spyOn(console, "error").mockImplementation(() => {});
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

  it("identifies configuration and root persistence failures without leaking error payloads", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NORMIC_OWNER_AUTH_ISSUER", "https://auth.test/auth/v1");
    vi.stubEnv("NORMIC_OWNER_AUTH_AUDIENCE", "authenticated");
    vi.stubEnv("NORMIC_OWNER_AUTH_JWKS_URL", "https://auth.test/jwks");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://normic.tech");
    vi.stubEnv("ROBINHOOD_RPC_URL", "https://rpc.test/secret-rpc-key");
    vi.stubEnv("ALCHEMY_API_KEY", "");
    vi.spyOn(OAuthTokenVerifier.prototype, "verifyOwner").mockResolvedValue({
      issuer: "https://auth.test/auth/v1",
      subject: crypto.randomUUID(),
      email: "owner@example.test",
    });
    mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
    mocks.prepareFinancialIdentity.mockReset();
    const request = () =>
      POST(
        new Request(
          "https://normic.tech/api/finance/prepare_financial_identity",
          {
            method: "POST",
            headers: {
              authorization: "Bearer secret-owner-token",
              "x-normic-auth-mode": "owner",
              "idempotency-key": crypto.randomUUID(),
              "content-type": "application/json",
            },
            body: JSON.stringify({ companyId: crypto.randomUUID() }),
          },
        ),
        { params: Promise.resolve({ command: "prepare_financial_identity" }) },
      );
    const missing = await request();
    expect(missing.status).toBe(503);
    expect((await missing.json()).error).toMatchObject({
      stage: "CONFIGURATION",
      code: "FINANCIAL_UNAVAILABLE",
      message: expect.stringContaining("ALCHEMY_API_KEY"),
    });
    expect(mocks.prepareFinancialIdentity).not.toHaveBeenCalled();
    vi.stubEnv("ALCHEMY_API_KEY", "secret-alchemy-key");
    mocks.prepareFinancialIdentity.mockRejectedValue({
      code: "P0001",
      message: "secret-error-detail",
      query: "secret-sql",
      parameters: ["secret-owner-token"],
    });
    const failed = await request();
    const payload = await failed.json();
    expect(failed.status).toBe(500);
    expect(payload.error).toMatchObject({
      stage: "ROOT_BINDING",
      code: "INTERNAL_ERROR",
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
    expect(log).toHaveBeenLastCalledWith("FINANCIAL_WALLET_SETUP_FAILED", {
      stage: "ROOT_BINDING",
      code: "INTERNAL_ERROR",
      databaseCode: "P0001",
      requestId: payload.error.requestId,
    });
    expect(JSON.stringify([log.mock.calls, payload])).not.toContain("secret-");
    mocks.prepareFinancialIdentity.mockResolvedValue({
      state: "pending_passkey",
    });
    expect((await request()).status).toBe(200);
  });
});
