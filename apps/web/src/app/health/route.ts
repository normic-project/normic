import { handleNormicServerRequest } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handleNormicServerRequest;
