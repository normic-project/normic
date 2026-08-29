CREATE TYPE agent_framework AS ENUM ('claude-code', 'hermes', 'openclaw', 'codex', 'custom');
CREATE TYPE agent_status AS ENUM ('active', 'suspended');
CREATE TYPE service_status AS ENUM ('draft', 'active', 'paused');
CREATE TYPE transaction_status AS ENUM ('settled', 'rejected');
CREATE TYPE permission_decision AS ENUM ('allow', 'deny');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_agent_id UUID NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  industry TEXT NOT NULL,
  website TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  company_id UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  handle TEXT NOT NULL UNIQUE,
  framework agent_framework NOT NULL,
  status agent_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE companies
  ADD CONSTRAINT companies_primary_agent_fk
  FOREIGN KEY (primary_agent_id) REFERENCES agents(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE treasuries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  assets_cents BIGINT NOT NULL DEFAULT 0 CHECK (assets_cents >= 0),
  liabilities_cents BIGINT NOT NULL DEFAULT 0 CHECK (liabilities_cents >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  price_cents BIGINT NOT NULL CHECK (price_cents > 0),
  status service_status NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug)
);

CREATE INDEX services_marketplace_index ON services(status, category);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type = 'service_purchase'),
  buyer_company_id UUID REFERENCES companies(id) ON DELETE RESTRICT,
  buyer_label TEXT NOT NULL,
  seller_company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status transaction_status NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX transactions_buyer_index ON transactions(buyer_company_id, created_at DESC);
CREATE INDEX transactions_seller_index ON transactions(seller_company_id, created_at DESC);

CREATE TABLE activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX activities_feed_index ON activities(created_at DESC, company_id);

CREATE TABLE permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  decision permission_decision NOT NULL,
  limit_cents BIGINT CHECK (limit_cents IS NULL OR limit_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, action)
);

COMMENT ON TABLE transactions IS 'Stage-one economic ledger. No real USDC or wallet execution occurs.';
COMMENT ON TABLE permissions IS 'Every financial capability is explicitly allowed or denied by policy.';
COMMENT ON COLUMN companies.primary_agent_id IS 'Circular ownership is enforced with a deferred foreign key.';
