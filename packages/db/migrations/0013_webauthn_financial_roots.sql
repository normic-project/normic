-- Direct WebAuthn MAv2 root groundwork. Stores public credential material only.
-- No wallet, passkey, session, signature, or onchain operation is created here.
CREATE TABLE financial_root_bindings (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL UNIQUE REFERENCES companies(id),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  root_type TEXT NOT NULL CHECK(root_type='webauthn-mav2'),
  status TEXT NOT NULL CHECK(status IN ('pending_passkey','passkey_verified','provisioned','revoked')),
  root_identity TEXT UNIQUE CHECK(root_identity IS NULL OR root_identity ~ '^webauthn-p256:[a-f0-9]{64}$'),
  smart_account_address TEXT UNIQUE CHECK(smart_account_address IS NULL OR smart_account_address ~ '^0x[0-9a-f]{40}$'),
  account_salt NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK(account_salt=0),
  data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION normic_guard_financial_root_binding()
RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'financial root bindings are immutable';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.company_id IS DISTINCT FROM NEW.company_id
     OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
     OR OLD.chain_id IS DISTINCT FROM NEW.chain_id
     OR OLD.root_type IS DISTINCT FROM NEW.root_type
     OR OLD.account_salt IS DISTINCT FROM NEW.account_salt
     OR (OLD.root_identity IS NOT NULL AND OLD.root_identity IS DISTINCT FROM NEW.root_identity)
     OR (OLD.smart_account_address IS NOT NULL AND OLD.smart_account_address IS DISTINCT FROM NEW.smart_account_address) THEN
    RAISE EXCEPTION 'financial root identity fields are immutable';
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status='pending_passkey' AND NEW.status='passkey_verified') OR
    (OLD.status='passkey_verified' AND NEW.status='provisioned') OR
    (OLD.status IN ('pending_passkey','passkey_verified','provisioned') AND NEW.status='revoked')
  ) THEN
    RAISE EXCEPTION 'invalid financial root status transition';
  END IF;
  NEW.updated_at=now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER financial_root_bindings_guard
BEFORE UPDATE OR DELETE ON financial_root_bindings
FOR EACH ROW EXECUTE FUNCTION normic_guard_financial_root_binding();

CREATE OR REPLACE FUNCTION normic_validate_financial_root_owner()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM companies
    WHERE id=NEW.company_id AND owner_user_id=NEW.owner_user_id
  ) THEN
    RAISE EXCEPTION 'financial root owner does not own company';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER financial_root_owner_guard
BEFORE INSERT OR UPDATE ON financial_root_bindings
FOR EACH ROW EXECUTE FUNCTION normic_validate_financial_root_owner();

CREATE TABLE financial_webauthn_credentials (
  id UUID PRIMARY KEY,
  root_binding_id UUID NOT NULL REFERENCES financial_root_bindings(id),
  credential_id TEXT NOT NULL UNIQUE CHECK(length(credential_id) BETWEEN 1 AND 4096 AND credential_id ~ '^[A-Za-z0-9_-]+$'),
  public_key_x TEXT NOT NULL CHECK(public_key_x ~ '^[A-Za-z0-9_-]{43}$'),
  public_key_y TEXT NOT NULL CHECK(public_key_y ~ '^[A-Za-z0-9_-]{43}$'),
  algorithm INTEGER NOT NULL CHECK(algorithm=-7),
  rp_id TEXT NOT NULL CHECK(length(rp_id) BETWEEN 1 AND 253),
  transports JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(transports)='array'),
  validation_entity_id INTEGER NOT NULL CHECK(validation_entity_id>=0),
  purpose TEXT NOT NULL CHECK(purpose IN ('primary','recovery')),
  sign_count NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK(sign_count>=0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX one_active_primary_financial_passkey
ON financial_webauthn_credentials(root_binding_id)
WHERE purpose='primary' AND revoked_at IS NULL;

CREATE OR REPLACE FUNCTION normic_guard_financial_webauthn_credential()
RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'financial WebAuthn credentials cannot be deleted';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.root_binding_id IS DISTINCT FROM NEW.root_binding_id
     OR OLD.credential_id IS DISTINCT FROM NEW.credential_id
     OR OLD.public_key_x IS DISTINCT FROM NEW.public_key_x
     OR OLD.public_key_y IS DISTINCT FROM NEW.public_key_y
     OR OLD.algorithm IS DISTINCT FROM NEW.algorithm
     OR OLD.rp_id IS DISTINCT FROM NEW.rp_id
     OR OLD.transports IS DISTINCT FROM NEW.transports
     OR OLD.validation_entity_id IS DISTINCT FROM NEW.validation_entity_id
     OR OLD.purpose IS DISTINCT FROM NEW.purpose
     OR NEW.sign_count < OLD.sign_count
     OR (OLD.revoked_at IS NOT NULL AND OLD.revoked_at IS DISTINCT FROM NEW.revoked_at) THEN
    RAISE EXCEPTION 'financial WebAuthn credential identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER financial_webauthn_credentials_guard
BEFORE UPDATE OR DELETE ON financial_webauthn_credentials
FOR EACH ROW EXECUTE FUNCTION normic_guard_financial_webauthn_credential();

CREATE TABLE financial_webauthn_challenges (
  id UUID PRIMARY KEY,
  root_binding_id UUID NOT NULL REFERENCES financial_root_bindings(id),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  challenge_hash TEXT NOT NULL CHECK(challenge_hash ~ '^[a-f0-9]{64}$'),
  purpose TEXT NOT NULL CHECK(purpose IN ('register_primary','register_recovery','root_assertion')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_financial_webauthn_challenge
ON financial_webauthn_challenges(root_binding_id,purpose)
WHERE consumed_at IS NULL;

CREATE OR REPLACE FUNCTION normic_guard_financial_webauthn_challenge()
RETURNS trigger AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.root_binding_id IS DISTINCT FROM NEW.root_binding_id
     OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
     OR OLD.challenge_hash IS DISTINCT FROM NEW.challenge_hash
     OR OLD.purpose IS DISTINCT FROM NEW.purpose
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR (OLD.consumed_at IS NOT NULL AND OLD.consumed_at IS DISTINCT FROM NEW.consumed_at) THEN
    RAISE EXCEPTION 'financial WebAuthn challenge identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER financial_webauthn_challenges_guard
BEFORE UPDATE ON financial_webauthn_challenges
FOR EACH ROW EXECUTE FUNCTION normic_guard_financial_webauthn_challenge();
