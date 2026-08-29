import { NormicClient } from "../packages/sdk/dist/index.js";
import { requireIsolatedSmokeRuntime } from "./smoke-guard.mjs";
const baseUrl = process.env.NORMIC_SMOKE_URL;
await requireIsolatedSmokeRuntime(baseUrl);
const nonce = crypto.randomUUID().replaceAll("-", "");
const registration = await NormicClient.onboard(
  { baseUrl },
  {
    creatorEmail: `sdk-${nonce}@example.com`,
    creatorName: "SDK Owner",
    agentName: "SDK Agent",
    handle: `sdk_${nonce.slice(0, 12)}`,
    framework: "custom",
    companyName: "SDK test",
    companySlug: `sdk-${nonce.slice(0, 20)}`,
    description: "Isolated SDK verification identity.",
    industry: "Tests",
  },
  crypto.randomUUID(),
);
const client = new NormicClient({ baseUrl, apiKey: registration.secret });
const identity = await client.getIdentity();
if (!(identity.agent.createdAt instanceof Date))
  throw new Error("SDK domain dates were not restored.");
const trading = await client.trading("get_trading_capabilities", {});
if (
  trading.state !== "blocked" ||
  trading.chainId !== 4663 ||
  trading.stockTokenTrading !== false
)
  throw new Error(
    "SDK did not preserve the fail-closed Phase 5 capability state.",
  );
const service = await client.createService(
  {
    companyId: identity.company.id,
    name: `SDK ${nonce}`,
    slug: `sdk-${nonce.slice(0, 16)}`,
    description: "Isolated SDK discovery verification service.",
    category: "SDK",
    inputSchema: {},
    outputSchema: {},
    pricingModel: "free",
  },
  crypto.randomUUID(),
);
const discovery = await client.searchServices({ keyword: nonce });
if (discovery.items.length !== 1 || discovery.items[0].id !== service.id)
  throw new Error("SDK keyword discovery failed.");
const credentials = await client.createCredential(
  { label: "SDK read only", scopes: ["company:read"] },
  crypto.randomUUID(),
);
const scoped = new NormicClient({ baseUrl, apiKey: credentials.secret });
await scoped.getIdentity();
await client.revokeCredential(credentials.credential.id, crypto.randomUUID());
let denied = false;
try {
  await scoped.getIdentity();
} catch (error) {
  denied = error.status === 401;
}
if (!denied) throw new Error("SDK revocation was not enforced.");
console.log(
  "SDK onboarding, dates, Phase 5 capability parity, discovery, scoped access, and revocation passed.",
);
