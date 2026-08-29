import "server-only";

let modulePromise: Promise<typeof import("@normic/mcp/vercel")> | undefined;

export async function handleNormicServerRequest(request: Request) {
  modulePromise ??= import("@normic/mcp/vercel");
  return (await modulePromise).handleVercelRequest(request);
}
