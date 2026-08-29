CREATE TABLE normic_oauth_clients (
  client_id UUID PRIMARY KEY,
  audience TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (audience ~ '^https://[^[:space:]]+/mcp$')
);

CREATE TABLE normic_oauth_agent_grants (
  oauth_client_id UUID NOT NULL REFERENCES normic_oauth_clients(client_id) ON DELETE RESTRICT,
  supabase_user_id UUID NOT NULL,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  credential_id UUID NOT NULL UNIQUE REFERENCES api_credentials(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (oauth_client_id, supabase_user_id)
);

CREATE INDEX normic_oauth_agent_grants_agent
  ON normic_oauth_agent_grants(agent_id, oauth_client_id);

ALTER TABLE normic_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE normic_oauth_agent_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE normic_oauth_clients FROM PUBLIC;
REVOKE ALL ON TABLE normic_oauth_agent_grants FROM PUBLIC;

CREATE FUNCTION public.normic_custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  claims JSONB;
  authentication_method TEXT;
  client_text TEXT;
  subject_text TEXT;
  configured_client public.normic_oauth_clients%ROWTYPE;
  mapped_agent_id UUID;
  mapped_credential_id UUID;
  mapped_scopes TEXT[];
BEGIN
  IF jsonb_typeof(event) <> 'object' OR jsonb_typeof(event->'claims') <> 'object' THEN
    RAISE EXCEPTION 'Invalid access-token hook input' USING ERRCODE = '22023';
  END IF;

  claims := event->'claims';
  authentication_method := event->>'authentication_method';
  client_text := COALESCE(event->>'client_id', claims->>'client_id');

  IF authentication_method NOT IN ('oauth_provider/authorization_code', 'token_refresh')
     OR client_text IS NULL
     OR client_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN event;
  END IF;

  SELECT * INTO configured_client
  FROM public.normic_oauth_clients
  WHERE client_id = client_text::UUID;

  IF NOT FOUND THEN
    RETURN event;
  END IF;
  IF NOT configured_client.enabled THEN
    RAISE EXCEPTION 'Normic OAuth client is disabled' USING ERRCODE = '28000';
  END IF;
  IF event ? 'client_id' AND claims ? 'client_id'
     AND event->>'client_id' IS DISTINCT FROM claims->>'client_id' THEN
    RAISE EXCEPTION 'Normic OAuth client binding is invalid' USING ERRCODE = '28000';
  END IF;

  subject_text := event->>'user_id';
  IF subject_text IS NULL
     OR subject_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR claims->>'sub' IS DISTINCT FROM subject_text
     OR claims->>'user_id' IS DISTINCT FROM subject_text
     OR claims->>'iss' IS NULL THEN
    RAISE EXCEPTION 'Normic OAuth subject binding is invalid' USING ERRCODE = '28000';
  END IF;

  SELECT a.id, c.id, c.scopes
    INTO mapped_agent_id, mapped_credential_id, mapped_scopes
  FROM public.normic_oauth_agent_grants g
  JOIN public.agents a
    ON a.id = g.agent_id AND a.status = 'active'
  JOIN public.users u
    ON u.id = a.user_id
   AND u.auth_issuer = claims->>'iss'
   AND u.auth_subject = subject_text
  JOIN public.api_credentials c
    ON c.id = g.credential_id
   AND c.agent_id = a.id
   AND c.issuer = claims->>'iss'
   AND c.audience = configured_client.audience
   AND c.revoked_at IS NULL
   AND (c.expires_at IS NULL OR c.expires_at > now())
   AND cardinality(c.scopes) > 0
   AND c.scopes <@ ARRAY[
     'company:read','company:write','services:read','services:write',
     'jobs:read','jobs:write','transactions:read','markets:read',
     'economy:spend','portfolio:read','portfolio:trade'
   ]::TEXT[]
  JOIN auth.users su
    ON su.id = g.supabase_user_id
   AND su.id::TEXT = subject_text
   AND su.email_confirmed_at IS NOT NULL
   AND lower(su.email) = lower(u.email)
  WHERE g.oauth_client_id = configured_client.client_id
    AND g.supabase_user_id = subject_text::UUID
    AND g.revoked_at IS NULL;

  IF mapped_agent_id IS NULL OR mapped_credential_id IS NULL THEN
    RAISE EXCEPTION 'Normic OAuth grant is unavailable' USING ERRCODE = '28000';
  END IF;

  claims := jsonb_set(claims, '{aud}', to_jsonb(configured_client.audience), true);
  claims := jsonb_set(claims, '{normic_agent_id}', to_jsonb(mapped_agent_id::TEXT), true);
  claims := jsonb_set(claims, '{normic_credential_id}', to_jsonb(mapped_credential_id::TEXT), true);
  claims := jsonb_set(claims, '{normic_scopes}', to_jsonb(mapped_scopes), true);
  claims := jsonb_set(claims, '{email_verified}', 'true'::JSONB, true);
  RETURN jsonb_set(event, '{claims}', claims, true);
END;
$$;

REVOKE ALL ON FUNCTION public.normic_custom_access_token_hook(JSONB) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.normic_oauth_clients FROM anon';
    EXECUTE 'REVOKE ALL ON TABLE public.normic_oauth_agent_grants FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.normic_custom_access_token_hook(JSONB) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.normic_oauth_clients FROM authenticated';
    EXECUTE 'REVOKE ALL ON TABLE public.normic_oauth_agent_grants FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.normic_custom_access_token_hook(JSONB) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO supabase_auth_admin';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.normic_custom_access_token_hook(JSONB) TO supabase_auth_admin';
  END IF;
END;
$$;

COMMENT ON TABLE normic_oauth_clients IS
  'Explicit production OAuth clients and exact Normic MCP audiences. Empty and disabled by default.';
COMMENT ON TABLE normic_oauth_agent_grants IS
  'Server-controlled Supabase user/client bindings to active Normic agents and credentials.';
COMMENT ON FUNCTION public.normic_custom_access_token_hook(JSONB) IS
  'Supabase Custom Access Token Hook. Preserves unrelated tokens and fails closed for configured Normic clients.';
