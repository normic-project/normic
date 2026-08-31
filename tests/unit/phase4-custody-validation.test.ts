import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  validateCustody,
  runValidation,
} from "../../packages/payments/scripts/validate-custody.mjs";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const env = {
  NORMIC_FINANCIAL_EXECUTION_ENABLED: "false",
  NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED: "false",
  NORMIC_TRADING_EXECUTION_ENABLED: "false",
  NORMIC_AUTONOMOUS_FINANCIAL_EXECUTION_ENABLED: "false",
  NORMIC_CUSTODY_PROVIDER: "privy",
  NORMIC_CUSTODY_CREDENTIAL_REF: "privy-app:test-app",
  PRIVY_APP_ID: "test-app",
  PRIVY_APP_SECRET: "test-only-secret",
  ALCHEMY_API_KEY: "test-only-alchemy",
  ROBINHOOD_RPC_URL: "https://rpc.example.test/test-only-key",
};

function transport(privyStatus = 200, chainId = "0x1237") {
  return vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.origin === "https://api.privy.io") {
      expect(request.method).toBe("GET");
      expect(url.pathname).toBe("/v1/wallets");
      expect(url.search).toBe("");
      expect(request.headers.get("authorization")).toBe(
        `Basic ${Buffer.from(`${env.PRIVY_APP_ID}:${env.PRIVY_APP_SECRET}`).toString("base64")}`,
      );
      expect(request.headers.get("privy-app-id")).toBe(env.PRIVY_APP_ID);
      return Response.json(
        privyStatus === 200
          ? { data: [], next_cursor: null }
          : { error: "test-only-secret" },
        { status: privyStatus },
      );
    }
    expect(request.url).toBe(env.ROBINHOOD_RPC_URL);
    expect(request.method).toBe("POST");
    const body = await request.json();
    expect(body.method).toBe("eth_chainId");
    expect(body.params ?? []).toEqual([]);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: chainId });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("read-only local custody validation", () => {
  it("initializes the real adapters and makes only the two allowed read calls", async () => {
    const fetch = transport();
    vi.stubGlobal("fetch", fetch);
    const before = { ...env };
    const status = await validateCustody(env);
    expect(status).toEqual(
      Object.fromEntries(Object.keys(status).map((key) => [key, "PASS"])),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).toBe(fetch);
    expect(env).toEqual(before);
  });

  it("fails before any network access if financial execution is enabled or unspecified", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const value of ["true", "", undefined]) {
      const status = await validateCustody({
        ...env,
        NORMIC_FINANCIAL_EXECUTION_ENABLED: value,
      });
      expect(Object.values(status).every((result) => result === "FAIL")).toBe(
        true,
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts authenticated HTTP 200 without reading wallet data or an SDK page schema", async () => {
    const fallback = transport();
    const json = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (new URL(request.url).origin !== "https://api.privy.io")
          return fallback(request);
        const response = new Response("unused wallet response", { status: 200 });
        response.json = json;
        return response;
      }),
    );
    expect(await validateCustody(env)).toMatchObject({
      PRIVY_CONNECTIVITY: "PASS",
      PRIVY_CREDENTIALS: "PASS",
    });
    expect(json).not.toHaveBeenCalled();
  });

  it("distinguishes credential rejection from connectivity failure", async () => {
    vi.stubGlobal("fetch", transport(401));
    expect(await validateCustody(env)).toMatchObject({
      PRIVY_CONNECTIVITY: "PASS",
      PRIVY_CREDENTIALS: "FAIL",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("test-only-secret");
      }),
    );
    const status = await validateCustody(env);
    expect(status).toMatchObject({
      PRIVY_CONNECTIVITY: "FAIL",
      PRIVY_CREDENTIALS: "FAIL",
    });
    expect(JSON.stringify(status)).not.toContain("test-only-secret");
  });

  it("rejects mismatched custody configuration and the wrong chain", async () => {
    vi.stubGlobal("fetch", transport(200, "0x1"));
    expect(
      await validateCustody({
        ...env,
        NORMIC_CUSTODY_CREDENTIAL_REF: "privy-app:other",
      }),
    ).toMatchObject({
      CUSTODY_REFERENCE: "FAIL",
      PRIVY_SESSION_CUSTODIAN: "FAIL",
      ALCHEMY_WALLET_API: "FAIL",
      ROBINHOOD_RPC: "FAIL",
    });
  });

  it("does not send RPC requests to an invalid HTTPS configuration", async () => {
    const fetch = transport();
    vi.stubGlobal("fetch", fetch);
    expect(
      await validateCustody({
        ...env,
        ROBINHOOD_RPC_URL: "http://rpc.example.test",
      }),
    ).toMatchObject({ ROBINHOOD_RPC: "FAIL" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("prints only statuses and returns failure when the env file cannot be read", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error("test-only-secret"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await runValidation()).toBe(1);
    expect(log).toHaveBeenCalledTimes(7);
    for (const [line] of log.mock.calls)
      expect(line).toMatch(/^[A-Z_]+: (PASS|FAIL)$/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
