import {
  AuthorizationError,
  NotFoundError,
  PolicyDeniedError,
} from "./errors.js";
import type { EconomyRepository } from "./repository.js";
import type {
  ApiScope,
  Money,
  PermissionAction,
  RequestContext,
} from "./types.js";

export type AuthorizationRequest = {
  scope: ApiScope;
  companyId?: string;
  action?: PermissionAction;
  amountCents?: Money;
};

export class AuthorizationPipeline {
  async assert(
    repository: EconomyRepository,
    context: RequestContext,
    request: AuthorizationRequest,
  ): Promise<void> {
    const agent = await repository.getAgent(context.principal.agentId);
    if (
      !agent ||
      agent.status !== "active" ||
      agent.userId !== context.principal.userId
    ) {
      throw new AuthorizationError(
        "The authenticated agent identity is not active.",
      );
    }

    if (!context.principal.scopes.includes(request.scope)) {
      throw new AuthorizationError(
        `Scope ${request.scope} is required for this operation.`,
        [request.scope],
      );
    }

    if (request.companyId) {
      const company = await repository.getCompany(request.companyId);
      if (!company) throw new NotFoundError("Company");
      if (
        company.ownerUserId !== context.principal.userId ||
        company.primaryAgentId !== context.principal.agentId
      ) {
        throw new AuthorizationError(
          "The authenticated agent is not authorized for this company.",
        );
      }

      if (request.action) {
        const permission = await repository.getPermission(
          company.id,
          request.action,
        );
        if (!permission || permission.decision === "deny") {
          throw new PolicyDeniedError(
            `Action ${request.action} is not permitted for this company.`,
          );
        }
        if (
          request.amountCents !== undefined &&
          permission.limitCents !== null &&
          request.amountCents > permission.limitCents
        ) {
          throw new PolicyDeniedError(
            `Action ${request.action} exceeds the approved limit of ${permission.limitCents} cents.`,
          );
        }
      }
    }
  }
}
