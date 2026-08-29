import { withDatabase } from "./runtime.js";

await withDatabase(async (database) => {
  const [checks] = await database.query<{
    companies: number;
    services: number;
    jobs: number;
    results: number;
    demo_rows: number;
    unbalanced_entries: number;
    exposed_secrets: number;
    reconciliation_errors: number;
    invalid_payment_flags: number;
    wrong_networks: number;
    wrong_trading_networks: number;
    unjournaled_trades: number;
    mutable_settlement_sources: number;
    invalid_autonomy_bindings: number;
    missing_action_history: number;
    active_terminal_reservations: number;
    unsafe_mandates: number;
  }>(`
    SELECT
      (SELECT count(*)::int FROM companies) companies,
      (SELECT count(*)::int FROM services) services,
      (SELECT count(*)::int FROM service_jobs) jobs,
      (SELECT count(*)::int FROM service_results) results,
      (SELECT count(*)::int FROM users WHERE id IN (
        '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003')) demo_rows,
      (SELECT count(*)::int FROM (
        SELECT e.id FROM ledger_entries e JOIN ledger_postings p ON p.entry_id=e.id
        WHERE e.status='posted' GROUP BY e.id
        HAVING sum(CASE WHEN p.direction='debit' THEN COALESCE(p.token_units,p.amount_cents) ELSE 0 END)
             <> sum(CASE WHEN p.direction='credit' THEN COALESCE(p.token_units,p.amount_cents) ELSE 0 END)
      ) x) unbalanced_entries,
      (SELECT count(*)::int FROM api_credentials WHERE length(secret_hash)<>64 OR secret_hash LIKE 'nmc_%') exposed_secrets,
      (SELECT count(*)::int FROM treasuries t WHERE t.balance_cents <> COALESCE((
        SELECT sum(CASE WHEN p.direction='debit' THEN p.amount_cents ELSE -p.amount_cents END)
        FROM ledger_accounts a JOIN ledger_postings p ON p.account_id=a.id
        JOIN ledger_entries e ON e.id=p.entry_id AND e.status='posted'
        WHERE a.company_id=t.company_id AND a.code='cash'),0)) reconciliation_errors,
      (SELECT count(*)::int FROM services WHERE payment_execution<>'unavailable') invalid_payment_flags,
      (SELECT count(*)::int FROM network_configurations WHERE network_id<>'robinhood-mainnet' OR execution_available) wrong_networks,
      (SELECT count(*)::int FROM trade_settlements WHERE chain_id<>4663) wrong_trading_networks,
      (SELECT count(*)::int FROM trades t WHERE t.status='CONFIRMED' AND NOT EXISTS(
        SELECT 1 FROM trade_settlements s JOIN ledger_entries e ON e.source_trade_settlement_id=s.id AND e.company_id=t.company_id AND e.status='posted'
        WHERE s.trade_id=t.id
      )) unjournaled_trades,
      (SELECT count(*)::int FROM ledger_entries e WHERE e.source_trade_settlement_id IS NOT NULL AND e.transaction_id IS NOT NULL) mutable_settlement_sources,
      (SELECT count(*)::int FROM autonomy_action_approvals a JOIN autonomy_action_plans p ON p.id=a.plan_id
       WHERE a.action_hash<>p.action_hash) invalid_autonomy_bindings,
      (SELECT count(*)::int FROM autonomy_action_plans p
       WHERE p.status IN ('EXECUTED','FAILED','REJECTED','EXPIRED','BLOCKED') AND NOT EXISTS(
         SELECT 1 FROM autonomy_action_history h WHERE h.plan_id=p.id
       )) missing_action_history,
      (SELECT count(*)::int FROM autonomy_spend_reservations r JOIN autonomy_action_plans p ON p.id=r.plan_id
       WHERE r.status='ACTIVE' AND p.status IN ('EXECUTED','FAILED','REJECTED','EXPIRED','BLOCKED')) active_terminal_reservations,
      (SELECT count(*)::int FROM autonomy_mandates m WHERE
        (COALESCE((m.data->>'allowServiceBuying')::boolean,false) AND
          (m.data->>'maxServiceSpendUsdg' IS NULL OR m.data->>'maxTotalDailySpendUsdg' IS NULL)) OR
        (COALESCE((m.data->>'allowStockTokenTrading')::boolean,false) AND
          (m.data->>'maxTradeUsdg' IS NULL OR m.data->>'maxDailyInvestmentUsdg' IS NULL OR
           m.data->>'maxStockTokenExposureUsdg' IS NULL OR m.data->>'minimumCashReserveUsdg' IS NULL OR
           m.data->>'maxTotalDailySpendUsdg' IS NULL))) unsafe_mandates
  `);
  if (
    !checks ||
    checks.demo_rows ||
    checks.unbalanced_entries ||
    checks.exposed_secrets ||
    checks.reconciliation_errors ||
    checks.invalid_payment_flags ||
    checks.wrong_networks ||
    checks.wrong_trading_networks ||
    checks.unjournaled_trades ||
    checks.mutable_settlement_sources ||
    checks.invalid_autonomy_bindings ||
    checks.missing_action_history ||
    checks.active_terminal_reservations ||
    checks.unsafe_mandates
  ) {
    throw new Error(
      `Phase 6 database verification failed: ${JSON.stringify(checks)}`,
    );
  }
  console.log(
    `Verified Phase 6 database: ${checks.companies} real companies, ${checks.services} services, ` +
      `${checks.jobs} jobs, ${checks.results} immutable results, zero known demo rows, zero exposed secrets, ` +
      `reconciled service/trading journals, exact approval bindings, and safe autonomy mandates.`,
  );
});
