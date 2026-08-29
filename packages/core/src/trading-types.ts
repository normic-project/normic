import type { EconomyRepository } from "./repository.js";
import type {
  EvmAddress,
  EvmHash,
  FinancialActor,
  FinancialSummary,
  FinancialWallet,
  SafeCall,
} from "./finance-types.js";

export type TradingEligibilityState =
  "UNKNOWN" | "PENDING" | "ELIGIBLE" | "INELIGIBLE" | "EXPIRED";

export type TradingEligibility = {
  companyId: string;
  ownerUserId: string;
  state: TradingEligibilityState;
  provider: string | null;
  rulesVersion: string | null;
  attestationId: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  reasonCode: string | null;
  version: number;
};

export type TradingPolicy = {
  companyId: string;
  enabled: boolean;
  allowBuy: boolean;
  allowSell: boolean;
  maxTradeUsdg: string;
  maxDailyInvestmentUsdg: string;
  maxTotalStockExposureUsdg: string;
  maxPositionUsdg: string;
  maxSlippageBps: number;
  maxOracleDeviationBps: number;
  maxPriceImpactBps: number;
  minimumCashReserveUsdg: string;
  allowedAssetIds: string[];
  blockedAssetIds: string[];
  sessionExpiresAt: string;
  version: number;
  updatedAt: string;
};

export type TradingSession = {
  id: string;
  companyId: string;
  publicKey: EvmAddress;
  providerSessionId: string;
  authorizationRef: string;
  expiresAt: string;
  policyVersion: number;
  revokedAt: string | null;
  createdAt: string;
};

export type CanonicalStockToken = {
  assetId: string;
  symbol: string;
  name: string;
  address: EvmAddress;
  chainId: 4663;
  decimals: number;
  status: string;
  tradingHalt: boolean;
  currentMultiplier: string;
  pendingMultiplier: string | null;
  pendingMultiplierEffectiveAt: string | null;
  oraclePaused: boolean;
  registrySource: string;
  verifiedAt: string;
  blockNumber: string;
};

export type OraclePrice = {
  assetId: string;
  token: EvmAddress;
  feed: EvmAddress;
  priceUnits: string;
  decimals: number;
  roundId: string;
  updatedAt: string;
  heartbeatSeconds: number;
  sequencerChecked: true;
  source: "chainlink-robinhood-mainnet";
  blockNumber: string;
};

export type TradingVenueCapabilities = {
  venue: "0x-swap-api";
  state: "ready" | "blocked";
  missing: string[];
  chainId: 4663;
  executionEnabled: boolean;
  configVersion: string | null;
  allowedTargets: EvmAddress[];
  allowedSpenders: EvmAddress[];
  allowedSources: string[];
};

export type TradingVenueConfiguration = {
  version: string;
  chainId: 4663;
  venue: "0x-swap-api";
  quoteOrigin: string;
  allowedTargets: EvmAddress[];
  allowedSpenders: EvmAddress[];
  allowedSources: string[];
  active: boolean;
};

export type VenueQuoteRequest = {
  wallet: EvmAddress;
  owner: EvmAddress;
  side: "BUY" | "SELL";
  asset: CanonicalStockToken;
  usdg: { address: EvmAddress; decimals: number };
  amountIn: string;
  slippageBps: number;
};

export type VenueQuote = {
  providerQuoteId: string;
  venue: "0x-swap-api";
  inputToken: EvmAddress;
  outputToken: EvmAddress;
  amountIn: string;
  expectedAmountOut: string;
  minimumAmountOut: string;
  blockNumber: string | null;
  route: { source: string; from: EvmAddress; to: EvmAddress }[];
  allowance: {
    token: EvmAddress;
    spender: EvmAddress;
    amount: string;
  } | null;
  transaction: SafeCall;
  quotedAt: string;
  expiresAt: string;
  venueConfigVersion: string;
};

export type TradeQuote = VenueQuote & {
  id: string;
  companyId: string;
  agentId: string;
  wallet: EvmAddress;
  side: "BUY" | "SELL";
  asset: CanonicalStockToken;
  oracle: OraclePrice;
  estimatedPriceImpactBps: number;
  oracleDeviationBps: number;
  slippageBps: number;
  policyVersion: number;
  eligibilityVersion: number;
  status: "QUOTED" | "EXPIRED" | "CONSUMED";
};

