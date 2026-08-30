-- Trusted, server-created Alchemy session authorization challenges. No keys,
-- balances, transactions, addresses, or provider credentials are seeded.
CREATE TABLE financial_session_authorizations (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES financial_wallets(company_id),
  public_key TEXT NOT NULL CHECK(public_key ~ '^0x[0-9a-f]{40}$'),
  provider_session_id TEXT NOT NULL UNIQUE,
  signer_ref TEXT NOT NULL UNIQUE,
  owner_authorization_payload TEXT NOT NULL CHECK(owner_authorization_payload ~ '^0x[0-9a-f]{64}$'),
  permission_digest TEXT NOT NULL CHECK(permission_digest ~ '^0x[0-9a-f]{64}$'),
  policy_version INTEGER NOT NULL CHECK(policy_version > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  data JSONB NOT NULL CHECK(jsonb_typeof(data) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX financial_session_authorizations_company_created
  ON financial_session_authorizations(company_id, created_at DESC);

CREATE FUNCTION normic_financial_session_authorization_update_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.company_id IS DISTINCT FROM NEW.company_id
    OR OLD.public_key IS DISTINCT FROM NEW.public_key
    OR OLD.provider_session_id IS DISTINCT FROM NEW.provider_session_id
    OR OLD.signer_ref IS DISTINCT FROM NEW.signer_ref
    OR OLD.owner_authorization_payload IS DISTINCT FROM NEW.owner_authorization_payload
    OR OLD.permission_digest IS DISTINCT FROM NEW.permission_digest
    OR OLD.policy_version IS DISTINCT FROM NEW.policy_version
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.consumed_at IS NOT NULL
    OR NEW.consumed_at IS NULL
  THEN
    RAISE EXCEPTION 'financial session authorization is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_session_authorization_guard
BEFORE UPDATE ON financial_session_authorizations
FOR EACH ROW EXECUTE FUNCTION normic_financial_session_authorization_update_guard();
CREATE TRIGGER financial_session_authorization_no_delete
BEFORE DELETE ON financial_session_authorizations
FOR EACH ROW EXECUTE FUNCTION normic_prevent_immutable_changes();
