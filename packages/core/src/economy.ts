import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { hydrateDomainDates } from "./serialization.js";
import {
  assertCredentialScopes,
  credentialSecretResult,
  hashApiSecret,
  issueApiSecret,
  publicCredential,
  requireCredentialOwner,
  type CredentialIssueResult,
} from "./auth.js";
import {
  AuthorizationError,
  PolicyDeniedError,
  AuthenticationError,
  ConflictError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  NotFoundError,
} from "./errors.js";
import { AuthorizationPipeline } from "./policy.js";
import type { EconomyRepository } from "./repository.js";
import type { VerifiedOwner } from "./oauth.js";
import {
  bootstrapRegistrationSchema,
  cancelInvocationSchema,
  createCredentialSchema,
  createServiceSchema,
  failJobSchema,
  getServiceSchema,
  invocationIdSchema,
  jobIdSchema,
  idempotencyKeySchema,
  registerAgentSchema,
  requestServiceSchema,
  searchServicesSchema,
  submitResultSchema,
  updateServiceSchema,
  type BootstrapRegistrationInput,
  type CancelInvocationInput,
  type CreateCredentialInput,
  type CreateServiceInput,
  type FailJobInput,
  type RegisterAgentInput,
  type RequestServiceInput,
  type SearchServicesInput,
  type SubmitResultInput,
  type UpdateServiceInput,
} from "./schemas.js";
import type {
  Activity,
  Agent,
  AgentIdentity,
  AgentRegistrationResult,
  ApiCredential,
  ApiCredentialRecord,
  AuditEvent,
  BootstrapRegistrationResult,
  Company,
  CompanyMetrics,
  CompanySnapshot,
  InvocationView,
  LeaderboardEntry,
  NetworkCapability,
  Permission,
  PublicCompanySnapshot,
  RequestContext,
  Service,
  ServiceInvocation,
  ServiceJob,
  ServicePage,
  ServiceResult,
  ServiceSearch,
} from "./types.js";

export type NetworkCapabilitySource = {
  listCapabilities(): NetworkCapability[];
};
export type SafeEvent = {
  name: string;
  actorAgentId?: string;
  resourceType?: string;
  resourceId?: string;
  outcome: "success" | "denied" | "failed";
};
export type EconomyDependencies = {
  repository: EconomyRepository;
  authorization?: AuthorizationPipeline;
  networks?: NetworkCapabilitySource;
  credentialIssuer?: string;
  credentialAudience?: string;
  credentialEnvironment?: string;
  clock?: () => Date;
  idGenerator?: () => string;
  eventSink?: (event: SafeEvent) => void;
};

const DEFAULT_SCOPES = [
  "company:read",
  "company:write",
  "services:read",
  "services:write",
  "jobs:read",
  "jobs:write",
  "transactions:read",
  "markets:read",
] as const;
const DEFAULT_PERMISSIONS: ReadonlyArray<
  Pick<Permission, "action" | "decision" | "limitCents">
> = [
  { action: "service:create", decision: "allow", limitCents: null },
  { action: "service:update", decision: "allow", limitCents: null },
  { action: "service:request", decision: "allow", limitCents: null },
  { action: "job:accept", decision: "allow", limitCents: null },
  { action: "job:process", decision: "allow", limitCents: null },
  { action: "job:complete", decision: "allow", limitCents: null },
  { action: "job:fail", decision: "allow", limitCents: null },
  { action: "job:cancel", decision: "allow", limitCents: null },
  { action: "treasury:transfer", decision: "deny", limitCents: null },
  { action: "asset:trade", decision: "deny", limitCents: null },
];

export class NormicEconomy {
  private readonly repository: EconomyRepository;
  private readonly authorization: AuthorizationPipeline;
  private readonly networks: NetworkCapabilitySource | undefined;
  private readonly credentialIssuer: string;
  private readonly credentialAudience: string;
  private readonly credentialEnvironment: string;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;
  private readonly eventSink: ((event: SafeEvent) => void) | undefined;
  private readonly pendingEvents = new AsyncLocalStorage<SafeEvent[]>();

  constructor(dependencies: EconomyDependencies) {
    this.repository = dependencies.repository;
    this.authorization =
      dependencies.authorization ?? new AuthorizationPipeline();
    this.networks = dependencies.networks;
    this.credentialIssuer =
      dependencies.credentialIssuer ?? "https://auth.normic.local";
    this.credentialAudience =
      dependencies.credentialAudience ?? "http://127.0.0.1:3100/mcp";
    this.credentialEnvironment = dependencies.credentialEnvironment ?? "live";
    this.clock = dependencies.clock ?? (() => new Date());
    this.idGenerator = dependencies.idGenerator ?? (() => crypto.randomUUID());
    this.eventSink = dependencies.eventSink;
  }

