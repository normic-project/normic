import { z } from "zod";
import { CapabilityBlockedError, DomainError } from "./errors.js";
import {
  tradeDecisionSchema,
  tradeQuoteInputSchema,
  tradingPolicySchema,
  type TradingService,
} from "./trading.js";
import { addressSchema } from "./finance-protocol.js";
import type { FinancialActor } from "./finance-types.js";

const company = z.object({ companyId: z.uuid() }).strict();
export const tradingInputs = {
  get_trading_capabilities: z.object({}).strict(),
  get_portfolio: company,
  get_position: company.extend({ symbol: z.string().min(1).max(16) }),
  list_positions: company,
  get_investable_balance: company,
  get_trading_policy: company,
  get_trading_eligibility: company,
  refresh_trading_eligibility: company,
  update_trading_policy: tradingPolicySchema,
  register_trading_session: company.extend({
    publicKey: addressSchema,
    providerSessionId: z.string().min(1).max(256),
    authorizationRef: z.string().min(1).max(256),
  }),
  revoke_trading_session: company,
  quote_stock_token: tradeQuoteInputSchema,
  buy_stock_token: z
    .object({ quoteId: z.uuid(), decision: tradeDecisionSchema })
    .strict(),
  sell_stock_token: z
    .object({ quoteId: z.uuid(), decision: tradeDecisionSchema })
    .strict(),
  reconcile_trade: z.object({ tradeId: z.uuid() }).strict(),
  get_trade: z.object({ tradeId: z.uuid() }).strict(),
  get_trades: company.extend({
    limit: z.number().int().min(1).max(100).default(50),
  }),
  get_realized_pnl: company,
  get_unrealized_pnl: company,
  get_token_approvals: company,
} as const;

export type TradingCommand = keyof typeof tradingInputs;
export type TradingCommandInput<K extends TradingCommand> = z.input<
  (typeof tradingInputs)[K]
>;

export function tradingEffect(command: TradingCommand) {
  if (command === "quote_stock_token") return "QUOTE" as const;
  if (command === "buy_stock_token" || command === "sell_stock_token")
    return "EXECUTE" as const;
  if (command === "reconcile_trade") return "CONFIRM" as const;
  if (command.startsWith("get_") || command === "list_positions")
    return "READ" as const;
  return "OWNER" as const;
}
export const tradingCommandRequiresReadyCapability = (
  command: TradingCommand,
) =>
  [
    "refresh_trading_eligibility",
    "register_trading_session",
    "quote_stock_token",
    "buy_stock_token",
    "sell_stock_token",
    "reconcile_trade",
  ].includes(command);

export async function runTradingCommand(
  service: TradingService,
  actor: FinancialActor,
  command: TradingCommand,
  raw: unknown,
  key: string,
) {
  if (tradingCommandRequiresReadyCapability(command)) {
    const capability = service.capabilities();
    if (capability.state !== "ready")
      throw new CapabilityBlockedError(
        "STOCK_TOKEN_TRADING",
        capability.missing,
      );
  }
  switch (command) {
    case "get_trading_capabilities":
      return service.capabilities();
    case "get_portfolio":
      return service.getPortfolio(actor, company.parse(raw).companyId);
    case "get_position": {
      const input = tradingInputs.get_position.parse(raw);
      return service.getPosition(actor, input.companyId, input.symbol);
    }
    case "list_positions":
      return service.listPositions(actor, company.parse(raw).companyId);
    case "get_investable_balance":
      return service.getInvestableCapital(actor, company.parse(raw).companyId);
    case "get_trading_policy":
      return service.getPolicy(actor, company.parse(raw).companyId);
    case "get_trading_eligibility":
      return service.getEligibility(actor, company.parse(raw).companyId);
    case "refresh_trading_eligibility":
      return service.refreshEligibility(
        actor,
        company.parse(raw).companyId,
        key,
      );
    case "update_trading_policy":
      return service.updatePolicy(
        actor,
        tradingInputs.update_trading_policy.parse(raw),
        key,
      );
    case "register_trading_session":
      return service.registerSession(
        actor,
        tradingInputs.register_trading_session.parse(raw),
        key,
      );
    case "revoke_trading_session":
      return service.revokeSession(actor, company.parse(raw).companyId, key);
    case "quote_stock_token":
      return service.quote(actor, tradeQuoteInputSchema.parse(raw), key);
    case "buy_stock_token": {
      const input = tradingInputs.buy_stock_token.parse(raw);
      return service.execute(actor, input.quoteId, input.decision, "BUY", key);
    }
    case "sell_stock_token": {
      const input = tradingInputs.sell_stock_token.parse(raw);
      return service.execute(actor, input.quoteId, input.decision, "SELL", key);
    }
    case "reconcile_trade":
      return service.reconcile(
        actor,
        tradingInputs.reconcile_trade.parse(raw).tradeId,
        key,
      );
    case "get_trade":
      return service.getTrade(
        actor,
        tradingInputs.get_trade.parse(raw).tradeId,
      );
    case "get_trades": {
      const input = tradingInputs.get_trades.parse(raw);
      return service.getTrades(actor, input.companyId, input.limit);
    }
    case "get_realized_pnl":
      return service.getRealizedPnl(actor, company.parse(raw).companyId);
    case "get_unrealized_pnl":
      return service.getUnrealizedPnl(actor, company.parse(raw).companyId);
    case "get_token_approvals":
      return service.getTokenApprovals(actor, company.parse(raw).companyId);
    default:
      throw new DomainError("Unknown trading operation.", "INVALID_INPUT");
  }
}
