ALTER TABLE companies ADD COLUMN owner_user_id UUID;
UPDATE companies c
SET owner_user_id = a.user_id
FROM agents a
WHERE a.id = c.primary_agent_id;
ALTER TABLE companies ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE companies
  ADD CONSTRAINT companies_owner_user_fk
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;
CREATE INDEX companies_owner_index ON companies(owner_user_id, created_at DESC);

ALTER TABLE services ADD COLUMN updated_at TIMESTAMPTZ;
UPDATE services SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE services ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE services ALTER COLUMN updated_at SET DEFAULT now();

ALTER TABLE permissions ADD COLUMN updated_at TIMESTAMPTZ;
UPDATE permissions SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE permissions ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE permissions ALTER COLUMN updated_at SET DEFAULT now();

ALTER TABLE treasuries ADD COLUMN ledger_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE treasuries DROP CONSTRAINT IF EXISTS treasuries_balance_cents_check;
ALTER TABLE treasuries DROP CONSTRAINT IF EXISTS treasuries_assets_cents_check;
ALTER TABLE treasuries DROP CONSTRAINT IF EXISTS treasuries_liabilities_cents_check;

ALTER TYPE transaction_status RENAME TO transaction_status_phase1;
CREATE TYPE transaction_status AS ENUM ('pending', 'posted', 'failed', 'reversed');
ALTER TABLE transactions
  ALTER COLUMN status TYPE transaction_status
  USING (CASE status::text
    WHEN 'settled' THEN 'posted'
    ELSE 'failed'
  END)::transaction_status;
DROP TYPE transaction_status_phase1;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
UPDATE transactions SET type = 'external_sale' WHERE buyer_company_id IS NULL;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('service_purchase', 'external_sale', 'reversal'));
ALTER TABLE transactions ADD COLUMN ledger_entry_id UUID;
ALTER TABLE transactions ADD COLUMN reversal_of_transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT;
ALTER TABLE transactions ADD COLUMN failure_reason TEXT;
ALTER TABLE transactions ADD COLUMN posted_at TIMESTAMPTZ;
UPDATE transactions SET posted_at = created_at WHERE status = 'posted';

