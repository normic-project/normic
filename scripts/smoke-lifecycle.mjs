import { requireIsolatedSmokeRuntime } from "./smoke-guard.mjs";
const origin = process.env.NORMIC_SMOKE_URL ?? "http://127.0.0.1:3100";
await requireIsolatedSmokeRuntime(origin);
const provider = await onboard("provider"),
  buyer = await onboard("buyer");
const service = await mutate(provider.secret, "/v1/services", {
  companyId: provider.identity.company.id,
  name: "Lifecycle verification",
  slug: `lifecycle-${crypto.randomUUID().slice(0, 8)}`,
  description:
    "A real local service created to verify the complete operational lifecycle.",
  category: "Verification",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  status: "active",
  pricingModel: "unavailable",
  quotedPrice: null,
  quotedCurrency: null,
});
let view = await mutate(buyer.secret, "/v1/invocations", {
  serviceId: service.id,
  input: { request: "verify" },
});
view = await mutate(provider.secret, `/v1/jobs/${view.job.id}/accept`, {});
view = await mutate(provider.secret, `/v1/jobs/${view.job.id}/start`, {});
view = await mutate(provider.secret, `/v1/jobs/${view.job.id}/result`, {
  output: { verified: true },
});
if (view.invocation.status !== "completed")
  throw new Error("Lifecycle did not complete.");
const balance = await get(
  provider.secret,
  `/v1/companies/${provider.identity.company.id}/balance`,
);
if (balance.state !== "unavailable")
  throw new Error(
    "A company without a real wallet received a fabricated balance.",
  );
const summary = await raw(
  provider.secret,
  "/v1/finance/get_financial_summary",
  { companyId: provider.identity.company.id },
);
if (
  summary.verifiedServiceRevenue !== "0" ||
  summary.serviceExpenses !== "0" ||
  summary.restrictedEscrow !== "0"
)
  throw new Error("Free service lifecycle changed finalized accounting.");
console.log(
  "REST service lifecycle smoke passed with zero financial side effects.",
);
async function onboard(label) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return raw("", "/v1/onboarding/register", {
    creatorEmail: `${label}-${nonce}@example.com`,
    creatorName: "Lifecycle Owner",
    agentName: `${label} lifecycle agent`,
    handle: `${label}_${nonce.slice(0, 12)}`,
    framework: "custom",
    companyName: `${label} lifecycle company`,
    companySlug: `${label}-${nonce.slice(0, 20)}`,
    description:
      "A real local identity created for lifecycle runtime verification.",
    industry: "Verification",
    website: null,
    credentialLabel: "Lifecycle credential",
  });
}
async function mutate(token, path, body) {
  return raw(token, path, body);
}
async function raw(token, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      `${path} failed: ${response.status} ${await response.text()}`,
    );
  return response.json();
}
async function get(token, path) {
  const response = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok)
    throw new Error(
      `${path} failed: ${response.status} ${await response.text()}`,
    );
  return response.json();
}
