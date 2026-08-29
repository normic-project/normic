import { verifyMessage, type Hex } from "viem";
import {
  DomainError,
  PolicyDeniedError,
  addressSchema,
  hashSchema,
  type FinancialWallet,
  type Trade,
  type TradeQuote,
  type TradingPolicy,
  type TradingSession,
  type TradingWalletPort,
} from "@normic/core";

/**
 * Deployment-owned custody boundary. A production implementation must retrieve
 * and validate the owner grant from its own protected store. It must never
 * expose a session private key or accept generic caller-supplied transaction
 * calldata.
 */
export interface TradingSessionCustodian {
  verifyAuthorization(input: {
    wallet: FinancialWallet;
    session: TradingSession;
    policy: TradingPolicy;
    quote: TradeQuote;
  }): Promise<{ ownerAuthorization: Hex }>;
  signApprovedTrade(input: {
    wallet: FinancialWallet;
    session: TradingSession;
    trade: Trade;
    quote: TradeQuote;
    prepared: Record<string, unknown>;
  }): Promise<Hex>;
}

export class AlchemyTradingWallet implements TradingWalletPort {
  readonly available: boolean;
  readonly autonomousAvailable: boolean;

  constructor(
    private readonly apiKey?: string,
    private readonly custodian?: TradingSessionCustodian,
  ) {
    this.available = !!apiKey;
    this.autonomousAvailable = !!apiKey && !!custodian;
  }

  private async request(method: string, params: unknown[]): Promise<unknown> {
    if (!this.apiKey)
      throw new DomainError(
        "Alchemy Wallet API credentials are not configured.",
        "TRADING_UNAVAILABLE",
      );
    try {
      const response = await fetch(
        `https://api.g.alchemy.com/v2/${encodeURIComponent(this.apiKey)}`,
        {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: crypto.randomUUID(),
            method,
            params,
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error();
      const data = (await response.json()) as {
        error?: unknown;
        result?: unknown;
      };
      if (data.error || data.result === undefined) throw new Error();
      return data.result;
    } catch {
      throw new DomainError(
        "The configured wallet provider could not complete the trade operation.",
        "TRADING_UNAVAILABLE",
      );
    }
  }

  async validateSession(
    wallet: FinancialWallet,
    session: TradingSession,
    policy: TradingPolicy,
    quote: TradeQuote,
  ) {
    if (!this.custodian)
      throw new DomainError(
        "A reviewed TradingSessionCustodian is required. Autonomous trading is blocked.",
        "TRADING_UNAVAILABLE",
      );
    if (
      wallet.chainId !== 4663 ||
      !policy.enabled ||
      session.revokedAt ||
      session.policyVersion !== policy.version ||
      quote.policyVersion !== policy.version ||
      new Date(session.expiresAt) <= new Date() ||
      new Date(quote.expiresAt) <= new Date() ||
      session.publicKey === wallet.ownerAddress
    )
      throw new PolicyDeniedError("The trading session is not authorized.");
    addressSchema.parse(quote.transaction.to);
    await this.custodian.verifyAuthorization({
      wallet,
      session,
      policy,
      quote,
    });
  }

  async execute(
    wallet: FinancialWallet,
    session: TradingSession,
    trade: Trade,
    quote: TradeQuote,
  ) {
    if (!this.custodian)
      throw new DomainError(
        "Autonomous trading signing is unavailable.",
        "TRADING_UNAVAILABLE",
      );
    await this.validateSession(wallet, session, trade.policySnapshot, quote);
    if (
      wallet.chainId !== 4663 ||
      trade.wallet !== wallet.address ||
      trade.quoteId !== quote.id ||
      quote.transaction.value !== "0x0" ||
      quote.status !== "CONSUMED"
    )
      throw new PolicyDeniedError("Unapproved autonomous trade operation.");

    const grant = await this.custodian.verifyAuthorization({
      wallet,
      session,
      policy: trade.policySnapshot,
      quote,
    });
    const permissions = {
      sessionId: session.providerSessionId,
      signature: grant.ownerAuthorization,
    };
    const prepared = (await this.request("wallet_prepareCalls", [
      {
        from: wallet.address,
        chainId: "0x1237",
        calls: [quote.transaction],
        capabilities: { permissions },
      },
    ])) as Record<string, unknown>;
    if (
      prepared.chainId !== "0x1237" ||
      prepared.type !== "user-operation-v070"
    )
      throw new DomainError(
        "Wallet provider returned an unexpected operation format or chain.",
        "TRADING_UNAVAILABLE",
      );
    const request = prepared.signatureRequest as {
      type?: string;
      data?: { raw?: Hex };
    };
    if (request?.type !== "personal_sign" || !request.data?.raw)
      throw new DomainError(
        "Wallet provider returned an unexpected signature request.",
        "TRADING_UNAVAILABLE",
      );
    const signature = await this.custodian.signApprovedTrade({
      wallet,
      session,
      trade,
      quote,
      prepared,
    });
    if (
      !(await verifyMessage({
        address: session.publicKey,
        message: { raw: request.data.raw },
        signature,
      }))
    )
      throw new DomainError(
        "The secure custodian returned an invalid session signature.",
        "TRADING_UNAVAILABLE",
      );
    const result = await this.request("wallet_sendPreparedCalls", [
      {
        type: prepared.type,
        data: prepared.data,
        chainId: "0x1237",
        capabilities: { permissions },
        signature: { type: "secp256k1", data: signature },
      },
    ]);
    const id =
      typeof result === "string" ? result : (result as { id?: unknown }).id;
    if (
      typeof id !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(id) ||
      id.length > 512
    )
      throw new DomainError(
        "Wallet broadcast status is unknown. Do not resubmit this trade.",
        "TRADING_UNAVAILABLE",
      );
    return { callId: id };
  }

  async status(callId: string) {
    if (!/^0x[0-9a-fA-F]+$/.test(callId))
      throw new DomainError("Invalid wallet call ID.", "INVALID_INPUT");
    const result = (await this.request("wallet_getCallsStatus", [callId])) as {
      id?: unknown;
      chainId?: unknown;
      status?: unknown;
      receipts?: { status?: unknown; transactionHash?: unknown }[];
    };
    if (
      result.id !== callId ||
      result.chainId !== "0x1237" ||
      typeof result.status !== "number"
    )
      throw new DomainError(
        "Wallet provider returned an unexpected trade status.",
        "TRADING_UNAVAILABLE",
      );
    if (result.status === 100)
      return { state: "pending" as const, transactionHash: null };
    if (result.status >= 400)
      return { state: "failed" as const, transactionHash: null };
    if (result.status === 200) {
      const receipt = result.receipts?.find(
        (entry) =>
          entry.status === "0x1" && typeof entry.transactionHash === "string",
      );
      if (!receipt)
        throw new DomainError(
          "Confirmed wallet call has no successful transaction receipt.",
          "TRADING_UNAVAILABLE",
        );
      return {
        state: "confirmed" as const,
        transactionHash: hashSchema.parse(receipt.transactionHash),
      };
    }
    return { state: "unknown" as const, transactionHash: null };
  }

  async revoke(_session: TradingSession): Promise<void> {
    throw new DomainError(
      "Local trading is paused. Complete permission revocation with the owner wallet provider.",
      "OWNER_ACTION_REQUIRED",
    );
  }
}
