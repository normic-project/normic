-- No seed data or contract addresses are inserted. All money is integer token units.
CREATE TABLE financial_indexer_lock (id INTEGER PRIMARY KEY CHECK(id=1));
INSERT INTO financial_indexer_lock VALUES(1);
CREATE TABLE financial_wallets (
  company_id UUID PRIMARY KEY REFERENCES companies(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  address TEXT NOT NULL UNIQUE CHECK (address ~ '^0x[0-9a-f]{40}$'),
  owner_address TEXT NOT NULL CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
  chain_id INTEGER NOT NULL CHECK (chain_id=4663),
  data JSONB NOT NULL CHECK (jsonb_typeof(data)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE spending_policies (
  company_id UUID PRIMARY KEY REFERENCES financial_wallets(company_id),
  enabled BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL CHECK (version>0),
  data JSONB NOT NULL CHECK (jsonb_typeof(data)='object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE wallet_transfer_observations (
  company_id UUID NOT NULL REFERENCES financial_wallets(company_id),
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  transaction_hash TEXT NOT NULL,log_index INTEGER NOT NULL,
  block_number NUMERIC(78,0) NOT NULL,block_hash TEXT NOT NULL,
  from_address TEXT NOT NULL,token_units NUMERIC(78,0) NOT NULL CHECK(token_units>=0),
  classification TEXT NOT NULL CHECK(classification IN ('capital','unattributed')),
  PRIMARY KEY(company_id,chain_id,transaction_hash,log_index)
);
CREATE TRIGGER wallet_transfers_immutable BEFORE UPDATE OR DELETE ON wallet_transfer_observations FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();
CREATE TRIGGER wallet_identity_immutable BEFORE UPDATE OR DELETE ON financial_wallets FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();
CREATE TABLE financial_sessions (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES financial_wallets(company_id),
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL CHECK (jsonb_typeof(data)='object')
);
CREATE UNIQUE INDEX one_active_financial_session ON financial_sessions(company_id) WHERE revoked_at IS NULL;
CREATE TABLE paid_invocations (
  id UUID PRIMARY KEY,
  onchain_id TEXT NOT NULL UNIQUE CHECK (onchain_id ~ '^0x[0-9a-f]{64}$'),
  service_id UUID NOT NULL REFERENCES services(id),
  provider_company_id UUID NOT NULL REFERENCES companies(id),
  provider_agent_id UUID NOT NULL REFERENCES agents(id),
  buyer_company_id UUID REFERENCES companies(id),
  buyer_agent_id UUID REFERENCES agents(id),
  buyer_wallet TEXT NOT NULL CHECK (buyer_wallet ~ '^0x[0-9a-f]{40}$'),
  amount_units NUMERIC(78,0) NOT NULL CHECK (amount_units>0),
  state TEXT NOT NULL CHECK (state IN ('payment_required','FUNDED','ACCEPTED','SUBMITTED','DISPUTED','RELEASED','REFUNDED')),
  data JSONB NOT NULL CHECK (jsonb_typeof(data)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (buyer_company_id IS NULL OR buyer_company_id<>provider_company_id),
  CHECK (buyer_agent_id IS NULL OR buyer_agent_id<>provider_agent_id)
);
CREATE INDEX paid_provider_queue ON paid_invocations(provider_agent_id,state,created_at);
CREATE TABLE payment_operations (
  id UUID PRIMARY KEY,
  invocation_id UUID NOT NULL REFERENCES paid_invocations(id),
  action TEXT NOT NULL CHECK(action IN ('fund','accept','submit','release','dispute','refund')),
  status TEXT NOT NULL CHECK(status IN ('prepared','broadcasting','submitted','confirmed','failed','unknown')),
  data JSONB NOT NULL CHECK (jsonb_typeof(data)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_live_payment_operation ON payment_operations(invocation_id,action) WHERE status<>'failed';
CREATE TABLE financial_idempotency (
  actor TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  response JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(actor,operation,key)
);
CREATE TABLE escrow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  transaction_hash TEXT NOT NULL CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
  log_index INTEGER NOT NULL CHECK(log_index>=0),
  block_number NUMERIC(78,0) NOT NULL,
  block_hash TEXT NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
  contract_address TEXT NOT NULL CHECK(contract_address ~ '^0x[0-9a-f]{40}$'),
  invocation_id TEXT NOT NULL REFERENCES paid_invocations(onchain_id),
  event_type TEXT NOT NULL,
  data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),
  observed_at TIMESTAMPTZ NOT NULL,
  UNIQUE(chain_id,transaction_hash,log_index)
);
CREATE TRIGGER escrow_events_immutable BEFORE UPDATE OR DELETE ON escrow_events
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();
CREATE TABLE financial_checkpoints (
  chain_id INTEGER PRIMARY KEY CHECK(chain_id=4663),
  block_number NUMERIC(78,0) NOT NULL,
  block_hash TEXT NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$')
);
CREATE TABLE wallet_challenges (
  id UUID PRIMARY KEY, wallet TEXT NOT NULL, message TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ
);
CREATE TABLE human_wallet_sessions (
  id UUID PRIMARY KEY, wallet TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE CHECK(secret_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE ledger_entries ALTER COLUMN transaction_id DROP NOT NULL;
ALTER TABLE ledger_entries ADD COLUMN source_event_id UUID REFERENCES escrow_events(id);
ALTER TABLE ledger_entries ADD COLUMN company_id UUID REFERENCES companies(id);
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_source_exclusive CHECK ((transaction_id IS NOT NULL AND source_event_id IS NULL) OR (transaction_id IS NULL AND source_event_id IS NOT NULL AND company_id IS NOT NULL));
CREATE UNIQUE INDEX one_event_journal_per_company ON ledger_entries(source_event_id,company_id) WHERE source_event_id IS NOT NULL;
ALTER TABLE ledger_postings ALTER COLUMN amount_cents DROP NOT NULL;
ALTER TABLE ledger_postings ADD COLUMN token_units NUMERIC(78,0) CHECK(token_units>0);
ALTER TABLE ledger_postings ADD CONSTRAINT ledger_unit_exclusive CHECK ((amount_cents IS NOT NULL AND token_units IS NULL) OR (amount_cents IS NULL AND token_units IS NOT NULL));

CREATE OR REPLACE FUNCTION normic_guard_ledger_entry() RETURNS trigger AS $$
DECLARE debit_total NUMERIC(78,0); credit_total NUMERIC(78,0); invalid_count INTEGER;
BEGIN
  IF TG_OP='INSERT' AND NEW.status<>'pending' THEN RAISE EXCEPTION 'new ledger entries must start pending'; END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.status='posted' THEN RAISE EXCEPTION 'posted ledger entries are immutable'; END IF;
  IF TG_OP='UPDATE' AND NEW.status='posted' THEN
    SELECT COALESCE(sum(COALESCE(token_units,amount_cents)) FILTER (WHERE direction='debit'),0),
           COALESCE(sum(COALESCE(token_units,amount_cents)) FILTER (WHERE direction='credit'),0),
           count(*) FILTER (WHERE (NEW.source_event_id IS NOT NULL AND (token_units IS NULL OR a.company_id<>NEW.company_id)) OR (NEW.source_event_id IS NULL AND amount_cents IS NULL))
    INTO debit_total,credit_total,invalid_count FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id WHERE entry_id=NEW.id;
    IF debit_total<=0 OR debit_total<>credit_total OR invalid_count>0 THEN RAISE EXCEPTION 'ledger entry is not balanced or mixes denominations/companies'; END IF;
    NEW.posted_at=COALESCE(NEW.posted_at,now());
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE FUNCTION normic_guard_paid_invocation() RETURNS trigger AS $$
BEGIN
  IF NEW.onchain_id<>OLD.onchain_id OR NEW.service_id<>OLD.service_id OR NEW.amount_units<>OLD.amount_units OR NEW.buyer_wallet<>OLD.buyer_wallet
     OR NEW.data->'terms' IS DISTINCT FROM OLD.data->'terms' OR NEW.data->'input' IS DISTINCT FROM OLD.data->'input'
     OR NEW.provider_company_id<>OLD.provider_company_id OR NEW.provider_agent_id<>OLD.provider_agent_id
     OR NEW.buyer_company_id IS DISTINCT FROM OLD.buyer_company_id OR NEW.buyer_agent_id IS DISTINCT FROM OLD.buyer_agent_id
     OR NEW.data->'serviceVersion' IS DISTINCT FROM OLD.data->'serviceVersion'
     OR (OLD.data->'resultSalt' IS NOT NULL AND NEW.data->'resultSalt' IS DISTINCT FROM OLD.data->'resultSalt')
     OR (OLD.data->'output'<>'null'::jsonb AND NEW.data->'output' IS DISTINCT FROM OLD.data->'output')
     OR (OLD.data->'resultHash'<>'null'::jsonb AND NEW.data->'resultHash' IS DISTINCT FROM OLD.data->'resultHash') THEN
    RAISE EXCEPTION 'paid invocation agreement and result are immutable';
  END IF;
  IF OLD.state IN ('RELEASED','REFUNDED') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'terminal escrow state is immutable'; END IF;
  IF NEW.state<>OLD.state AND NOT (
    (OLD.state='payment_required' AND NEW.state='FUNDED') OR
    (OLD.state='FUNDED' AND NEW.state IN ('ACCEPTED','REFUNDED')) OR
    (OLD.state='ACCEPTED' AND NEW.state IN ('SUBMITTED','REFUNDED')) OR
    (OLD.state='SUBMITTED' AND NEW.state IN ('RELEASED','DISPUTED')) OR
    (OLD.state='DISPUTED' AND NEW.state IN ('RELEASED','REFUNDED'))
  ) THEN RAISE EXCEPTION 'invalid escrow transition'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER paid_invocation_guard BEFORE UPDATE ON paid_invocations FOR EACH ROW EXECUTE FUNCTION normic_guard_paid_invocation();
CREATE TRIGGER paid_invocation_no_delete BEFORE DELETE ON paid_invocations FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();
COMMENT ON COLUMN ledger_postings.token_units IS 'Exact canonical USDG base units. Never converted to legacy cents.';
