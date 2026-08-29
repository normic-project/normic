import type { NormicEconomy } from "./economy.js";
import type { FinancialService } from "./finance.js";
import type { RequestContext } from "./types.js";
import type { RequestServiceInput, SubmitResultInput } from "./schemas.js";
/** Shared Phase 3/4 routing belongs to core, not individual delivery handlers. */
export class NormicServiceNetwork {
  constructor(
    readonly economy: NormicEconomy,
    readonly finance: FinancialService,
  ) {}
  async request(
    context: RequestContext,
    input: RequestServiceInput,
    key: string,
  ) {
    const service = await this.economy.getService(context, input.serviceId);
    return service.pricingModel === "fixed" &&
      service.quotedPrice &&
      !/^0(?:\.0+)?$/.test(service.quotedPrice)
      ? this.finance.requestService({ kind: "agent", context }, input, key)
      : this.economy.requestService(context, input, key);
  }
  async invocation(context: RequestContext, id: string) {
    return (await this.finance.repository.getInvocation(id))
      ? this.finance.getInvocation({ kind: "agent", context }, id)
      : this.economy.getInvocation(context, id);
  }
  async action(
    context: RequestContext,
    id: string,
    action: "accept" | "start",
    key: string,
  ) {
    if (await this.finance.repository.getInvocation(id))
      return action === "accept"
        ? this.finance.prepare({ kind: "agent", context }, id, "accept", key)
        : this.finance.startJob({ kind: "agent", context }, id, key);
    return action === "accept"
      ? this.economy.acceptJob(context, id, key)
      : this.economy.startJob(context, id, key);
  }
  async submit(context: RequestContext, input: SubmitResultInput, key: string) {
    return (await this.finance.repository.getInvocation(input.jobId))
      ? this.finance.submitResult({ kind: "agent", context }, input, key)
      : this.economy.submitResult(context, input, key);
  }
}