  async bootstrapAgent(
    input: BootstrapRegistrationInput,
    idempotencyKey: string,
    owner?: VerifiedOwner,
  ): Promise<BootstrapRegistrationResult> {
    if (process.env.NODE_ENV === "production" && !owner)
      throw new AuthenticationError(
        "Verified human ownership is required in production.",
      );
    idempotencyKeySchema.parse(idempotencyKey);
    const parsed = bootstrapRegistrationSchema.parse(input);
    if (owner && owner.email !== parsed.creatorEmail)
      throw new AuthorizationError(
        "The registration email must match the verified owner session.",
      );
    const requestHash = stableHash({ input: parsed, owner: owner ?? null });
    return this.committedTransaction(async (repository) => {
      const claim = await repository.claimOnboarding({
        key: idempotencyKey,
        requestHash,
        createdAt: this.clock(),
      });
      if (claim.state === "conflict") throw new IdempotencyConflictError();
      if (claim.state === "processing") throw new IdempotencyInProgressError();
      if (claim.state === "replay") {
        const replay = claim.response as {
          companyId: string;
          credentialId: string;
        };
        const [company, credential] = await Promise.all([
          repository.getCompany(replay.companyId),
          repository.getCredential(replay.credentialId),
        ]);
        if (!company || !credential)
          throw new ConflictError(
            "The completed onboarding record is unavailable.",
          );
        return {
          identity: await this.snapshot(repository, company),
          credential: publicCredential(credential),
          secret: null,
          secretShown: false,
        };
      }
      const existingOwner = await repository.getUserByEmail(
        parsed.creatorEmail,
      );
      if (
        existingOwner &&
        (!owner ||
          existingOwner.authIssuer !== owner.issuer ||
          existingOwner.authSubject !== owner.subject)
      )
        throw new ConflictError(
          "This email is already registered to a different identity.",
        );
      if (await repository.getAgentByHandle(parsed.handle))
        throw new ConflictError(
          `Agent handle @${parsed.handle} is already registered.`,
        );
      if (await repository.getCompanyBySlug(parsed.companySlug))
        throw new ConflictError(
          `Company slug ${parsed.companySlug} is already registered.`,
        );
      const now = this.clock();
      const userId = existingOwner?.id ?? this.idGenerator();
      const companyId = this.idGenerator();
      const agentId = this.idGenerator();
      const company = companyFrom(parsed, companyId, userId, agentId, now);
      const agent = agentFrom(parsed, agentId, userId, companyId, now);
      if (!existingOwner)
        await repository.createUser({
          id: userId,
          email: parsed.creatorEmail,
          name: parsed.creatorName,
          createdAt: now,
          authIssuer: owner?.issuer ?? null,
          authSubject: owner?.subject ?? null,
        });
      await this.persistIdentity(repository, company, agent, now);
      const issued = issueApiSecret(this.credentialEnvironment);
      const credential = this.credentialRecord(
        agent.id,
        parsed.credentialLabel,
        [...DEFAULT_SCOPES],
        null,
        issued,
        now,
        null,
      );
      await repository.createCredential(credential);
      await repository.createAuditEvent(
        this.audit(
          null,
          "credential.created",
          company.id,
          "api_credential",
          credential.id,
          "create",
          { prefix: credential.prefix },
          now,
        ),
      );
      await repository.completeOnboarding({
        key: idempotencyKey,
        response: { companyId, credentialId: credential.id },
      });
      this.emit({
        name: "onboarding.completed",
        actorAgentId: agent.id,
        resourceType: "company",
        resourceId: company.id,
        outcome: "success",
      });
      return {
        identity: await this.snapshot(repository, company),
        ...credentialSecretResult(credential, issued.secret),
      };
    });
  }

  async registerAgent(
    context: RequestContext,
    input: RegisterAgentInput,
    idempotencyKey: string,
  ): Promise<AgentRegistrationResult> {
    const parsed = registerAgentSchema.parse(input);
    return this.withIdempotency(
      context,
      "agent.register",
      idempotencyKey,
      parsed,
      async (repository) => {
        await this.authorization.assert(repository, context, {
          scope: "company:write",
        });
        const owner = await repository.getUser(context.principal.userId);
        if (!owner) throw new NotFoundError("Owner user");
        if (await repository.getAgentByHandle(parsed.handle))
          throw new ConflictError(
            `Agent handle @${parsed.handle} is already registered.`,
          );
        if (await repository.getCompanyBySlug(parsed.companySlug))
          throw new ConflictError(
            `Company slug ${parsed.companySlug} is already registered.`,
          );
        const now = this.clock(),
          companyId = this.idGenerator(),
          agentId = this.idGenerator();
        const company = companyFrom(parsed, companyId, owner.id, agentId, now);
        const agent = agentFrom(parsed, agentId, owner.id, companyId, now);
        await this.persistIdentity(repository, company, agent, now);
        const issued = issueApiSecret(this.credentialEnvironment);
        const credential = this.credentialRecord(
          agent.id,
          "Registered agent",
          DEFAULT_SCOPES.filter((scope) =>
            context.principal.scopes.includes(scope),
          ),
          null,
          issued,
          now,
          null,
        );
        await repository.createCredential(credential);
        await repository.createAuditEvent(
          this.audit(
            context.principal.agentId,
            "credential.created",
            company.id,
            "api_credential",
            credential.id,
            "create",
            { prefix: credential.prefix },
            now,
          ),
        );
        return {
          ...(await this.snapshot(repository, company)),
          ...credentialSecretResult(credential, issued.secret),
        };
      },
      (result) => ({ ...result, secret: null, secretShown: false }),
    );
  }

  async createService(
    context: RequestContext,
    input: CreateServiceInput,
    idempotencyKey: string,
  ): Promise<Service> {
    const parsed = createServiceSchema.parse(input);
    return this.withIdempotency(
      context,
      "service.create",
      idempotencyKey,
      parsed,
      async (repository) => {
        await this.authorization.assert(repository, context, {
          scope: "services:write",
          companyId: parsed.companyId,
          action: "service:create",
        });
        if (
          (await repository.listServices({ companyId: parsed.companyId })).some(
            (service) => service.slug === parsed.slug,
          )
        ) {
          throw new ConflictError(
            `Service slug ${parsed.slug} already exists for this company.`,
          );
        }
        const now = this.clock();
        const service: Service = {
          id: this.idGenerator(),
          companyId: parsed.companyId,
          agentId: context.principal.agentId,
          slug: parsed.slug,
          name: parsed.name,
          description: parsed.description,
          category: parsed.category,
          inputSchema: parsed.inputSchema,
          outputSchema: parsed.outputSchema,
          status: parsed.status,
          version: 1,
          pricingModel: parsed.pricingModel,
          quotedPrice: parsed.quotedPrice,
          quotedCurrency: parsed.quotedCurrency,
          paymentExecution: "unavailable",
          createdAt: now,
          updatedAt: now,
        };
        await repository.createService(service);
        await this.record(
          repository,
          context.principal.agentId,
          service.companyId,
          "service.created",
          "service.created",
          `${service.name} was published to the Normic service network.`,
          "service",
          service.id,
          "create",
          now,
          { serviceId: service.id, status: service.status },
        );
        return service;
      },
    );
  }

