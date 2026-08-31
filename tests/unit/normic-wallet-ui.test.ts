// @vitest-environment jsdom
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as React from "react";
import type * as ReactDOMClient from "react-dom/client";
import { NormicWallet } from "../../apps/web/src/components/normic-wallet";
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  onAuthStateChange: vi.fn(),
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: vi.fn(),
}));
vi.mock("../../apps/web/node_modules/@supabase/ssr", () => ({
  createBrowserClient: () => ({ auth: mocks }),
}));
vi.mock(
  "../../apps/web/node_modules/@simplewebauthn/browser/esm/index.js",
  () => ({
    startRegistration: mocks.startRegistration,
    browserSupportsWebAuthn: mocks.browserSupportsWebAuthn,
  }),
);
const requireWeb = createRequire(resolve("apps/web/package.json"));
const { createElement, act } = requireWeb("react") as typeof React;
const { createRoot } = requireWeb("react-dom/client") as typeof ReactDOMClient;
let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
const companyId = "10000000-0000-4000-8000-000000000001",
  ownerId = "20000000-0000-4000-8000-000000000001";
const connection = {
  connected: true,
  identity: {
    company: { id: companyId, name: "Test company" },
    agent: { name: "Test agent" },
    credentialId: "credential",
  },
  credentials: [{ id: "credential", lastUsedAt: "2026-08-01T00:00:00Z" }],
};
const wallet = {
  address: `0x${"42".repeat(20)}`,
  chainId: 4663,
  deployed: false,
};
let state: string,
  storedWallet: unknown,
  requests: { command: string; headers: Headers; body: unknown }[],
  failProvision: boolean;
