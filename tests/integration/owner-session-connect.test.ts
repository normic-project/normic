import { createServer, type Server } from "node:http";
import { OAuthTokenVerifier } from "@normic/core";
import { afterEach, describe, expect, it } from "vitest";
import { handlePublicRestRequest } from "../../apps/mcp/src/rest.js";
import { ownerRequestHeaders } from "../../apps/web/src/lib/owner-request.js";
import {
  createTestRuntime,
  TEST_AUDIENCE,
  TEST_ISSUER,
} from "../support/runtime.js";

describe("production-style Supabase owner Connect Agent request", () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>> | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    await runtime?.database.close();
  });

  it("accepts a verified standard owner session without MCP claims", async () => {
    runtime = await createTestRuntime();
    const subject = crypto.randomUUID();
    const email = "verified-owner@example.com";
    const policyId = crypto.randomUUID();
    await runtime.database.query("CREATE SCHEMA auth");
    await runtime.database.query(`CREATE TABLE auth.users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL,
      email_confirmed_at TIMESTAMPTZ
    )`);
    await runtime.database.query(
      "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())",
      [subject, email],
    );
    await runtime.database.query(
      `INSERT INTO normic_oauth_clients
       (client_id,audience,enabled,allow_dynamic_clients)
       VALUES($1,$2,true,true)`,
      [policyId, TEST_AUDIENCE],
    );
    const [verifiedUser] = await runtime.database.query<{ verified: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM auth.users
         WHERE id=$1 AND email_confirmed_at IS NOT NULL
           AND lower(email)=lower($2)
       ) AS verified`,
      [subject, email],
    );
    expect(verifiedUser?.verified).toBe(true);

    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const verifier = new OAuthTokenVerifier({
      issuer: TEST_ISSUER,
      audience: "authenticated",
      jwksUrl: `${TEST_ISSUER}/jwks`,
      keyResolver: async () => keys.publicKey,
      ownerIdentityResolver: async (owner) => {
        const [user] = await runtime!.database.query<{ verified: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM auth.users
             WHERE id=$1 AND email_confirmed_at IS NOT NULL
               AND lower(email)=lower($2)
           ) AS verified`,
          [owner.subject, owner.email],
        );
        return user?.verified === true;
      },
    });
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "ES256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: TEST_ISSUER,
        aud: "authenticated",
        sub: subject,
        role: "authenticated",
        is_anonymous: false,
        email,
        session_id: crypto.randomUUID(),
        aal: "aal1",
        iat: now,
        exp: now + 60,
      }),
    ).toString("base64url");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    const accessToken = `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
    await expect(verifier.verify(accessToken)).resolves.toMatchObject({
      iss: TEST_ISSUER,
      aud: "authenticated",
      sub: subject,
    });
    await expect(verifier.verifyOwner(accessToken)).resolves.toMatchObject({
      issuer: TEST_ISSUER,
      subject,
      email,
    });

    server = createServer((request, response) => {
      void handlePublicRestRequest(
        request,
        response,
        runtime!.economy,
        (token) => verifier.verifyOwner(token),
      );
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("The test HTTP server did not bind.");

    const headers = ownerRequestHeaders(accessToken, {
      "idempotency-key": "verified-owner-connect",
    });
    const authorization = headers.get("authorization");
    expect(authorization?.startsWith("Bearer ")).toBe(true);
    expect(authorization?.length).toBe(accessToken.length + 7);
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/onboarding/connect`,
      { method: "POST", headers, body: "{}" },
    );

    const result = (await response.json()) as {
      identity: { agent: { status: string } };
      credential: { scopes: string[] };
      error?: { message?: string };
    };
    expect(response.status, result.error?.message).toBe(201);
    expect(result.identity.agent.status).toBe("active");
    expect(result.credential.scopes).toContain("services:write");
    expect(result.credential.scopes).not.toContain("economy:spend");

    await runtime.database.query(
      "UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1",
      [subject],
    );
    const denied = await fetch(
      `http://127.0.0.1:${address.port}/v1/onboarding/connect`,
      {
        method: "POST",
        headers: ownerRequestHeaders(accessToken, {
          "idempotency-key": "unverified-owner-connect",
        }),
        body: "{}",
      },
    );
    expect(denied.status).toBe(401);
  });
});
