import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  type FinancialSummary,
  type PositionLot,
  type Trade,
  type TradeQuote,
  type TradingClaim,
  type TradingEligibility,
  type TradingPolicy,
  type TradingRepository,
  type TradingSession,
  type TradingVenueConfiguration,
  type VerifiedTradeSettlement,
} from "@normic/core";
import { PostgresEconomyRepository } from "./repository.js";
import { PostgresFinancialRepository } from "./financial-repository.js";
import type { RuntimeDatabase, SqlExecutor, SqlParameter } from "./database.js";

export class PostgresTradingRepository implements TradingRepository {
  readonly economy: PostgresEconomyRepository;
  private readonly finance: PostgresFinancialRepository;

  constructor(private readonly db: RuntimeDatabase | SqlExecutor) {
    this.economy = new PostgresEconomyRepository(db);
    this.finance = new PostgresFinancialRepository(db);
  }

  transaction<T>(operation: (tx: TradingRepository) => Promise<T>): Promise<T> {
    return "transaction" in this.db
      ? this.db.transaction((tx) =>
          operation(new PostgresTradingRepository(tx)),
        )
      : operation(this);
  }

  async lockCompany(companyId: string) {
    await this.db.query("SELECT id FROM companies WHERE id=$1 FOR UPDATE", [
      companyId,
    ]);
  }

  async claim(
    actor: string,
    operation: string,
    key: string,
    hash: string,
  ): Promise<TradingClaim> {
    const inserted = await this.db.query(
      "INSERT INTO trading_idempotency(actor,operation,key,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING actor",
      [actor, operation, key, hash],
    );
    if (inserted.length) return { replay: false };
    const [record] = await this.db.query<{
      request_hash: string;
      response: unknown;
    }>(
      "SELECT request_hash,response FROM trading_idempotency WHERE actor=$1 AND operation=$2 AND key=$3 FOR UPDATE",
      [actor, operation, key],
    );
    if (!record || record.request_hash !== hash)
      throw new IdempotencyConflictError();
    if (record.response === null) throw new IdempotencyInProgressError();
    return { replay: true, response: record.response };
  }

  async complete(
    actor: string,
    operation: string,
    key: string,
    response: unknown,
  ) {
    await this.db.query(
      "UPDATE trading_idempotency SET response=$4::jsonb WHERE actor=$1 AND operation=$2 AND key=$3",
      [actor, operation, key, JSON.stringify(response)],
    );
  }

  private async data<T>(sql: string, args: readonly SqlParameter[]) {
    return (await this.db.query<{ data: T }>(sql, args))[0]?.data ?? null;
  }

  getWallet(companyId: string) {
    return this.finance.getWallet(companyId);
  }

  financialSummary(companyId: string): Promise<FinancialSummary> {
    return this.finance.summary(companyId);
  }

  getEligibility(companyId: string) {
    return this.data<TradingEligibility>(
      "SELECT data FROM trading_eligibility WHERE company_id=$1",
      [companyId],
    );
  }

  async saveEligibility(value: TradingEligibility) {
    await this.db.query(
      `INSERT INTO trading_eligibility
       (company_id,owner_user_id,state,provider,rules_version,attestation_id,verified_at,expires_at,reason_code,version,data)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT(company_id) DO UPDATE SET
         owner_user_id=EXCLUDED.owner_user_id,state=EXCLUDED.state,provider=EXCLUDED.provider,
         rules_version=EXCLUDED.rules_version,attestation_id=EXCLUDED.attestation_id,
         verified_at=EXCLUDED.verified_at,expires_at=EXCLUDED.expires_at,
         reason_code=EXCLUDED.reason_code,version=EXCLUDED.version,data=EXCLUDED.data,updated_at=now()`,
      [
        value.companyId,
        value.ownerUserId,
        value.state,
        value.provider,
        value.rulesVersion,
        value.attestationId,
        value.verifiedAt,
        value.expiresAt,
        value.reasonCode,
        value.version,
        JSON.stringify(value),
      ],
    );
  }

  getPolicy(companyId: string) {
    return this.data<TradingPolicy>(
      "SELECT data FROM trading_policies WHERE company_id=$1",
      [companyId],
    );
  }

