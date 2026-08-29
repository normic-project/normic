import { createHash, randomBytes } from "node:crypto";
import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
} from "./errors.js";
import type { EconomyRepository } from "./repository.js";
import type {
  ApiCredential,
  ApiCredentialRecord,
  ApiScope,
  AuditEvent,
  AuthPrincipal,
  RequestContext,
} from "./types.js";

export type AuthenticatorOptions = {
  issuer: string;
  audience: string;
  clock?: () => Date;
  idGenerator?: () => string;
  eventSink?: (event: {
    name: "authentication_failure";
    reason: string;
  }) => void;
};

export class ApiCredentialAuthenticator {
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(
    private readonly repository: EconomyRepository,
    private readonly options: AuthenticatorOptions,
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async authenticate(token: string | null): Promise<AuthPrincipal> {
    const now = this.clock();
    if (!token || !token.startsWith("nmc_")) {
      await this.auditFailure("missing_or_malformed", now);
      throw new AuthenticationError();
    }

    const credential = await this.repository.getCredentialByHash(
      hashApiSecret(token),
    );
    if (!credential) {
      await this.auditFailure("unknown_credential", now);
      throw new AuthenticationError();
    }
    if (credential.revokedAt) {
      await this.auditFailure("revoked_credential", now, credential.agentId);
      throw new AuthenticationError("The bearer credential has been revoked.");
    }
    if (
      credential.expiresAt &&
      credential.expiresAt.getTime() <= now.getTime()
    ) {
      await this.auditFailure("expired_credential", now, credential.agentId);
      throw new AuthenticationError("The bearer credential has expired.");
    }
    if (credential.issuer !== this.options.issuer) {
      await this.auditFailure("invalid_issuer", now, credential.agentId);
      throw new AuthenticationError("The bearer credential issuer is invalid.");
    }
    if (credential.audience !== this.options.audience) {
      await this.auditFailure("invalid_audience", now, credential.agentId);
      throw new AuthenticationError(
        "The bearer credential audience is invalid.",
      );
    }

    const agent = await this.repository.getAgent(credential.agentId);
    if (!agent || agent.status !== "active") {
      await this.auditFailure("inactive_agent", now, credential.agentId);
      throw new AuthenticationError("The credential agent is not active.");
    }

    await this.repository.touchCredential(credential.id, now);
    return {
      agentId: agent.id,
      userId: agent.userId,
      credentialId: credential.id,
      scopes: credential.scopes,
      issuer: credential.issuer,
      audience: credential.audience,
      expiresAt: credential.expiresAt,
    };
  }

  private async auditFailure(
    reason: string,
    createdAt: Date,
    agentId: string | null = null,
  ) {
    const event: AuditEvent = {
      id: this.idGenerator(),
      type: "authentication.failed",
      actorAgentId: agentId,
      companyId: null,
      resourceType: "authentication",
      resourceId: null,
      action: "authenticate",
      metadata: { reason },
      createdAt,
    };
    await this.repository.createAuditEvent(event);
    this.options.eventSink?.({ name: "authentication_failure", reason });
  }
}

export function issueApiSecret(environment = "live"): {
  secret: string;
  prefix: string;
} {
  const prefix = randomBytes(4).toString("hex");
  const secret = `nmc_${environment}_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { secret, prefix };
}

export function hashApiSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function publicCredential(record: ApiCredentialRecord): ApiCredential {
  const { secretHash: _secretHash, ...credential } = record;
  return credential;
}

export type CredentialIssueResult = {
  credential: ApiCredential;
  secret: string | null;
  secretShown: boolean;
};

export function credentialSecretResult(
  record: ApiCredentialRecord,
  secret: string,
): CredentialIssueResult {
  return {
    credential: publicCredential(record),
    secret,
    secretShown: true,
  };
}

export function assertCredentialScopes(
  context: RequestContext,
  scopes: readonly ApiScope[],
): void {
  const disallowed = scopes.filter(
    (scope) => !context.principal.scopes.includes(scope),
  );
  if (disallowed.length > 0) {
    throw new AuthorizationError(
      `A credential cannot grant scopes its creator does not hold: ${disallowed.join(", ")}.`,
      disallowed,
    );
  }
}

export async function requireCredentialOwner(
  repository: EconomyRepository,
  context: RequestContext,
  credentialId: string,
): Promise<ApiCredentialRecord> {
  const credential = await repository.getCredential(credentialId);
  if (!credential) throw new NotFoundError("API credential");
  if (credential.agentId !== context.principal.agentId) {
    throw new AuthorizationError(
      "The API credential belongs to another agent.",
    );
  }
  return credential;
}
