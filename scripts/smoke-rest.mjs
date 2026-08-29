import { requireIsolatedSmokeRuntime } from "./smoke-guard.mjs";
const baseUrl = process.env.NORMIC_SMOKE_URL ?? "http://127.0.0.1:3100";
await requireIsolatedSmokeRuntime(baseUrl);
const registration = await onboard(baseUrl, "rest");
const response = await fetch(`${baseUrl}/v1/identity`, {
  headers: { authorization: `Bearer ${registration.secret}` },
});
if (!response.ok)
  throw new Error(
    `REST smoke failed: ${response.status} ${await response.text()}`,
  );
const identity = await response.json();
if (identity.agent?.id !== registration.identity.agent.id)
  throw new Error("REST identity does not match the onboarded agent.");
console.log(`REST authenticated smoke passed for ${identity.agent.id}.`);
const financial = await fetch(`${baseUrl}/v1/finance/get_financial_summary`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${registration.secret}`,
  },
  body: JSON.stringify({ companyId: identity.company.id }),
});
if (!financial.ok || (await financial.json()).verifiedServiceRevenue !== "0")
  throw new Error("New companies must have zero verified revenue.");
const denied = await fetch(`${baseUrl}/v1/finance/get_wallet`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ companyId: identity.company.id }),
});
if (denied.status !== 401)
  throw new Error("Unauthenticated wallet access was not rejected.");
console.log("REST financial authentication and zero-start semantics passed.");
const trading = await fetch(`${baseUrl}/v1/trading/get_trading_capabilities`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${registration.secret}`,
  },
  body: "{}",
});
const tradingCapabilities = await trading.json();
if (
  !trading.ok ||
  tradingCapabilities.chainId !== 4663 ||
  tradingCapabilities.state !== "blocked" ||
  tradingCapabilities.stockTokenTrading !== false
)
  throw new Error(
    "Stock Token trading must truthfully report blocked in the isolated runtime.",
  );
const unauthenticatedTrading = await fetch(
  `${baseUrl}/v1/trading/get_trading_capabilities`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  },
);
if (unauthenticatedTrading.status !== 401)
  throw new Error(
    "Unauthenticated trading capability access was not rejected.",
  );
console.log(
  "REST Phase 5 authentication and fail-closed capability smoke passed.",
);
async function onboard(origin, label) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const response = await fetch(`${origin}/v1/onboarding/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `${label}-${nonce}`,
    },
    body: JSON.stringify({
      creatorEmail: `${label}-${nonce}@example.com`,
      creatorName: "Smoke Owner",
      agentName: `${label} smoke agent`,
      handle: `${label}_${nonce.slice(0, 12)}`,
      framework: "custom",
      companyName: `${label} smoke company`,
      companySlug: `${label}-${nonce.slice(0, 20)}`,
      description:
        "A real local identity created for authenticated runtime verification.",
      industry: "Verification",
      website: null,
      credentialLabel: "Smoke credential",
    }),
  });
  if (!response.ok)
    throw new Error(
      `Onboarding failed: ${response.status} ${await response.text()}`,
    );
  const value = await response.json();
  if (!value.secret)
    throw new Error("Onboarding did not return a one-time secret.");
  return value;
}
