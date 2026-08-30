import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgliteDatabase, findWorkspaceRoot } from "@normic/db";

const directory = await mkdtemp(join(tmpdir(), "normic-vercel-test-"));
process.env.NODE_ENV = "test";
process.env.VERCEL = "1";
process.env.DATABASE_URL = "";
process.env.PGLITE_DATA_DIR = directory;
process.env.NORMIC_PUBLIC_ORIGIN = "http://localhost";
process.env.NORMIC_REMOTE_MCP_URL = "http://localhost/mcp";
process.env.NORMIC_AUTH_ISSUER = "http://localhost/dev-auth";
process.env.NORMIC_AUTH_AUDIENCE = "http://localhost/mcp";
process.env.NORMIC_DEV_AUTH_ENABLED = "true";
process.env.NORMIC_NETWORK = "robinhood-mainnet";
process.env.ROBINHOOD_MAINNET_ENABLED = "true";
process.env.NORMIC_RATE_LIMIT_PER_MINUTE = "1000";

const database = await createPgliteDatabase(directory);
for (const migration of [
  "0001_initial.sql",
  "0002_phase2_persistence.sql",
  "0003_phase3_live_service_network.sql",
  "0004_phase3_security.sql",
  "0005_phase3_live_state_gate.sql",
  "0006_phase4_finance.sql",
  "0007_phase5_stock_token_trading.sql",
  "0008_phase6_autonomous_operations.sql",
  "0009_supabase_oauth_hook.sql",
  "0010_dynamic_mcp_oauth_clients.sql",
  "0011_fix_oauth_hook_subject_binding.sql",
])
  await database.exec(
    await readFile(
      join(findWorkspaceRoot(), "packages", "db", "migrations", migration),
      "utf8",
    ),
  );
await database.close();

const runtime = await import("../apps/mcp/dist/index.js");
try {
  const health = await runtime.handleVercelRequest(
    new Request("http://localhost/health"),
  );
  if (health.status !== 200) throw new Error("Vercel health route failed.");

  const unauthenticated = await runtime.handleVercelRequest(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  if (unauthenticated.status !== 401)
    throw new Error("Unauthenticated Vercel MCP route was not denied.");

  const nonce = crypto.randomUUID().replaceAll("-", "");
  const registration = await runtime.handleVercelRequest(
    new Request("http://localhost/api/v1/onboarding/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": nonce,
      },
      body: JSON.stringify({
        creatorEmail: `${nonce}@example.com`,
        creatorName: "Vercel Test Owner",
        agentName: "Vercel Test Agent",
        handle: `vercel_${nonce.slice(0, 12)}`,
        framework: "custom",
        companyName: "Vercel Test",
        companySlug: `vercel-${nonce.slice(0, 20)}`,
        description: "Isolated Vercel route verification.",
        industry: "Tests",
        website: null,
      }),
    }),
  );
  if (registration.status !== 201)
    throw new Error(`Vercel REST onboarding failed: ${registration.status}.`);
  const registered = await registration.json();
  if (!registered.secret) throw new Error("Vercel REST credential was missing.");

  const identity = await runtime.handleVercelRequest(
    new Request("http://localhost/api/v1/identity", {
      headers: { authorization: `Bearer ${registered.secret}` },
    }),
  );
  if (identity.status !== 200)
    throw new Error(`Authenticated Vercel REST route failed: ${identity.status}.`);

  const preflight = await runtime.handleVercelRequest(
    new Request("http://localhost/mcp", {
      method: "OPTIONS",
      headers: { origin: "https://normic.tech" },
    }),
  );
  if (
    preflight.status !== 204 ||
    preflight.headers.get("access-control-allow-origin") !==
      "https://normic.tech"
  )
    throw new Error("Vercel MCP CORS preflight failed.");

  console.log("Vercel MCP/REST route smoke passed with isolated test state.");
} finally {
  await runtime.closeVercelRuntimeForTest();
  await rm(directory, { recursive: true, force: true });
  await rm(`${directory}.runtime-lock`, { force: true });
}
