export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  // This index reports endpoint liveness, not dependency/capability readiness.
  return Response.json(
    {
      name: "Normic API",
      status: "online",
      version: "v1",
      routes: { status: "/api/status", v1: "/api/v1" },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
