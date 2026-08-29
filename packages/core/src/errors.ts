import { ZodError } from "zod";

export function publicError(error: unknown): {
  code: string;
  message: string;
  status: number;
  capability?: string;
  blockers?: string[];
} {
  if (error instanceof DomainError) {
    const status =
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "UNAUTHENTICATED"
          ? 401
          : ["FORBIDDEN", "POLICY_DENIED"].includes(error.code)
            ? 403
            : error.code === "PAYLOAD_TOO_LARGE"
              ? 413
              : [
                    "FINANCIAL_UNAVAILABLE",
                    "TRADING_UNAVAILABLE",
                    "CAPABILITY_BLOCKED",
                  ].includes(error.code)
                ? 503
                : error.code === "CONFLICT" ||
                    error.code.startsWith("IDEMPOTENCY_")
                  ? 409
                  : 400;
    return {
      code: error.code,
      message: error.message,
      status,
      ...(error instanceof CapabilityBlockedError
        ? { capability: error.capability, blockers: [...error.blockers] }
        : {}),
    };
  }
  if (error instanceof ZodError || error instanceof SyntaxError)
    return {
      code: "INVALID_INPUT",
      message: "The request does not match the expected schema.",
      status: 400,
    };
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23505"
  )
    return {
      code: "CONFLICT",
      message: "A record with these identifiers already exists.",
      status: 409,
    };
  return {
    code: "INTERNAL_ERROR",
    message:
      "The request could not be completed. Contact the operator with the request ID.",
    status: 500,
  };
}

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
export class NotFoundError extends DomainError {
  constructor(resource: string) {
    super(`${resource} was not found.`, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}
export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, "CONFLICT");
    this.name = "ConflictError";
  }
}
export class AuthenticationError extends DomainError {
  constructor(message = "The bearer credential is missing or invalid.") {
    super(message, "UNAUTHENTICATED");
    this.name = "AuthenticationError";
  }
}
export class AuthorizationError extends DomainError {
  constructor(
    message: string,
    readonly requiredScopes: readonly string[] = [],
  ) {
    super(message, "FORBIDDEN");
    this.name = "AuthorizationError";
  }
}
export class PolicyDeniedError extends DomainError {
  constructor(message: string) {
    super(message, "POLICY_DENIED");
    this.name = "PolicyDeniedError";
  }
}
export class IdempotencyConflictError extends DomainError {
  constructor() {
    super(
      "This idempotency key was already used with a different request payload.",
      "IDEMPOTENCY_CONFLICT",
    );
    this.name = "IdempotencyConflictError";
  }
}
export class IdempotencyInProgressError extends DomainError {
  constructor() {
    super(
      "A request with this idempotency key is still processing.",
      "IDEMPOTENCY_IN_PROGRESS",
    );
    this.name = "IdempotencyInProgressError";
  }
}
export class LedgerImbalanceError extends DomainError {
  constructor() {
    super(
      "Ledger postings must contain equal debit and credit totals.",
      "LEDGER_IMBALANCE",
    );
    this.name = "LedgerImbalanceError";
  }
}
export class NetworkDisabledError extends DomainError {
  constructor(network: string) {
    super(
      `${network} execution is disabled by configuration.`,
      "NETWORK_DISABLED",
    );
    this.name = "NetworkDisabledError";
  }
}
export class CapabilityBlockedError extends DomainError {
  constructor(
    readonly capability: string,
    readonly blockers: readonly string[],
  ) {
    super(
      `${capability} is blocked by production readiness controls.`,
      "CAPABILITY_BLOCKED",
    );
    this.name = "CapabilityBlockedError";
  }
}