  async updateService(
    context: RequestContext,
    input: UpdateServiceInput,
    idempotencyKey: string,
  ): Promise<Service> {
    const parsed = updateServiceSchema.parse(input);
    return this.withIdempotency(
      context,
      "service.update",
      idempotencyKey,
      parsed,
      async (repository) => {
        const current = await repository.lockServiceForUpdate(parsed.serviceId);
        if (!current) throw new NotFoundError("Service");
        await this.authorization.assert(repository, context, {
          scope: "services:write",
          companyId: current.companyId,
          action: "service:update",
        });
        const updated: Service = {
          ...current,
          name: parsed.name ?? current.name,
          description: parsed.description ?? current.description,
          category: parsed.category ?? current.category,
          inputSchema: parsed.inputSchema ?? current.inputSchema,
          outputSchema: parsed.outputSchema ?? current.outputSchema,
          status: parsed.status ?? current.status,
          pricingModel: parsed.pricingModel ?? current.pricingModel,
          quotedPrice:
            parsed.quotedPrice === undefined
              ? current.quotedPrice
              : parsed.quotedPrice,
          quotedCurrency:
            parsed.quotedCurrency === undefined
              ? current.quotedCurrency
              : parsed.quotedCurrency,
          paymentExecution: "unavailable",
          version: current.version + 1,
          updatedAt: this.clock(),
        };
        createServiceSchema.parse(updatedServiceInput(updated));
        await repository.updateService(updated);
        await this.record(
          repository,
          context.principal.agentId,
          updated.companyId,
          "service.updated",
          "service.updated",
          `${updated.name} was updated.`,
          "service",
          updated.id,
          "update",
          updated.updatedAt,
          {
            serviceId: updated.id,
            version: updated.version,
            status: updated.status,
          },
        );
        return updated;
      },
    );
  }

  async searchServices(
    context: RequestContext,
    input: SearchServicesInput,
  ): Promise<ServicePage> {
    await this.authorization.assert(this.repository, context, {
      scope: "services:read",
    });
    const filters = serviceSearch(searchServicesSchema.parse(input));
    if (filters.status && filters.status !== "active") {
      const agent = await this.requireOwnAgent(this.repository, context);
      await this.authorization.assert(this.repository, context, {
        scope: "services:read",
        companyId: filters.companyId ?? agent.companyId,
      });
      filters.companyId = agent.companyId;
    } else filters.status = "active";
    return this.repository.searchServices(filters);
  }

  discoverServices(input: SearchServicesInput): Promise<ServicePage> {
    return this.repository.searchServices({
      ...serviceSearch(searchServicesSchema.parse(input)),
      status: "active",
    });
  }

  async getService(
    context: RequestContext,
    serviceId: string,
  ): Promise<Service> {
    getServiceSchema.parse({ serviceId });
    await this.authorization.assert(this.repository, context, {
      scope: "services:read",
    });
    const service = await this.repository.getService(serviceId);
    if (!service) throw new NotFoundError("Service");
    if (service.status !== "active")
      await this.authorization.assert(this.repository, context, {
        scope: "services:read",
        companyId: service.companyId,
      });
    return service;
  }

  async requestService(
    context: RequestContext,
    input: RequestServiceInput,
    idempotencyKey: string,
  ): Promise<InvocationView> {
    const parsed = requestServiceSchema.parse(input);
    return this.withIdempotency(
      context,
      "service.request",
      idempotencyKey,
      parsed,
      async (repository) => {
        const buyer = await this.requireOwnAgent(repository, context);
        await this.authorization.assert(repository, context, {
          scope: "jobs:write",
          companyId: buyer.companyId,
          action: "service:request",
        });
        const service = await repository.lockServiceForUpdate(parsed.serviceId);
        if (!service || service.status !== "active")
          throw new NotFoundError("Active service");
        if (service.agentId === buyer.id)
          throw new ConflictError("An agent cannot request its own service.");
        if (
          service.pricingModel === "fixed" &&
          service.quotedPrice &&
          !/^0(?:\.0+)?$/.test(service.quotedPrice)
        )
          throw new PolicyDeniedError(
            "Paid services require the verified USDG escrow payment flow.",
          );
        const now = this.clock(),
          invocationId = this.idGenerator();
        const invocation: ServiceInvocation = {
          id: invocationId,
          serviceId: service.id,
          buyerAgentId: buyer.id,
          providerAgentId: service.agentId,
          input: parsed.input,
          status: "created",
          pricingSnapshot: {
            model: service.pricingModel,
            quotedPrice: service.quotedPrice,
            quotedCurrency: service.quotedCurrency,
            paymentExecution: "unavailable",
            serviceVersion: service.version,
          },
          createdAt: now,
          acceptedAt: null,
          processingAt: null,
          completedAt: null,
          failureReason: null,
        };
        const job: ServiceJob = {
          id: this.idGenerator(),
          invocationId,
          providerAgentId: service.agentId,
          status: "created",
          createdAt: now,
          acceptedAt: null,
          processingAt: null,
          completedAt: null,
        };
        await repository.createInvocation(invocation);
        await repository.createJob(job);
        const provider = await repository.getAgent(service.agentId);
        if (!provider) throw new NotFoundError("Provider agent");
        await this.record(
          repository,
          buyer.id,
          provider.companyId,
          "job.requested",
          "service.requested",
          `A service request was created for ${service.name}.`,
          "invocation",
          invocation.id,
          "request",
          now,
          {
            invocationId: invocation.id,
            serviceId: service.id,
            buyerAgentId: buyer.id,
          },
        );
        return { invocation, job, result: null, service };
      },
    );
  }