export type TradeDecision = {
  objective: string;
  action: "BUY" | "SELL";
  asset: string;
  reasonSummary: string;
  riskChecks: string[];
  policyVersion: number;
};

export type TradeStatus =
  | "PROPOSED"
  | "QUOTED"
  | "POLICY_APPROVED"
  | "SIMULATED"
  | "SUBMITTED"
  | "PENDING"
  | "CONFIRMED"
  | "REJECTED"
  | "QUOTE_EXPIRED"
  | "SIMULATION_FAILED"
  | "REVERTED"
  | "CANCELLED";

export type Trade = {
  id: string;
  quoteId: string;
  companyId: string;
  agentId: string;
  wallet: EvmAddress;
  assetId: string;
  assetAddress: EvmAddress;
  symbol: string;
  side: "BUY" | "SELL";
  amountIn: string;
  expectedAmountOut: string;
  minimumAmountOut: string;
  venue: "0x-swap-api";
  status: TradeStatus;
  decision: TradeDecision;
  policySnapshot: TradingPolicy;
  providerCallId: string | null;
  transactionHash: EvmHash | null;
  blockNumber: string | null;
  actualAmountIn: string | null;
  actualAmountOut: string | null;
  realizedPnlUsdg: string | null;
  failureReason: string | null;
  createdAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
};

export type VerifiedTradeSettlement = {
  chainId: 4663;
  transactionHash: EvmHash;
  blockNumber: string;
  blockHash: EvmHash;
  wallet: EvmAddress;
  inputToken: EvmAddress;
  outputToken: EvmAddress;
  actualAmountIn: string;
  actualAmountOut: string;
  confirmedAt: string;
};

export type PositionLot = {
  id: string;
  companyId: string;
  assetId: string;
  assetAddress: EvmAddress;
  symbol: string;
  sourceTradeId: string;
  originalRawUnits: string;
  remainingRawUnits: string;
  originalCostUsdg: string;
  remainingCostUsdg: string;
  multiplierAtBuy: string;
  createdAt: string;
};

export type PortfolioPosition = {
  asset: CanonicalStockToken;
  rawUnits: string;
  displayUnits: string;
  onchainRawUnits: string;
  reconciled: boolean;
  costBasisUsdg: string;
  currentValueUsdg: string;
  unrealizedPnlUsdg: string;
  oracle: OraclePrice;
};

export type InvestableCapital = {
  companyId: string;
  verifiedServiceRevenue: string;
  verifiedExternalRevenue: string;
  verifiedAgentNetworkRevenue: string;
  serviceExpenses: string;
  confirmedStockPurchases: string;
  verifiedTradingProceeds: string;
  ownerCapitalIncluded: false;
  externalTransfersIncluded: false;
  unattributedTransfersIncluded: false;
  availableUsdg: string;
  source: "verified-settlement-lineage";
};

export type Portfolio = {
  state: "available";
  companyId: string;
  wallet: EvmAddress;
  chainId: 4663;
  usdgCash: string;
  ownerCapitalUsdg: string;
  unattributedTransfersUsdg: string;
  investableCapital: InvestableCapital;
  positions: PortfolioPosition[];
  stockValueUsdg: string;
  realizedPnlUsdg: string;
  unrealizedPnlUsdg: string;
  totalEconomicNetWorthUsdg: string;
  source: "robinhood-mainnet-finalized";
  blockNumber: string;
  timestamp: string;
};

export type TradingCapabilities = {
  state: "ready" | "blocked";
  chainId: 4663;
  execution: false | "configured";
  venue: TradingVenueCapabilities;
  missing: string[];
  eligibilityProvider: string | null;
  autonomousSession: boolean;
  stockTokenTrading: boolean;
};

export interface EligibilityProvider {
  capabilities(): {
    state: "ready" | "blocked";
    provider: string | null;
    missing: string[];
  };
  assess(input: {
    companyId: string;
    ownerUserId: string;
    ownerIssuer: string;
    ownerSubject: string;
  }): Promise<
    Omit<TradingEligibility, "companyId" | "ownerUserId" | "version">
  >;
}

