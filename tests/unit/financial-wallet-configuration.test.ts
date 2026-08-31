import { describe, expect, it } from "vitest";
import { assertWebAuthnWalletConfiguration } from "@normic/payments";
import { WalletRequestError } from "../../apps/web/src/lib/financial-wallet-client";

const env = {
  ALCHEMY_API_KEY: "test-only-key",
  ROBINHOOD_RPC_URL: "https://rpc.example.test/test-only-key",
  NEXT_PUBLIC_APP_URL: "https://normic.tech",
  NORMIC_FINANCIAL_EXECUTION_ENABLED: "false",
  NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED: "false",
  NORMIC_TRADING_EXECUTION_ENABLED: "false",
  NORMIC_AUTONOMOUS_FINANCIAL_EXECUTION_ENABLED: "false",
};
describe("WebAuthn wallet configuration", () => {
  it("requires no execution flag or Privy root/session credential", () => {
    expect(() => assertWebAuthnWalletConfiguration(env)).not.toThrow();
  });
  it.each(["ALCHEMY_API_KEY", "ROBINHOOD_RPC_URL"])(
    "reports missing %s before a passkey ceremony",
    (name) => {
      expect(() =>
        assertWebAuthnWalletConfiguration({ ...env, [name]: "" }),
      ).toThrow(name);
    },
  );
  it.each([
    "http://rpc.test/secret",
    "https://user:secret@rpc.test",
    "https://rpc.mainnet.chain.robinhood.com",
    "not-a-url-secret",
  ])("rejects unsafe RPC configuration without printing it", (rpc) => {
    expect(() =>
      assertWebAuthnWalletConfiguration({ ...env, ROBINHOOD_RPC_URL: rpc }),
    ).toThrow("Wallet setup requires a dedicated HTTPS ROBINHOOD_RPC_URL.");
  });
  it("keeps the financial origin fixed", () => {
    expect(() =>
      assertWebAuthnWalletConfiguration({
        ...env,
        NEXT_PUBLIC_APP_URL: "https://evil.test",
      }),
    ).toThrow("production origin https://normic.tech");
  });
  it("shows only fixed configuration copy and a validated support reference", () => {
    const id = crypto.randomUUID();
    expect(
      new WalletRequestError("FINANCIAL_UNAVAILABLE", "CONFIGURATION", id)
        .message,
    ).toContain(`Support reference: ${id}`);
    expect(
      new WalletRequestError("INTERNAL_ERROR", "secret-stage", "secret-error")
        .message,
    ).not.toContain("secret-");
  });
});