  async getInvocation(
    context: RequestContext,
    invocationId: string,
  ): Promise<InvocationView> {
    invocationIdSchema.parse({ invocationId });
    await this.authorization.assert(this.repository, context, {
      scope: "jobs:read",
    });
    const invocation = await this.repository.getInvocation(invocationId);
    if (!invocation) throw new NotFoundError("Service invocation");
    this.assertParty(context, invocation);
    return this.invocationView(this.repository, invocation);
  }

  async listJobs(
    context: RequestContext,
    filters: {
      status?: ServiceJob["status"];
      role?: "provider" | "buyer";
      limit?: number;
    } = {},
  ): Promise<ServiceJob[]> {
    await this.authorization.assert(this.repository, context, {
      scope: "jobs:read",
    });
    const query: Parameters<EconomyRepository["listJobs"]>[0] =
      filters.role === "buyer"
        ? { buyerAgentId: context.principal.agentId }
        : { providerAgentId: context.principal.agentId };
    if (filters.status) query.status = filters.status;
    if (filters.limit) query.limit = filters.limit;
    return this.repository.listJobs(query);
  }

  acceptJob(context: RequestContext, jobId: string, key: string) {
    jobIdSchema.parse({ jobId });
    return this.transitionJob(
      context,
      jobId,
      key,
      "accept",
      "created",
      "accepted",
      "job:accept",
    );
  }
  startJob(context: RequestContext, jobId: string, key: string) {
    jobIdSchema.parse({ jobId });
    return this.transitionJob(
      context,
      jobId,
      key,
      "start",
      "accepted",
      "processing",
      "job:process",
    );
  }

  async submitResult(
    context: RequestContext,
    input: SubmitResultInput,
    key: string,
  ): Promise<InvocationView> {
    const parsed = submitResultSchema.parse(input);
    return this.withIdempotency(
      context,
      "job.submit",
      key,
      parsed,
      async (repository) => {
        const { job, invocation, service } = await this.requireProviderJob(
          repository,
          context,
          parsed.jobId,
          "processing",
          "job:complete",
        );
        const now = this.clock();
        const result: ServiceResult = {
          id: this.idGenerator(),
          invocationId: invocation.id,
          jobId: job.id,
          providerAgentId: context.principal.agentId,
          output: parsed.output,
          createdAt: now,
        };
        const nextJob = {
          ...job,
          status: "completed" as const,
          completedAt: now,
        };
        const nextInvocation = {
          ...invocation,
          status: "completed" as const,
          completedAt: now,
        };
        await repository.createResult(result);
        await repository.updateJob(nextJob);
        await repository.updateInvocation(nextInvocation);
        await this.record(
          repository,
          context.principal.agentId,
          service.companyId,
          "job.completed",
          "job.completed",
          `${service.name} completed an invocation.`,
          "job",
          job.id,
          "complete",
          now,
          { jobId: job.id, invocationId: invocation.id },
        );
        return { service, invocation: nextInvocation, job: nextJob, result };
      },
    );
  }

  async failJob(
    context: RequestContext,
    input: FailJobInput,
    key: string,
  ): Promise<InvocationView> {
    const parsed = failJobSchema.parse(input);
    return this.withIdempotency(
      context,
      "job.fail",
      key,
      parsed,
      async (repository) => {
        const { job, invocation, service } = await this.requireProviderJob(
          repository,
          context,
          parsed.jobId,
          ["created", "accepted", "processing"],
          "job:fail",
        );
        const now = this.clock();
        const nextJob = { ...job, status: "failed" as const, completedAt: now };
        const nextInvocation = {
          ...invocation,
          status: "failed" as const,
          completedAt: now,
          failureReason: parsed.failureReason,
        };
        await repository.updateJob(nextJob);
        await repository.updateInvocation(nextInvocation);
        await this.record(
          repository,
          context.principal.agentId,
          service.companyId,
          "job.failed",
          "job.failed",
          `${service.name} reported a failed invocation.`,
          "job",
          job.id,
          "fail",
          now,
          { jobId: job.id, invocationId: invocation.id },
        );
        return {
          service,
          invocation: nextInvocation,
          job: nextJob,
          result: null,
        };
      },
    );
  }

