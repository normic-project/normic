-- Phase 5: real Robinhood Chain Stock Token trading state. No rows, balances,
-- assets, quotes, or provider configuration are seeded by this migration.

ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS ledger_accounts_code_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_code_check
  CHECK (code IN (
    'cash','service_revenue','service_expense','other_asset','liability',
    'stock_asset','trading_pnl'
  ));

INSERT INTO ledger_accounts (company_id,code,name,type,normal_balance,created_at)
SELECT id,'stock_asset','Stock Token cost basis','asset','debit',created_at FROM companies
ON CONFLICT(company_id,code) DO NOTHING;
INSERT INTO ledger_accounts (company_id,code,name,type,normal_balance,created_at)
SELECT id,'trading_pnl','Realized trading PnL','revenue','credit',created_at FROM companies
ON CONFLICT(company_id,code) DO NOTHING;

CREATE TABLE trading_eligibility (
  company_id UUID PRIMARY KEY REFERENCES companies(id),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK(state IN ('UNKNOWN','PENDING','ELIGIBLE','INELIGIBLE','EXPIRED')),
  provider TEXT,rules_version TEXT,attestation_id TEXT,
  verified_at TIMESTAMPTZ,expires_at TIMESTAMPTZ,reason_code TEXT,
  version INTEGER NOT NULL CHECK(version>0),
  data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trading_policies (
  company_id UUID PRIMARY KEY REFERENCES financial_wallets(company_id),
  enabled BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL CHECK(version>0),
  data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trading_sessions (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES financial_wallets(company_id),
  public_key TEXT NOT NULL CHECK(public_key ~ '^0x[0-9a-f]{40}$'),
  provider_session_id TEXT NOT NULL,
  authorization_ref TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK(policy_version>0),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_trading_session
  ON trading_sessions(company_id) WHERE revoked_at IS NULL;

CREATE TABLE trade_quotes (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL CHECK(status IN ('QUOTED','EXPIRED','CONSUMED')),
  expires_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trade_quotes_company_created ON trade_quotes(company_id,created_at DESC);

CREATE TABLE trades (
  id UUID PRIMARY KEY,
  quote_id UUID NOT NULL UNIQUE REFERENCES trade_quotes(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  wallet TEXT NOT NULL CHECK(wallet ~ '^0x[0-9a-f]{40}$'),
  asset_id TEXT NOT NULL CHECK(asset_id ~ '^0x[0-9a-f]{64}$'),
  asset_address TEXT NOT NULL CHECK(asset_address ~ '^0x[0-9a-f]{40}$'),
  side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  status TEXT NOT NULL CHECK(status IN (
    'PROPOSED','QUOTED','POLICY_APPROVED','SIMULATED','SUBMITTED','PENDING','CONFIRMED',
    'REJECTED','QUOTE_EXPIRED','SIMULATION_FAILED','REVERTED','CANCELLED'
  )),
  provider_call_id TEXT,
  transaction_hash TEXT CHECK(transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
  block_number NUMERIC(78,0),
  actual_amount_in NUMERIC(78,0),
  actual_amount_out NUMERIC(78,0),
  realized_pnl_usdg NUMERIC(78,0),
  failure_reason TEXT,
  data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),
  created_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ
);
CREATE INDEX trades_company_created ON trades(company_id,created_at DESC);
CREATE UNIQUE INDEX trades_provider_call_unique ON trades(provider_call_id) WHERE provider_call_id IS NOT NULL;
CREATE UNIQUE INDEX trades_transaction_unique ON trades(transaction_hash) WHERE transaction_hash IS NOT NULL;

CREATE TABLE trade_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID NOT NULL UNIQUE REFERENCES trades(id),
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  transaction_hash TEXT NOT NULL UNIQUE CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
  block_number NUMERIC(78,0) NOT NULL,
  block_hash TEXT NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
  wallet TEXT NOT NULL CHECK(wallet ~ '^0x[0-9a-f]{40}$'),
  input_token TEXT NOT NULL CHECK(input_token ~ '^0x[0-9a-f]{40}$'),
  output_token TEXT NOT NULL CHECK(output_token ~ '^0x[0-9a-f]{40}$'),
  actual_amount_in NUMERIC(78,0) NOT NULL CHECK(actual_amount_in>0),
  actual_amount_out NUMERIC(78,0) NOT NULL CHECK(actual_amount_out>0),
  data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),
  confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trade_settlements_immutable BEFORE UPDATE OR DELETE ON trade_settlements
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();

CREATE TABLE position_lots (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  asset_id TEXT NOT NULL CHECK(asset_id ~ '^0x[0-9a-f]{64}$'),
  asset_address TEXT NOT NULL CHECK(asset_address ~ '^0x[0-9a-f]{40}$'),
  symbol TEXT NOT NULL,
  source_trade_id UUID NOT NULL UNIQUE REFERENCES trades(id),
  original_raw_units NUMERIC(78,0) NOT NULL CHECK(original_raw_units>0),
  remaining_raw_units NUMERIC(78,0) NOT NULL CHECK(remaining_raw_units>=0),
  original_cost_usdg NUMERIC(78,0) NOT NULL CHECK(original_cost_usdg>0),
  remaining_cost_usdg NUMERIC(78,0) NOT NULL CHECK(remaining_cost_usdg>=0),
  multiplier_at_buy NUMERIC(78,0) NOT NULL CHECK(multiplier_at_buy>0),
  created_at TIMESTAMPTZ NOT NULL,
  CHECK(remaining_raw_units<=original_raw_units),
  CHECK(remaining_cost_usdg<=original_cost_usdg)
);
CREATE INDEX position_lots_fifo
  ON position_lots(company_id,asset_id,created_at,id) WHERE remaining_raw_units>0;

CREATE TABLE trading_idempotency (
  actor TEXT NOT NULL,operation TEXT NOT NULL,key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  response JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(actor,operation,key)
);

CREATE TABLE trading_venue_configs (
  version TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  venue TEXT NOT NULL,
  quote_origin TEXT NOT NULL,
  allowed_targets TEXT[] NOT NULL CHECK(cardinality(allowed_targets)>0),
  allowed_spenders TEXT[] NOT NULL CHECK(cardinality(allowed_spenders)>0),
  allowed_sources TEXT[] NOT NULL CHECK(cardinality(allowed_sources)>0),
  active BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_trading_venue_config ON trading_venue_configs(chain_id) WHERE active;

CREATE TABLE oracle_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL UNIQUE REFERENCES trade_quotes(id),
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  asset_id TEXT NOT NULL,feed TEXT NOT NULL,round_id TEXT NOT NULL,
  price_units NUMERIC(78,0) NOT NULL CHECK(price_units>0),decimals INTEGER NOT NULL,
  block_number NUMERIC(78,0) NOT NULL,updated_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER oracle_snapshots_immutable BEFORE UPDATE OR DELETE ON oracle_snapshots
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();

CREATE TABLE token_approval_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  wallet TEXT NOT NULL,token TEXT NOT NULL,spender TEXT NOT NULL,
  allowance NUMERIC(78,0) NOT NULL CHECK(allowance>=0),
  block_number NUMERIC(78,0) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER token_approval_snapshots_immutable BEFORE UPDATE OR DELETE ON token_approval_snapshots
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();

CREATE TABLE portfolio_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  block_number NUMERIC(78,0) NOT NULL,
  reconciled BOOLEAN NOT NULL,
  data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER portfolio_reconciliations_immutable BEFORE UPDATE OR DELETE ON portfolio_reconciliations
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();

ALTER TABLE ledger_entries ADD COLUMN source_trade_settlement_id UUID REFERENCES trade_settlements(id);
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_source_exclusive;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_source_exclusive CHECK (
  (transaction_id IS NOT NULL)::int +
  (source_event_id IS NOT NULL)::int +
  (source_trade_settlement_id IS NOT NULL)::int = 1
  AND ((transaction_id IS NOT NULL) OR company_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_trade_settlement_journal_per_company
  ON ledger_entries(source_trade_settlement_id,company_id)
  WHERE source_trade_settlement_id IS NOT NULL;

CREATE OR REPLACE FUNCTION normic_guard_ledger_entry() RETURNS trigger AS $$
DECLARE debit_total NUMERIC(78,0); credit_total NUMERIC(78,0); invalid_count INTEGER;
BEGIN
  IF TG_OP='INSERT' AND NEW.status<>'pending' THEN RAISE EXCEPTION 'new ledger entries must start pending'; END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.status='posted' THEN RAISE EXCEPTION 'posted ledger entries are immutable'; END IF;
  IF TG_OP='UPDATE' AND NEW.status='posted' THEN
    SELECT COALESCE(sum(COALESCE(token_units,amount_cents)) FILTER (WHERE direction='debit'),0),
           COALESCE(sum(COALESCE(token_units,amount_cents)) FILTER (WHERE direction='credit'),0),
           count(*) FILTER (WHERE
             ((NEW.source_event_id IS NOT NULL OR NEW.source_trade_settlement_id IS NOT NULL)
               AND (token_units IS NULL OR a.company_id<>NEW.company_id))
             OR (NEW.transaction_id IS NOT NULL AND amount_cents IS NULL))
    INTO debit_total,credit_total,invalid_count
    FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id WHERE entry_id=NEW.id;
    IF debit_total<=0 OR debit_total<>credit_total OR invalid_count>0 THEN RAISE EXCEPTION 'ledger entry is not balanced or mixes denominations/companies'; END IF;
    NEW.posted_at=COALESCE(NEW.posted_at,now());
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE FUNCTION normic_guard_trade_quote() RETURNS trigger AS $$
BEGIN
  IF OLD.company_id<>NEW.company_id OR OLD.agent_id<>NEW.agent_id OR OLD.expires_at<>NEW.expires_at
     OR OLD.data - 'status' IS DISTINCT FROM NEW.data - 'status' THEN
    RAISE EXCEPTION 'trade quote terms are immutable';
  END IF;
  IF OLD.status<>'QUOTED' OR NEW.status NOT IN ('EXPIRED','CONSUMED') THEN
    RAISE EXCEPTION 'invalid trade quote transition';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trade_quote_guard BEFORE UPDATE ON trade_quotes
FOR EACH ROW EXECUTE FUNCTION normic_guard_trade_quote();
CREATE TRIGGER trade_quote_no_delete BEFORE DELETE ON trade_quotes
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();

CREATE FUNCTION normic_guard_trade() RETURNS trigger AS $$
BEGIN
  IF OLD.quote_id<>NEW.quote_id OR OLD.company_id<>NEW.company_id OR OLD.agent_id<>NEW.agent_id
     OR OLD.wallet<>NEW.wallet OR OLD.asset_id<>NEW.asset_id OR OLD.asset_address<>NEW.asset_address
     OR OLD.side<>NEW.side OR OLD.created_at<>NEW.created_at
     OR OLD.data - ARRAY['status','providerCallId','transactionHash','blockNumber','actualAmountIn','actualAmountOut','realizedPnlUsdg','failureReason','submittedAt','confirmedAt']
        IS DISTINCT FROM
        NEW.data - ARRAY['status','providerCallId','transactionHash','blockNumber','actualAmountIn','actualAmountOut','realizedPnlUsdg','failureReason','submittedAt','confirmedAt'] THEN
    RAISE EXCEPTION 'trade agreement is immutable';
  END IF;
  IF OLD.status IN ('CONFIRMED','REJECTED','QUOTE_EXPIRED','SIMULATION_FAILED','REVERTED','CANCELLED')
     AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'terminal trade is immutable'; END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='POLICY_APPROVED' AND NEW.status IN ('SIMULATED','SIMULATION_FAILED','REJECTED')) OR
    (OLD.status='SIMULATED' AND NEW.status IN ('SUBMITTED','PENDING','REJECTED','REVERTED')) OR
    (OLD.status='SUBMITTED' AND NEW.status IN ('PENDING','CONFIRMED','REVERTED')) OR
    (OLD.status='PENDING' AND NEW.status IN ('CONFIRMED','REVERTED'))
  ) THEN RAISE EXCEPTION 'invalid trade transition'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trade_guard BEFORE UPDATE ON trades FOR EACH ROW EXECUTE FUNCTION normic_guard_trade();
CREATE TRIGGER trade_no_delete BEFORE DELETE ON trades
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();

COMMENT ON TABLE trade_settlements IS 'Immutable finalized Robinhood Chain trade evidence; never populated from submission responses.';
COMMENT ON TABLE position_lots IS 'FIFO execution-accounting lots in raw token units and canonical USDG base-unit cost.';
