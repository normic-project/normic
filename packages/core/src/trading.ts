import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  DomainError,
  NotFoundError,
  PolicyDeniedError,
} from "./errors.js";
import { AuthorizationPipeline } from "./policy.js";
import { idempotencyKeySchema } from "./schemas.js";
import { addressSchema, positiveUnitsSchema } from "./finance-protocol.js";
import { canonicalJson } from "./finance.js";
import type { FinancialActor } from "./finance-types.js";
import type {
  CanonicalStockToken,
  EligibilityProvider,
  OraclePrice,
  Portfolio,
  PortfolioPosition,
  PositionLot,
  Trade,
  TradeDecision,
  TradeQuote,
  TradingAssetPort,
  TradingEligibility,
  TradingPolicy,
  TradingRepository,
  TradingSession,
  TradingVenueProvider,
  TradingWalletPort,
} from "./trading-types.js";

const assetIdSchema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/)
  .transform((value) => value.toLowerCase());
const symbolSchema = z.string().regex(/^[A-Z0-9.-]{1,16}$/);
const bpsSchema = z.number().int().min(0).max(10_000);
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const hashActor = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const tradingPolicySchema = z
  .object({
    companyId: z.uuid(),
    enabled: z.boolean(),
    allowBuy: z.boolean(),
    allowSell: z.boolean(),
    maxTradeUsdg: positiveUnitsSchema,
    maxDailyInvestmentUsdg: positiveUnitsSchema,
    maxTotalStockExposureUsdg: positiveUnitsSchema,
    maxPositionUsdg: positiveUnitsSchema,
    maxSlippageBps: bpsSchema.max(2_000),
    maxOracleDeviationBps: bpsSchema.max(2_000),
    maxPriceImpactBps: bpsSchema.max(2_000),
    minimumCashReserveUsdg: positiveUnitsSchema,
    allowedAssetIds: z.array(assetIdSchema).min(1).max(256),
    blockedAssetIds: z.array(assetIdSchema).max(256),
    sessionExpiresAt: z.iso.datetime(),
  })
  .strict();

export const tradeQuoteInputSchema = z
  .object({
    companyId: z.uuid(),
    symbol: symbolSchema,
    side: z.enum(["BUY", "SELL"]),
    amountIn: positiveUnitsSchema,
  })
  .strict();

export const tradeDecisionSchema = z
  .object({
    objective: z.string().trim().min(1).max(240),
    reasonSummary: z.string().trim().min(1).max(500),
    riskChecks: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
  })
  .strict();

function signed(value: bigint): string {
  return value.toString();
}

export function stockValueInUsdg(
  rawUnits: string,
  tokenDecimals: number,
  oracle: OraclePrice,
  usdgDecimals: number,
): string {
  const numerator =
    BigInt(rawUnits) * BigInt(oracle.priceUnits) * 10n ** BigInt(usdgDecimals);
  const denominator =
    10n ** BigInt(tokenDecimals) * 10n ** BigInt(oracle.decimals);
  return (numerator / denominator).toString();
}

export function deviationBps(actual: string, reference: string): number {
  const a = BigInt(actual),
    r = BigInt(reference);
  if (r <= 0n)
    throw new PolicyDeniedError("The oracle reference value is invalid.");
  const difference = a >= r ? a - r : r - a;
  const result = (difference * 10_000n) / r;
  return Number(result > 10_000n ? 10_000n : result);
}

function effectiveEligibility(value: TradingEligibility | null) {
  if (!value) return null;
  if (
    value.state === "ELIGIBLE" &&
    (!value.expiresAt || new Date(value.expiresAt) <= new Date())
  )
    return { ...value, state: "EXPIRED" as const };
  return value;
}

export class TradingService {
  private readonly auth = new AuthorizationPipeline();

  constructor(
    readonly repository: TradingRepository,
    readonly assets: TradingAssetPort,
    readonly venue: TradingVenueProvider,
    readonly eligibilityProvider: EligibilityProvider,
    readonly wallets: TradingWalletPort,
    private readonly eventSink?: (event: {
      name: string;
      resourceId: string | null;
    }) => void,
  ) {}

  capabilities() {
    const venue = this.venue.capabilities(),
      assets = this.assets.capabilities(),
      eligibility = this.eligibilityProvider.capabilities();
    const missing = [
      ...venue.missing,
      ...assets.missing,
      ...eligibility.missing,
      ...(!this.wallets.available ? ["ALCHEMY_API_KEY"] : []),
      ...(!this.wallets.autonomousAvailable
        ? ["reviewed TradingSessionCustodian integration"]
        : []),
    ];
    return {
      state: missing.length === 0 ? "ready" : "blocked",
      chainId: 4663,
      execution: missing.length === 0 ? "configured" : false,
      venue,
      missing: [...new Set(missing)],
      eligibilityProvider: eligibility.provider,
      autonomousSession: this.wallets.autonomousAvailable,
      stockTokenTrading: missing.length === 0,
    } as const;
  }

  private actorId(actor: FinancialActor) {
    return actor.kind === "agent"
      ? `agent:${actor.context.principal.agentId}`
      : actor.kind === "owner"
        ? `owner:${hashActor(`${actor.owner.issuer}|${actor.owner.subject}`)}`
        : `human:${actor.wallet.toLowerCase()}`;
  }

  private async authorize(
    repository: TradingRepository,
    actor: FinancialActor,
    companyId: string,
    scope: "portfolio:read" | "portfolio:trade",
  ) {
    if (actor.kind === "agent") {
      await this.auth.assert(repository.economy, actor.context, {
        scope,
        companyId,
        ...(scope === "portfolio:trade" ? { action: "asset:trade" } : {}),
      });
      const credential = await repository.economy.getCredential(
        actor.context.principal.credentialId,
      );
      if (
        !credential ||
        credential.agentId !== actor.context.principal.agentId ||
        credential.revokedAt ||
        (credential.expiresAt && credential.expiresAt <= new Date()) ||
        !credential.scopes.includes(scope)
      )
        throw new AuthenticationError();
      return;
    }
    if (actor.kind === "human")
      throw new AuthorizationError(
        "A wallet buyer session cannot manage an agent portfolio.",
      );
    const company = await repository.economy.getCompany(companyId),
      owner = company
        ? await repository.economy.getUser(company.ownerUserId)
        : null;
    if (
      !company ||
      !owner ||
      owner.authIssuer !== actor.owner.issuer ||
      owner.authSubject !== actor.owner.subject
    )
      throw new AuthorizationError(
        "The verified owner does not own this company.",
      );
  }

