import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANONICAL_USDG,
  TradingService,
  type CanonicalStockToken,
  type EligibilityProvider,
  type EvmAddress,
  type EvmHash,
  type FinancialActor,
  type OraclePrice,
  type TradingAssetPort,
  type TradingVenueProvider,
  type TradingWalletPort,
  type VenueQuoteRequest,
} from "@normic/core";
import {
  PostgresFinancialRepository,
  PostgresTradingRepository,
} from "@normic/db";
import {
  createCredential,
  createIdentity,
  createTestRuntime,
  serviceInput,
} from "../support/runtime.js";

const address = (value: number) =>
  `0x${value.toString(16).padStart(40, "0")}` as EvmAddress;
const hash = (value: number) =>
  `0x${value.toString(16).padStart(64, "0")}` as EvmHash;
const ASSET_ID = hash(500);
const ASSET_ADDRESS = address(500);
const SPENDER = address(700);
const ROUTER = address(701);

describe("Phase 5 isolated trading and portfolio accounting", () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  let repository: PostgresTradingRepository;
  let finance: PostgresFinancialRepository;
  let identity: Awaited<ReturnType<typeof createIdentity>>;
  let actor: FinancialActor;
  let trading: TradingService;
  let asset: CanonicalStockToken;
  let oracle: OraclePrice;
  let walletBalance: Record<string, bigint>;
  let halted: boolean;
  let staleOracle: boolean;
  let routeTarget: EvmAddress;
  let routeSpender: EvmAddress;
  let walletStatus: "pending" | "confirmed" | "failed";
  let transactionNumber: number;
  let executeCount: number;
  let quoteOutputBps: number;
  let quoteExpiryOffsetMs: number;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    repository = new PostgresTradingRepository(runtime.database);
    finance = new PostgresFinancialRepository(runtime.database);
    identity = await createIdentity(runtime.repository, "trading5");
    const credential = await createCredential(
      runtime.repository,
      identity.agentId,
      "nmc_test_phase5_portfolio",
    );
    identity.context.principal.credentialId = credential.id;
    actor = { kind: "agent", context: identity.context };
    await runtime.database.query(
      "UPDATE permissions SET decision='allow' WHERE company_id=$1 AND action='asset:trade'",
      [identity.companyId],
    );
    await finance.saveWallet({
      companyId: identity.companyId,
      agentId: identity.agentId,
      address: address(1),
      ownerAddress: address(2),
      chainId: 4663,
      provider: "alchemy-wallet-api",
      walletType: "erc4337-sma-b",
      authorizationStatus: "owner_verified",
      deployed: true,
      createdAt: new Date().toISOString(),
    });
    await repository.saveEligibility({
      companyId: identity.companyId,
      ownerUserId: identity.userId,
      state: "ELIGIBLE",
      provider: "isolated-test",
      rulesVersion: "test-1",
      attestationId: "attestation-test",
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      reasonCode: null,
      version: 1,
    });
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await repository.savePolicy({
      companyId: identity.companyId,
      enabled: true,
      allowBuy: true,
      allowSell: true,
      maxTradeUsdg: "50000000",
      maxDailyInvestmentUsdg: "50000000",
      maxTotalStockExposureUsdg: "100000000",
      maxPositionUsdg: "100000000",
      maxSlippageBps: 100,
      maxOracleDeviationBps: 100,
      maxPriceImpactBps: 100,
      minimumCashReserveUsdg: "10000000",
      allowedAssetIds: [ASSET_ID],
      blockedAssetIds: [],
      sessionExpiresAt: expiresAt,
      version: 1,
      updatedAt: new Date().toISOString(),
    });
    await repository.saveSession({
      id: crypto.randomUUID(),
      companyId: identity.companyId,
      publicKey: address(3),
      providerSessionId: "trading-session-test",
      authorizationRef: "owner-grant-test",
      expiresAt,
      policyVersion: 1,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    });
    await runtime.database.query(
      `INSERT INTO trading_venue_configs
       (version,chain_id,venue,quote_origin,allowed_targets,allowed_spenders,
        allowed_sources,active,created_by)
       VALUES($1,4663,'0x-swap-api',$2,ARRAY[$3],ARRAY[$4],ARRAY[$5],true,$6)`,
      [
        "isolated-v1",
        "https://api.0x.org",
        ROUTER,
        SPENDER,
        "0x_RFQ",
        "isolated-test",
      ],
    );

    asset = {
      assetId: ASSET_ID,
      symbol: "NVDA",
      name: "NVIDIA Stock Token",
      address: ASSET_ADDRESS,
      chainId: 4663,
      decimals: 6,
      status: "ASSET_STATUS_ACTIVE",
      tradingHalt: false,
      currentMultiplier: "1000000000000000000",
      pendingMultiplier: null,
      pendingMultiplierEffectiveAt: null,
      oraclePaused: false,
      registrySource: "isolated-official-fixture",
      verifiedAt: new Date().toISOString(),
      blockNumber: "100",
    };
    oracle = {
      assetId: ASSET_ID,
      token: ASSET_ADDRESS,
      feed: address(600),
      priceUnits: "2000000",
      decimals: 6,
      roundId: "10",
      updatedAt: new Date().toISOString(),
      heartbeatSeconds: 60,
      sequencerChecked: true,
      source: "chainlink-robinhood-mainnet",
      blockNumber: "100",
    };
    walletBalance = {
      [CANONICAL_USDG.toLowerCase()]: 100_000_000n,
      [ASSET_ADDRESS]: 0n,
    };
    halted = false;
    staleOracle = false;
    routeTarget = ROUTER;
    routeSpender = SPENDER;
    walletStatus = "confirmed";
    transactionNumber = 1000;
    executeCount = 0;
    quoteOutputBps = 10_000;
    quoteExpiryOffsetMs = 30_000;

    const assets: TradingAssetPort = {
      capabilities: () => ({ state: "ready", missing: [] }),
      validateChain: vi.fn(async () => {}),
      canonicalUsdg: async () => ({
        address: CANONICAL_USDG.toLowerCase() as EvmAddress,
        decimals: 6,
        blockNumber: "100",
      }),
      resolveAsset: async (symbol) => {
        if (symbol !== "NVDA") throw new Error("Fake token rejected.");
        return { ...asset, tradingHalt: halted };
      },
      oracle: async () => {
        if (staleOracle) throw new Error("Stale oracle blocked.");
        return { ...oracle };
      },
      tokenBalance: async (_wallet, token) => ({
        units: (walletBalance[token.toLowerCase()] ?? 0n).toString(),
        blockNumber: "100",
        timestamp: new Date().toISOString(),
      }),
      allowance: async () => currentAmount,
      simulate: vi.fn(async () => {
        if (routeTarget !== ROUTER || routeSpender !== SPENDER)
          throw new Error("Unverified route.");
      }),
      verifySettlement: async (trade, quote) => {
        const input = BigInt(quote.amountIn),
          output = BigInt(quote.expectedAmountOut),
          inputKey = quote.inputToken.toLowerCase(),
          outputKey = quote.outputToken.toLowerCase();
        walletBalance[inputKey] = (walletBalance[inputKey] ?? 0n) - input;
        walletBalance[outputKey] = (walletBalance[outputKey] ?? 0n) + output;
        return {
          chainId: 4663,
          transactionHash: trade.transactionHash!,
          blockNumber: String(transactionNumber),
          blockHash: hash(transactionNumber + 1),
          wallet: trade.wallet,
          inputToken: quote.inputToken,
          outputToken: quote.outputToken,
          actualAmountIn: quote.amountIn,
          actualAmountOut: quote.expectedAmountOut,
          confirmedAt: new Date().toISOString(),
        };
      },
    };
    const venue: TradingVenueProvider = {
      capabilities: () => ({
        venue: "0x-swap-api",
        state: "ready",
        missing: [],
        chainId: 4663,
        executionEnabled: true,
        configVersion: "isolated-v1",
        allowedTargets: [ROUTER],
        allowedSpenders: [SPENDER],
        allowedSources: ["0x_RFQ"],
      }),
      quote: async (input: VenueQuoteRequest) => {
        const price = BigInt(oracle.priceUnits),
          amount = BigInt(input.amountIn);
        let output =
          input.side === "BUY"
            ? (amount * 1_000_000n) / price
            : (amount * price) / 1_000_000n;
        output = (output * BigInt(quoteOutputBps)) / 10_000n;
        const now = Date.now();
        currentAmount = input.amountIn;
        return {
          providerQuoteId: `quote-${now}`,
          venue: "0x-swap-api",
          inputToken:
            input.side === "BUY" ? input.usdg.address : input.asset.address,
          outputToken:
            input.side === "BUY" ? input.asset.address : input.usdg.address,
          amountIn: input.amountIn,
          expectedAmountOut: output.toString(),
          minimumAmountOut: ((output * 99n) / 100n).toString(),
          blockNumber: "100",
          route: [
            {
              source: "0x_RFQ",
              from:
                input.side === "BUY" ? input.usdg.address : input.asset.address,
              to:
                input.side === "BUY" ? input.asset.address : input.usdg.address,
            },
          ],
          allowance: {
            token:
              input.side === "BUY" ? input.usdg.address : input.asset.address,
            spender: routeSpender,
            amount: input.amountIn,
          },
          transaction: { to: routeTarget, data: hash(900), value: "0x0" },
          quotedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + quoteExpiryOffsetMs).toISOString(),
          venueConfigVersion: "isolated-v1",
        };
      },
    };
    const eligibility: EligibilityProvider = {
      capabilities: () => ({
        state: "ready",
        provider: "isolated-test",
        missing: [],
      }),
      assess: async () => ({
        state: "ELIGIBLE",
        provider: "isolated-test",
        rulesVersion: "test-1",
        attestationId: "test",
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        reasonCode: null,
      }),
    };
    const wallets: TradingWalletPort = {
      available: true,
      autonomousAvailable: true,
      validateSession: vi.fn(async () => {}),
      execute: vi.fn(async () => {
        executeCount += 1;
        return { callId: `0x${executeCount.toString(16)}` };
      }),
      status: async () => ({
        state: walletStatus,
        transactionHash:
          walletStatus === "confirmed" ? hash(transactionNumber) : null,
      }),
      revoke: vi.fn(async () => {}),
    };
    trading = new TradingService(
      repository,
      assets,
      venue,
      eligibility,
      wallets,
    );
  });

  let currentAmount = "0";

  afterEach(async () => runtime.database.close());

  async function creditVerifiedRevenue(amount: string) {
    const service = await runtime.economy.createService(
      identity.context,
      {
        ...serviceInput(identity.companyId, crypto.randomUUID()),
        pricingModel: "fixed",
        quotedPrice: "1.00",
        quotedCurrency: "USDG",
      },
      `service-${crypto.randomUUID()}`,
    );
    const now = new Date().toISOString(),
      invocationId = crypto.randomUUID(),
      onchainId = hash(transactionNumber + 20),
      terms = {
        nonce: hash(transactionNumber + 21),
        buyer: address(90),
        provider: address(1),
        providerOwner: address(2),
        amount,
        acceptBy: "2000000000",
        completeBy: "2000003600",
        reviewPeriod: "3600",
      };
    await finance.createInvocation({
      id: invocationId,
      onchainId,
      serviceId: service.id,
      providerCompanyId: identity.companyId,
      providerAgentId: identity.agentId,
      buyerCompanyId: null,
      buyerAgentId: null,
      buyerWallet: address(90),
      terms,
      tokenDecimals: 6,
      input: {},
      output: {},
      resultHash: hash(1),
      state: "RELEASED",
      jobStatus: "completed",
      serviceVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const event = {
      chainId: 4663 as const,
      transactionHash: hash(transactionNumber + 22),
      logIndex: 0,
      blockNumber: String(transactionNumber + 22),
      blockHash: hash(transactionNumber + 23),
      contractAddress: address(99),
      invocationId: onchainId,
      name: "InvocationReleased" as const,
      terms,
      resultHash: hash(1),
      observedAt: now,
    };
    await finance.insertEvent(event);
    await finance.postJournal(
      event,
      identity.companyId,
      "cash",
      "service_revenue",
      amount,
    );
  }

  async function quote(side: "BUY" | "SELL", amountIn: string, key: string) {
    return trading.quote(
      actor,
      { companyId: identity.companyId, symbol: "NVDA", side, amountIn },
      key,
    );
  }

  async function executeAndConfirm(
    side: "BUY" | "SELL",
    amountIn: string,
    suffix: string,
  ) {
    const q = await quote(side, amountIn, `quote-${suffix}`),
      pending = await trading.execute(
        actor,
        q.id,
        {
          objective: "Test bounded earned-capital allocation",
          reasonSummary: "Uses verified earned capital under the owner policy.",
          riskChecks: ["policy", "capital", "oracle"],
        },
        side,
        `execute-${suffix}`,
      );
    expect(pending.status).toBe("PENDING");
    return trading.reconcile(actor, pending.id, `reconcile-${suffix}`);
  }

  it("excludes owner transfers and admits only verified finalized service revenue", async () => {
    await runtime.database.query(
      `INSERT INTO wallet_transfer_observations
       (company_id,chain_id,transaction_hash,log_index,block_number,block_hash,from_address,token_units,classification)
       VALUES($1,4663,$2,0,10,$3,$4,1000000000,'capital')`,
      [identity.companyId, hash(10), hash(11), address(2)],
    );
    expect((await repository.capital(identity.companyId)).availableUsdg).toBe(
      "0",
    );
    expect(
      (await repository.capitalSources(identity.companyId)).ownerCapitalUsdg,
    ).toBe("1000000000");
    await expect(quote("BUY", "12000000", "no-earned-capital")).rejects.toThrow(
      /verified earned capital/i,
    );
    await creditVerifiedRevenue("30000000");
    expect((await repository.capital(identity.companyId)).availableUsdg).toBe(
      "30000000",
    );
  });

  it("blocks unknown, expired, halted, stale, blocked and over-limit trades", async () => {
    await creditVerifiedRevenue("60000000");
    await repository.saveEligibility({
      ...(await repository.getEligibility(identity.companyId))!,
      state: "UNKNOWN",
      version: 2,
    });
    await expect(
      quote("BUY", "12000000", "unknown-eligibility"),
    ).rejects.toThrow(/UNKNOWN/);
    await repository.saveEligibility({
      ...(await repository.getEligibility(identity.companyId))!,
      state: "ELIGIBLE",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      version: 3,
    });
    await expect(
      quote("BUY", "12000000", "expired-eligibility"),
    ).rejects.toThrow(/EXPIRED/);
    await repository.saveEligibility({
      ...(await repository.getEligibility(identity.companyId))!,
      state: "ELIGIBLE",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      version: 4,
    });
    const policy = (await repository.getPolicy(identity.companyId))!;
    await repository.savePolicy({
      ...policy,
      maxTradeUsdg: "1000000",
      version: 2,
    });
    await repository.saveSession({
      ...(await repository.getSession(identity.companyId))!,
      policyVersion: 2,
    });
    await expect(quote("BUY", "12000000", "over-limit")).rejects.toThrow(
      /per-trade limit/i,
    );
    await repository.savePolicy({ ...policy, version: 3 });
    await repository.saveSession({
      ...(await repository.getSession(identity.companyId))!,
      policyVersion: 3,
    });
    halted = true;
    await expect(quote("BUY", "12000000", "halted-token")).rejects.toThrow(
      /paused/i,
    );
    halted = false;
    staleOracle = true;
    await expect(quote("BUY", "12000000", "stale-oracle")).rejects.toThrow(
      /Stale oracle/i,
    );
    staleOracle = false;
    await repository.savePolicy({
      ...policy,
      allowedAssetIds: [hash(999)],
      version: 4,
    });
    await repository.saveSession({
      ...(await repository.getSession(identity.companyId))!,
      policyVersion: 4,
    });
    await expect(quote("BUY", "12000000", "blocked-asset")).rejects.toThrow(
      /owner-allowlisted/i,
    );
  });

  it("enforces reserve, daily, exposure, oracle deviation and quote expiry", async () => {
    await creditVerifiedRevenue("60000000");
    const original = (await repository.getPolicy(identity.companyId))!;
    await repository.savePolicy({
      ...original,
      minimumCashReserveUsdg: "95000000",
      version: 2,
    });
    await repository.saveSession({
      ...(await repository.getSession(identity.companyId))!,
      policyVersion: 2,
    });
    await expect(quote("BUY", "12000000", "reserve-limit")).rejects.toThrow(
      /cash reserve/i,
    );

    await repository.savePolicy({
      ...original,
      maxDailyInvestmentUsdg: "11000000",
      version: 3,
    });
    await repository.saveSession({
      ...(await repository.getSession(identity.companyId))!,
      policyVersion: 3,
    });
    await expect(quote("BUY", "12000000", "daily-limit")).rejects.toThrow(
      /daily investment/i,
    );

    await repository.savePolicy({
      ...original,
      maxTotalStockExposureUsdg: "11000000",
      maxPositionUsdg: "11000000",
      version: 4,
    });
    await repository.saveSession({
      ...(await repository.getSession(identity.companyId))!,
      policyVersion: 4,
    });
    await expect(quote("BUY", "12000000", "exposure-limit")).rejects.toThrow(
      /exposure/i,
    );

    await repository.savePolicy({ ...original, version: 5 });
    await repository.saveSession({
      ...(await repository.getSession(identity.companyId))!,
      policyVersion: 5,
    });
    quoteOutputBps = 9_000;
    await expect(quote("BUY", "12000000", "oracle-deviation")).rejects.toThrow(
      /deviates|price impact/i,
    );
    quoteOutputBps = 10_000;
    quoteExpiryOffsetMs = -1;
    const expired = await quote("BUY", "12000000", "expired-quote");
    await expect(
      trading.execute(
        actor,
        expired.id,
        {
          objective: "Bounded buy",
          reasonSummary: "A safe test allocation.",
          riskChecks: ["policy"],
        },
        "BUY",
        "expired-execution",
      ),
    ).rejects.toThrow(/expired/i);
    expect((await repository.getQuote(expired.id))?.status).toBe("EXPIRED");
  });

  it("creates one confirmed buy, balanced journal and reconciled real position", async () => {
    await creditVerifiedRevenue("30000000");
    const confirmed = await executeAndConfirm("BUY", "12000000", "buy-once");
    expect(confirmed).toMatchObject({
      status: "CONFIRMED",
      actualAmountIn: "12000000",
      actualAmountOut: "6000000",
    });
    expect(executeCount).toBe(1);
    const portfolio = await trading.getPortfolio(actor, identity.companyId);
    expect(portfolio).toMatchObject({
      state: "available",
      ownerCapitalUsdg: "0",
      positions: [
        {
          rawUnits: "6000000",
          displayUnits: "6000000",
          onchainRawUnits: "6000000",
          reconciled: true,
          costBasisUsdg: "12000000",
        },
      ],
    });
    const [balance] = await runtime.database.query<{
      debit: string;
      credit: string;
    }>(
      `SELECT
       sum(CASE WHEN p.direction='debit' THEN p.token_units ELSE 0 END)::text debit,
       sum(CASE WHEN p.direction='credit' THEN p.token_units ELSE 0 END)::text credit
       FROM ledger_entries e JOIN ledger_postings p ON p.entry_id=e.id
       WHERE e.source_trade_settlement_id IS NOT NULL`,
    );
    expect(balance?.debit).toBe(balance?.credit);
    expect(
      await runtime.database.query("SELECT id FROM trade_settlements"),
    ).toHaveLength(1);
  });

  it("is idempotent and does not create a position for a failed transaction", async () => {
    await creditVerifiedRevenue("30000000");
    const q = await quote("BUY", "12000000", "duplicate-buy"),
      decision = {
        objective: "Bounded buy",
        reasonSummary: "A safe test allocation.",
        riskChecks: ["policy"],
      };
    const first = await trading.execute(
      actor,
      q.id,
      decision,
      "BUY",
      "duplicate-execute-key",
    );
    const replay = await trading.execute(
      actor,
      q.id,
      decision,
      "BUY",
      "duplicate-execute-key",
    );
    expect(replay.id).toBe(first.id);
    expect(executeCount).toBe(1);
    walletStatus = "failed";
    const failed = await trading.reconcile(actor, first.id, "failed-reconcile");
    expect(failed.status).toBe("REVERTED");
    expect(await repository.lots(identity.companyId)).toEqual([]);
    expect(
      await runtime.database.query("SELECT id FROM trade_settlements"),
    ).toEqual([]);
  });

  it("uses FIFO for a partial sell and recognizes PnL only after finality", async () => {
    await creditVerifiedRevenue("50000000");
    await executeAndConfirm("BUY", "12000000", "fifo-buy");
    oracle = { ...oracle, priceUnits: "2400000", roundId: "11" };
    transactionNumber += 10;
    const sale = await executeAndConfirm("SELL", "3000000", "fifo-sell");
    expect(sale.realizedPnlUsdg).toBe("1200000");
    const lots = await repository.lots(identity.companyId, ASSET_ID);
    expect(lots).toEqual([
      expect.objectContaining({
        remainingRawUnits: "3000000",
        remainingCostUsdg: "6000000",
      }),
    ]);
    expect(await repository.realizedPnl(identity.companyId)).toBe("1200000");
    const portfolio = await trading.getPortfolio(actor, identity.companyId);
    expect(portfolio).toMatchObject({
      state: "available",
      realizedPnlUsdg: "1200000",
      unrealizedPnlUsdg: "1200000",
    });
  });

  it("does not broadcast a duplicate sell for the same idempotency key", async () => {
    await creditVerifiedRevenue("30000000");
    await executeAndConfirm("BUY", "12000000", "sell-idempotency-buy");
    const q = await quote("SELL", "3000000", "sell-idempotency-quote"),
      decision = {
        objective: "Reduce a bounded position",
        reasonSummary: "Preserves capital under the configured owner policy.",
        riskChecks: ["position", "oracle", "policy"],
      },
      first = await trading.execute(
        actor,
        q.id,
        decision,
        "SELL",
        "duplicate-sell-key",
      ),
      replay = await trading.execute(
        actor,
        q.id,
        decision,
        "SELL",
        "duplicate-sell-key",
      );
    expect(replay.id).toBe(first.id);
    expect(executeCount).toBe(2);
  });

  it("keeps display multiplier separate from raw balance, cost basis and PnL", async () => {
    await creditVerifiedRevenue("30000000");
    await executeAndConfirm("BUY", "12000000", "multiplier-buy");
    asset = {
      ...asset,
      currentMultiplier: "2000000000000000000",
    };
    const portfolio = await trading.getPortfolio(actor, identity.companyId);
    expect(portfolio).toMatchObject({
      state: "available",
      positions: [
        {
          rawUnits: "6000000",
          displayUnits: "12000000",
          costBasisUsdg: "12000000",
          unrealizedPnlUsdg: "0",
        },
      ],
    });
  });

  it("enforces emergency pause, revocation and cross-company authorization", async () => {
    await creditVerifiedRevenue("30000000");
    const policy = (await repository.getPolicy(identity.companyId))!;
    await expect(
      trading.updatePolicy(actor, policy, "agent-cannot-enable-trading"),
    ).rejects.toThrow(/Agent credentials cannot enable/i);
    await expect(
      trading.refreshEligibility(
        actor,
        identity.companyId,
        "agent-cannot-refresh-eligibility",
      ),
    ).rejects.toThrow(/verified human owner/i);
    await repository.savePolicy({ ...policy, enabled: false, version: 2 });
    await expect(quote("BUY", "12000000", "paused-policy")).rejects.toThrow(
      /disabled/i,
    );
    await repository.savePolicy({ ...policy, version: 3 });
    await repository.saveSession({
      ...(await repository.getSession(identity.companyId))!,
      policyVersion: 3,
      revokedAt: new Date().toISOString(),
    });
    await expect(quote("BUY", "12000000", "revoked-session")).rejects.toThrow(
      /session/i,
    );
    const outsider = await createIdentity(runtime.repository, "outsider5");
    expect(await repository.getPolicy(outsider.companyId)).toBeNull();
    const outsideCredential = await createCredential(
      runtime.repository,
      outsider.agentId,
      "nmc_test_phase5_outsider",
    );
    outsider.context.principal.credentialId = outsideCredential.id;
    await expect(
      trading.getPortfolio(
        { kind: "agent", context: outsider.context },
        identity.companyId,
      ),
    ).rejects.toThrow(/not authorized/i);
  });
});