  async savePolicy(value: TradingPolicy) {
    await this.db.query(
      `INSERT INTO trading_policies(company_id,enabled,version,data)
       VALUES($1,$2,$3,$4::jsonb)
       ON CONFLICT(company_id) DO UPDATE SET
         enabled=EXCLUDED.enabled,version=EXCLUDED.version,data=EXCLUDED.data,updated_at=now()`,
      [value.companyId, value.enabled, value.version, JSON.stringify(value)],
    );
  }

  getSession(companyId: string) {
    return this.data<TradingSession>(
      "SELECT data FROM trading_sessions WHERE company_id=$1 AND revoked_at IS NULL ORDER BY expires_at DESC LIMIT 1",
      [companyId],
    );
  }

  async saveSession(value: TradingSession) {
    await this.db.query(
      `INSERT INTO trading_sessions
       (id,company_id,public_key,provider_session_id,authorization_ref,policy_version,expires_at,revoked_at,data,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       ON CONFLICT(id) DO UPDATE SET revoked_at=EXCLUDED.revoked_at,data=EXCLUDED.data`,
      [
        value.id,
        value.companyId,
        value.publicKey.toLowerCase(),
        value.providerSessionId,
        value.authorizationRef,
        value.policyVersion,
        value.expiresAt,
        value.revokedAt,
        JSON.stringify(value),
        value.createdAt,
      ],
    );
  }

  async getVenueConfiguration(version: string) {
    const [row] = await this.db.query<{
      version: string;
      chain_id: number;
      venue: string;
      quote_origin: string;
      allowed_targets: string[];
      allowed_spenders: string[];
      allowed_sources: string[];
      active: boolean;
    }>(
      `SELECT version,chain_id,venue,quote_origin,allowed_targets,allowed_spenders,
       allowed_sources,active FROM trading_venue_configs WHERE version=$1`,
      [version],
    );
    if (!row || row.chain_id !== 4663 || row.venue !== "0x-swap-api")
      return null;
    return {
      version: row.version,
      chainId: 4663,
      venue: "0x-swap-api",
      quoteOrigin: row.quote_origin,
      allowedTargets:
        row.allowed_targets as TradingVenueConfiguration["allowedTargets"],
      allowedSpenders:
        row.allowed_spenders as TradingVenueConfiguration["allowedSpenders"],
      allowedSources: row.allowed_sources,
      active: row.active,
    } satisfies TradingVenueConfiguration;
  }