  private async auditDenied(
    actor: FinancialActor,
    companyId: string,
    error: unknown,
  ) {
    if (
      error instanceof AuthorizationError ||
      error instanceof PolicyDeniedError
    ) {
      await this.repository.audit(
        "stock_trade_policy_rejected",
        companyId,
        null,
        this.actorId(actor),
      );
      this.eventSink?.({ name: "trade_policy_rejected", resourceId: null });
    }
  }

  async getEligibility(actor: FinancialActor, companyId: string) {
    z.uuid().parse(companyId);
    await this.authorize(this.repository, actor, companyId, "portfolio:read");
    return (
      effectiveEligibility(await this.repository.getEligibility(companyId)) ?? {
        companyId,
        state: "UNKNOWN" as const,
        provider: null,
        reasonCode: "eligibility_not_verified",
      }
    );
  }

  async refreshEligibility(
    actor: FinancialActor,
    companyId: string,
    key: string,
  ) {
    if (actor.kind !== "owner")
      throw new AuthorizationError(
        "Only a verified human owner can refresh trading eligibility.",
      );
    idempotencyKeySchema.parse(key);
    try {
      return await this.repository.transaction(async (repository) => {
        await this.authorize(repository, actor, companyId, "portfolio:read");
        await repository.lockCompany(companyId);
        const claim = await repository.claim(
          this.actorId(actor),
          "trading.eligibility_refreshed",
          key,
          digest({ companyId }),
        );
        if (claim.replay) return claim.response as TradingEligibility;
        const capability = this.eligibilityProvider.capabilities();
        if (capability.state !== "ready")
          throw new DomainError(
            "A production-grade owner eligibility provider is not configured.",
            "TRADING_UNAVAILABLE",
          );
        const company = await repository.economy.getCompany(companyId),
          owner = company
            ? await repository.economy.getUser(company.ownerUserId)
            : null;
        if (!company || !owner?.authIssuer || !owner.authSubject)
          throw new AuthorizationError("Verified owner identity is required.");
        const previous = await repository.getEligibility(companyId),
          assessment = await this.eligibilityProvider.assess({
            companyId,
            ownerUserId: owner.id,
            ownerIssuer: owner.authIssuer,
            ownerSubject: owner.authSubject,
          }),
          value: TradingEligibility = {
            ...assessment,
            companyId,
            ownerUserId: owner.id,
            version: (previous?.version ?? 0) + 1,
          };
        await repository.saveEligibility(value);
        await repository.audit(
          "trading.eligibility_refreshed",
          companyId,
          null,
          this.actorId(actor),
          { state: value.state, rulesVersion: value.rulesVersion ?? "none" },
        );
        await repository.complete(
          this.actorId(actor),
          "trading.eligibility_refreshed",
          key,
          value,
        );
        return value;
      });
    } catch (error) {
      await this.auditDenied(actor, companyId, error);
      throw error;
    }
  }

  async getPolicy(actor: FinancialActor, companyId: string) {
    await this.authorize(this.repository, actor, companyId, "portfolio:read");
    return {
      policy: await this.repository.getPolicy(companyId),
      session: await this.repository.getSession(companyId),
      eligibility: await this.getEligibility(actor, companyId),
      capabilities: this.capabilities(),
    };
  }