  async cancelInvocation(
    context: RequestContext,
    input: CancelInvocationInput,
    key: string,
  ): Promise<InvocationView> {
    const parsed = cancelInvocationSchema.parse(input);
    return this.withIdempotency(
      context,
      "invocation.cancel",
      key,
      parsed,
      async (repository) => {
        const invocation = await repository.getInvocation(parsed.invocationId);
        if (!invocation) throw new NotFoundError("Service invocation");
        if (invocation.buyerAgentId !== context.principal.agentId)
          throw new AuthorizationError(
            "Only the requesting agent can cancel this invocation.",
          );
        const buyer = await this.requireOwnAgent(repository, context);
        await this.authorization.assert(repository, context, {
          scope: "jobs:write",
          companyId: buyer.companyId,
          action: "job:cancel",
        });
        if (
          !(["created", "accepted"] as const).includes(
            invocation.status as "created" | "accepted",
          )
        )
          throw new ConflictError(
            "Only created or accepted invocations can be cancelled.",
          );
        const job = await repository.lockJobForUpdate(
          (await repository.getJobByInvocation(invocation.id))?.id ?? "",
        );
        if (!job || job.status !== invocation.status)
          throw new ConflictError("The job state changed before cancellation.");
        const now = this.clock();
        const nextJob = {
          ...job,
          status: "cancelled" as const,
          completedAt: now,
        };
        const nextInvocation = {
          ...invocation,
          status: "cancelled" as const,
          completedAt: now,
          failureReason: parsed.reason ?? null,
        };
        await repository.updateJob(nextJob);
        await repository.updateInvocation(nextInvocation);
        const service = await repository.getService(invocation.serviceId);
        if (!service) throw new NotFoundError("Service");
        await this.record(
          repository,
          context.principal.agentId,
          service.companyId,
          "job.cancelled",
          "job.cancelled",
          `An invocation for ${service.name} was cancelled.`,
          "job",
          job.id,
          "cancel",
          now,
          { jobId: job.id, invocationId: invocation.id },
        );
        return {
          service,
          invocation: nextInvocation,
          job: nextJob,
          result: null,
        };
      },
    );
  }

  async createCredential(
    context: RequestContext,
    input: CreateCredentialInput,
    key: string,
  ): Promise<CredentialIssueResult> {
    const parsed = createCredentialSchema.parse(input);
    assertCredentialScopes(context, parsed.scopes);
    return this.withIdempotency(
      context,
      "credential.create",
      key,
      parsed,
      async (repository) => {
        await this.authorization.assert(repository, context, {
          scope: "company:write",
        });
        const agent = await this.requireOwnAgent(repository, context),
          now = this.clock();
        const issued = issueApiSecret(this.credentialEnvironment);
        const credential = this.credentialRecord(
          agent.id,
          parsed.label,
          parsed.scopes,
          parsed.expiresAt,
          issued,
          now,
          null,
        );
        await repository.createCredential(credential);
        await repository.createAuditEvent(
          this.audit(
            agent.id,
            "credential.created",
            agent.companyId,
            "api_credential",
            credential.id,
            "create",
            { prefix: credential.prefix },
            now,
          ),
        );
        return credentialSecretResult(credential, issued.secret);
      },
      (result) => ({
        credential: result.credential,
        secret: null,
        secretShown: false,
      }),
    );
  }

  async rotateCredential(
    context: RequestContext,
    credentialId: string,
    key: string,
  ): Promise<CredentialIssueResult> {
    return this.withIdempotency(
      context,
      "credential.rotate",
      key,
      { credentialId },
      async (repository) => {
        const ownerAgent = await this.requireOwnAgent(repository, context);
        await repository.lockCompanyForUpdate(ownerAgent.companyId);
        await this.authorization.assert(repository, context, {
          scope: "company:write",
        });
        const old = await requireCredentialOwner(
          repository,
          context,
          credentialId,
        );
        if (old.revokedAt || (old.expiresAt && old.expiresAt <= this.clock()))
          throw new ConflictError(
            "A revoked or expired credential cannot be rotated.",
          );
        assertCredentialScopes(context, old.scopes);
        const now = this.clock(),
          issued = issueApiSecret(this.credentialEnvironment);
        const next = this.credentialRecord(
          old.agentId,
          old.label,
          old.scopes,
          old.expiresAt,
          issued,
          now,
          old.id,
        );
        await repository.revokeCredential(old.id, now);
        await repository.createCredential(next);
        const agent = await this.requireOwnAgent(repository, context);
        await repository.createAuditEvent(
          this.audit(
            agent.id,
            "credential.rotated",
            agent.companyId,
            "api_credential",
            next.id,
            "rotate",
            { prefix: next.prefix, rotatedFromId: old.id },
            now,
          ),
        );
        return credentialSecretResult(next, issued.secret);
      },
      (result) => ({
        credential: result.credential,
        secret: null,
        secretShown: false,
      }),
    );
  }

  async revokeCredential(
    context: RequestContext,
    credentialId: string,
    key: string,
  ): Promise<ApiCredential> {
    return this.withIdempotency(
      context,
      "credential.revoke",
      key,
      { credentialId },
      async (repository) => {
        await this.authorization.assert(repository, context, {
          scope: "company:write",
        });
        const credential = await requireCredentialOwner(
            repository,
            context,
            credentialId,
          ),
          now = this.clock();
        await repository.revokeCredential(credential.id, now);
        const agent = await this.requireOwnAgent(repository, context);
        await repository.createAuditEvent(
          this.audit(
            agent.id,
            "credential.revoked",
            agent.companyId,
            "api_credential",
            credential.id,
            "revoke",
            { prefix: credential.prefix },
            now,
          ),
        );
        return {
          ...publicCredential(credential),
          revokedAt: credential.revokedAt ?? now,
        };
      },
    );
  }

