import {
  DomainError,
  FinancialService,
  FINANCIAL_WEBAUTHN_ORIGIN,
  type FinancialRepository,
} from "@normic/core";
import { RobinhoodFinancialChain } from "./robinhood-finance.js";
import {
  AlchemyFinancialWallet,
  type SessionCustodian,
} from "./alchemy-wallet.js";
import { createPrivySessionCustodianFromEnvironment } from "./privy-session-custodian.js";

// Wallet enrollment is independent of payment-execution flags and Privy sessions.
// Check its own dependencies before the user creates an irreversible root key.
export function assertWebAuthnWalletConfiguration(
  env: Record<string, string | undefined>,
) {
  const missing = ["ALCHEMY_API_KEY", "ROBINHOOD_RPC_URL"].filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length)
    throw new DomainError(
      `Wallet setup requires ${missing.join(", ")}.`,
      "FINANCIAL_UNAVAILABLE",
    );
  let validRpc = false;
  try {
    const url = new URL(env.ROBINHOOD_RPC_URL!);
    validRpc =
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.hostname !== "rpc.mainnet.chain.robinhood.com";
  } catch {
    // Never include the configured URL or API key in an error.
  }
  if (!validRpc)
    throw new DomainError(
      "Wallet setup requires a dedicated HTTPS ROBINHOOD_RPC_URL.",
      "FINANCIAL_UNAVAILABLE",
    );
  if (
    (env.NEXT_PUBLIC_APP_URL ?? env.NORMIC_PUBLIC_ORIGIN) !==
    FINANCIAL_WEBAUTHN_ORIGIN
  )
    throw new DomainError(
      "Wallet setup requires the production origin https://normic.tech.",
      "FINANCIAL_UNAVAILABLE",
    );
}

export function createFinancialRuntime(
  repository: FinancialRepository,
  env: Record<string, string | undefined>,
  custodian?: SessionCustodian,
) {
  const sessionCustodian =
    custodian ?? createPrivySessionCustodianFromEnvironment(env);
  const chain = new RobinhoodFinancialChain(env),
    wallets = new AlchemyFinancialWallet(
      chain,
      env.ALCHEMY_API_KEY,
      sessionCustodian,
      env.ROBINHOOD_RPC_URL,
    );
  return new FinancialService(repository, chain, wallets, {
    origin:
      env.NEXT_PUBLIC_APP_URL ??
      env.NORMIC_PUBLIC_ORIGIN ??
      "http://localhost:3000",
    acceptTimeoutSeconds: Number(env.NORMIC_ACCEPT_TIMEOUT_SECONDS ?? 3600),
    completionTimeoutSeconds: Number(
      env.NORMIC_COMPLETION_TIMEOUT_SECONDS ?? 86400,
    ),
    reviewWindowSeconds: Number(env.NORMIC_REVIEW_WINDOW_SECONDS ?? 86400),
  });
}
