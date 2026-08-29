CREATE TABLE autonomy_mandates (
  company_id UUID NOT NULL REFERENCES companies(id),
  version INTEGER NOT NULL CHECK(version > 0),
  mode TEXT NOT NULL CHECK(mode IN ('MANUAL','SUPERVISED','AUTONOMOUS')),
  session_expires_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,version)
);
CREATE INDEX autonomy_mandates_current ON autonomy_mandates(company_id,version DESC);
CREATE TRIGGER autonomy_mandates_immutable BEFORE UPDATE OR DELETE ON autonomy_mandates
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();

CREATE TABLE agent_heartbeats (
  agent_id UUID PRIMARY KEY REFERENCES agents(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ONLINE','IDLE','BUSY','OFFLINE','PAUSED')),
  current_job_id UUID REFERENCES service_jobs(id),
  connected_at TIMESTAMPTZ NOT NULL,
  last_heartbeat_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX agent_heartbeats_company ON agent_heartbeats(company_id,last_heartbeat_at DESC);

CREATE TABLE autonomy_opportunities (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  kind TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('OPEN','CLAIMED','DISMISSED','EXPIRED')),
  data JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(company_id,fingerprint)
);
CREATE INDEX autonomy_opportunities_open ON autonomy_opportunities(company_id,status,created_at DESC);

CREATE TABLE autonomy_action_plans (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  credential_id UUID NOT NULL REFERENCES api_credentials(id),
  opportunity_id UUID REFERENCES autonomy_opportunities(id),
  action_type TEXT NOT NULL,
  action_hash TEXT NOT NULL CHECK(length(action_hash)=64),
  mandate_version INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('MANUAL','SUPERVISED','AUTONOMOUS')),
  status TEXT NOT NULL CHECK(status IN ('PENDING_APPROVAL','APPROVED','REJECTED','EXPIRED','EXECUTING','EXECUTED','FAILED','BLOCKED')),
  financial_amount_usdg NUMERIC(78,0) NOT NULL CHECK(financial_amount_usdg >= 0),
  transaction_reference TEXT,
  failure_code TEXT,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  executed_at TIMESTAMPTZ
);
CREATE INDEX autonomy_action_plans_company ON autonomy_action_plans(company_id,created_at DESC);
CREATE INDEX autonomy_action_plans_status ON autonomy_action_plans(company_id,status,expires_at);

CREATE TABLE autonomy_action_approvals (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL UNIQUE REFERENCES autonomy_action_plans(id),
  action_hash TEXT NOT NULL CHECK(length(action_hash)=64),
  status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','EXPIRED','EXECUTED','FAILED')),
  owner_issuer TEXT,
  owner_subject TEXT,
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE autonomy_action_history (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  opportunity_id UUID REFERENCES autonomy_opportunities(id),
  plan_id UUID NOT NULL REFERENCES autonomy_action_plans(id),
  action_type TEXT NOT NULL,
  mandate_version INTEGER NOT NULL,
  transaction_reference TEXT,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX autonomy_action_history_company ON autonomy_action_history(company_id,created_at DESC);
CREATE TRIGGER autonomy_action_history_immutable BEFORE UPDATE OR DELETE ON autonomy_action_history
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();

CREATE TABLE autonomy_spend_reservations (
  plan_id UUID PRIMARY KEY REFERENCES autonomy_action_plans(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  amount_usdg NUMERIC(78,0) NOT NULL CHECK(amount_usdg > 0),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','CONSUMED','RELEASED')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX autonomy_spend_reservations_active ON autonomy_spend_reservations(company_id,status,expires_at);

CREATE TABLE autonomy_circuit_breakers (
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  active BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  triggered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,code)
);

CREATE TABLE autonomy_idempotency (
  actor TEXT NOT NULL,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(actor,operation,key)
);

CREATE FUNCTION normic_guard_action_plan() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'action plans cannot be deleted'; END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.agent_id <> OLD.agent_id OR
     NEW.credential_id <> OLD.credential_id OR NEW.action_type <> OLD.action_type OR
     NEW.action_hash <> OLD.action_hash OR NEW.mandate_version <> OLD.mandate_version OR
     NEW.financial_amount_usdg <> OLD.financial_amount_usdg OR
     (NEW.data->'action') IS DISTINCT FROM (OLD.data->'action') THEN
    RAISE EXCEPTION 'approved action identity is immutable';
  END IF;
  IF OLD.status IN ('EXECUTED','FAILED','REJECTED','EXPIRED','BLOCKED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal action plan is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER autonomy_action_plan_guard BEFORE UPDATE OR DELETE ON autonomy_action_plans
FOR EACH ROW EXECUTE FUNCTION normic_guard_action_plan();

CREATE FUNCTION normic_guard_action_approval() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'action approvals cannot be deleted'; END IF;
  IF NEW.plan_id <> OLD.plan_id OR NEW.action_hash <> OLD.action_hash THEN
    RAISE EXCEPTION 'approval payload binding is immutable';
  END IF;
  IF OLD.status IN ('REJECTED','EXPIRED','EXECUTED','FAILED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal action approval is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER autonomy_action_approval_guard BEFORE UPDATE OR DELETE ON autonomy_action_approvals
FOR EACH ROW EXECUTE FUNCTION normic_guard_action_approval();
