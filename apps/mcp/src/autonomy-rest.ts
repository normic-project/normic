import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AuthenticationError,
  autonomyEffect,
  autonomyInputs,
  idempotencyKeySchema,
  parseSafeJson,
  runAutonomyCommand,
  type AutonomyActor,
  type AutonomyCommand,
  type AutonomyService,
  type VerifiedOwner,
} from "@normic/core";

export async function handleAutonomyRest(
  request: IncomingMessage,
  response: ServerResponse,
  autonomy: AutonomyService,
  agentActor: () => Promise<AutonomyActor>,
  verifyOwner?: (token: string) => Promise<VerifiedOwner>,
) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/v1/autonomy/")) return false;
  const name = url.pathname.slice("/v1/autonomy/".length);
  if (request.method !== "POST" || !Object.hasOwn(autonomyInputs, name))
    return false;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 262_144) throw new Error("Request body exceeds 256 KiB.");
    chunks.push(bytes);
  }
  const command = name as AutonomyCommand;
  const raw = chunks.length
    ? parseSafeJson(Buffer.concat(chunks).toString("utf8"))
    : {};
  const token =
    request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1] ?? "";
  let actor: AutonomyActor;
  if (request.headers["x-normic-auth-mode"] === "owner") {
    if (!verifyOwner)
      throw new AuthenticationError(
        "The owner identity provider is not configured.",
      );
    actor = { kind: "owner", owner: await verifyOwner(token) };
  } else {
    actor = await agentActor();
  }
  const key = String(request.headers["idempotency-key"] ?? "");
  if (autonomyEffect(command) !== "READ") idempotencyKeySchema.parse(key);
  const value = await runAutonomyCommand(autonomy, actor, command, raw, key);
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
  return true;
}
