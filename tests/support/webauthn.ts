// Test-only software authenticator. Never imported by application/runtime code.
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { createRequire } from "node:module";
import type {
  FinancialWebAuthnRegistrationResponse,
  FinancialWebAuthnAuthenticationResponse,
} from "@normic/core";
const requireCore = createRequire(
  new URL("../../packages/core/package.json", import.meta.url),
);
const { isoCBOR } = requireCore("@simplewebauthn/server/helpers") as {
  isoCBOR: { encode(value: unknown): Uint8Array };
};
export function testPasskey() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const id = randomBytes(32),
    credentialId = id.toString("base64url");
  const x = Buffer.from(jwk.x!, "base64url"),
    y = Buffer.from(jwk.y!, "base64url");
  const publicKey = `0x${x.toString("hex")}${y.toString("hex")}` as const;
  const registration = (
    challenge: string,
    input: {
      origin?: string;
      rpId?: string;
      flags?: number;
      crossOrigin?: boolean;
      curve?: number;
      privateField?: boolean;
      offCurve?: boolean;
    } = {},
  ): FinancialWebAuthnRegistrationResponse => {
    const key = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, input.curve ?? 1],
      [-2, input.offCurve ? Buffer.alloc(32) : x],
      [-3, y],
    ]);
    if (input.privateField) key.set(-4, Buffer.alloc(32));
    const length = Buffer.alloc(2);
    length.writeUInt16BE(id.length);
    const data = Buffer.concat([
      createHash("sha256")
        .update(input.rpId ?? "normic.tech")
        .digest(),
      Buffer.from([input.flags ?? 0x45]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      length,
      id,
      isoCBOR.encode(key),
    ]);
    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: Buffer.from(
          JSON.stringify({
            type: "webauthn.create",
            challenge,
            origin: input.origin ?? "https://normic.tech",
            crossOrigin: input.crossOrigin ?? false,
          }),
        ).toString("base64url"),
        attestationObject: Buffer.from(
          isoCBOR.encode(
            new Map<string, unknown>([
              ["fmt", "none"],
              ["authData", data],
              ["attStmt", new Map()],
            ]),
          ),
        ).toString("base64url"),
        transports: ["internal"],
      },
    };
  };
  const assertion = (
    challenge: string,
    counter = 1,
  ): FinancialWebAuthnAuthenticationResponse => {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const authData = Buffer.concat([
      createHash("sha256").update("normic.tech").digest(),
      Buffer.from([5]),
      count,
    ]);
    const client = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge,
        origin: "https://normic.tech",
        crossOrigin: false,
      }),
    );
    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        authenticatorData: authData.toString("base64url"),
        clientDataJSON: client.toString("base64url"),
        signature: sign(
          "sha256",
          Buffer.concat([
            authData,
            createHash("sha256").update(client).digest(),
          ]),
          pair.privateKey,
        ).toString("base64url"),
      },
    };
  };
  return { credentialId, publicKey, registration, assertion };
}
