export * from "./robinhood-finance.js";
export * from "./alchemy-wallet.js";
export * from "./runtime.js";
export * from "./alchemy-trading-wallet.js";
export type PaymentIntent = {
  payerCompanyId: string;
  payeeCompanyId: string;
  reference: string;
};
export interface PaymentProvider {
  readonly key: string;
  readonly executionAvailable: false;
  execute(intent: PaymentIntent): Promise<never>;
}
export class UnavailablePaymentProvider implements PaymentProvider {
  readonly key = "unavailable";
  readonly executionAvailable = false as const;
  async execute(_intent: PaymentIntent): Promise<never> {
    throw new Error(
      "The legacy generic PaymentProvider cannot execute payments. Use the guarded Phase 4 FinancialService flow.",
    );
  }
}