let approvalExpired: boolean;
beforeEach(() => {
  window.history.replaceState({}, "", "/wallet");
  approvalExpired = false;
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("isSecureContext", true);
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://auth.test.normic");
  vi.stubEnv(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "sb_publishable_test_only",
  );
  mocks.getSession.mockResolvedValue({
    data: {
      session: { access_token: "test-owner-token", user: { id: ownerId } },
    },
  });
  mocks.getUser.mockResolvedValue({
    data: { user: { id: ownerId, email_confirmed_at: "2026-08-01" } },
    error: null,
  });
  mocks.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
  mocks.browserSupportsWebAuthn.mockReturnValue(true);
  mocks.startRegistration.mockResolvedValue({
    id: "test-credential",
    type: "public-key",
  });
  state = "uninitialized";
  storedWallet = null;
  requests = [];
  failProvision = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/onboarding/connection")
        return Response.json(connection);
      const command = url.split("/").at(-1)!;
      requests.push({
        command,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      if (command === "get_wallet") return Response.json(storedWallet);
      if (command === "prepare_canary_review")
        return Response.json({
          wallet: wallet.address,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          escrow: `0x${"55".repeat(20)}`,
          approvalRequired: true,
          deployed: false,
          gas: { requiredWei: null },
          blockers: ["DISTINCT_PROVIDER_AND_REAL_001_USDG_SERVICE_REQUIRED"],
        });
      if (command === "get_wallet_owner_approval")
        return approvalExpired
          ? Response.json(
              { error: { code: "WALLET_APPROVAL_EXPIRED" } },
              { status: 400 },
            )
          : Response.json({
              companyId,
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
            });
      if (command === "get_financial_identity")
        return Response.json({
          state,
          smartAccountAddress: storedWallet ? wallet.address : null,
        });
      if (command === "prepare_financial_identity") {
        state = "pending_passkey";
        return Response.json({ state });
      }
      if (command === "begin_financial_passkey_registration")
        return Response.json({
          challenge: "test-challenge",
          rp: { id: "normic.tech" },
          authenticatorSelection: { userVerification: "required" },
        });
      if (command === "complete_financial_passkey_registration") {
        state = "passkey_verified";
        return Response.json({ state });
      }
      if (command === "provision_financial_wallet") {
        if (failProvision)
          return Response.json(
            {
              error: {
                code: "FINANCIAL_UNAVAILABLE",
                message: "sensitive upstream detail",
              },
            },
            { status: 503 },
          );
        state = "provisioned";
        storedWallet = wallet;
        return Response.json(wallet);
      }
      throw new Error("Unexpected operation");
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const render = () =>
  act(async () => {
    root.render(createElement(NormicWallet));
  });
const click = () =>
  act(async () => {
    container.querySelector("button")!.click();
  });
describe("Create Normic Wallet", () => {
  it("shows an authenticated unsigned canary review without prompting for a passkey or sending payments", async () => {
    storedWallet = wallet;
    state = "provisioned";
    await render();
    await click();
    expect(container.textContent).toContain("0.01 USDG per transaction");
    expect(container.textContent).toContain("60 minutes from preparation");
    expect(container.textContent).toContain("different real owner");
    expect(container.textContent).toContain("no passkey prompt or transaction");
    expect(mocks.startRegistration).not.toHaveBeenCalled();
    const request = requests.find((r) => r.command === "prepare_canary_review");
    expect(request?.headers.get("authorization")).toBe(
      "Bearer test-owner-token",
    );
    expect(
      requests
        .filter((r) => !r.command.startsWith("get_"))
        .map((r) => r.command),
    ).toEqual(["prepare_canary_review"]);
  });
  it("preserves an approval link while the owner signs in in a separate tab", async () => {
    const path = `/wallet?approval=${crypto.randomUUID()}&agent=${crypto.randomUUID()}`;
    window.history.replaceState({}, "", path);
    mocks.getSession.mockResolvedValueOnce({ data: { session: null } });
    await render();
    const signIn =
      container.querySelector<HTMLAnchorElement>('a[href="/owner"]');
    expect(signIn?.target).toBe("_blank");
    expect(signIn?.rel).toContain("noopener");
    expect(requests).toHaveLength(0);
    await act(async () => {
      mocks.onAuthStateChange.mock.calls[0]![0]("SIGNED_IN");
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(window.location.pathname + window.location.search).toBe(path);
    expect(container.textContent).toContain(
      "Your agent requested wallet preparation",
    );
    expect(mocks.startRegistration).not.toHaveBeenCalled();
  });
  it("reviews agent requests with owner authentication and waits for a personal click before passkey enrollment", async () => {
    window.history.replaceState(
      {},
      "",
      `/wallet?approval=${crypto.randomUUID()}&agent=${crypto.randomUUID()}`,
    );
    await render();
    expect(container.textContent).toContain(
      "Your agent requested wallet preparation",
    );
    expect(mocks.startRegistration).not.toHaveBeenCalled();
    const reviews = () =>
      requests.filter((r) => r.command === "get_wallet_owner_approval");
    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]!.headers.get("authorization")).toBe(
      "Bearer test-owner-token",
    );
    await click();
    expect(reviews()).toHaveLength(2);
    expect(mocks.startRegistration).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(wallet.address);
  });
  it("blocks expired links without creating a passkey and checks expiry again on click", async () => {
    window.history.replaceState(
      {},
      "",
      `/wallet?approval=${crypto.randomUUID()}&agent=${crypto.randomUUID()}`,
    );
    await render();
    approvalExpired = true;
    await click();
    expect(container.textContent).toContain("approval link has expired");
    expect(mocks.startRegistration).not.toHaveBeenCalled();
    expect(
      requests.some((r) => r.command === "prepare_financial_identity"),
    ).toBe(false);
    expect(container.querySelector("button")?.disabled).toBe(true);
  });
  it("sends owner bearer authentication through the passkey flow and displays only the resulting wallet", async () => {
    await render();
    expect(container.textContent).toContain("Create Normic Wallet");
    expect(
      container.querySelector(".normic-wallet-section > button.button")
        ?.textContent,
    ).toBe("Create Normic Wallet");
    await click();
    expect(mocks.startRegistration).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({ rp: { id: "normic.tech" } }),
    });
    expect(
      requests
        .filter((r) => !r.command.startsWith("get_"))
        .map((r) => r.command),
    ).toEqual([
      "prepare_financial_identity",
      "begin_financial_passkey_registration",
      "complete_financial_passkey_registration",
      "provision_financial_wallet",
    ]);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe(
        "Bearer test-owner-token",
      );
      expect(request.headers.get("x-normic-auth-mode")).toBe("owner");
      expect(request.headers.get("idempotency-key")).toBeTruthy();
    }
    expect(container.textContent).toContain(wallet.address);
    expect(container.textContent).toContain("counterfactual");
    expect(container.textContent).not.toContain("test-owner-token");
    expect(container.textContent).not.toContain("test-credential");
    expect(container.querySelector("button")?.textContent).toBe(
      "Prepare canary review",
    );
  });
  it("displays an existing wallet without any passkey ceremony", async () => {
    state = "provisioned";
    storedWallet = wallet;
    await render();
    expect(container.textContent).toContain(wallet.address);
    expect(container.querySelector("button")?.textContent).toBe(
      "Prepare canary review",
    );
    expect(mocks.startRegistration).not.toHaveBeenCalled();
  });
  it("resumes provider failure without enrolling a second passkey", async () => {
    failProvision = true;
    await render();
    await click();
    expect(container.textContent).toContain("Resume wallet setup");
    expect(container.textContent).not.toContain("sensitive upstream");
    failProvision = false;
    await click();
    expect(mocks.startRegistration).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(wallet.address);
  });
  it("handles a canceled ceremony without provisioning", async () => {
    mocks.startRegistration.mockRejectedValue(
      new DOMException("canceled", "NotAllowedError"),
    );
    await render();
    await click();
    expect(container.textContent).toContain("canceled or timed out");
    expect(
      requests.some((r) => r.command === "provision_financial_wallet"),
    ).toBe(false);
  });
  it("handles unsupported devices without issuing a challenge", async () => {
    mocks.browserSupportsWebAuthn.mockReturnValue(false);
    await render();
    await click();
    expect(container.textContent).toContain("support passkeys");
    expect(
      requests.some(
        (r) => r.command === "begin_financial_passkey_registration",
      ),
    ).toBe(false);
  });
  it("requires a verified owner session and hides the wallet after sign-out", async () => {
    storedWallet = wallet;
    state = "provisioned";
    await render();
    await act(async () => {
      mocks.onAuthStateChange.mock.calls[0]![0]("SIGNED_OUT", null);
    });
    expect(container.textContent).not.toContain(wallet.address);
    expect(container.textContent).toContain("Sign in to Normic");
  });
  it("does not create a wallet for an unverified session", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: ownerId, email_confirmed_at: null } },
      error: null,
    });
    await render();
    expect(container.querySelector("button")).toBeNull();
    expect(requests).toHaveLength(0);
    expect(mocks.startRegistration).not.toHaveBeenCalled();
  });
});
