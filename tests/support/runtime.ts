import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  API_SCOPES,
  NormicEconomy,
  hashApiSecret,
  type ApiCredentialRecord,
  type AuthPrincipal,
  type PermissionAction,
  type RequestContext,
} from "@normic/core";
import { createChainRegistry } from "@normic/chains";
import {
  PostgresEconomyRepository,
  createPgliteDatabase,
  findWorkspaceRoot,
} from "@normic/db";

export const TEST_ISSUER = "https://auth.test.normic";
export const TEST_AUDIENCE = "https://api.test.normic/mcp";
export async function createTestRuntime(eventSink?: (value: unknown) => void) {
  const database = await createPgliteDatabase("memory://");
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
    "0012_privy_financial_sessions.sql",
    "0013_webauthn_financial_roots.sql",
  ])
    await database.exec(
      await readFile(
        join(findWorkspaceRoot(), "packages", "db", "migrations", migration),
        "utf8",
      ),
    );
  const repository = new PostgresEconomyRepository(database);
  const economy = new NormicEconomy({
    repository,
    networks: createChainRegistry({ robinhoodMainnetEnabled: true }),
    credentialIssuer: TEST_ISSUER,
    credentialAudience: TEST_AUDIENCE,
    credentialEnvironment: "test",
    ...(eventSink ? { eventSink } : {}),
  });
  return { database, repository, economy };
}
export async function createIdentity(
  repository: PostgresEconomyRepository,
  variant: string,
  scopes = [...API_SCOPES],
) {
  const userId = crypto.randomUUID(),
    agentId = crypto.randomUUID(),
    companyId = crypto.randomUUID(),
    now = new Date();
  await repository.transaction(async (tx) => {
    await tx.createUser({
      id: userId,
      email: `${variant}-${crypto.randomUUID()}@example.com`,
      name: `${variant} owner`,
      createdAt: now,
    });
    await tx.createCompany({
      id: companyId,
      ownerUserId: userId,
      primaryAgentId: agentId,
      slug: `${variant}-${crypto.randomUUID()}`,
      name: `${variant} Company`,
      description: `A registered company for the ${variant} integration scenario.`,
      industry: "Agent services",
      website: null,
      createdAt: now,
    });
    await tx.createAgent({
      id: agentId,
      userId,
      companyId,
      name: `${variant} Agent`,
      handle: `${variant}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
      framework: "codex",
      status: "active",
      createdAt: now,
    });
    await tx.createTreasury({
      id: crypto.randomUUID(),
      companyId,
      balanceCents: 0,
      assetsCents: 0,
      liabilitiesCents: 0,
      ledgerVersion: 0,
      updatedAt: now,
    });
    await tx.ensureLedgerAccounts(companyId, now);
    const actions: PermissionAction[] = [
      "service:create",
      "service:update",
      "service:request",
      "job:accept",
      "job:process",
      "job:complete",
      "job:fail",
      "job:cancel",
    ];
    for (const action of actions)
      await tx.createPermission({
        id: crypto.randomUUID(),
        companyId,
        action,
        decision: "allow",
        limitCents: null,
        createdAt: now,
        updatedAt: now,
      });
    for (const action of ["treasury:transfer", "asset:trade"] as const)
      await tx.createPermission({
        id: crypto.randomUUID(),
        companyId,
        action,
        decision: "deny",
        limitCents: null,
        createdAt: now,
        updatedAt: now,
      });
  });
  const principal: AuthPrincipal = {
    agentId,
    userId,
    credentialId: crypto.randomUUID(),
    scopes: [...scopes],
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    expiresAt: null,
  };
  return {
    userId,
    agentId,
    companyId,
    context: { principal } satisfies RequestContext,
  };
}
export async function createCredential(
  repository: PostgresEconomyRepository,
  agentId: string,
  token: string,
  options: {
    revokedAt?: Date | null;
    expiresAt?: Date | null;
    scopes?: (typeof API_SCOPES)[number][];
  } = {},
) {
  const credential: ApiCredentialRecord = {
    id: crypto.randomUUID(),
    agentId,
    prefix: token.split("_")[2] ?? "test",
    secretHash: hashApiSecret(token),
    label: "Test credential",
    scopes: options.scopes ?? [...API_SCOPES],
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    createdAt: new Date(),
    lastUsedAt: null,
    expiresAt: options.expiresAt ?? null,
    revokedAt: options.revokedAt ?? null,
    rotatedFromId: null,
  };
  await repository.createCredential(credential);
  return credential;
}
export function serviceInput(companyId: string, variant: string) {
  return {
    companyId,
    name: `Service ${variant}`,
    slug: `service-${variant}`,
    description: `A real persisted service used for the ${variant} lifecycle scenario.`,
    category: "Operations",
    inputSchema: {
      type: "object",
      properties: { request: { type: "string" } },
    },
    outputSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
    },
    status: "active" as const,
    pricingModel: "quote" as const,
    quotedPrice: null,
    quotedCurrency: null,
  };
}