  async getIdentity(context: RequestContext): Promise<AgentIdentity> {
    await this.authorization.assert(this.repository, context, {
      scope: "company:read",
    });
    const agent = await this.requireOwnAgent(this.repository, context),
      company = await this.repository.getCompany(agent.companyId);
    if (!company) throw new NotFoundError("Company");
    return {
      agent,
      company,
      scopes: [...context.principal.scopes],
      credentialId: context.principal.credentialId,
    };
  }
  async getCompany(
    context: RequestContext,
    identifier: string,
  ): Promise<CompanySnapshot> {
    const company = await this.findCompany(this.repository, identifier);
    await this.authorization.assert(this.repository, context, {
      scope: "company:read",
      companyId: company.id,
    });
    return this.snapshot(this.repository, company);
  }
  async getBalance(
    context: RequestContext,
    companyId?: string,
  ): Promise<CompanyMetrics> {
    const agent = await this.requireOwnAgent(this.repository, context),
      id = companyId
        ? (await this.findCompany(this.repository, companyId)).id
        : agent.companyId;
    await this.authorization.assert(this.repository, context, {
      scope: "transactions:read",
      companyId: id,
    });
    return this.repository.getMetrics(id);
  }
  async getPermissions(context: RequestContext): Promise<Permission[]> {
    const agent = await this.requireOwnAgent(this.repository, context);
    await this.authorization.assert(this.repository, context, {
      scope: "company:read",
      companyId: agent.companyId,
    });
    return this.repository.listPermissions(agent.companyId);
  }
  async getActivity(
    context: RequestContext,
    filters: { companyId?: string; limit?: number } = {},
  ) {
    const agent = await this.requireOwnAgent(this.repository, context),
      companyId = filters.companyId ?? agent.companyId;
    await this.authorization.assert(this.repository, context, {
      scope: "company:read",
      companyId,
    });
    return this.repository.listActivities({
      companyId,
      ...(filters.limit ? { limit: filters.limit } : {}),
    });
  }
  async getAuditActivity(context: RequestContext, limit = 20) {
    const agent = await this.requireOwnAgent(this.repository, context);
    await this.authorization.assert(this.repository, context, {
      scope: "company:read",
      companyId: agent.companyId,
    });
    return this.repository.listAuditEvents({
      companyId: agent.companyId,
      limit,
    });
  }
  async getLeaderboard(context: RequestContext, limit = 20) {
    await this.authorization.assert(this.repository, context, {
      scope: "company:read",
    });
    return this.getPublicLeaderboard(limit);
  }
  async listServices(
    context: RequestContext,
    filters: { companyId?: string; status?: Service["status"] } = {},
  ) {
    await this.authorization.assert(this.repository, context, {
      scope: "services:read",
    });
    const page = await this.searchServices(context, { ...filters, limit: 100 });
    return page.items;
  }
  async getServices(context: RequestContext, identifier: string) {
    const company = await this.findCompany(this.repository, identifier);
    await this.authorization.assert(this.repository, context, {
      scope: "services:read",
      companyId: company.id,
    });
    return this.repository.listServices({ companyId: company.id });
  }
  async getCredentials(context: RequestContext): Promise<ApiCredential[]> {
    await this.authorization.assert(this.repository, context, {
      scope: "company:read",
    });
    return this.repository.listCredentials(context.principal.agentId);
  }
  getSupportedNetworks(context: RequestContext): Promise<NetworkCapability[]> {
    return this.authorization
      .assert(this.repository, context, { scope: "company:read" })
      .then(() => this.networks?.listCapabilities() ?? []);
  }
  assertScope(
    context: RequestContext,
    scope: Parameters<AuthorizationPipeline["assert"]>[2]["scope"],
  ): Promise<void> {
    return this.authorization.assert(this.repository, context, { scope });
  }

  async getPublicCompany(identifier: string): Promise<PublicCompanySnapshot> {
    const snapshot = await this.snapshot(
      this.repository,
      await this.findCompany(this.repository, identifier),
    );
    return {
      company: snapshot.company,
      agent: snapshot.agent,
      operations: snapshot.operations,
      services: snapshot.services.filter(
        (service) => service.status === "active",
      ),
    };
  }
  getPublicServices(
    filters: { companyId?: string; status?: Service["status"] } = {},
  ) {
    return this.repository.listServices({ ...filters, status: "active" });
  }
  getPublicActivity(filters: { companyId?: string; limit?: number } = {}) {
    return this.repository.listActivities(filters);
  }
  async getPublicLeaderboard(limit = 20): Promise<LeaderboardEntry[]> {
    const snapshots = await Promise.all(
      (await this.repository.listCompanies()).map((company) =>
        this.getPublicCompany(company.id),
      ),
    );
    return snapshots
      .sort(
        (a, b) =>
          b.operations.jobsCompleted - a.operations.jobsCompleted ||
          b.operations.completionRate - a.operations.completionRate ||
          b.operations.uniqueBuyers - a.operations.uniqueBuyers ||
          a.company.name.localeCompare(b.company.name),
      )
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((snapshot, index) => ({ ...snapshot, rank: index + 1 }));
  }

  private async transitionJob(
    context: RequestContext,
    jobId: string,
    key: string,
    operation: string,
    from: ServiceJob["status"],
    to: ServiceJob["status"],
    action: Permission["action"],
  ): Promise<InvocationView> {
    return this.withIdempotency(
      context,
      `job.${operation}`,
      key,
      { jobId },
      async (repository) => {
        const { job, invocation, service } = await this.requireProviderJob(
          repository,
          context,
          jobId,
          from,
          action,
        );
        const now = this.clock();
        const dates =
          to === "accepted" ? { acceptedAt: now } : { processingAt: now };
        const nextJob = { ...job, status: to, ...dates };
        const nextInvocation = { ...invocation, status: to, ...dates };
        await repository.updateJob(nextJob);
        await repository.updateInvocation(nextInvocation);
        const activityType =
          to === "accepted" ? "job.accepted" : "job.processing";
        const auditType = to === "accepted" ? "job.accepted" : "job.started";
        await this.record(
          repository,
          context.principal.agentId,
          service.companyId,
          activityType,
          auditType,
          `${service.name} moved to ${to}.`,
          "job",
          job.id,
          operation,
          now,
          { jobId: job.id, invocationId: invocation.id },
        );
        return {
          service,
          invocation: nextInvocation,
          job: nextJob,
          result: null,
        };
      },
    );
  }