export interface TradingAssetPort {
  capabilities(): { state: "ready" | "blocked"; missing: string[] };
  validateChain(): Promise<void>;
  canonicalUsdg(): Promise<{
    address: EvmAddress;
    decimals: number;
    blockNumber: string;
  }>;
  resolveAsset(symbol: string): Promise<CanonicalStockToken>;
  oracle(asset: CanonicalStockToken): Promise<OraclePrice>;
  tokenBalance(
    wallet: EvmAddress,
    token: EvmAddress,
  ): Promise<{
    units: string;
    blockNumber: string;
    timestamp: string;
  }>;
  allowance(
    wallet: EvmAddress,
    token: EvmAddress,
    spender: EvmAddress,
  ): Promise<string>;
  simulate(wallet: EvmAddress, calls: SafeCall[]): Promise<void>;
  verifySettlement(
    trade: Trade,
    quote: TradeQuote,
  ): Promise<VerifiedTradeSettlement>;
}

export interface TradingVenueProvider {
  capabilities(): TradingVenueCapabilities;
  quote(input: VenueQuoteRequest): Promise<VenueQuote>;
}

export interface TradingWalletPort {
  readonly available: boolean;
  readonly autonomousAvailable: boolean;
  validateSession(
    wallet: FinancialWallet,
    session: TradingSession,
    policy: TradingPolicy,
    quote: TradeQuote,
  ): Promise<void>;
  execute(
    wallet: FinancialWallet,
    session: TradingSession,
    trade: Trade,
    quote: TradeQuote,
  ): Promise<{ callId: string }>;
  status(callId: string): Promise<{
    state: "pending" | "confirmed" | "failed" | "unknown";
    transactionHash: EvmHash | null;
  }>;
  revoke(session: TradingSession): Promise<void>;
}

export type TradingClaim =
  { replay: false } | { replay: true; response: unknown };

export interface TradingRepository {
  readonly economy: EconomyRepository;
  transaction<T>(operation: (tx: TradingRepository) => Promise<T>): Promise<T>;
  lockCompany(companyId: string): Promise<void>;
  claim(
    actor: string,
    operation: string,
    key: string,
    hash: string,
  ): Promise<TradingClaim>;
  complete(
    actor: string,
    operation: string,
    key: string,
    response: unknown,
  ): Promise<void>;
  getWallet(companyId: string): Promise<FinancialWallet | null>;
  financialSummary(companyId: string): Promise<FinancialSummary>;
  getEligibility(companyId: string): Promise<TradingEligibility | null>;
  saveEligibility(value: TradingEligibility): Promise<void>;
  getPolicy(companyId: string): Promise<TradingPolicy | null>;
  savePolicy(value: TradingPolicy): Promise<void>;
  getSession(companyId: string): Promise<TradingSession | null>;
  saveSession(value: TradingSession): Promise<void>;
  getVenueConfiguration(
    version: string,
  ): Promise<TradingVenueConfiguration | null>;
  saveQuote(value: TradeQuote): Promise<void>;
  getQuote(id: string, lock?: boolean): Promise<TradeQuote | null>;
  saveTrade(value: Trade): Promise<void>;
  getTrade(id: string, lock?: boolean): Promise<Trade | null>;
  getTradeByQuote(id: string): Promise<Trade | null>;
  listTrades(companyId: string, limit: number): Promise<Trade[]>;
  dailyInvestment(companyId: string): Promise<string>;
  capital(companyId: string): Promise<InvestableCapital>;
  capitalSources(companyId: string): Promise<{
    ownerCapitalUsdg: string;
    unattributedTransfersUsdg: string;
  }>;
  lots(
    companyId: string,
    assetId?: string,
    lock?: boolean,
  ): Promise<PositionLot[]>;
  applySettlement(
    trade: Trade,
    quote: TradeQuote,
    settlement: VerifiedTradeSettlement,
  ): Promise<Trade>;
  realizedPnl(companyId: string): Promise<string>;
  audit(
    type: string,
    companyId: string | null,
    resourceId: string | null,
    actor: string,
    details?: Record<string, string>,
  ): Promise<void>;
}

export type TradingActor = FinancialActor;
