import { handleNormicServerRequest } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = handleNormicServerRequest;
export const POST = handleNormicServerRequest;
export const PATCH = handleNormicServerRequest;
export const DELETE = handleNormicServerRequest;
export const OPTIONS = handleNormicServerRequest;