  async saveQuote(value: TradeQuote) {
    const inserted = await this.db.query(
      `INSERT INTO trade_quotes(id,company_id,agent_id,status,expires_at,data,created_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT(id) DO NOTHING RETURNING id`,
      [
        value.id,
        value.companyId,
        value.agentId,
        value.status,
        value.expiresAt,
        JSON.stringify(value),
        value.quotedAt,
      ],
    );
    if (inserted.length) {
      await this.db.query(
        `INSERT INTO oracle_snapshots
         (quote_id,chain_id,asset_id,feed,round_id,price_units,decimals,block_number,updated_at,data)
         VALUES($1,4663,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          value.id,
          value.asset.assetId,
          value.oracle.feed,
          value.oracle.roundId,
          value.oracle.priceUnits,
          value.oracle.decimals,
          value.oracle.blockNumber,
          value.oracle.updatedAt,
          JSON.stringify(value.oracle),
        ],
      );
    } else {
      await this.db.query(
        "UPDATE trade_quotes SET status=$2,data=$3::jsonb WHERE id=$1",
        [value.id, value.status, JSON.stringify(value)],
      );
    }
  }

  getQuote(id: string, lock = false) {
    return this.data<TradeQuote>(
      `SELECT data FROM trade_quotes WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    );
  }

  async saveTrade(value: Trade) {
    await this.db.query(
      `INSERT INTO trades
       (id,quote_id,company_id,agent_id,wallet,asset_id,asset_address,side,status,provider_call_id,
        transaction_hash,block_number,actual_amount_in,actual_amount_out,realized_pnl_usdg,failure_reason,
        data,created_at,submitted_at,confirmed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20)
       ON CONFLICT(id) DO UPDATE SET
         status=EXCLUDED.status,provider_call_id=EXCLUDED.provider_call_id,
         transaction_hash=EXCLUDED.transaction_hash,block_number=EXCLUDED.block_number,
         actual_amount_in=EXCLUDED.actual_amount_in,actual_amount_out=EXCLUDED.actual_amount_out,
         realized_pnl_usdg=EXCLUDED.realized_pnl_usdg,failure_reason=EXCLUDED.failure_reason,
         data=EXCLUDED.data,submitted_at=EXCLUDED.submitted_at,confirmed_at=EXCLUDED.confirmed_at`,
      [
        value.id,
        value.quoteId,
        value.companyId,
        value.agentId,
        value.wallet.toLowerCase(),
        value.assetId,
        value.assetAddress.toLowerCase(),
        value.side,
        value.status,
        value.providerCallId,
        value.transactionHash,
        value.blockNumber,
        value.actualAmountIn,
        value.actualAmountOut,
        value.realizedPnlUsdg,
        value.failureReason,
        JSON.stringify(value),
        value.createdAt,
        value.submittedAt,
        value.confirmedAt,
      ],
    );
  }

  getTrade(id: string, lock = false) {
    return this.data<Trade>(
      `SELECT data FROM trades WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    );
  }

  getTradeByQuote(id: string) {
    return this.data<Trade>("SELECT data FROM trades WHERE quote_id=$1", [id]);
  }

  async listTrades(companyId: string, limit: number) {
    return (
      await this.db.query<{ data: Trade }>(
        "SELECT data FROM trades WHERE company_id=$1 ORDER BY created_at DESC,id LIMIT $2",
        [companyId, limit],
      )
    ).map((row) => row.data);
  }

  async dailyInvestment(companyId: string) {
    const [row] = await this.db.query<{ total: string }>(
      `SELECT COALESCE(sum(actual_amount_in),0)::text total FROM trades
       WHERE company_id=$1 AND side='BUY' AND status='CONFIRMED'
         AND confirmed_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [companyId],
    );
    return row?.total ?? "0";
  }

  async capital(companyId: string) {
    const [service] = await this.db.query<{
      revenue: string;
      external_revenue: string;
      agent_network_revenue: string;
      expenses: string;
    }>(
      `SELECT
         COALESCE(sum(CASE WHEN a.code='service_revenue' THEN
           CASE WHEN p.direction='credit' THEN p.token_units ELSE -p.token_units END ELSE 0 END),0)::text revenue,
         COALESCE(sum(CASE WHEN a.code='service_revenue' AND i.buyer_company_id IS NULL THEN
           CASE WHEN p.direction='credit' THEN p.token_units ELSE -p.token_units END ELSE 0 END),0)::text external_revenue,
         COALESCE(sum(CASE WHEN a.code='service_revenue' AND i.buyer_company_id IS NOT NULL THEN
           CASE WHEN p.direction='credit' THEN p.token_units ELSE -p.token_units END ELSE 0 END),0)::text agent_network_revenue,
         COALESCE(sum(CASE WHEN a.code='service_expense' THEN
           CASE WHEN p.direction='debit' THEN p.token_units ELSE -p.token_units END ELSE 0 END),0)::text expenses
       FROM ledger_accounts a JOIN ledger_postings p ON p.account_id=a.id
       JOIN ledger_entries e ON e.id=p.entry_id
       LEFT JOIN escrow_events ev ON ev.id=e.source_event_id
       LEFT JOIN paid_invocations i ON i.onchain_id=ev.invocation_id
       WHERE a.company_id=$1 AND e.status='posted' AND e.source_event_id IS NOT NULL`,
      [companyId],
    );
    const [trading] = await this.db.query<{
      purchases: string;
      proceeds: string;
    }>(
      `SELECT
         COALESCE(sum(actual_amount_in) FILTER(WHERE side='BUY'),0)::text purchases,
         COALESCE(sum(actual_amount_out) FILTER(WHERE side='SELL'),0)::text proceeds
       FROM trades WHERE company_id=$1 AND status='CONFIRMED'`,
      [companyId],
    );
    const revenue = BigInt(service?.revenue ?? "0"),
      expenses = BigInt(service?.expenses ?? "0"),
      purchases = BigInt(trading?.purchases ?? "0"),
      proceeds = BigInt(trading?.proceeds ?? "0"),
      available = revenue - expenses - purchases + proceeds;
    return {
      companyId,
      verifiedServiceRevenue: revenue.toString(),
      verifiedExternalRevenue: service?.external_revenue ?? "0",
      verifiedAgentNetworkRevenue: service?.agent_network_revenue ?? "0",
      serviceExpenses: expenses.toString(),
      confirmedStockPurchases: purchases.toString(),
      verifiedTradingProceeds: proceeds.toString(),
      ownerCapitalIncluded: false as const,
      externalTransfersIncluded: false as const,
      unattributedTransfersIncluded: false as const,
      availableUsdg: (available > 0n ? available : 0n).toString(),
      source: "verified-settlement-lineage" as const,
    };
  }

  async capitalSources(companyId: string) {
    const rows = await this.db.query<{ classification: string; total: string }>(
      `SELECT classification,COALESCE(sum(token_units),0)::text total
       FROM wallet_transfer_observations WHERE company_id=$1 GROUP BY classification`,
      [companyId],
    );
    const amount = (classification: string) =>
      rows.find((row) => row.classification === classification)?.total ?? "0";
    return {
      ownerCapitalUsdg: amount("capital"),
      unattributedTransfersUsdg: amount("unattributed"),
    };
  }

  async lots(companyId: string, assetId?: string, lock = false) {
    const parameters: SqlParameter[] = [companyId];
    let condition = "company_id=$1 AND remaining_raw_units>0";
    if (assetId) {
      parameters.push(assetId);
      condition += " AND asset_id=$2";
    }
    const rows = await this.db.query<{
      id: string;
      company_id: string;
      asset_id: string;
      asset_address: PositionLot["assetAddress"];
      symbol: string;
      source_trade_id: string;
      original_raw_units: string;
      remaining_raw_units: string;
      original_cost_usdg: string;
      remaining_cost_usdg: string;
      multiplier_at_buy: string;
      created_at: Date;
    }>(
      `SELECT id,company_id,asset_id,asset_address,symbol,source_trade_id,
       original_raw_units::text,remaining_raw_units::text,original_cost_usdg::text,
       remaining_cost_usdg::text,multiplier_at_buy::text,created_at
       FROM position_lots WHERE ${condition} ORDER BY created_at,id${lock ? " FOR UPDATE" : ""}`,
      parameters,
    );
    return rows.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      assetId: row.asset_id,
      assetAddress: row.asset_address,
      symbol: row.symbol,
      sourceTradeId: row.source_trade_id,
      originalRawUnits: row.original_raw_units,
      remainingRawUnits: row.remaining_raw_units,
      originalCostUsdg: row.original_cost_usdg,
      remainingCostUsdg: row.remaining_cost_usdg,
      multiplierAtBuy: row.multiplier_at_buy,
      createdAt: row.created_at.toISOString(),
    }));
  }

  private async account(companyId: string, code: string) {
    const [row] = await this.db.query<{ id: string }>(
      "SELECT id FROM ledger_accounts WHERE company_id=$1 AND code=$2",
      [companyId, code],
    );
    if (!row) throw new Error(`Missing ledger account ${code}.`);
    return row.id;
  }

  async applySettlement(
    trade: Trade,
    quote: TradeQuote,
    settlement: VerifiedTradeSettlement,
  ) {
    const [stored] = await this.db.query<{ id: string }>(
      `INSERT INTO trade_settlements
       (trade_id,chain_id,transaction_hash,block_number,block_hash,wallet,input_token,output_token,
        actual_amount_in,actual_amount_out,data,confirmed_at)
       VALUES($1,4663,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       ON CONFLICT(trade_id) DO NOTHING RETURNING id`,
      [
        trade.id,
        settlement.transactionHash,
        settlement.blockNumber,
        settlement.blockHash,
        settlement.wallet,
        settlement.inputToken,
        settlement.outputToken,
        settlement.actualAmountIn,
        settlement.actualAmountOut,
        JSON.stringify(settlement),
        settlement.confirmedAt,
      ],
    );
    if (!stored) {
      const existing = await this.getTrade(trade.id);
      if (
        !existing?.transactionHash ||
        existing.transactionHash !== settlement.transactionHash
      )
        throw new IdempotencyConflictError();
      return existing;
    }

    const entryId = crypto.randomUUID();
    await this.db.query(
      "INSERT INTO ledger_entries(id,description,source_trade_settlement_id,company_id) VALUES($1,$2,$3,$4)",
      [
        entryId,
        `Finalized ${trade.side} ${trade.symbol} Stock Token`,
        stored.id,
        trade.companyId,
      ],
    );
    const postings: {
      account: string;
      direction: "debit" | "credit";
      units: bigint;
    }[] = [];
    let realized: bigint | null = null;
    if (trade.side === "BUY") {
      const cost = BigInt(settlement.actualAmountIn);
      await this.db.query(
        `INSERT INTO position_lots
         (id,company_id,asset_id,asset_address,symbol,source_trade_id,original_raw_units,
          remaining_raw_units,original_cost_usdg,remaining_cost_usdg,multiplier_at_buy,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$8,$9,$10)`,
        [
          crypto.randomUUID(),
          trade.companyId,
          trade.assetId,
          trade.assetAddress,
          trade.symbol,
          trade.id,
          settlement.actualAmountOut,
          settlement.actualAmountIn,
          quote.asset.currentMultiplier,
          settlement.confirmedAt,
        ],
      );
      postings.push(
        { account: "stock_asset", direction: "debit", units: cost },
        { account: "cash", direction: "credit", units: cost },
      );
    } else {
      let remaining = BigInt(settlement.actualAmountIn),
        cost = 0n;
      const lots = await this.lots(trade.companyId, trade.assetId, true);
      for (const lot of lots) {
        if (remaining === 0n) break;
        const available = BigInt(lot.remainingRawUnits),
          consumed = available < remaining ? available : remaining,
          oldCost = BigInt(lot.remainingCostUsdg),
          allocated =
            consumed === available ? oldCost : (oldCost * consumed) / available;
        await this.db.query(
          "UPDATE position_lots SET remaining_raw_units=remaining_raw_units-$2,remaining_cost_usdg=remaining_cost_usdg-$3 WHERE id=$1",
          [lot.id, consumed.toString(), allocated.toString()],
        );
        remaining -= consumed;
        cost += allocated;
      }
      if (remaining !== 0n)
        throw new Error("Finalized sale exceeds the confirmed FIFO position.");
      const proceeds = BigInt(settlement.actualAmountOut);
      realized = proceeds - cost;
      postings.push(
        { account: "cash", direction: "debit", units: proceeds },
        { account: "stock_asset", direction: "credit", units: cost },
      );
      if (realized > 0n)
        postings.push({
          account: "trading_pnl",
          direction: "credit",
          units: realized,
        });
      if (realized < 0n)
        postings.push({
          account: "trading_pnl",
          direction: "debit",
          units: -realized,
        });
    }
    for (const posting of postings) {
      if (posting.units === 0n) continue;
      await this.db.query(
        "INSERT INTO ledger_postings(entry_id,account_id,direction,token_units) VALUES($1,$2,$3,$4)",
        [
          entryId,
          await this.account(trade.companyId, posting.account),
          posting.direction,
          posting.units.toString(),
        ],
      );
    }
    await this.db.query(
      "UPDATE ledger_entries SET status='posted' WHERE id=$1",
      [entryId],
    );
    const confirmed: Trade = {
      ...trade,
      status: "CONFIRMED",
      transactionHash: settlement.transactionHash,
      blockNumber: settlement.blockNumber,
      actualAmountIn: settlement.actualAmountIn,
      actualAmountOut: settlement.actualAmountOut,
      realizedPnlUsdg: realized?.toString() ?? null,
      failureReason: null,
      confirmedAt: settlement.confirmedAt,
    };
    await this.saveTrade(confirmed);
    return confirmed;
  }

  async realizedPnl(companyId: string) {
    const [row] = await this.db.query<{ total: string }>(
      "SELECT COALESCE(sum(realized_pnl_usdg),0)::text total FROM trades WHERE company_id=$1 AND side='SELL' AND status='CONFIRMED'",
      [companyId],
    );
    return row?.total ?? "0";
  }

  async audit(
    type: string,
    companyId: string | null,
    resourceId: string | null,
    actor: string,
    details: Record<string, string> = {},
  ) {
    await this.db.query(
      "INSERT INTO audit_events(type,company_id,resource_type,resource_id,action,metadata) VALUES($1,$2,'trading',$3,$1,$4::jsonb)",
      [type, companyId, resourceId, JSON.stringify({ actor, ...details })],
    );
  }
}