  private async requireProviderJob(
    repository: EconomyRepository,
    context: RequestContext,
    jobId: string,
    expected: ServiceJob["status"] | ServiceJob["status"][],
    action: Permission["action"],
  ): Promise<{
    job: ServiceJob;
    invocation: ServiceInvocation;
    service: Service;
  }> {
    const job = await repository.lockJobForUpdate(jobId);
    if (!job) throw new NotFoundError("Service job");
    if (job.providerAgentId !== context.principal.agentId)
      throw new AuthorizationError(
        "This job belongs to another provider agent.",
      );
    const agent = await this.requireOwnAgent(repository, context);
    await this.authorization.assert(repository, context, {
      scope: "jobs:write",
      companyId: agent.companyId,
      action,
    });
    const states = Array.isArray(expected) ? expected : [expected];
    if (!states.includes(job.status))
      throw new ConflictError(
        `This job must be ${states.join(" or ")} before it can transition.`,
      );
    const invocation = await repository.getInvocation(job.invocationId);
    if (!invocation || invocation.status !== job.status)
      throw new ConflictError(
        "The invocation state does not match the job state.",
      );
    const service = await repository.getService(invocation.serviceId);
    if (!service) throw new NotFoundError("Service");
    return { job, invocation, service };
  }

  private async invocationView(
    repository: EconomyRepository,
    invocation: ServiceInvocation,
  ): Promise<InvocationView> {
    const [job, result, service] = await Promise.all([
      repository.getJobByInvocation(invocation.id),
      repository.getResultByInvocation(invocation.id),
      repository.getService(invocation.serviceId),
    ]);
    if (!job || !service) throw new NotFoundError("Invocation resources");
    return { invocation, job, result, service };
  }
  private assertParty(context: RequestContext, invocation: ServiceInvocation) {
    if (
      context.principal.agentId !== invocation.buyerAgentId &&
      context.principal.agentId !== invocation.providerAgentId
    )
      throw new AuthorizationError("This invocation belongs to another agent.");
  }
  private async persistIdentity(
    repository: EconomyRepository,
    company: Company,
    agent: Agent,
    now: Date,
  ) {
    await repository.createCompany(company);
    await repository.createAgent(agent);
    await repository.createTreasury({
      id: this.idGenerator(),
      companyId: company.id,
      balanceCents: 0,
      assetsCents: 0,
      liabilitiesCents: 0,
      ledgerVersion: 0,
      updatedAt: now,
    });
    await repository.ensureLedgerAccounts(company.id, now);
    for (const definition of DEFAULT_PERMISSIONS)
      await repository.createPermission({
        id: this.idGenerator(),
        companyId: company.id,
        ...definition,
        createdAt: now,
        updatedAt: now,
      });
    await repository.createActivity({
      id: this.idGenerator(),
      companyId: company.id,
      type: "agent.registered",
      summary: `${agent.name} registered ${company.name} on Normic.`,
      metadata: { agentHandle: agent.handle },
      createdAt: now,
    });
    await repository.createAuditEvent(
      this.audit(
        agent.id,
        "agent.registered",
        company.id,
        "agent",
        agent.id,
        "register",
        { ownerUserId: company.ownerUserId },
        now,
      ),
    );
  }
  private async snapshot(
    repository: EconomyRepository,
    company: Company,
  ): Promise<CompanySnapshot> {
    const [agent, treasury, services, metrics, operations] = await Promise.all([
      repository.getAgent(company.primaryAgentId),
      repository.getTreasury(company.id),
      repository.listServices({ companyId: company.id }),
      repository.getMetrics(company.id),
      repository.getOperationalMetrics(company.id),
    ]);
    if (!agent || !treasury) throw new NotFoundError("Company resources");
    return { company, agent, treasury, services, metrics, operations };
  }
  private async findCompany(repository: EconomyRepository, identifier: string) {
    const company = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(identifier)
      ? await repository.getCompany(identifier)
      : await repository.getCompanyBySlug(identifier);
    if (!company) throw new NotFoundError("Company");
    return company;
  }
  private async requireOwnAgent(
    repository: EconomyRepository,
    context: RequestContext,
  ) {
    const agent = await repository.getAgent(context.principal.agentId);
    if (
      !agent ||
      agent.userId !== context.principal.userId ||
      agent.status !== "active"
    )
      throw new NotFoundError("Agent identity");
    return agent;
  }
  private credentialRecord(
    agentId: string,
    label: string,
    scopes: ApiCredentialRecord["scopes"],
    expiresAt: Date | null,
    issued: { secret: string; prefix: string },
    now: Date,
    rotatedFromId: string | null,
  ): ApiCredentialRecord {
    return {
      id: this.idGenerator(),
      agentId,
      prefix: issued.prefix,
      secretHash: hashApiSecret(issued.secret),
      label,
      scopes,
      issuer: this.credentialIssuer,
      audience: this.credentialAudience,
      createdAt: now,
      lastUsedAt: null,
      expiresAt,
      revokedAt: null,
      rotatedFromId,
    };
  }
  private async record(
    repository: EconomyRepository,
    actorAgentId: string,
    companyId: string,
    activityType: Activity["type"],
    auditType: AuditEvent["type"],
    summary: string,
    resourceType: string,
    resourceId: string,
    action: string,
    now: Date,
    metadata: Record<string, string | number | boolean | null>,
  ) {
    await repository.createActivity({
      id: this.idGenerator(),
      companyId,
      type: activityType,
      summary,
      metadata,
      createdAt: now,
    });
    await repository.createAuditEvent(
      this.audit(
        actorAgentId,
        auditType,
        companyId,
        resourceType,
        resourceId,
        action,
        metadata,
        now,
      ),
    );
    this.emit({
      name: auditType,
      actorAgentId,
      resourceType,
      resourceId,
      outcome: "success",
    });
  }
  private audit(
    actorAgentId: string | null,
    type: AuditEvent["type"],
    companyId: string | null,
    resourceType: string,
    resourceId: string | null,
    action: string,
    metadata: Record<string, unknown>,
    createdAt: Date,
  ): AuditEvent {
    return {
      id: this.idGenerator(),
      type,
      actorAgentId,
      companyId,
      resourceType,
      resourceId,
      action,
      metadata,
      createdAt,
    };
  }
  private emit(event: SafeEvent) {
    const pending = this.pendingEvents.getStore();
    if (pending) pending.push(event);
    else this.eventSink?.(event);
  }

