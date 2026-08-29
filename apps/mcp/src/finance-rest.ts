import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AuthenticationError,
  financialInputs,
  financialEffect,
  parseSafeJson,
  runFinancialCommand,
  type FinancialService,
  type FinancialActor,
  type FinancialCommand,
  type VerifiedOwner,
} from "@normic/core";
import { z } from "zod";
export async function handleFinancialRest(
  request: IncomingMessage,
  response: ServerResponse,
  f: FinancialService,
  agentActor: () => Promise<FinancialActor>,
  verifyOwner?: (token: string) => Promise<VerifiedOwner>,
) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/v1/finance/")) return false;
  const name = url.pathname.slice("/v1/finance/".length);
  const send = (data: unknown) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(JSON.stringify(data));
    return true;
  };
  if (name === "capabilities" && request.method === "GET")
    return send(f.capabilities());
  if (request.method !== "POST") return false;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 262144) throw new Error("Request too large.");
    chunks.push(bytes);
  }
  const raw = parseSafeJson(Buffer.concat(chunks).toString("utf8"));
  const mutationKey = String(request.headers["idempotency-key"] ?? "");
  if (name === "wallet_challenge")
    return send(
      await f.walletChallenge(
        z.object({ wallet: z.string() }).strict().parse(raw).wallet,
        mutationKey,
      ),
    );
  if (name === "wallet_authenticate") {
    const p = z
      .object({ challengeId: z.uuid(), signature: z.string() })
      .strict()
      .parse(raw);
    return send(
      await f.authenticateWallet(p.challengeId, p.signature, mutationKey),
    );
  }
  if (!Object.hasOwn(financialInputs, name)) return false;
  const token =
    request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1] ?? "";
  let actor: FinancialActor;
  if (request.headers["x-normic-auth-mode"] === "owner") {
    if (!verifyOwner)
      throw new AuthenticationError(
        "The owner identity provider is not configured.",
      );
    actor = { kind: "owner", owner: await verifyOwner(token) };
  } else
    actor = token.startsWith("nmh_")
      ? await f.humanActor(token)
      : await agentActor();
  const command = name as FinancialCommand,
    key = String(request.headers["idempotency-key"] ?? "");
  if (financialEffect(command) !== "reads")
    z.string().min(8).max(128).parse(key);
  return send(await runFinancialCommand(f, actor, command, raw, key));
}
