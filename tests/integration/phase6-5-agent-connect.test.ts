import { afterEach, describe, expect, it } from "vitest";
import {
  createTestRuntime,
  TEST_AUDIENCE,
  TEST_ISSUER,
} from "../support/runtime.js";

describe("owner-connected external MCP identity", () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>> | undefined;

  afterEach(async () => runtime?.database.close());

  it("atomically provisions one internal identity and a trusted safe grant", async () => {
    runtime = await createTestRuntime();
    const policyId = crypto.randomUUID();
    const subject = crypto.randomUUID();
    const owner = {
      issuer: TEST_ISSUER,
      subject,
      email: "owner-connect@example.com",
    };
    await runtime.database.query(
      `INSERT INTO normic_oauth_clients
       (client_id,audience,enabled,allow_dynamic_clients)
       VALUES($1,$2,true,true)`,
      [policyId, TEST_AUDIENCE],
    );

    const first = await runtime.economy.connectExternalAgent(
      owner,
      "connect-owner-first",
    );
    const repeated = await runtime.economy.connectExternalAgent(
      owner,
      "connect-owner-repeated",
    );

    expect(repeated.identity.agent.id).toBe(first.identity.agent.id);
    expect(repeated.credential.id).toBe(first.credential.id);
    expect(first.secret).toBeNull();
    expect(first.credential.scopes).toEqual([
      "company:read",
      "company:write",
      "services:read",
      "services:write",
      "jobs:read",
      "jobs:write",
      "transactions:read",
      "markets:read",
    ]);
    expect(first.credential.scopes).not.toContain("economy:spend");
    expect(first.credential.scopes).not.toContain("portfolio:trade");

    const [counts] = await runtime.database.query<{
      users: number;
      agents: number;
      companies: number;
      grants: number;
    }>(`SELECT
      (SELECT count(*)::int FROM users) users,
      (SELECT count(*)::int FROM agents) agents,
      (SELECT count(*)::int FROM companies) companies,
      (SELECT count(*)::int FROM normic_oauth_agent_grants) grants`);
    expect(counts).toEqual({ users: 1, agents: 1, companies: 1, grants: 1 });

    const connection = await runtime.economy.getOwnerConnection(owner);
    expect(connection.connected).toBe(true);
    expect(connection.identity?.agent.id).toBe(first.identity.agent.id);
  });

  it("fails closed and rolls back when no trusted dynamic policy exists", async () => {
    runtime = await createTestRuntime();
    const owner = {
      issuer: TEST_ISSUER,
      subject: crypto.randomUUID(),
      email: "blocked-connect@example.com",
    };

    await expect(
      runtime.economy.connectExternalAgent(owner, "connect-owner-blocked"),
    ).rejects.toMatchObject({ code: "CAPABILITY_BLOCKED" });
    const [counts] = await runtime.database.query<{
      users: number;
      agents: number;
      credentials: number;
    }>(`SELECT
      (SELECT count(*)::int FROM users) users,
      (SELECT count(*)::int FROM agents) agents,
      (SELECT count(*)::int FROM api_credentials) credentials`);
    expect(counts).toEqual({ users: 0, agents: 0, credentials: 0 });
  });
});