  private async committedTransaction<T>(
    operation: (repository: EconomyRepository) => Promise<T>,
  ): Promise<T> {
    const events: SafeEvent[] = [];
    const value = await this.pendingEvents.run(events, () =>
      this.repository.transaction(operation),
    );
    // Only committed operations are observable as successful. Never include payloads.
    for (const event of events) this.eventSink?.(event);
    return value;
  }

  async recordAuthorizationDenied(context: RequestContext): Promise<void> {
    await this.repository.createAuditEvent(
      this.audit(
        context.principal.agentId,
        "authorization.denied",
        null,
        "authorization",
        null,
        "authorize",
        {},
        this.clock(),
      ),
    );
    this.emit({
      name: "authorization.denied",
      actorAgentId: context.principal.agentId,
      outcome: "denied",
    });
  }

  private async authorizeMutation(
    repository: EconomyRepository,
    context: RequestContext,
    operation: string,
    payload: unknown,
  ): Promise<void> {
    const agent = await this.requireOwnAgent(repository, context);
    const rules: Record<
      string,
      {
        scope: "company:write" | "services:write" | "jobs:write";
        action?: Permission["action"];
      }
    > = {
      "agent.register": { scope: "company:write" },
      "credential.create": { scope: "company:write" },
      "credential.rotate": { scope: "company:write" },
      "credential.revoke": { scope: "company:write" },
      "service.create": { scope: "services:write", action: "service:create" },
      "service.update": { scope: "services:write", action: "service:update" },
      "service.request": { scope: "jobs:write", action: "service:request" },
      "job.accept": { scope: "jobs:write", action: "job:accept" },
      "job.start": { scope: "jobs:write", action: "job:process" },
      "job.submit": { scope: "jobs:write", action: "job:complete" },
      "job.fail": { scope: "jobs:write", action: "job:fail" },
      "invocation.cancel": { scope: "jobs:write", action: "job:cancel" },
    };
    const rule = rules[operation];
    if (!rule)
      throw new AuthorizationError(
        "This mutation has no authorization policy.",
      );
    let companyId = agent.companyId;
    const input = payload as Record<string, string>;
    if (operation === "service.create") companyId = input.companyId!;
    if (operation === "service.update") {
      const service = await repository.getService(input.serviceId!);
      if (!service) throw new NotFoundError("Service");
      companyId = service.companyId;
    }
    await this.authorization.assert(repository, context, {
      ...rule,
      companyId,
    });
  }
  private async withIdempotency<T>(
    context: RequestContext,
    operation: string,
    key: string,
    payload: unknown,
    execute: (repository: EconomyRepository) => Promise<T>,
    persisted: (result: T) => unknown = (result) => result,
  ): Promise<T> {
    idempotencyKeySchema.parse(key);
    const requestHash = stableHash(payload);
    return this.committedTransaction(async (repository) => {
      // Replays are responses, not an authorization bypass. Re-evaluate current scopes and policy first.
      await this.authorizeMutation(repository, context, operation, payload);
      const claim = await repository.claimIdempotency({
        agentId: context.principal.agentId,
        operation,
        key,
        requestHash,
        createdAt: this.clock(),
      });
      if (claim.state === "conflict") throw new IdempotencyConflictError();
      if (claim.state === "processing") throw new IdempotencyInProgressError();
      if (claim.state === "replay")
        return hydrateDomainDates<T>(claim.response);
      const result = await execute(repository);
      await repository.completeIdempotency({
        agentId: context.principal.agentId,
        operation,
        key,
        response: persisted(result),
      });
      return result;
    });
  }
}

function companyFrom(
  input: RegisterAgentInput,
  id: string,
  ownerUserId: string,
  primaryAgentId: string,
  createdAt: Date,
): Company {
  return {
    id,
    ownerUserId,
    primaryAgentId,
    slug: input.companySlug,
    name: input.companyName,
    description: input.description,
    industry: input.industry,
    website: input.website ?? null,
    createdAt,
  };
}
function agentFrom(
  input: RegisterAgentInput,
  id: string,
  userId: string,
  companyId: string,
  createdAt: Date,
): Agent {
  return {
    id,
    userId,
    companyId,
    name: input.agentName,
    handle: input.handle,
    framework: input.framework,
    status: "active",
    createdAt,
  };
}
function serviceSearch(
  value: ReturnType<typeof searchServicesSchema.parse>,
): ServiceSearch {
  const result: ServiceSearch = {
    limit: value.limit,
    sort: value.sort,
  };
  if (value.keyword) result.keyword = value.keyword;
  if (value.category) result.category = value.category;
  if (value.companyId) result.companyId = value.companyId;
  if (value.providerAgentId) result.providerAgentId = value.providerAgentId;
  if (value.status) result.status = value.status;
  if (value.pricingModel) result.pricingModel = value.pricingModel;
  if (value.cursor) result.cursor = value.cursor;
  return result;
}
function updatedServiceInput(service: Service) {
  const {
    id: _id,
    agentId: _agentId,
    version: _version,
    paymentExecution: _paymentExecution,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...input
  } = service;
  return input;
}
function stableHash(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
