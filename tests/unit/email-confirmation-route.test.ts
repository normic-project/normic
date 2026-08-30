import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, HEAD } from "../../apps/web/src/app/auth/confirm/route";
import {
  getOwnerAuthView,
  hasEmailConfirmationError,
  hasEmailConfirmationReturn,
  shouldShowEmailVerifiedNotice,
} from "../../apps/web/src/lib/frontend-auth-state";

const requireFromWeb = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { NextRequest } = requireFromWeb("next/server");
const { createServerClient } = requireFromWeb("@supabase/ssr");
const authUrl = "https://confirmation-test.supabase.co";
const publishableKey = "sb_publishable_isolated_test_only";
const tokenHash = "a".repeat(56);
const user = {
  id: "test-owner",
  email: "owner@example.com",
  email_confirmed_at: "2026-01-01T00:00:00Z",
};
const fetchMock = vi.fn();

function sessionResult() {
  // Isolated SDK transport fixture, never a production credential.
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    access_token: `${encode({ alg: "HS256" })}.${encode({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.test-signature`,
    refresh_token: "test-refresh-only",
    token_type: "bearer",
    expires_in: 3600,
    user,
  };
}

function request(query = `token_hash=${tokenHash}&type=email`) {
  return new NextRequest(`https://normic.tech/auth/confirm?${query}`, {
    headers: { cookie: "unrelated=preserve-me" },
  });
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", authUrl);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", publishableKey);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json(sessionResult()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Normic server-side email confirmation", () => {
  it("exchanges TokenHash with the real SSR SDK and persists the browser-compatible session", async () => {
    const expectedSession = sessionResult();
    fetchMock.mockResolvedValueOnce(Response.json(expectedSession));
    const response = await GET(request());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${authUrl}/auth/v1/verify`);
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toMatchObject({
      token_hash: tokenHash,
      type: "email",
    });
    expect(new Headers(options.headers).get("apikey")).toBe(publishableKey);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://normic.tech/#type=email",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const cookies = response.cookies.getAll();
    expect(cookies.length).toBeGreaterThan(0);
    expect(
      cookies.every((cookie) => cookie.secure && cookie.path === "/"),
    ).toBe(true);
    expect(cookies.some((cookie) => cookie.name === "unrelated")).toBe(false);
    const restored = createServerClient(authUrl, publishableKey, {
      cookies: { getAll: () => cookies, setAll: vi.fn() },
    });
    const { data } = await restored.auth.getSession();
    expect(data.session?.access_token).toBe(expectedSession.access_token);
    expect(data.session?.refresh_token).toBe("test-refresh-only");
    expect(await response.text()).toBe("");
  });

  it("uses a fixed Normic destination, not query or forwarded-host redirect values", async () => {
    const response = await GET(
      new NextRequest(
        `https://untrusted.invalid/auth/confirm?token_hash=${tokenHash}&type=email&next=https://untrusted.invalid&redirect_to=https://untrusted.invalid`,
        { headers: { "x-forwarded-host": "untrusted.invalid" } },
      ),
    );
    const destination = response.headers.get("location")!;
    expect(destination).toBe("https://normic.tech/#type=email");
    expect(destination).not.toContain(tokenHash);
    expect(hasEmailConfirmationReturn(new URL(destination), false)).toBe(true);
    expect(
      shouldShowEmailVerifiedNotice({
        confirmationReturn: true,
        trustedVerifiedUser: false,
        previouslyValidatedNotice: false,
      }),
    ).toBe(false);
  });

  it.each([
    "",
    "type=email",
    `token_hash=${tokenHash}`,
    "token_hash=&type=email",
    "token_hash=%20& type=email",
    `token_hash=${tokenHash}&type=recovery`,
    `token_hash=${tokenHash}&type=signup`,
    `token_hash=${tokenHash}&type=email_change`,
    `token_hash=${tokenHash}&type=email&type=email`,
    `token_hash=${tokenHash}&token_hash=other&type=email`,
    `token_hash=${"a".repeat(1025)}&type=email`,
  ])(
    "rejects malformed or unsupported input before contacting Supabase: case %#",
    async (query) => {
      const response = await GET(request(query));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.headers.get("location")).toBe(
        "https://normic.tech/owner#error_code=otp_expired",
      );
      expect(response.cookies.getAll()).toEqual([]);
    },
  );

  it("routes expired/replayed tokens to resend without exposing provider errors or changing an existing session", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        {
          code: "otp_expired",
          msg: "provider-internal-error-do-not-reflect",
        },
        { status: 403 },
      ),
    );
    const response = await GET(request());
    expect(response.headers.get("location")).toBe(
      "https://normic.tech/owner#error_code=otp_expired",
    );
    expect(response.cookies.getAll()).toEqual([]);
    expect(await response.text()).toBe("");
    const confirmationError = hasEmailConfirmationError(
      new URL(response.headers.get("location")!),
    );
    expect(confirmationError).toBe(true);
    expect(
      getOwnerAuthView({
        authenticated: false,
        emailVerified: false,
        connected: false,
        confirmationError,
      }),
    ).toBe("expired-link");
    expect(
      getOwnerAuthView({
        authenticated: true,
        emailVerified: true,
        connected: false,
        confirmationError,
      }),
    ).toBe("connect");
  });

  it("does not issue partial cookies or a success hint for an unverified provider response", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        ...sessionResult(),
        user: { ...user, email_confirmed_at: null },
      }),
    );
    const response = await GET(request());
    expect(response.headers.get("location")).toContain(
      "error_code=otp_expired",
    );
    expect(response.cookies.getAll()).toEqual([]);
  });

  it("fails closed when configuration is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    const response = await GET(request());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toContain(
      "error_code=otp_expired",
    );
    expect(response.cookies.getAll()).toEqual([]);
  });

  it("does not consume a verification token for HEAD requests", () => {
    expect(HEAD().status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
