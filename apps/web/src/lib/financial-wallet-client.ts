import type { FinancialWallet } from "@normic/core";
import { ownerRequestHeaders } from "./owner-request";

export type WalletIdentityState = {
  state:
    | "uninitialized"
    | "pending_passkey"
    | "passkey_verified"
    | "provisioned"
    | "revoked";
  smartAccountAddress: string | null;
};
export class WalletRequestError extends Error {
  constructor(
    readonly code: string,
    stage?: string,
    requestId?: string,
  ) {
    super(
      (stage === "CONFIGURATION"
        ? "Wallet setup is not configured yet. Please contact Normic support."
        : code === "UNAUTHENTICATED"
          ? "Your session or passkey challenge has expired. Please try again."
          : code === "FORBIDDEN" || code === "POLICY_DENIED"
            ? "A verified owner and an active MCP-connected agent are required."
            : code === "CONFLICT" || code.startsWith("IDEMPOTENCY_")
              ? "Your wallet setup has changed. Refresh its status before retrying."
              : "Wallet setup is temporarily unavailable. Your existing passkey and wallet will not be replaced. Please retry.") +
        (typeof requestId === "string" && /^[0-9a-f-]{36}$/i.test(requestId)
          ? ` Support reference: ${requestId}.`
          : ""),
    );
  }
}
export async function walletRequest<T>(
  token: string,
  command: string,
  input: unknown,
  key = crypto.randomUUID(),
): Promise<T> {
  if (!token) throw new WalletRequestError("UNAUTHENTICATED");
  const response = await fetch(`/api/finance/${command}`, {
    method: "POST",
    cache: "no-store",
    headers: ownerRequestHeaders(token, {
      "x-normic-auth-mode": "owner",
      "idempotency-key": key,
    }),
    body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok)
    throw new WalletRequestError(
      typeof data.error?.code === "string" ? data.error.code : "UNAVAILABLE",
      data.error?.stage,
      data.error?.requestId,
    );
  return data as T;
}
export async function loadFinancialWallet(token: string, companyId: string) {
  const [identity, wallet] = await Promise.all([
    walletRequest<WalletIdentityState>(token, "get_financial_identity", {
      companyId,
    }),
    walletRequest<FinancialWallet | null>(token, "get_wallet", { companyId }),
  ]);
  return { identity, wallet };
}
