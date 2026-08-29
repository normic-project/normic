import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCredential,
  createIdentity,
  createTestRuntime,
  TEST_AUDIENCE,
  TEST_ISSUER,
} from "../support/runtime.js";

describe("Supabase Custom Access Token Hook", () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  let identity: Awaited<ReturnType<typeof createIdentity>>;
  let credential: Awaited<ReturnType<typeof createCredential>>;
  let clientId: string;
  let subject: string;
  let event: Record<string, unknown>;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    identity = await createIdentity(runtime.repository, "supabase-hook");
    credential = await createCredential(
      runtime.repository,
      identity.agentId,
      "nmc_test_supabase_oauth",
      { scopes: ["company:read", "services:read"] },
    );
    clientId = crypto.randomUUID();
    subject = crypto.randomUUID();
    const owner = await runtime.repository.getUser(identity.userId);
    await runtime.database.exec(`
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL,
        email_confirmed_at TIMESTAMPTZ
      );
    `);
    await runtime.database.query(
      "UPDATE users SET auth_issuer=$2, auth_subject=$3 WHERE id=$1",
      [identity.userId, TEST_ISSUER, subject],
    );
    await runtime.database.query(
      "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())",
      [subject, owner!.email],
    );
    await runtime.database.query(
      "INSERT INTO normic_oauth_clients(client_id,audience,enabled) VALUES($1,$2,true)",
      [clientId, TEST_AUDIENCE],
    );
    await runtime.database.query(
      "INSERT INTO normic_oauth_agent_grants(oauth_client_id,supabase_user_id,agent_id,credential_id) VALUES($1,$2,$3,$4)",
      [clientId, subject, identity.agentId, credential.id],
    );
    event = {
      user_id: subject,
      client_id: clientId,
      authentication_method: "oauth_provider/authorization_code",
      claims: {
        iss: TEST_ISSUER,
        aud: "authenticated",
        sub: subject,
        user_id: subject,
        client_id: clientId,
        role: "authenticated",
        exp: 2_000_000_000,
        iat: 1_900_000_000,
        user_metadata: {
          normic_agent_id: crypto.randomUUID(),
          normic_scopes: ["portfolio:trade"],
        },
        normic_agent_id: crypto.randomUUID(),
        normic_credential_id: crypto.randomUUID(),
        normic_scopes: ["portfolio:trade"],
      },
    };
  });

  afterEach(async () => runtime.database.close());

  async function invoke(value = event) {
    const [row] = await runtime.database.query<{ value: Record<string, any> }>(
      "SELECT public.normic_custom_access_token_hook($1::jsonb) value",
      [JSON.stringify(value)],
    );
    return row!.value;
  }

  it("preserves required claims and derives Normic claims from trusted rows", async () => {
    const result = await invoke();
    expect(result.claims).toMatchObject({
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: subject,
      user_id: subject,
      client_id: clientId,
      role: "authenticated",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
      normic_agent_id: identity.agentId,
      normic_credential_id: credential.id,
      normic_scopes: ["company:read", "services:read"],
      email_verified: true,
    });
    expect(result.claims.user_metadata.normic_scopes).toEqual([
      "portfolio:trade",
    ]);
  });

  it("does not alter unrelated Supabase login or OAuth-client tokens", async () => {
    const login = {
      ...event,
      authentication_method: "password",
    };
    expect(await invoke(login)).toEqual(login);
    const unrelated = {
      ...event,
      client_id: crypto.randomUUID(),
      claims: {
        ...(event.claims as Record<string, unknown>),
        client_id: crypto.randomUUID(),
      },
    };
    expect(await invoke(unrelated)).toEqual(unrelated);
  });

  it("accepts dynamic clients only through an enabled trusted policy and grant", async () => {
    await runtime.database.query(
      "UPDATE normic_oauth_clients SET allow_dynamic_clients=true WHERE client_id=$1",
      [clientId],
    );
    const dynamicClientId = crypto.randomUUID();
    const dynamicEvent = {
      ...event,
      client_id: dynamicClientId,
      claims: {
        ...(event.claims as Record<string, unknown>),
        client_id: dynamicClientId,
      },
    };

    const result = await invoke(dynamicEvent);
    expect(result.claims).toMatchObject({
      aud: TEST_AUDIENCE,
      client_id: dynamicClientId,
      normic_agent_id: identity.agentId,
      normic_credential_id: credential.id,
      normic_scopes: ["company:read", "services:read"],
    });

    await runtime.database.query(
      "UPDATE normic_oauth_agent_grants SET revoked_at=now() WHERE oauth_client_id=$1 AND supabase_user_id=$2",
      [clientId, subject],
    );
    await expect(invoke(dynamicEvent)).rejects.toThrow(/grant is unavailable/);
  });

  it("allows only one enabled dynamic-client policy", async () => {
    await runtime.database.query(
      "UPDATE normic_oauth_clients SET allow_dynamic_clients=true WHERE client_id=$1",
      [clientId],
    );
    await expect(
      runtime.database.query(
        "INSERT INTO normic_oauth_clients(client_id,audience,enabled,allow_dynamic_clients) VALUES($1,$2,true,true)",
        [crypto.randomUUID(), TEST_AUDIENCE],
      ),
    ).rejects.toThrow();
  });

  it("fails closed for invalid intended-client mappings", async () => {
    await runtime.database.query(
      "UPDATE api_credentials SET revoked_at=now() WHERE id=$1",
      [credential.id],
    );
    await expect(invoke()).rejects.toThrow(/grant is unavailable/);
    await runtime.database.query(
      "UPDATE api_credentials SET revoked_at=NULL WHERE id=$1",
      [credential.id],
    );
    await runtime.database.query(
      "UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1",
      [subject],
    );
    await expect(invoke()).rejects.toThrow(/grant is unavailable/);
  });
});
