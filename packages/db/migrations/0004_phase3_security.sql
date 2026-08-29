-- Bind human ownership to a verified external identity. No passwords or tokens.
ALTER TABLE users ADD COLUMN auth_issuer TEXT;
ALTER TABLE users ADD COLUMN auth_subject TEXT;
ALTER TABLE users ADD CONSTRAINT users_auth_pair CHECK ((auth_issuer IS NULL) = (auth_subject IS NULL));
CREATE UNIQUE INDEX users_auth_identity_unique ON users(auth_issuer, auth_subject) WHERE auth_subject IS NOT NULL;

-- Operational records cannot be repurposed to another service or counterparty.
CREATE FUNCTION normic_guard_invocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Invocation history is immutable'; END IF;
  IF (NEW.service_id, NEW.buyer_agent_id, NEW.provider_agent_id, NEW.input, NEW.pricing_snapshot, NEW.created_at)
      IS DISTINCT FROM (OLD.service_id, OLD.buyer_agent_id, OLD.provider_agent_id, OLD.input, OLD.pricing_snapshot, OLD.created_at) THEN
    RAISE EXCEPTION 'Invocation identity and agreement are immutable';
  END IF;
  IF OLD.status IN ('completed','failed','cancelled') THEN RAISE EXCEPTION 'Terminal invocation is immutable'; END IF;
  IF NOT ((OLD.status='created' AND NEW.status IN ('accepted','failed','cancelled')) OR
          (OLD.status='accepted' AND NEW.status IN ('processing','failed','cancelled')) OR
          (OLD.status='processing' AND NEW.status IN ('completed','failed'))) THEN
    RAISE EXCEPTION 'Invalid invocation transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invocation_guard BEFORE UPDATE OR DELETE ON service_invocations FOR EACH ROW EXECUTE FUNCTION normic_guard_invocation();

CREATE FUNCTION normic_verify_job_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM service_jobs j JOIN service_invocations i ON i.id=j.invocation_id
    WHERE j.id=NEW.id AND (j.status<>i.status OR j.provider_agent_id<>i.provider_agent_id)) THEN
    RAISE EXCEPTION 'Job and invocation must agree';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER job_consistency AFTER INSERT OR UPDATE ON service_jobs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION normic_verify_job_consistency();

ALTER TABLE service_invocations ADD CONSTRAINT invocation_input_object CHECK (jsonb_typeof(input)='object');
ALTER TABLE service_results ADD CONSTRAINT result_output_object CHECK (jsonb_typeof(output)='object');
ALTER TABLE services ADD CONSTRAINT service_schema_objects CHECK (jsonb_typeof(input_schema)='object' AND jsonb_typeof(output_schema)='object');
ALTER TABLE services ADD CONSTRAINT fixed_quote_metadata CHECK (pricing_model<>'fixed' OR (quoted_price IS NOT NULL AND quoted_currency IS NOT NULL));
