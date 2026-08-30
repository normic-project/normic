import { createRequire } from "node:module";
import { OAuthAgentAuthenticator, OAuthTokenVerifier } from "@normic/core";
import { RobinhoodMarketDataProvider } from "@normic/markets";
import { afterEach, describe, expect, it } from "vitest";
import { createNormicMcpHandler } from "../../apps/mcp/src/tools.js";
import {
  createCredential,
  createIdentity,
  createTestRuntime,
  TEST_AUDIENCE,
  TEST_ISSUER,
} from "../support/runtime.js";

type AuthInfo =
  import("../../apps/mcp/node_modules/@modelcontextprotocol/server").AuthInfo;
const requireFromMcp = createRequire(
  new URL("../../apps/mcp/package.json", import.meta.url),
);
const { getOAuthProtectedResourceMetadataUrl, requireBearerAuth } =
  requireFromMcp(
    "@modelcontextprotocol/server",
  ) as typeof import("../../apps/mcp/node_modules/@modelcontextprotocol/server");

describe("production-shaped MCP OAuth access", () => {
  let closeRuntime: (() => Promise<void>) | undefined;
  let closeHandler: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeHandler?.();
    await closeRuntime?.();
  });

  it("accepts a Supabase OAuth token without user_id for initialize and tools/list", async () => {
    const runtime = await createTestRuntime();
    closeRuntime = () => runtime.database.close();
    const identity = await createIdentity(runtime.repository, "mcp-oauth");
    const credential = await createCredential(
      runtime.repository,
      identity.agentId,
      "nmc_test_mcp_oauth_access",
      { scopes: ["company:read", "services:read"] },
    );
    const subject = crypto.randomUUID();
    const policyId = crypto.randomUUID();
    await runtime.database.query(
      "UPDATE users SET auth_issuer=$2,auth_subject=$3 WHERE id=$1",
      [identity.userId, TEST_ISSUER, subject],
    );
    await runtime.database.query(
      `INSERT INTO normic_oauth_clients
       (client_id,audience,enabled,allow_dynamic_clients)
       VALUES($1,$2,true,true)`,
      [policyId, TEST_AUDIENCE],
    );
    await runtime.database.query(
      `INSERT INTO normic_oauth_agent_grants
       (oauth_client_id,supabase_user_id,agent_id,credential_id)
       VALUES($1,$2,$3,$4)`,
      [policyId, subject, identity.agentId, credential.id],
    );

    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const verifier = new OAuthTokenVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwksUrl: `${TEST_ISSUER}/jwks`,
      keyResolver: async () => keys.publicKey,
    });
    const authenticator = new OAuthAgentAuthenticator(
      runtime.repository,
      verifier,
      { issuer: TEST_ISSUER, audience: TEST_AUDIENCE },
    );
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: subject,
      role: "authenticated",
      is_anonymous: false,
      client_id: crypto.randomUUID(),
      normic_agent_id: identity.agentId,
      normic_credential_id: credential.id,
      normic_scopes: ["company:read", "services:read"],
      iat: now,
      exp: now + 60,
    };
    const header = Buffer.from(
      JSON.stringify({ alg: "ES256", typ: "at+jwt" }),
    ).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    const token = `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;

    const gate = requireBearerAuth({
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(
        new URL(TEST_AUDIENCE),
      ),
      verifier: {
        async verifyAccessToken(value): Promise<AuthInfo> {
          const principal = await authenticator.authenticate(value);
          return {
            token: value,
            clientId: principal.agentId,
            scopes: principal.scopes,
            expiresAt: Math.floor(principal.expiresAt!.getTime() / 1000),
            resource: new URL(principal.audience),
            extra: {
              userId: principal.userId,
              credentialId: principal.credentialId,
              issuer: principal.issuer,
              audience: principal.audience,
            },
          };
        },
      },
    });
    const auth = await gate(
      new Request(TEST_AUDIENCE, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(auth).not.toBeInstanceOf(Response);
    if (auth instanceof Response) throw new Error("OAuth bearer was rejected.");

    const handler = createNormicMcpHandler(
      runtime.economy,
      new RobinhoodMarketDataProvider({ enabled: false }),
    );
    closeHandler = () => handler.close();
    const call = (body: Record<string, unknown>) =>
      handler.fetch(
        new Request(TEST_AUDIENCE, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        { authInfo: auth },
      );

    const initialized = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "oauth-regression", version: "1.0.0" },
      },
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.text()).toContain('"serverInfo"');

    const tools = await call({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(tools.status).toBe(200);
    expect(await tools.text()).toContain('"normic_get_identity"');
  });
});
