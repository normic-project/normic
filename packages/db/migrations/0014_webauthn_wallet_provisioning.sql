-- Bind counterfactual WebAuthn-root MAv2 wallets without an external EOA owner.
-- Existing EOA-root wallet rows remain valid; no wallet or credential is created.
ALTER TABLE financial_wallets
  ADD COLUMN root_binding_id UUID UNIQUE REFERENCES financial_root_bindings(id),
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'alchemy-wallet-api'
    CHECK(provider='alchemy-wallet-api'),
  ADD COLUMN wallet_type TEXT NOT NULL DEFAULT 'erc4337-sma-b'
    CHECK(wallet_type IN ('erc4337-sma-b','erc4337-mav2-webauthn')),
  ADD CONSTRAINT financial_wallet_root_model CHECK(
    (root_binding_id IS NULL AND wallet_type='erc4337-sma-b') OR
    (root_binding_id IS NOT NULL AND owner_address=address AND wallet_type='erc4337-mav2-webauthn')
  );

-- Public COSE is reconstructed from the existing X/Y columns, never stored as
-- an arbitrary blob. No new key-material column or credential backfill is needed.
CREATE OR REPLACE FUNCTION normic_validate_financial_wallet_root()
RETURNS trigger AS $$
BEGIN
  IF NEW.root_binding_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM financial_root_bindings r
    JOIN companies c ON c.id=r.company_id AND c.owner_user_id=r.owner_user_id
    JOIN agents a ON a.id=c.primary_agent_id AND a.company_id=c.id AND a.user_id=c.owner_user_id
    JOIN financial_webauthn_credentials k ON k.root_binding_id=r.id
    WHERE r.id=NEW.root_binding_id AND r.company_id=NEW.company_id
      AND a.id=NEW.agent_id AND r.smart_account_address=NEW.address
      AND r.status='provisioned' AND r.root_identity IS NOT NULL
      AND k.purpose='primary' AND k.revoked_at IS NULL
      AND k.rp_id='normic.tech' AND k.validation_entity_id=0
      AND NEW.data->>'rootBindingId'=r.id::text
      AND NEW.data->>'address'=NEW.address
      AND NEW.data->>'ownerAddress'=NEW.owner_address
      AND NEW.data->>'companyId'=NEW.company_id::text
      AND NEW.data->>'agentId'=NEW.agent_id::text
      AND NEW.data->>'walletType'=NEW.wallet_type
      AND NEW.data->>'chainId'='4663'
  ) THEN
    RAISE EXCEPTION 'financial wallet must match the verified company WebAuthn root';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER financial_wallet_root_guard BEFORE INSERT ON financial_wallets
FOR EACH ROW EXECUTE FUNCTION normic_validate_financial_wallet_root();

-- Runtime snapshots must not circumvent the scalar immutable identity columns.
CREATE OR REPLACE FUNCTION normic_validate_financial_root_snapshot()
RETURNS trigger AS $$
BEGIN
  IF NEW.data->>'id' IS DISTINCT FROM NEW.id::text
    OR NEW.data->>'companyId' IS DISTINCT FROM NEW.company_id::text
    OR NEW.data->>'ownerUserId' IS DISTINCT FROM NEW.owner_user_id::text
    OR NEW.data->>'chainId' IS DISTINCT FROM NEW.chain_id::text
    OR NEW.data->>'rootType' IS DISTINCT FROM NEW.root_type
    OR NEW.data->>'status' IS DISTINCT FROM NEW.status
    OR NEW.data->>'rootIdentity' IS DISTINCT FROM NEW.root_identity
    OR NEW.data->>'smartAccountAddress' IS DISTINCT FROM NEW.smart_account_address
    OR NEW.data->>'accountSalt' IS DISTINCT FROM NEW.account_salt::text THEN
    RAISE EXCEPTION 'financial root snapshot must match immutable identity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER financial_root_snapshot_guard BEFORE INSERT OR UPDATE ON financial_root_bindings
FOR EACH ROW EXECUTE FUNCTION normic_validate_financial_root_snapshot();
