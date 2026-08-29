import { request } from "node:http";
import { requireIsolatedSmokeRuntime } from "./smoke-guard.mjs";
const origin = process.env.NORMIC_SMOKE_URL;
await requireIsolatedSmokeRuntime(origin);
for (const path of ["/v1/jobs", "/v1/identity", "/mcp"]) {
  const response = await fetch(`${origin}${path}`, {
    method: path === "/mcp" ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    ...(path === "/mcp" ? { body: "{}" } : {}),
  });
  if (response.status !== 401)
    throw new Error(`Unauthenticated ${path} was not denied.`);
}
const nonce = crypto.randomUUID().replaceAll("-", "");
const registration = await fetch(`${origin}/v1/onboarding/register`, {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": nonce },
  body: JSON.stringify({
    creatorEmail: `${nonce}@example.com`,
    creatorName: "Test Owner",
    agentName: "Test Agent",
    handle: `test_${nonce.slice(0, 12)}`,
    framework: "custom",
    companyName: "Security Test",
    companySlug: `security-${nonce.slice(0, 20)}`,
    description: "Isolated security verification identity.",
    industry: "Tests",
    website: null,
  }),
});
const { secret } = await registration.json();
if (!secret) throw new Error("Security setup failed.");
const largeinvalid = await fetch(`${origin}/v1/services`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${secret}`,
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
  },
  body: "{invalid",
});
if (largeinvalid.status !== 400)
  throw new Error("Invalid JSON was not rejected safely.");
const status = await new Promise((resolve, reject) => {
  const req = request(
    `${origin}/mcp`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "transfer-encoding": "chunked",
      },
    },
    (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    },
  );
  req.once("error", reject);
  req.write('{"data":"');
  req.write("x".repeat(280_000));
  req.end('"}');
});
if (status !== 413)
  throw new Error(`Chunked oversized MCP payload was not rejected: ${status}.`);
console.log(
  "REST/MCP authentication, invalid JSON, and chunked payload limits passed.",
);
