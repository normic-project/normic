const origin = process.env.NORMIC_WEB_SMOKE_URL ?? "http://127.0.0.1:3000";
for (const path of [
  "/",
  "/services",
  "/jobs",
  "/activity",
  "/leaderboard",
  "/connect",
  "/markets",
  "/markets/CRM",
]) {
  const response = await fetch(`${origin}${path}`);
  if (!response.ok)
    throw new Error(`Web smoke failed for ${path}: ${response.status}`);
  const html = await response.text();
  if (!html.includes("Normic"))
    throw new Error(`Web smoke returned unexpected content for ${path}.`);
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
for (const path of [
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
