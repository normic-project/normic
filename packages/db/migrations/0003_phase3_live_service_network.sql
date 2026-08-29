-- Phase 3 removes the known Phase 2 demo economy and introduces the live,
-- operational service network. No service lifecycle table posts to the ledger.

SET CONSTRAINTS ALL DEFERRED;

DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
DROP TRIGGER IF EXISTS ledger_postings_immutable ON ledger_postings;
DROP TRIGGER IF EXISTS ledger_entries_guard ON ledger_entries;
DROP TRIGGER IF EXISTS ledger_postings_insert_guard ON ledger_postings;

DELETE FROM ledger_postings WHERE entry_id IN (
  SELECT id FROM ledger_entries WHERE transaction_id IN (
    SELECT id FROM transactions WHERE seller_company_id IN (
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000003'
    )
  )
);
UPDATE transactions SET ledger_entry_id = NULL WHERE seller_company_id IN (
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003'
);
DELETE FROM ledger_entries WHERE transaction_id IN (
  SELECT id FROM transactions WHERE seller_company_id IN (
    '30000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000003'
  )
);
DELETE FROM transactions WHERE seller_company_id IN (
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003'
);
DELETE FROM idempotency_records WHERE agent_id IN (
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003'
);
DELETE FROM audit_events WHERE company_id IN (
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003'
);
DELETE FROM api_credentials WHERE agent_id IN (
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003'
);
DELETE FROM activities WHERE company_id IN (
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003'
);
DELETE FROM permissions WHERE company_id IN (
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003'
);
DELETE FROM treasuries WHERE company_id IN (
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003'
);
DELETE FROM ledger_accounts WHERE company_id IN (
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003'
);
DELETE FROM services WHERE company_id IN (
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003'
);
DELETE FROM agents WHERE id IN (
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003'
);
DELETE FROM companies WHERE id IN (
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003'
);
DELETE FROM users WHERE id IN (
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003'
);

CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();
CREATE TRIGGER ledger_postings_immutable
BEFORE UPDATE OR DELETE ON ledger_postings
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();
CREATE TRIGGER ledger_entries_guard
BEFORE INSERT OR UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION normic_guard_ledger_entry();
CREATE TRIGGER ledger_postings_insert_guard
BEFORE INSERT ON ledger_postings
FOR EACH ROW EXECUTE FUNCTION normic_guard_ledger_posting_insert();

ALTER TYPE service_status ADD VALUE IF NOT EXISTS 'archived';
ALTER TABLE services ADD COLUMN agent_id UUID REFERENCES agents(id) ON DELETE RESTRICT;
ALTER TABLE services ADD COLUMN input_schema JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE services ADD COLUMN output_schema JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE services ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE services ADD COLUMN pricing_model TEXT NOT NULL DEFAULT 'unavailable'
  CHECK (pricing_model IN ('free', 'fixed', 'quote', 'unavailable'));
ALTER TABLE services ADD COLUMN quoted_price TEXT;
ALTER TABLE services ADD COLUMN quoted_currency TEXT;
ALTER TABLE services ADD COLUMN payment_execution TEXT NOT NULL DEFAULT 'unavailable'
  CHECK (payment_execution = 'unavailable');
UPDATE services s SET
  agent_id = c.primary_agent_id,
  pricing_model = 'fixed',
  quoted_price = trim(to_char(s.price_cents::numeric / 100, 'FM999999999999990.00')),
  quoted_currency = 'USD'
FROM companies c WHERE c.id = s.company_id;
ALTER TABLE services ALTER COLUMN agent_id SET NOT NULL;
ALTER TABLE services DROP COLUMN price_cents;
CREATE INDEX services_agent_index ON services(agent_id, created_at DESC);
CREATE INDEX services_discovery_index ON services(status, category, created_at DESC, id);

CREATE TABLE service_invocations (
  id UUID PRIMARY KEY,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  buyer_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  provider_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  input JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created','accepted','processing','completed','failed','cancelled')),
  pricing_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  processing_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failure_reason TEXT,
  CHECK (buyer_agent_id <> provider_agent_id)
);
CREATE INDEX service_invocations_buyer_index ON service_invocations(buyer_agent_id, created_at DESC);
CREATE INDEX service_invocations_provider_index ON service_invocations(provider_agent_id, created_at DESC);

CREATE TABLE service_jobs (
  id UUID PRIMARY KEY,
  invocation_id UUID NOT NULL UNIQUE REFERENCES service_invocations(id) ON DELETE RESTRICT,
  provider_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('created','accepted','processing','completed','failed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  processing_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX service_jobs_provider_index ON service_jobs(provider_agent_id, status, created_at DESC);

CREATE TABLE service_results (
  id UUID PRIMARY KEY,
  invocation_id UUID NOT NULL UNIQUE REFERENCES service_invocations(id) ON DELETE RESTRICT,
  job_id UUID NOT NULL UNIQUE REFERENCES service_jobs(id) ON DELETE RESTRICT,
  provider_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  output JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER service_results_immutable
BEFORE UPDATE OR DELETE ON service_results
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();

CREATE TABLE onboarding_idempotency (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('processing','completed')),
  response_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ
);

CREATE TABLE rate_limit_windows (
  bucket_hash TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0)
);

DELETE FROM network_configurations;
INSERT INTO network_configurations
  (network_id, display_name, provider_key, enabled, execution_available)
VALUES ('robinhood-mainnet', 'Robinhood Chain Mainnet', 'robinhood-read-only', false, false);

COMMENT ON TABLE service_invocations IS 'Operational requests only. No payment or ledger posting is implied.';
COMMENT ON TABLE service_results IS 'Immutable provider results. Sensitive payloads must not be logged.';
COMMENT ON COLUMN services.payment_execution IS 'Phase 3 payment execution is unavailable.';