CREATE TABLE api_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  prefix TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  issuer TEXT NOT NULL,
  audience TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  rotated_from_id UUID REFERENCES api_credentials(id) ON DELETE RESTRICT,
  CHECK (cardinality(scopes) > 0),
  CHECK (secret_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX api_credentials_agent_index ON api_credentials(agent_id, created_at DESC);
CREATE INDEX api_credentials_prefix_index ON api_credentials(prefix);

CREATE TYPE ledger_account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');
CREATE TYPE ledger_direction AS ENUM ('debit', 'credit');
CREATE TYPE ledger_entry_status AS ENUM ('pending', 'posted', 'failed');

CREATE TABLE ledger_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  code TEXT NOT NULL CHECK (code IN ('cash', 'service_revenue', 'service_expense', 'other_asset', 'liability')),
  name TEXT NOT NULL,
  type ledger_account_type NOT NULL,
  normal_balance ledger_direction NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
  description TEXT NOT NULL,
  status ledger_entry_status NOT NULL DEFAULT 'pending',
  reversal_of_entry_id UUID REFERENCES ledger_entries(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ
);

ALTER TABLE transactions
  ADD CONSTRAINT transactions_ledger_entry_fk
  FOREIGN KEY (ledger_entry_id) REFERENCES ledger_entries(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX transactions_ledger_entry_unique
  ON transactions(ledger_entry_id) WHERE ledger_entry_id IS NOT NULL;

CREATE TABLE ledger_postings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES ledger_entries(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  direction ledger_direction NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_postings_entry_index ON ledger_postings(entry_id);
CREATE INDEX ledger_postings_account_index ON ledger_postings(account_id, entry_id);

INSERT INTO ledger_accounts (company_id, code, name, type, normal_balance, created_at)
SELECT id, definition.code, definition.name, definition.type::ledger_account_type,
       definition.normal_balance::ledger_direction, created_at
FROM companies
CROSS JOIN (VALUES
  ('cash', 'Cash', 'asset', 'debit'),
  ('service_revenue', 'Service revenue', 'revenue', 'credit'),
  ('service_expense', 'Service expense', 'expense', 'debit'),
  ('other_asset', 'Other assets', 'asset', 'debit'),
  ('liability', 'Liabilities', 'liability', 'credit')
) AS definition(code, name, type, normal_balance)
ON CONFLICT (company_id, code) DO NOTHING;

INSERT INTO ledger_entries (transaction_id, description, status, created_at, posted_at)
SELECT id, 'Phase 1 ledger backfill for transaction ' || id::text, 'posted', created_at, created_at
FROM transactions
WHERE status = 'posted'
ON CONFLICT (transaction_id) DO NOTHING;

UPDATE transactions t
SET ledger_entry_id = e.id
FROM ledger_entries e
WHERE e.transaction_id = t.id AND t.ledger_entry_id IS NULL;

INSERT INTO ledger_postings (entry_id, account_id, direction, amount_cents, created_at)
SELECT e.id, a.id, 'debit', t.amount_cents, t.created_at
FROM transactions t
JOIN ledger_entries e ON e.transaction_id = t.id
JOIN ledger_accounts a ON a.company_id = t.seller_company_id AND a.code = 'cash'
WHERE NOT EXISTS (SELECT 1 FROM ledger_postings p WHERE p.entry_id = e.id AND p.account_id = a.id);
INSERT INTO ledger_postings (entry_id, account_id, direction, amount_cents, created_at)
SELECT e.id, a.id, 'credit', t.amount_cents, t.created_at
FROM transactions t
JOIN ledger_entries e ON e.transaction_id = t.id
JOIN ledger_accounts a ON a.company_id = t.seller_company_id AND a.code = 'service_revenue'
WHERE NOT EXISTS (SELECT 1 FROM ledger_postings p WHERE p.entry_id = e.id AND p.account_id = a.id);
INSERT INTO ledger_postings (entry_id, account_id, direction, amount_cents, created_at)
SELECT e.id, a.id, 'debit', t.amount_cents, t.created_at
FROM transactions t
JOIN ledger_entries e ON e.transaction_id = t.id
JOIN ledger_accounts a ON a.company_id = t.buyer_company_id AND a.code = 'service_expense'
WHERE t.buyer_company_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ledger_postings p WHERE p.entry_id = e.id AND p.account_id = a.id);
INSERT INTO ledger_postings (entry_id, account_id, direction, amount_cents, created_at)
SELECT e.id, a.id, 'credit', t.amount_cents, t.created_at
FROM transactions t
JOIN ledger_entries e ON e.transaction_id = t.id
JOIN ledger_accounts a ON a.company_id = t.buyer_company_id AND a.code = 'cash'
WHERE t.buyer_company_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ledger_postings p WHERE p.entry_id = e.id AND p.account_id = a.id);

CREATE TABLE idempotency_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
  response_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (agent_id, operation, idempotency_key),
  CHECK (request_hash ~ '^[a-f0-9]{64}$')
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  actor_agent_id UUID REFERENCES agents(id) ON DELETE RESTRICT,
  company_id UUID REFERENCES companies(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL,
  resource_id UUID,
  action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_company_index ON audit_events(company_id, created_at DESC);
CREATE INDEX audit_events_actor_index ON audit_events(actor_agent_id, created_at DESC);

CREATE TABLE network_configurations (
  network_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  execution_available BOOLEAN NOT NULL DEFAULT false CHECK (execution_available = false),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO network_configurations (network_id, display_name, provider_key, enabled, execution_available) VALUES
  ('base', 'Base', 'mock-base', false, false),
  ('robinhood-chain', 'Robinhood Chain', 'mock-robinhood', false, false)
ON CONFLICT (network_id) DO NOTHING;

CREATE FUNCTION normic_prevent_immutable_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();

CREATE TRIGGER ledger_postings_immutable
BEFORE UPDATE OR DELETE ON ledger_postings
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();

CREATE FUNCTION normic_guard_ledger_entry() RETURNS trigger AS $$
DECLARE
  debit_total BIGINT;
  credit_total BIGINT;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'pending' THEN
    RAISE EXCEPTION 'new ledger entries must start pending';
  END IF;
  IF TG_OP = 'DELETE' AND OLD.status = 'posted' THEN
    RAISE EXCEPTION 'posted ledger entries are immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    RAISE EXCEPTION 'posted ledger entries are immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'posted' THEN
    SELECT
      COALESCE(sum(amount_cents) FILTER (WHERE direction = 'debit'), 0),
      COALESCE(sum(amount_cents) FILTER (WHERE direction = 'credit'), 0)
    INTO debit_total, credit_total
    FROM ledger_postings WHERE entry_id = NEW.id;
    IF debit_total <= 0 OR debit_total <> credit_total THEN
      RAISE EXCEPTION 'ledger entry is not balanced';
    END IF;
    NEW.posted_at = COALESCE(NEW.posted_at, now());
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_guard
BEFORE INSERT OR UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION normic_guard_ledger_entry();

CREATE FUNCTION normic_guard_ledger_posting_insert() RETURNS trigger AS $$
DECLARE
  entry_status ledger_entry_status;
BEGIN
  SELECT status INTO entry_status FROM ledger_entries WHERE id = NEW.entry_id;
  IF entry_status IS DISTINCT FROM 'pending'::ledger_entry_status THEN
    RAISE EXCEPTION 'postings can only be added to pending ledger entries';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_postings_insert_guard
BEFORE INSERT ON ledger_postings
FOR EACH ROW EXECUTE FUNCTION normic_guard_ledger_posting_insert();

UPDATE treasuries t
SET ledger_version = balances.entry_count,
    balance_cents = balances.cash_cents,
    assets_cents = balances.assets_cents,
    liabilities_cents = balances.liabilities_cents,
    updated_at = now()
FROM (
  SELECT a.company_id,
    count(DISTINCT e.id)::bigint AS entry_count,
    COALESCE(sum(CASE WHEN a.code = 'cash' THEN
      CASE WHEN p.direction = 'debit' THEN p.amount_cents ELSE -p.amount_cents END ELSE 0 END), 0)::bigint AS cash_cents,
    COALESCE(sum(CASE WHEN a.code = 'other_asset' THEN
      CASE WHEN p.direction = 'debit' THEN p.amount_cents ELSE -p.amount_cents END ELSE 0 END), 0)::bigint AS assets_cents,
    COALESCE(sum(CASE WHEN a.code = 'liability' THEN
      CASE WHEN p.direction = 'credit' THEN p.amount_cents ELSE -p.amount_cents END ELSE 0 END), 0)::bigint AS liabilities_cents
  FROM ledger_accounts a
  LEFT JOIN ledger_postings p ON p.account_id = a.id
  LEFT JOIN ledger_entries e ON e.id = p.entry_id AND e.status = 'posted'
  GROUP BY a.company_id
) balances
WHERE balances.company_id = t.company_id;

COMMENT ON TABLE ledger_entries IS 'Immutable posted journal entries. Corrections use new reversal entries.';
COMMENT ON TABLE treasuries IS 'Reconciled projection only; ledger postings are the accounting source of truth.';
COMMENT ON TABLE api_credentials IS 'Only SHA-256 hashes of high-entropy opaque credentials are persisted.';
