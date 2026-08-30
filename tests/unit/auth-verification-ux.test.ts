// @vitest-environment jsdom
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type * as React from "react";
import type * as ReactDOMClient from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerConsole } from "../../apps/web/src/components/owner-console";
import { EmailVerificationNotice } from "../../apps/web/src/components/email-verification-notice";
import { PasswordInput } from "../../apps/web/src/components/password-input";
import {
  EMAIL_CONFIRMATION_ADDRESS_KEY,
  EMAIL_CONFIRMATION_ERROR_KEY,
  EMAIL_CONFIRMATION_PENDING_KEY,
  EMAIL_RESEND_AFTER_KEY,
} from "../../apps/web/src/lib/frontend-auth-state";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  resend: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
}));
vi.mock("../../apps/web/node_modules/@supabase/ssr", () => ({
  createBrowserClient: () => ({ auth: mocks }),
}));
vi.mock("../../apps/web/node_modules/next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}));
vi.mock("../../apps/web/src/components/autonomy-console", () => ({
  AutonomyConsole: () => null,
}));

const requireFromWeb = createRequire(resolve("apps/web/package.json"));
const { createElement, act } = requireFromWeb("react") as typeof React;
const { createRoot } = requireFromWeb(
  "react-dom/client",
) as typeof ReactDOMClient;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const neutralResend =
  "If this address needs verification, a new link will arrive shortly.";

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://auth.test.normic");
  vi.stubEnv(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "sb_publishable_test_only",
  );
  sessionStorage.clear();
  window.history.replaceState({}, "", "/owner");
  mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
  mocks.signUp.mockResolvedValue({ data: { session: null }, error: null });
  mocks.resend.mockResolvedValue({ error: null });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        connected: false,
        identity: null,
        credentials: [],
        permissions: [],
      }),
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function renderOwner() {
  await act(async () =>
    root.render(
      createElement(OwnerConsole, {
        paymentsReady: false,
        tradingReady: false,
      }),
    ),
  );
}
function button(text: string) {
  const value = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === text,
  );
  if (!value) throw new Error(`Missing button: ${text}`);
  return value;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function fill(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(
    `input[name="${name}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function signup() {
  await renderOwner();
  await fill("email", "owner@example.com");
  await fill("password", "isolated-test-password");
  await click("Create Account");
}
async function expireLink() {
  window.history.replaceState(
    {},
    "",
    "/owner#error=access_denied&error_code=otp_expired",
  );
  await renderOwner();
  await fill("email", "owner@example.com");
}

describe("signup verification and recovery", () => {
  it("replaces signup with a dedicated email state without granting access", async () => {
    await signup();
    expect(container.textContent).toContain("CHECK YOUR EMAIL");
    expect(container.textContent).toContain("owner@example.com");
    expect(container.querySelector('input[name="password"]')).toBeNull();
    expect(button("Resend verification email").disabled).toBe(true);
    expect(container.textContent).not.toContain("Connect your agent.");
    expect(mocks.resend).not.toHaveBeenCalled();
  });

  it("resends only after cooldown using the exact Supabase signup flow", async () => {
    await signup();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(button("Resend verification email").disabled).toBe(false);
    await click("Resend verification email");
    expect(mocks.resend).toHaveBeenCalledExactlyOnceWith({
      type: "signup",
      email: "owner@example.com",
      options: { emailRedirectTo: "https://normic.tech" },
    });
    expect(container.textContent).toContain(neutralResend);
    expect(container.textContent).toContain("Resend available in 60s");
    await click("Resend verification email");
    expect(mocks.resend).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(container.textContent).toContain("Resend available in 59s");
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderOwner();
    expect(button("Resend verification email").disabled).toBe(true);
    expect(container.textContent).toContain("Resend available in 59s");
  });

  it("offers recovery for expired links without reflecting untrusted error text", async () => {
    await expireLink();
    expect(container.textContent).toContain("EMAIL LINK EXPIRED");
    expect(container.textContent).toContain(
      "This verification link is no longer valid.",
    );
    expect(button("Send new verification link").disabled).toBe(false);
    await click("Send new verification link");
    expect(mocks.resend).toHaveBeenCalledTimes(1);
    await click("Back to sign in");
    expect(container.textContent).toContain("Secure sign in.");
    expect(window.location.hash).toBe("");
  });

  it("clears the signup email and password for another email without resetting cooldown", async () => {
    await signup();
    const deadline = sessionStorage.getItem(EMAIL_RESEND_AFTER_KEY);
    await click("Use another email");
    expect(container.textContent).toContain("Create your account.");
    expect(
      container.querySelector<HTMLInputElement>('input[name="email"]')!.value,
    ).toBe("");
    expect(
      container.querySelector<HTMLInputElement>('input[name="password"]')!
        .value,
    ).toBe("");
    expect(
      container
        .querySelector('input[name="password"]')!
        .getAttribute("autocomplete"),
    ).toBe("new-password");
    expect(sessionStorage.getItem(EMAIL_CONFIRMATION_ADDRESS_KEY)).toBeNull();
    expect(sessionStorage.getItem(EMAIL_CONFIRMATION_PENDING_KEY)).toBeNull();
    expect(sessionStorage.getItem(EMAIL_RESEND_AFTER_KEY)).toBe(deadline);
  });

  it("uses unconfirmed-password-login errors to offer verification, not Connect Agent", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      error: { code: "email_not_confirmed" },
    });
    await renderOwner();
    await fill("email", "owner@example.com");
    await fill("password", "isolated-test-password");
    await click("Sign In");
    expect(container.textContent).toContain("CHECK YOUR EMAIL");
    expect(container.textContent).not.toContain("Connect your agent.");
  });

  it.each([
    null,
    { code: "user_not_found", status: 400 },
    { code: "email_exists", status: 400 },
  ])(
    "does not enumerate email addresses through resend responses (%j)",
    async (error) => {
      mocks.resend.mockResolvedValue({ error });
      await expireLink();
      await click("Send new verification link");
      expect(container.textContent).toContain(neutralResend);
      expect(container.textContent).toContain("Resend available in 60s");
    },
  );

  it("enforces single-flight resend and handles provider rate limits without retries", async () => {
    let resolve!: (value: unknown) => void;
    mocks.resend.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await expireLink();
    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(mocks.resend).toHaveBeenCalledTimes(1);
    expect(button("Back to sign in").disabled).toBe(true);
    await act(async () =>
      resolve({ error: { status: 429, code: "over_email_send_rate_limit" } }),
    );
    expect(container.textContent).toContain(
      "Please wait before requesting another link.",
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.resend).toHaveBeenCalledTimes(1);
  });

  it("shows a clean network error without reflecting provider internals", async () => {
    mocks.resend.mockRejectedValue(new Error("private provider diagnostics"));
    await expireLink();
    await click("Send new verification link");
    expect(container.textContent).toContain(
      "We couldn't request a link right now.",
    );
    expect(container.textContent).not.toContain("private provider diagnostics");
  });

  it("never shows an expired-link panel over an actually verified session", async () => {
    window.history.replaceState({}, "", "/owner#error_code=otp_expired");
    sessionStorage.setItem(EMAIL_CONFIRMATION_ERROR_KEY, "true");
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-owner-session" } },
    });
    mocks.getUser.mockResolvedValue({
      data: {
        user: { email: "owner@example.com", email_confirmed_at: "2026-01-01" },
      },
      error: null,
    });
    await renderOwner();
    expect(mocks.getUser).toHaveBeenCalledWith("test-owner-session");
    expect(container.textContent).toContain("Connect your agent.");
    expect(container.textContent).not.toContain("EMAIL LINK EXPIRED");
    expect(sessionStorage.getItem(EMAIL_CONFIRMATION_ERROR_KEY)).toBeNull();
  });

  it("routes a failed confirmation return from the homepage into owner recovery", async () => {
    window.history.replaceState(
      {},
      "",
      "/#error=access_denied&error_code=otp_expired",
    );
    await act(async () => root.render(createElement(EmailVerificationNotice)));
    expect(mocks.getSession).toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith("/owner");
    expect(sessionStorage.getItem(EMAIL_CONFIRMATION_ERROR_KEY)).toBe("true");
    expect(window.location.hash).toBe("");
    expect(container.textContent).not.toContain("Email verified");
  });

  it("does not redirect an already verified owner on a stale confirmation return", async () => {
    window.history.replaceState({}, "", "/#error_code=otp_expired");
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-owner-session" } },
    });
    mocks.getUser.mockResolvedValue({
      data: { user: { email_confirmed_at: "2026-01-01" } },
      error: null,
    });
    await act(async () => root.render(createElement(EmailVerificationNotice)));
    expect(mocks.getUser).toHaveBeenCalledWith("test-owner-session");
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(EMAIL_CONFIRMATION_ERROR_KEY)).toBeNull();
  });

  it.each(["signup", "email"])(
    "shows the %s confirmation notice only after verifying the returned session",
    async (type) => {
      window.history.replaceState({}, "", `/#type=${type}`);
      mocks.getSession.mockResolvedValue({
        data: { session: { access_token: "test-owner-session" } },
      });
      mocks.getUser.mockResolvedValue({
        data: { user: { email_confirmed_at: "2026-01-01" } },
        error: null,
      });
      await act(async () =>
        root.render(createElement(EmailVerificationNotice)),
      );
      expect(container.textContent).toContain("Email verified");
      expect(mocks.getUser).toHaveBeenCalledWith("test-owner-session");
      expect(mocks.replace).not.toHaveBeenCalled();
    },
  );

  it("does not show a successful server-confirmation hint as verified without a session", async () => {
    window.history.replaceState({}, "", "/#type=email");
    await act(async () => root.render(createElement(EmailVerificationNotice)));
    expect(mocks.getSession).toHaveBeenCalled();
    expect(container.textContent).not.toContain("Email verified");
  });
});

describe("password visibility", () => {
  it("toggles the same input without submitting, changing its value, or losing password-manager attributes", async () => {
    await act(async () =>
      root.render(
        createElement(PasswordInput, {
          name: "password",
          autoComplete: "current-password",
          required: true,
        }),
      ),
    );
    await fill("password", "isolated-test-password");
    const input = container.querySelector("input")!;
    const toggle = container.querySelector("button")!;
    expect(input.type).toBe("password");
    expect(toggle.getAttribute("aria-label")).toBe("Show password");
    expect(toggle.type).toBe("button");
    expect(toggle.tabIndex).toBe(0);
    expect(toggle.getAttribute("aria-controls")).toBe(input.id);
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    await act(async () => toggle.click());
    expect(input.type).toBe("text");
    expect(toggle.getAttribute("aria-label")).toBe("Hide password");
    await act(async () => toggle.click());
    expect(input.type).toBe("password");
    expect(input.value).toBe("isolated-test-password");
    expect(input.name).toBe("password");
    expect(input.autocomplete).toBe("current-password");
  });
});
