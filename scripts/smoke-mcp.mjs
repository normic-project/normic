import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { requireIsolatedSmokeRuntime } from "./smoke-guard.mjs";
const origin = process.env.NORMIC_SMOKE_URL ?? "http://127.0.0.1:3100";
await requireIsolatedSmokeRuntime(origin);
const nonce = crypto.randomUUID().replaceAll("-", "");
const onboarding = await fetch(`${origin}/v1/onboarding/register`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": `mcp-${nonce}`,
  },
  body: JSON.stringify({
    creatorEmail: `mcp-${nonce}@example.com`,
    creatorName: "MCP Owner",
    agentName: "MCP smoke agent",
    handle: `mcp_${nonce.slice(0, 12)}`,
    framework: "custom",
    companyName: "MCP smoke company",
    companySlug: `mcp-${nonce.slice(0, 20)}`,
    description: "A real local identity created for MCP runtime verification.",
    industry: "Verification",
    website: null,
    credentialLabel: "MCP smoke credential",
  }),
});
if (!onboarding.ok)
  throw new Error(
    `MCP onboarding failed: ${onboarding.status} ${await onboarding.text()}`,
  );
const { secret, identity } = await onboarding.json();
const client = new Client({ name: "normic-phase5-smoke", version: "0.5.0" });
const transport = new StreamableHTTPClientTransport(
  new URL(process.env.NORMIC_MCP_SMOKE_URL ?? `${origin}/mcp`),
  { authProvider: { token: async () => secret } },
);
try {
  await client.connect(transport);
  const response = await client.callTool({
    name: "normic_get_identity",
    arguments: {},
  });
  if (response.isError)
    throw new Error("normic_get_identity returned an MCP error.");
  const tools = await client.listTools();
  for (const tool of tools.tools)
    if (
      typeof tool.description !== "string" ||
      tool.description.trim().length < 20 ||
      !tool.inputSchema ||
      tool.inputSchema.type !== "object"
    )
      throw new Error(`MCP discovery metadata is incomplete for ${tool.name}.`);
  for (const name of [
    "normic_request_service",
    "normic_submit_result",
    "normic_list_stock_tokens",
    "normic_search_services",
    "normic_get_service",
    "normic_get_my_jobs",
    "normic_cancel_job",
    "normic_get_stock_price",
    "normic_get_wallet",
    "normic_get_spending_policy",
    "normic_fund_service",
    "normic_get_financial_summary",
    "normic_confirm_payment",
    "normic_get_trading_capabilities",
    "normic_get_portfolio",
    "normic_get_investable_balance",
    "normic_get_trading_policy",
    "normic_get_trading_eligibility",
    "normic_quote_stock_token",
    "normic_buy_stock_token",
    "normic_sell_stock_token",
    "normic_reconcile_trade",
    "normic_get_trades",
    "normic_get_token_approvals",
  ])
    if (!tools.tools.some((tool) => tool.name === name))
      throw new Error(`Missing MCP tool ${name}.`);
  const balance = await client.callTool({
    name: "normic_get_balance",
    arguments: { identifier: identity.company.id },
  });
  if (balance.isError || !JSON.stringify(balance).includes("unavailable"))
    throw new Error("Missing wallets must not produce fabricated balances.");
  const trading = await client.callTool({
    name: "normic_get_trading_capabilities",
    arguments: {},
  });
  if (
    trading.isError ||
    !JSON.stringify(trading).includes("blocked") ||
    !JSON.stringify(trading).includes("4663")
  )
    throw new Error("MCP must expose the truthful fail-closed trading state.");
  console.log(
    "MCP authenticated smoke passed with Phase 5 tools and fail-closed execution semantics.",
  );
} finally {
  await client.close();
}