  async updatePolicy(
    actor: FinancialActor,
    raw: z.input<typeof tradingPolicySchema>,
    key: string,
  ) {
    if (actor.kind !== "owner")
      throw new AuthorizationError(
        "Agent credentials cannot enable or change autonomous trading.",
      );
    const input = tradingPolicySchema.parse(raw);
    if (
      new Set(input.allowedAssetIds).size !== input.allowedAssetIds.length ||
      new Set(input.blockedAssetIds).size !== input.blockedAssetIds.length ||
      input.allowedAssetIds.some((id) => input.blockedAssetIds.includes(id))
    )
      throw new DomainError(
        "Trading asset allowlists and blocklists must be unique and disjoint.",
        "INVALID_INPUT",
      );
    if (new Date(input.sessionExpiresAt) <= new Date())
      throw new PolicyDeniedError(
        "Trading policy expiry must be in the future.",
      );
    idempotencyKeySchema.parse(key);
    return this.repository.transaction(async (repository) => {
      await this.authorize(
        repository,
        actor,
        input.companyId,
        "portfolio:read",
      );
      await repository.lockCompany(input.companyId);
      const claim = await repository.claim(
        this.actorId(actor),
        "trading.policy_changed",
        key,
        digest(input),
      );
      if (claim.replay) return claim.response as TradingPolicy;
      const eligibility = effectiveEligibility(
        await repository.getEligibility(input.companyId),
      );
      if (input.enabled && eligibility?.state !== "ELIGIBLE")
        throw new PolicyDeniedError(
          "Trading cannot be enabled without current owner eligibility.",
        );
      const previous = await repository.getPolicy(input.companyId),
        policy: TradingPolicy = {
          ...input,
          allowedAssetIds: [...new Set(input.allowedAssetIds)].sort(),
          blockedAssetIds: [...new Set(input.blockedAssetIds)].sort(),
          version: (previous?.version ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        };
      await repository.savePolicy(policy);
      const session = await repository.getSession(input.companyId);
      if (session && session.policyVersion !== policy.version) {
        await repository.saveSession({
          ...session,
          revokedAt: new Date().toISOString(),
        });
      }
      await repository.audit(
        policy.enabled ? "trading.policy_enabled" : "trading.paused",
        input.companyId,
        null,
        this.actorId(actor),
        { policyVersion: String(policy.version) },
      );
      await repository.complete(
        this.actorId(actor),
        "trading.policy_changed",
        key,
        policy,
      );
      return policy;
    });
  }

  async registerSession(
    actor: FinancialActor,
    input: {
      companyId: string;
      publicKey: string;
      providerSessionId: string;
      authorizationRef: string;
    },
    key: string,
  ) {
    if (actor.kind !== "owner")
      throw new AuthorizationError(
        "Only a verified owner can register a trading session.",
      );
    idempotencyKeySchema.parse(key);
    const parsed = {
      companyId: z.uuid().parse(input.companyId),
      publicKey: addressSchema.parse(input.publicKey),
      providerSessionId: z
        .string()
        .min(1)
        .max(256)
        .parse(input.providerSessionId),
      authorizationRef: z
        .string()
        .min(1)
        .max(256)
        .parse(input.authorizationRef),
    };
    return this.repository.transaction(async (repository) => {
      await this.authorize(
        repository,
        actor,
        parsed.companyId,
        "portfolio:read",
      );
      await repository.lockCompany(parsed.companyId);
      const claim = await repository.claim(
        this.actorId(actor),
        "trading.session_registered",
        key,
        digest(parsed),
      );
      if (claim.replay) return claim.response as TradingSession;
      const wallet = await repository.getWallet(parsed.companyId),
        policy = await repository.getPolicy(parsed.companyId),
        eligibility = effectiveEligibility(
          await repository.getEligibility(parsed.companyId),
        );
      if (!wallet || !policy?.enabled || eligibility?.state !== "ELIGIBLE")
        throw new PolicyDeniedError(
          "An eligible owner, connected wallet, and enabled trading policy are required.",
        );
      if (parsed.publicKey === wallet.ownerAddress.toLowerCase())
        throw new PolicyDeniedError(
          "The trading session key cannot be the owner root key.",
        );
      const old = await repository.getSession(parsed.companyId);
      if (old)
        await repository.saveSession({
          ...old,
          revokedAt: new Date().toISOString(),
        });
      const session: TradingSession = {
        id: randomUUID(),
        companyId: parsed.companyId,
        publicKey: parsed.publicKey,
        providerSessionId: parsed.providerSessionId,
        authorizationRef: parsed.authorizationRef,
        expiresAt: policy.sessionExpiresAt,
        policyVersion: policy.version,
        revokedAt: null,
        createdAt: new Date().toISOString(),
      };
      await repository.saveSession(session);
      await repository.audit(
        "trading.session_registered",
        parsed.companyId,
        session.id,
        this.actorId(actor),
      );
      await repository.complete(
        this.actorId(actor),
        "trading.session_registered",
        key,
        session,
      );
      return session;
    });
  }

  async revokeSession(actor: FinancialActor, companyId: string, key: string) {
    if (actor.kind !== "owner")
      throw new AuthorizationError(
        "Only a verified owner can revoke the trading session.",
      );
    idempotencyKeySchema.parse(key);
    return this.repository.transaction(async (repository) => {
      await this.authorize(repository, actor, companyId, "portfolio:read");
      await repository.lockCompany(companyId);
      const claim = await repository.claim(
        this.actorId(actor),
        "trading.session_revoked",
        key,
        digest({ companyId }),
      );
      if (claim.replay) return claim.response;
      const session = await repository.getSession(companyId);
      if (session && !session.revokedAt) {
        const revoked = { ...session, revokedAt: new Date().toISOString() };
        await repository.saveSession(revoked);
        try {
          await this.wallets.revoke(revoked);
        } catch {
          // Local revocation is immediate. The owner must complete provider/onchain revocation.
        }
      }
      const result = {
        companyId,
        locallyRevoked: true,
        ownerOnchainActionRequired: true,
      };
      await repository.audit(
        "trading.session_revoked",
        companyId,
        session?.id ?? null,
        this.actorId(actor),
      );
      await repository.complete(
        this.actorId(actor),
        "trading.session_revoked",
        key,
        result,
      );
      return result;
    });
  }

  private async activeControls(
    repository: TradingRepository,
    actor: FinancialActor,
    companyId: string,
    side: "BUY" | "SELL",
  ) {
    await this.authorize(repository, actor, companyId, "portfolio:trade");
    if (actor.kind !== "agent")
      throw new AuthorizationError(
        "Autonomous trades must be initiated by a scoped agent credential.",
      );
    const wallet = await repository.getWallet(companyId),
      policy = await repository.getPolicy(companyId),
      session = await repository.getSession(companyId),
      eligibility = effectiveEligibility(
        await repository.getEligibility(companyId),
      );
    if (!wallet)
      throw new PolicyDeniedError(
        "A verified company smart wallet is required.",
      );
    if (
      !policy?.enabled ||
      (side === "BUY" ? !policy.allowBuy : !policy.allowSell) ||
      new Date(policy.sessionExpiresAt) <= new Date()
    )
      throw new PolicyDeniedError(
        "Autonomous trading is disabled or the requested side is not permitted.",
      );
    if (eligibility?.state !== "ELIGIBLE") {
      this.eventSink?.({ name: "trade_blocked_eligibility", resourceId: null });
      throw new PolicyDeniedError(
        `Owner trading eligibility is ${eligibility?.state ?? "UNKNOWN"}.`,
      );
    }
    if (
      !session ||
      session.revokedAt ||
      session.policyVersion !== policy.version ||
      new Date(session.expiresAt) <= new Date()
    )
      throw new PolicyDeniedError(
        "A current, separate owner-authorized trading session is required.",
      );
    if (this.capabilities().state !== "ready")
      throw new DomainError(
        "Stock Token execution is blocked by incomplete production configuration.",
        "TRADING_UNAVAILABLE",
      );
    const venue = this.venue.capabilities(),
      configured = venue.configVersion
        ? await repository.getVenueConfiguration(venue.configVersion)
        : null,
      normalized = (values: string[]) =>
        [...values].map((value) => value.toLowerCase()).sort(),
      same = (left: string[], right: string[]) =>
        JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
    if (
      !configured?.active ||
      configured.chainId !== venue.chainId ||
      configured.venue !== venue.venue ||
      !same(configured.allowedTargets, venue.allowedTargets) ||
      !same(configured.allowedSpenders, venue.allowedSpenders) ||
      !same(configured.allowedSources, venue.allowedSources)
    )
      throw new DomainError(
        "The deployment venue configuration is not backed by the active audited database allowlist.",
        "TRADING_UNAVAILABLE",
      );
    return { wallet, policy, session, eligibility };
  }

  private validateAssetPolicy(
    policy: TradingPolicy,
    asset: CanonicalStockToken,
    side: "BUY" | "SELL",
  ) {
    if (
      !policy.allowedAssetIds.includes(asset.assetId) ||
      policy.blockedAssetIds.includes(asset.assetId)
    )
      throw new PolicyDeniedError(
        "The canonical asset is not owner-allowlisted.",
      );
    if (asset.status !== "ASSET_STATUS_ACTIVE")
      throw new PolicyDeniedError("The Stock Token is not active.");
    if (asset.tradingHalt || asset.oraclePaused) {
      this.eventSink?.({
        name: "trade_blocked_halt",
        resourceId: asset.assetId,
      });
      throw new PolicyDeniedError(
        `${side} is blocked while trading or the oracle is paused.`,
      );
    }
  }

  private validateMarketRisk(
    policy: TradingPolicy,
    quote: Pick<
      TradeQuote,
      "slippageBps" | "oracleDeviationBps" | "estimatedPriceImpactBps"
    >,
  ) {
    if (quote.slippageBps > policy.maxSlippageBps) {
      this.eventSink?.({ name: "trade_blocked_slippage", resourceId: null });
      throw new PolicyDeniedError("Quote slippage exceeds the owner policy.");
    }
    if (quote.oracleDeviationBps > policy.maxOracleDeviationBps) {
      this.eventSink?.({ name: "trade_blocked_oracle", resourceId: null });
      throw new PolicyDeniedError(
        "Execution quote deviates too far from the oracle.",
      );
    }
    if (quote.estimatedPriceImpactBps > policy.maxPriceImpactBps)
      throw new PolicyDeniedError(
        "Estimated price impact exceeds the owner policy.",
      );
  }

  private async revalidateBeforeBroadcast(
    actor: FinancialActor,
    trade: Trade,
    quote: TradeQuote,
    expected: {
      wallet: { address: string };
      policy: TradingPolicy;
      session: TradingSession;
      eligibility: TradingEligibility;
    },
  ) {
    const controls = await this.activeControls(
      this.repository,
      actor,
      trade.companyId,
      trade.side,
    );
    if (
      controls.wallet.address !== expected.wallet.address ||
      controls.policy.version !== expected.policy.version ||
      controls.session.id !== expected.session.id ||
      controls.eligibility.version !== expected.eligibility.version ||
      new Date(quote.expiresAt) <= new Date()
    )
      throw new PolicyDeniedError(
        "Trading controls or the firm quote changed before broadcast.",
      );
    await this.assets.validateChain();
    const asset = await this.assets.resolveAsset(quote.asset.symbol);
    if (
      asset.assetId !== quote.asset.assetId ||
      asset.address !== quote.asset.address
    )
      throw new PolicyDeniedError("Canonical asset identity changed.");
    this.validateAssetPolicy(controls.policy, asset, trade.side);
    const oracle = await this.assets.oracle(asset),
      usdg = await this.assets.canonicalUsdg(),
      stockUnits =
        trade.side === "BUY" ? quote.expectedAmountOut : quote.amountIn,
      quoteUsdg =
        trade.side === "BUY" ? quote.amountIn : quote.expectedAmountOut,
      reference = stockValueInUsdg(
        stockUnits,
        asset.decimals,
        oracle,
        usdg.decimals,
      );
    this.validateMarketRisk(controls.policy, {
      ...quote,
      oracleDeviationBps: deviationBps(quoteUsdg, reference),
      estimatedPriceImpactBps: deviationBps(quoteUsdg, reference),
    });
    await this.wallets.validateSession(
      controls.wallet,
      controls.session,
      controls.policy,
      quote,
    );
    if (quote.allowance) {
      const allowance = await this.assets.allowance(
        controls.wallet.address,
        quote.allowance.token,
        quote.allowance.spender,
      );
      if (allowance !== quote.allowance.amount)
        throw new DomainError(
          "The exact token allowance changed before broadcast.",
          "OWNER_ACTION_REQUIRED",
        );
    }
  }

  private async positionValue(
    repository: TradingRepository,
    companyId: string,
    assetId?: string,
  ) {
    const usdg = await this.assets.canonicalUsdg(),
      lots = await repository.lots(companyId, assetId),
      groups = new Map<string, PositionLot[]>();
    for (const lot of lots)
      groups.set(lot.assetId, [...(groups.get(lot.assetId) ?? []), lot]);
    let total = 0n,
      selected = 0n;
    for (const [id, values] of groups) {
      const asset = await this.assets.resolveAsset(values[0]!.symbol);
      if (asset.assetId !== id || asset.address !== values[0]!.assetAddress)
        throw new DomainError(
          "Canonical asset registry changed unexpectedly.",
          "TRADING_UNAVAILABLE",
        );
      const oracle = await this.assets.oracle(asset),
        units = values.reduce(
          (sum, lot) => sum + BigInt(lot.remainingRawUnits),
          0n,
        ),
        value = BigInt(
          stockValueInUsdg(
            units.toString(),
            asset.decimals,
            oracle,
            usdg.decimals,
          ),
        );
      total += value;
      if (id === assetId) selected = value;
    }
    return { total, selected };
  }

  async quote(
    actor: FinancialActor,
    raw: z.input<typeof tradeQuoteInputSchema>,
    key: string,
  ) {
    const input = tradeQuoteInputSchema.parse(raw);
    idempotencyKeySchema.parse(key);
    try {
      return await this.repository.transaction(async (repository) => {
        const controls = await this.activeControls(
          repository,
          actor,
          input.companyId,
          input.side,
        );
        await repository.lockCompany(input.companyId);
        const claim = await repository.claim(
          this.actorId(actor),
          "stock_trade_quote_created",
          key,
          digest(input),
        );
        if (claim.replay) return claim.response as TradeQuote;
        await this.assets.validateChain();
        const asset = await this.assets.resolveAsset(input.symbol);
        this.validateAssetPolicy(controls.policy, asset, input.side);
        const usdg = await this.assets.canonicalUsdg(),
          venueQuote = await this.venue.quote({
            wallet: controls.wallet.address,
            owner: controls.wallet.ownerAddress,
            side: input.side,
            asset,
            usdg: { address: usdg.address, decimals: usdg.decimals },
            amountIn: input.amountIn,
            slippageBps: controls.policy.maxSlippageBps,
          }),
          oracle = await this.assets.oracle(asset);
        const quoteUsdg =
            input.side === "BUY"
              ? input.amountIn
              : venueQuote.expectedAmountOut,
          stockUnits =
            input.side === "BUY"
              ? venueQuote.expectedAmountOut
              : input.amountIn,
          oracleUsdg = stockValueInUsdg(
            stockUnits,
            asset.decimals,
            oracle,
            usdg.decimals,
          ),
          deviation = deviationBps(quoteUsdg, oracleUsdg);
        const quote: TradeQuote = {
          ...venueQuote,
          id: randomUUID(),
          companyId: input.companyId,
          agentId:
            actor.kind === "agent" ? actor.context.principal.agentId : "",
          wallet: controls.wallet.address,
          side: input.side,
          asset,
          oracle,
          estimatedPriceImpactBps: deviation,
          oracleDeviationBps: deviation,
          slippageBps: controls.policy.maxSlippageBps,
          policyVersion: controls.policy.version,
          eligibilityVersion: controls.eligibility.version,
          status: "QUOTED",
        };
        this.validateMarketRisk(controls.policy, quote);
        const tradeUsdg = BigInt(quoteUsdg);
        if (tradeUsdg > BigInt(controls.policy.maxTradeUsdg))
          throw new PolicyDeniedError(
            "Trade exceeds the owner per-trade limit.",
          );
        if (input.side === "BUY") {
          const capital = await repository.capital(input.companyId),
            cash = await this.assets.tokenBalance(
              controls.wallet.address,
              usdg.address,
            ),
            daily = await repository.dailyInvestment(input.companyId),
            exposure = await this.positionValue(
              repository,
              input.companyId,
              asset.assetId,
            ),
            proposedValue = BigInt(oracleUsdg);
          if (BigInt(capital.availableUsdg) < BigInt(input.amountIn))
            throw new PolicyDeniedError(
              "Only verified earned capital may fund autonomous investments.",
            );
          if (
            BigInt(cash.units) <
            BigInt(input.amountIn) +
              BigInt(controls.policy.minimumCashReserveUsdg)
          )
            throw new PolicyDeniedError(
              "The trade would breach the configured cash reserve.",
            );
          if (
            BigInt(daily) + BigInt(input.amountIn) >
            BigInt(controls.policy.maxDailyInvestmentUsdg)
          )
            throw new PolicyDeniedError(
              "The trade would exceed the daily investment limit.",
            );
          if (
            exposure.total + proposedValue >
              BigInt(controls.policy.maxTotalStockExposureUsdg) ||
            exposure.selected + proposedValue >
              BigInt(controls.policy.maxPositionUsdg)
          )
            throw new PolicyDeniedError(
              "The trade would exceed portfolio or position exposure limits.",
            );
        } else {
          const lots = await repository.lots(input.companyId, asset.assetId);
          const held = lots.reduce(
            (sum, lot) => sum + BigInt(lot.remainingRawUnits),
            0n,
          );
          if (held < BigInt(input.amountIn))
            throw new PolicyDeniedError(
              "The confirmed earned-capital position is insufficient.",
            );
        }
        await this.wallets.validateSession(
          controls.wallet,
          controls.session,
          controls.policy,
          quote,
        );
        await repository.saveQuote(quote);
        await repository.audit(
          "stock_trade_quote_created",
          input.companyId,
          quote.id,
          this.actorId(actor),
          {
            side: quote.side,
            assetId: asset.assetId,
            venue: quote.venue,
          },
        );
        await repository.complete(
          this.actorId(actor),
          "stock_trade_quote_created",
          key,
          quote,
        );
        this.eventSink?.({ name: "trade_quote_created", resourceId: quote.id });
        return quote;
      });
    } catch (error) {
      await this.auditDenied(actor, input.companyId, error);
      throw error;
    }
  }

  private async prepareTrade(
    actor: FinancialActor,
    quoteId: string,
    rawDecision: z.input<typeof tradeDecisionSchema>,
    side: "BUY" | "SELL",
    key: string,
  ) {
    idempotencyKeySchema.parse(key);
    z.uuid().parse(quoteId);
    const decisionInput = tradeDecisionSchema.parse(rawDecision);
    const prepared = await this.repository.transaction(async (repository) => {
      const quote = await repository.getQuote(quoteId, true);
      if (!quote) throw new NotFoundError("Trade quote");
      await this.authorize(
        repository,
        actor,
        quote.companyId,
        "portfolio:trade",
      );
      if (actor.kind !== "agent")
        throw new AuthorizationError(
          "Autonomous trades must be initiated by a scoped agent credential.",
        );
      await repository.lockCompany(quote.companyId);
      if (
        quote.status === "QUOTED" &&
        new Date(quote.expiresAt) <= new Date()
      ) {
        quote.status = "EXPIRED";
        await repository.saveQuote(quote);
        await repository.audit(
          "stock_trade_quote_expired",
          quote.companyId,
          quote.id,
          this.actorId(actor),
        );
        return { expired: true as const, quoteId: quote.id };
      }
      const claim = await repository.claim(
        this.actorId(actor),
        `stock_trade_${side.toLowerCase()}`,
        key,
        digest({ quoteId, decisionInput, side }),
      );
      if (claim.replay)
        return { replay: true as const, trade: claim.response as Trade };
      const existing = await repository.getTradeByQuote(quoteId);
      if (existing)
        throw new ConflictError("This quote has already created a trade.");
      if (quote.side !== side || quote.status !== "QUOTED")
        throw new PolicyDeniedError("The quote cannot be used for this trade.");
      const controls = await this.activeControls(
        repository,
        actor,
        quote.companyId,
        side,
      );
      if (
        controls.policy.version !== quote.policyVersion ||
        controls.eligibility.version !== quote.eligibilityVersion ||
        this.venue.capabilities().configVersion !== quote.venueConfigVersion
      )
        throw new PolicyDeniedError(
          "Policy, eligibility, or venue configuration changed after quoting.",
        );
      const asset = await this.assets.resolveAsset(quote.asset.symbol);
      if (
        asset.assetId !== quote.asset.assetId ||
        asset.address !== quote.asset.address
      )
        throw new PolicyDeniedError("Canonical asset identity changed.");
      this.validateAssetPolicy(controls.policy, asset, side);
      const oracle = await this.assets.oracle(asset),
        usdg = await this.assets.canonicalUsdg(),
        stockUnits = side === "BUY" ? quote.expectedAmountOut : quote.amountIn,
        quoteUsdg = side === "BUY" ? quote.amountIn : quote.expectedAmountOut,
        reference = stockValueInUsdg(
          stockUnits,
          asset.decimals,
          oracle,
          usdg.decimals,
        ),
        currentDeviation = deviationBps(quoteUsdg, reference);
      this.validateMarketRisk(controls.policy, {
        ...quote,
        oracleDeviationBps: currentDeviation,
        estimatedPriceImpactBps: currentDeviation,
      });
      await this.wallets.validateSession(
        controls.wallet,
        controls.session,
        controls.policy,
        quote,
      );
      if (quote.allowance) {
        const allowance = await this.assets.allowance(
          controls.wallet.address,
          quote.allowance.token,
          quote.allowance.spender,
        );
        if (allowance !== quote.allowance.amount)
          throw new DomainError(
            "An exact owner-approved token allowance is required before autonomous execution.",
            "OWNER_ACTION_REQUIRED",
          );
      }
      const now = new Date().toISOString(),
        decision: TradeDecision = {
          ...decisionInput,
          action: side,
          asset: quote.asset.symbol,
          policyVersion: controls.policy.version,
        },
        trade: Trade = {
          id: randomUUID(),
          quoteId: quote.id,
          companyId: quote.companyId,
          agentId: quote.agentId,
          wallet: quote.wallet,
          assetId: quote.asset.assetId,
          assetAddress: quote.asset.address,
          symbol: quote.asset.symbol,
          side,
          amountIn: quote.amountIn,
          expectedAmountOut: quote.expectedAmountOut,
          minimumAmountOut: quote.minimumAmountOut,
          venue: quote.venue,
          status: "POLICY_APPROVED",
          decision,
          policySnapshot: controls.policy,
          providerCallId: null,
          transactionHash: null,
          blockNumber: null,
          actualAmountIn: null,
          actualAmountOut: null,
          realizedPnlUsdg: null,
          failureReason: null,
          createdAt: now,
          submittedAt: null,
          confirmedAt: null,
        };
      quote.status = "CONSUMED";
      await repository.saveQuote(quote);
      await repository.saveTrade(trade);
      await repository.audit(
        "stock_trade_proposed",
        trade.companyId,
        trade.id,
        this.actorId(actor),
        {
          side,
          assetId: trade.assetId,
          policyVersion: String(controls.policy.version),
        },
      );
      this.eventSink?.({ name: "trade_proposed", resourceId: trade.id });
      return {
        replay: false as const,
        trade,
        quote,
        wallet: controls.wallet,
        policy: controls.policy,
        session: controls.session,
        eligibility: controls.eligibility,
      };
    });
    if (prepared.expired === true) {
      this.eventSink?.({
        name: "trade_quote_expired",
        resourceId: prepared.quoteId ?? null,
      });
      throw new PolicyDeniedError("The firm quote has expired.");
    }
    return prepared;
  }

  async execute(
    actor: FinancialActor,
    quoteId: string,
    decision: z.input<typeof tradeDecisionSchema>,
    side: "BUY" | "SELL",
    key: string,
  ) {
    let prepared;
    try {
      prepared = await this.prepareTrade(actor, quoteId, decision, side, key);
    } catch (error) {
      throw error;
    }
    if (prepared.replay) return prepared.trade;
    let trade = prepared.trade;
    try {
      await this.assets.simulate(trade.wallet, [prepared.quote.transaction]);
      trade = { ...trade, status: "SIMULATED" };
      await this.repository.saveTrade(trade);
    } catch {
      trade = {
        ...trade,
        status: "SIMULATION_FAILED",
        failureReason: "transaction_simulation_failed",
      };
      await this.repository.transaction(async (repository) => {
        await repository.saveTrade(trade);
        await repository.audit(
          "stock_trade_simulation_failed",
          trade.companyId,
          trade.id,
          this.actorId(actor),
        );
        await repository.complete(
          this.actorId(actor),
          `stock_trade_${side.toLowerCase()}`,
          key,
          trade,
        );
      });
      this.eventSink?.({
        name: "trade_simulation_failed",
        resourceId: trade.id,
      });
      return trade;
    }
    try {
      await this.revalidateBeforeBroadcast(
        actor,
        trade,
        prepared.quote,
        prepared,
      );
    } catch {
      trade = {
        ...trade,
        status: "REJECTED",
        failureReason: "pre_broadcast_revalidation_failed",
      };
      await this.repository.transaction(async (repository) => {
        await repository.saveTrade(trade);
        await repository.audit(
          "stock_trade_pre_broadcast_rejected",
          trade.companyId,
          trade.id,
          this.actorId(actor),
        );
        await repository.complete(
          this.actorId(actor),
          `stock_trade_${side.toLowerCase()}`,
          key,
          trade,
        );
      });
      this.eventSink?.({ name: "trade_policy_rejected", resourceId: trade.id });
      return trade;
    }
    trade = {
      ...trade,
      status: "PENDING",
      submittedAt: new Date().toISOString(),
    };
    await this.repository.saveTrade(trade);
    try {
      const result = await this.wallets.execute(
        prepared.wallet,
        prepared.session,
        trade,
        prepared.quote,
      );
      trade = { ...trade, providerCallId: result.callId };
      await this.repository.saveTrade(trade);
      this.eventSink?.({ name: "trade_submitted", resourceId: trade.id });
    } catch {
      trade = {
        ...trade,
        failureReason: "broadcast_status_unknown_do_not_retry",
      };
      await this.repository.saveTrade(trade);
    }
    await this.repository.complete(
      this.actorId(actor),
      `stock_trade_${side.toLowerCase()}`,
      key,
      trade,
    );
    return trade;
  }

  async reconcile(actor: FinancialActor, tradeId: string, key: string) {
    z.uuid().parse(tradeId);
    idempotencyKeySchema.parse(key);
    const operation = "stock_trade_reconciled",
      initial = await this.repository.getTrade(tradeId);
    if (!initial) throw new NotFoundError("Trade");
    await this.authorize(
      this.repository,
      actor,
      initial.companyId,
      "portfolio:trade",
    );
    const claimed = await this.repository.transaction(async (repository) => {
      await repository.lockCompany(initial.companyId);
      const trade = await repository.getTrade(tradeId, true);
      if (!trade) throw new NotFoundError("Trade");
      const claim = await repository.claim(
        this.actorId(actor),
        operation,
        key,
        digest({ tradeId }),
      );
      if (claim.replay)
        return { replay: true as const, trade: claim.response as Trade };
      if (
        !["CONFIRMED", "REVERTED", "REJECTED", "CANCELLED"].includes(
          trade.status,
        ) &&
        !trade.providerCallId
      )
        throw new DomainError(
          "Broadcast status is unknown and has no provider call ID; manual investigation is required.",
          "TRADING_UNAVAILABLE",
        );
      return { replay: false as const, trade };
    });
    if (claimed.replay) return claimed.trade;
    const trade = claimed.trade;
    if (
      ["CONFIRMED", "REVERTED", "REJECTED", "CANCELLED"].includes(trade.status)
    ) {
      await this.repository.complete(
        this.actorId(actor),
        operation,
        key,
        trade,
      );
      return trade;
    }
    const providerCallId = trade.providerCallId;
    if (!providerCallId)
      throw new DomainError(
        "Broadcast status is unknown and has no provider call ID; manual investigation is required.",
        "TRADING_UNAVAILABLE",
      );
    const status = await this.wallets.status(providerCallId);
    if (status.state === "pending" || status.state === "unknown") {
      await this.repository.complete(
        this.actorId(actor),
        operation,
        key,
        trade,
      );
      return trade;
    }
    if (status.state === "failed" || !status.transactionHash) {
      const failed = {
        ...trade,
        status: "REVERTED" as const,
        failureReason: "wallet_provider_reported_failure",
      };
      await this.repository.transaction(async (repository) => {
        await repository.saveTrade(failed);
        await repository.complete(this.actorId(actor), operation, key, failed);
      });
      this.eventSink?.({ name: "trade_reverted", resourceId: trade.id });
      return failed;
    }
    const quote = await this.repository.getQuote(trade.quoteId);
    if (!quote) throw new NotFoundError("Trade quote");
    const candidate = { ...trade, transactionHash: status.transactionHash };
    const settlement = await this.assets.verifySettlement(candidate, quote);
    const confirmed = await this.repository.transaction(async (repository) => {
      await repository.lockCompany(trade.companyId);
      const current = await repository.getTrade(trade.id, true);
      if (!current) throw new NotFoundError("Trade");
      if (current.status === "CONFIRMED") return current;
      const applied = await repository.applySettlement(
        { ...current, transactionHash: status.transactionHash },
        quote,
        settlement,
      );
      await repository.audit(
        "stock_trade_confirmed",
        applied.companyId,
        applied.id,
        this.actorId(actor),
        { transactionHash: settlement.transactionHash },
      );
      await repository.complete(this.actorId(actor), operation, key, applied);
      return applied;
    });
    this.eventSink?.({ name: "trade_confirmed", resourceId: trade.id });
    return confirmed;
  }

  async getTrade(actor: FinancialActor, tradeId: string) {
    z.uuid().parse(tradeId);
    const trade = await this.repository.getTrade(tradeId);
    if (!trade) throw new NotFoundError("Trade");
    await this.authorize(
      this.repository,
      actor,
      trade.companyId,
      "portfolio:read",
    );
    return trade;
  }

  async getTrades(actor: FinancialActor, companyId: string, limit = 50) {
    await this.authorize(this.repository, actor, companyId, "portfolio:read");
    return this.repository.listTrades(
      companyId,
      z.number().int().min(1).max(100).parse(limit),
    );
  }

  async getInvestableCapital(actor: FinancialActor, companyId: string) {
    await this.authorize(this.repository, actor, companyId, "portfolio:read");
    return this.repository.capital(companyId);
  }

  private async buildPortfolio(
    actor: FinancialActor,
    companyId: string,
  ): Promise<Portfolio> {
    await this.authorize(this.repository, actor, companyId, "portfolio:read");
    const wallet = await this.repository.getWallet(companyId);
    if (!wallet)
      throw new DomainError(
        "No verified company smart wallet is connected.",
        "TRADING_UNAVAILABLE",
      );
    const usdg = await this.assets.canonicalUsdg(),
      cash = await this.assets.tokenBalance(wallet.address, usdg.address),
      lots = await this.repository.lots(companyId),
      groups = new Map<string, PositionLot[]>();
    for (const lot of lots)
      groups.set(lot.assetId, [...(groups.get(lot.assetId) ?? []), lot]);
    const positions: PortfolioPosition[] = [];
    for (const [assetId, values] of groups) {
      const asset = await this.assets.resolveAsset(values[0]!.symbol);
      if (
        asset.assetId !== assetId ||
        asset.address !== values[0]!.assetAddress
      )
        throw new DomainError(
          "Portfolio asset no longer matches the canonical registry.",
          "TRADING_UNAVAILABLE",
        );
      const oracle = await this.assets.oracle(asset),
        tracked = values.reduce(
          (sum, lot) => sum + BigInt(lot.remainingRawUnits),
          0n,
        ),
        cost = values.reduce(
          (sum, lot) => sum + BigInt(lot.remainingCostUsdg),
          0n,
        ),
        chain = await this.assets.tokenBalance(wallet.address, asset.address),
        value = BigInt(
          stockValueInUsdg(
            tracked.toString(),
            asset.decimals,
            oracle,
            usdg.decimals,
          ),
        ),
        display = (tracked * BigInt(asset.currentMultiplier)) / 10n ** 18n;
      positions.push({
        asset,
        rawUnits: tracked.toString(),
        displayUnits: display.toString(),
        onchainRawUnits: chain.units,
        reconciled: chain.units === tracked.toString(),
        costBasisUsdg: cost.toString(),
        currentValueUsdg: value.toString(),
        unrealizedPnlUsdg: signed(value - cost),
        oracle,
      });
    }
    const stockValue = positions.reduce(
        (sum, position) => sum + BigInt(position.currentValueUsdg),
        0n,
      ),
      unrealized = positions.reduce(
        (sum, position) => sum + BigInt(position.unrealizedPnlUsdg),
        0n,
      ),
      capitalSources = await this.repository.capitalSources(companyId);
    return {
      state: "available",
      companyId,
      wallet: wallet.address,
      chainId: 4663,
      usdgCash: cash.units,
      ...capitalSources,
      investableCapital: await this.repository.capital(companyId),
      positions,
      stockValueUsdg: stockValue.toString(),
      realizedPnlUsdg: await this.repository.realizedPnl(companyId),
      unrealizedPnlUsdg: unrealized.toString(),
      totalEconomicNetWorthUsdg: (BigInt(cash.units) + stockValue).toString(),
      source: "robinhood-mainnet-finalized",
      blockNumber: cash.blockNumber,
      timestamp: cash.timestamp,
    };
  }

  async getPortfolio(actor: FinancialActor, companyId: string) {
    try {
      const portfolio = await this.buildPortfolio(actor, companyId);
      this.eventSink?.({ name: "portfolio_reconciled", resourceId: companyId });
      return portfolio;
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
      return {
        state: "unavailable" as const,
        companyId,
        chainId: 4663,
        reason: "Verified portfolio data is unavailable; no fallback was used.",
      };
    }
  }

  async getPosition(actor: FinancialActor, companyId: string, symbol: string) {
    const portfolio = await this.getPortfolio(actor, companyId);
    if (portfolio.state !== "available") return portfolio;
    const target = symbolSchema.parse(symbol);
    const position = portfolio.positions.find(
      (value) => value.asset.symbol === target,
    );
    if (!position) throw new NotFoundError("Position");
    return position;
  }

  async listPositions(actor: FinancialActor, companyId: string) {
    const portfolio = await this.getPortfolio(actor, companyId);
    return portfolio.state === "available" ? portfolio.positions : portfolio;
  }

  async getRealizedPnl(actor: FinancialActor, companyId: string) {
    await this.authorize(this.repository, actor, companyId, "portfolio:read");
    return {
      companyId,
      realizedPnlUsdg: await this.repository.realizedPnl(companyId),
      finalizedOnly: true,
      taxAdvice: false,
    };
  }

  async getUnrealizedPnl(actor: FinancialActor, companyId: string) {
    const portfolio = await this.getPortfolio(actor, companyId);
    return portfolio.state === "available"
      ? {
          companyId,
          unrealizedPnlUsdg: portfolio.unrealizedPnlUsdg,
          source: portfolio.source,
          timestamp: portfolio.timestamp,
          isVerifiedServiceRevenue: false,
          taxAdvice: false,
        }
      : portfolio;
  }

  async getTokenApprovals(actor: FinancialActor, companyId: string) {
    await this.authorize(this.repository, actor, companyId, "portfolio:read");
    const wallet = await this.repository.getWallet(companyId),
      spenders = this.venue.capabilities().allowedSpenders;
    if (!wallet || !spenders.length)
      return {
        state: "unavailable" as const,
        companyId,
        reason:
          "A verified wallet and configured venue spender allowlist are required.",
      };
    const usdg = await this.assets.canonicalUsdg(),
      lots = await this.repository.lots(companyId),
      tokens = new Map<
        string,
        { symbol: string; address: typeof usdg.address }
      >();
    tokens.set(usdg.address, { symbol: "USDG", address: usdg.address });
    for (const lot of lots) {
      const asset = await this.assets.resolveAsset(lot.symbol);
      if (asset.assetId !== lot.assetId || asset.address !== lot.assetAddress)
        throw new DomainError(
          "A portfolio token no longer matches the canonical registry.",
          "TRADING_UNAVAILABLE",
        );
      tokens.set(asset.address, {
        symbol: asset.symbol,
        address: asset.address,
      });
    }
    const approvals = [];
    for (const token of tokens.values())
      for (const spender of spenders) {
        const allowance = await this.assets.allowance(
          wallet.address,
          token.address,
          spender,
        );
        if (BigInt(allowance) > 0n)
          approvals.push({ ...token, spender, allowance });
      }
    return {
      state: "available" as const,
      companyId,
      wallet: wallet.address,
      chainId: 4663 as const,
      approvals,
      allowlistedSpendersOnly: true,
      revokeRequiresOwnerWallet: true,
    };
  }
}
