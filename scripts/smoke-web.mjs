const origin = process.env.NORMIC_WEB_SMOKE_URL ?? "http://127.0.0.1:3000";
for (const path of [
  "/",
  "/services",
  "/jobs",
  "/activity",
  "/leaderboard",
  "/connect",
  "/docs",
  "/owner",
  "/oauth/consent",
  "/markets",
  "/markets/CRM",
]) {
  const response = await fetch(`${origin}${path}`);
  if (!response.ok)
    throw new Error(`Web smoke failed for ${path}: ${response.status}`);
  if (["/owner", "/oauth/consent"].includes(path)) {
    if (
      response.headers.get("content-security-policy") !==
        "frame-ancestors 'none'" ||
      response.headers.get("x-frame-options") !== "DENY"
    )
      throw new Error(`Framing protection is missing on ${path}.`);
  }
  const html = await response.text();
  if (!html.includes("Normic"))
    throw new Error(`Web smoke returned unexpected content for ${path}.`);
  if (path === "/" && !html.includes("Your agents do"))
    throw new Error("The public agent-first landing page was not rendered.");
  if (path === "/owner" && !html.includes("OWNER CONTROL LAYER"))
    throw new Error("The minimal owner control layer was not rendered.");
  if (path === "/owner" && !html.includes("Checking secure session"))
    throw new Error("The session-safe Normic Account panel was not rendered.");
  if (path === "/docs" && !html.includes("AGENT DOCUMENTATION"))
    throw new Error("The agent documentation page was not rendered.");
  if (["/", "/connect", "/docs", "/owner"].includes(path)) {
    for (const forbidden of [
      /create agent/i,
      /supabase/i,
      /robinhood chain/i,
      /chain id 4663/i,
    ])
      if (forbidden.test(html))
        throw new Error(
          `Public infrastructure or agent-creation copy leaked on ${path}.`,
        );
  }
  if (path === "/jobs" && !html.includes("Authentication required"))
    throw new Error("The private jobs page did not require authentication.");
  if (
    path === "/services" &&
    process.env.NORMIC_EXPECT_EMPTY === "true" &&
    !html.includes("No services found")
  )
    throw new Error(
      "The empty database did not render its empty service state.",
    );
}
const api = await fetch(`${origin}/api`);
if (!api.ok || !api.headers.get("content-type")?.includes("application/json"))
  throw new Error("The public API index did not return JSON successfully.");
const index = await api.json();
if (
  index.name !== "Normic API" ||
  index.status !== "online" ||
  index.version !== "v1" ||
  index.routes?.status !== "/api/status" ||
  index.routes?.v1 !== "/api/v1"
)
  throw new Error("The public API index does not match its documented routes.");
for (const path of [
  "/status",
  "/services/00000000-0000-4000-8000-000000000000",
  "/company/00000000-0000-4000-8000-000000000000",
]) {
  const response = await fetch(`${origin}${path}`);
  if (response.status !== 404)
    throw new Error(`Missing resource ${path} did not return 404.`);
}
if ((await fetch(`${origin}/api/jobs`)).status !== 401)
  throw new Error("Private web jobs were accessible without credentials.");
console.log("Web runtime smoke passed for the current public routes.");
