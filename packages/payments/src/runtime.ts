import { FinancialService, type FinancialRepository } from "@normic/core";
import { RobinhoodFinancialChain } from "./robinhood-finance.js";
import {
  AlchemyFinancialWallet,
  type SessionCustodian,
} from "./alchemy-wallet.js";
import { createPrivySessionCustodianFromEnvironment } from "./privy-session-custodian.js";
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
