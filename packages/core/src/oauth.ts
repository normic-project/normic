import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { AuthenticationError } from "./errors.js";
import type { EconomyRepository } from "./repository.js";
import type { AuthPrincipal } from "./types.js";

export type VerifiedOwner = { issuer: string; subject: string; email: string };
export type OAuthVerifierConfig = {
  issuer: string;
  audience: string;
  jwksUrl: string;
  keyResolver?: JWTVerifyGetKey;
};

// Only operator-configured HTTPS key sets are used. Token-controlled jku/x5u URLs
// are never followed; no signing material is present in this application.
export class OAuthTokenVerifier {
  private readonly keys: JWTVerifyGetKey;
  constructor(private readonly config: OAuthVerifierConfig) {
    for (const value of [config.issuer, config.jwksUrl]) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error(
          "OAuth issuer and JWKS URL must use HTTPS without embedded credentials.",
        );
    }
    this.keys =
      config.keyResolver ??
      createRemoteJWKSet(new URL(config.jwksUrl), {
        timeoutDuration: 5000,
        cooldownDuration: 30_000,
      });
  }
  async verify(token: string) {
    if (token.length > 16_384) throw new AuthenticationError();
    const { payload } = await jwtVerify(token, this.keys, {
      issuer: this.config.issuer,
      audience: this.config.audience,
      algorithms: ["RS256", "ES256"],
      requiredClaims: ["sub", "iat", "exp"],
      clockTolerance: 5,
    });
    return payload;
  }
  async verifyOwner(token: string): Promise<VerifiedOwner> {
    try {
      const payload = await this.verify(token);
      if (payload.email_verified !== true || !payload.sub || !payload.iss)
        throw new AuthenticationError();
      return {
        issuer: payload.iss,
        subject: payload.sub,
        email: z.email().parse(payload.email).toLowerCase(),
      };
    } catch {
      throw new AuthenticationError(
        "A valid, verified owner session is required.",
      );
    }
  }
}

export class OAuthAgentAuthenticator {
  constructor(
    private readonly repository: EconomyRepository,
    private readonly verifier: OAuthTokenVerifier,
    private readonly config: {
      issuer: string;
      audience: string;
      eventSink?: (event: { name: string }) => void;
    },
  ) {}
  async authenticate(token: string): Promise<AuthPrincipal> {
    try {
      const payload = await this.verifier.verify(token);
      const agentId = z.uuid().parse(payload.sub);
      const credentialId = z.uuid().parse(payload.normic_credential_id);
      const credential = await this.repository.getCredential(credentialId);
      const now = new Date();
      if (
        !credential ||
        credential.agentId !== agentId ||
        credential.revokedAt ||
        (credential.expiresAt && credential.expiresAt <= now) ||
        credential.issuer !== this.config.issuer ||
        credential.audience !== this.config.audience
      )
        throw new AuthenticationError();
      const agent = await this.repository.getAgent(agentId);
      if (!agent || agent.status !== "active") throw new AuthenticationError();
      const grants =
        typeof payload.scope === "string" ? payload.scope.split(" ") : [];
      const scopes = credential.scopes.filter((scope) =>
        grants.includes(scope),
      );
      const expiresAt = new Date(
        Math.min(
          payload.exp! * 1000,
          credential.expiresAt?.getTime() ?? Infinity,
        ),
      );
      await this.repository.touchCredential(credential.id, now);
      return {
        agentId,
        userId: agent.userId,
        credentialId,
        scopes,
        expiresAt,
        issuer: this.config.issuer,
        audience: this.config.audience,
      };
    } catch {
      await this.repository.createAuditEvent({
        id: crypto.randomUUID(),
        type: "authentication.failed",
        actorAgentId: null,
        companyId: null,
        resourceType: "authentication",
        resourceId: null,
        action: "authenticate",
        metadata: { reason: "invalid_oauth_access_token" },
        createdAt: new Date(),
      });
      this.config.eventSink?.({ name: "authentication_failure" });
      throw new AuthenticationError(
        "The OAuth access token is invalid or expired.",
      );
    }
  }
}
