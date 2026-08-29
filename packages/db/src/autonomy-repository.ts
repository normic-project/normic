import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  type ActionApproval,
  type ActionHistory,
  type ActionPlan,
  type AgentHeartbeat,
  type AutonomyClaim,
  type AutonomyRepository,
  type AutonomyRiskStatus,
  type Opportunity,
  type OwnerMandate,
} from "@normic/core";
import { PostgresEconomyRepository } from "./repository.js";
import type { RuntimeDatabase, SqlExecutor, SqlParameter } from "./database.js";

export class PostgresAutonomyRepository implements AutonomyRepository {
  readonly economy: PostgresEconomyRepository;

  constructor(private readonly db: RuntimeDatabase | SqlExecutor) {
    this.economy = new PostgresEconomyRepository(db);
  }

  transaction<T>(
    operation: (tx: AutonomyRepository) => Promise<T>,
  ): Promise<T> {
    return "transaction" in this.db
      ? this.db.transaction((tx) =>
          operation(new PostgresAutonomyRepository(tx)),
        )
      : operation(this);
  }

  async lockCompany(companyId: string) {
    await this.db.query("SELECT id FROM companies WHERE id=$1 FOR UPDATE", [
      companyId,
    ]);
  }

  async claim(
    actor: string,
    operation: string,
    key: string,
    requestHash: string,
  ) {
    const inserted = await this.db.query(
      "INSERT INTO autonomy_idempotency(actor,operation,key,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING actor",
      [actor, operation, key, requestHash],
    );
    if (inserted.length) return { replay: false } satisfies AutonomyClaim;
    const [record] = await this.db.query<{
      request_hash: string;
      response: unknown;
    }>(
      "SELECT request_hash,response FROM autonomy_idempotency WHERE actor=$1 AND operation=$2 AND key=$3 FOR UPDATE",
      [actor, operation, key],
    );
    if (!record || record.request_hash !== requestHash)
      throw new IdempotencyConflictError();
    if (record.response === null) throw new IdempotencyInProgressError();
    return { replay: true, response: record.response } satisfies AutonomyClaim;
  }

  async complete(
    actor: string,
    operation: string,
    key: string,
    response: unknown,
  ) {
    await this.db.query(
      "UPDATE autonomy_idempotency SET response=$4::jsonb WHERE actor=$1 AND operation=$2 AND key=$3",
      [actor, operation, key, JSON.stringify(response)],
    );
  }

  private async data<T>(sql: string, parameters: readonly SqlParameter[]) {
    return (await this.db.query<{ data: T }>(sql, parameters))[0]?.data ?? null;
  }

  getMandate(companyId: string) {
    return this.data<OwnerMandate>(
      "SELECT data FROM autonomy_mandates WHERE company_id=$1 ORDER BY version DESC LIMIT 1",
      [companyId],
    );
  }

  async saveMandate(value: OwnerMandate) {
    await this.db.query(
      `INSERT INTO autonomy_mandates(company_id,version,mode,session_expires_at,data,created_at)
       VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        value.companyId,
        value.version,
        value.mode,
        value.sessionExpiresAt,
        JSON.stringify(value),
        value.updatedAt,
      ],
    );
  }

  getHeartbeat(agentId: string) {
    return this.data<AgentHeartbeat>(
      "SELECT data FROM agent_heartbeats WHERE agent_id=$1",
      [agentId],
    );
  }

  async saveHeartbeat(value: AgentHeartbeat) {
    await this.db.query(
      `INSERT INTO agent_heartbeats
       (agent_id,company_id,session_id,status,current_job_id,connected_at,last_heartbeat_at,expires_at,data)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT(agent_id) DO UPDATE SET
         company_id=EXCLUDED.company_id,session_id=EXCLUDED.session_id,status=EXCLUDED.status,
         current_job_id=EXCLUDED.current_job_id,connected_at=EXCLUDED.connected_at,
         last_heartbeat_at=EXCLUDED.last_heartbeat_at,expires_at=EXCLUDED.expires_at,data=EXCLUDED.data`,
      [
        value.agentId,
        value.companyId,
        value.sessionId,
        value.status,
        value.currentJobId,
        value.connectedAt,
        value.lastHeartbeatAt,
        value.expiresAt,
        JSON.stringify(value),
      ],
    );
  }

  async saveOpportunity(value: Opportunity) {
    await this.db.query(
      `INSERT INTO autonomy_opportunities
       (id,company_id,agent_id,kind,source_type,source_id,fingerprint,status,data,expires_at,claimed_at,dismissed_at,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)
       ON CONFLICT(company_id,fingerprint) DO NOTHING`,
      [
        value.id,
        value.companyId,
        value.agentId,
        value.kind,
        value.sourceType,
        value.sourceId,
        value.fingerprint,
        value.status,
        JSON.stringify(value),
        value.expiresAt,
        value.claimedAt,
        value.dismissedAt,
        value.createdAt,
      ],
    );
  }

  getOpportunity(id: string) {
    return this.data<Opportunity>(
      "SELECT data FROM autonomy_opportunities WHERE id=$1",
      [id],
    );
  }

  async listOpportunities(companyId: string, limit: number) {
    return (
      await this.db.query<{ data: Opportunity }>(
        `SELECT data FROM autonomy_opportunities
         WHERE company_id=$1 AND status IN ('OPEN','CLAIMED')
           AND (expires_at IS NULL OR expires_at>now())
         ORDER BY created_at DESC,id LIMIT $2`,
        [companyId, limit],
      )
    ).map((row) => row.data);
  }

  async updateOpportunity(value: Opportunity) {
    await this.db.query(
      `UPDATE autonomy_opportunities SET status=$2,claimed_at=$3,dismissed_at=$4,data=$5::jsonb
       WHERE id=$1`,
      [
        value.id,
        value.status,
        value.claimedAt,
        value.dismissedAt,
        JSON.stringify(value),
      ],
    );
  }

  async savePlan(value: ActionPlan) {
    await this.db.query(
      `INSERT INTO autonomy_action_plans
       (id,company_id,agent_id,credential_id,opportunity_id,action_type,action_hash,mandate_version,
        mode,status,financial_amount_usdg,transaction_reference,failure_code,data,created_at,expires_at,executed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17)
       ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,
         transaction_reference=EXCLUDED.transaction_reference,failure_code=EXCLUDED.failure_code,
         data=EXCLUDED.data,executed_at=EXCLUDED.executed_at`,
      [
        value.id,
        value.companyId,
        value.agentId,
        value.credentialId,
        value.opportunityId,
        value.action.type,
        value.actionHash,
        value.mandateVersion,
        value.mode,
        value.status,
        value.financialAmountUsdg,
        value.transactionReference,
        value.failureCode,
        JSON.stringify(value),
        value.createdAt,
        value.expiresAt,
        value.executedAt,
      ],
    );
  }

  getPlan(id: string, lock = false) {
    return this.data<ActionPlan>(
      `SELECT data FROM autonomy_action_plans WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    );
  }

  async listPendingApprovals(companyId: string) {
    return (
      await this.db.query<{ plan: ActionPlan; approval: ActionApproval }>(
        `SELECT p.data plan,a.data approval FROM autonomy_action_plans p
         JOIN autonomy_action_approvals a ON a.plan_id=p.id
         WHERE p.company_id=$1 AND p.status='PENDING_APPROVAL' AND a.status='PENDING'
           AND p.expires_at>now() ORDER BY p.created_at`,
        [companyId],
      )
    ).map((row) => ({ plan: row.plan, approval: row.approval }));
  }

  async saveApproval(value: ActionApproval) {
    await this.db.query(
      `INSERT INTO autonomy_action_approvals
       (id,plan_id,action_hash,status,owner_issuer,owner_subject,decided_at,expires_at,created_at,data)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT(plan_id) DO UPDATE SET status=EXCLUDED.status,
         owner_issuer=EXCLUDED.owner_issuer,owner_subject=EXCLUDED.owner_subject,
         decided_at=EXCLUDED.decided_at,data=EXCLUDED.data`,
      [
        value.id,
        value.planId,
        value.actionHash,
        value.status,
        value.ownerIssuer,
        value.ownerSubject,
        value.decidedAt,
        value.expiresAt,
        value.createdAt,
        JSON.stringify(value),
      ],
    );
  }

  getApproval(planId: string, lock = false) {
    return this.data<ActionApproval>(
      `SELECT data FROM autonomy_action_approvals WHERE plan_id=$1${lock ? " FOR UPDATE" : ""}`,
      [planId],
    );
  }

  async addHistory(value: ActionHistory) {
    await this.db.query(
      `INSERT INTO autonomy_action_history
       (id,company_id,agent_id,opportunity_id,plan_id,action_type,mandate_version,
        transaction_reference,data,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [
        value.id,
        value.companyId,
        value.agentId,
        value.opportunityId,
        value.planId,
        value.actionType,
        value.mandateVersion,
        value.transactionReference,
        JSON.stringify(value),
        value.createdAt,
      ],
    );
  }

  async listHistory(companyId: string, limit: number) {
    return (
      await this.db.query<{ data: ActionHistory }>(
        "SELECT data FROM autonomy_action_history WHERE company_id=$1 ORDER BY created_at DESC,id LIMIT $2",
        [companyId, limit],
      )
    ).map((row) => row.data);
  }

  async dailyExecutedSpend(companyId: string) {
    const [row] = await this.db.query<{ total: string }>(
      `SELECT COALESCE(sum(financial_amount_usdg),0)::text total
       FROM autonomy_action_plans WHERE company_id=$1 AND status='EXECUTED'
         AND action_type IN ('BUY_AGENT_SERVICE','BUY_STOCK_TOKEN')
         AND executed_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [companyId],
    );
    return row?.total ?? "0";
  }

  async activeReservations(companyId: string) {
    const [row] = await this.db.query<{ total: string }>(
      `SELECT COALESCE(sum(amount_usdg),0)::text total FROM autonomy_spend_reservations
       WHERE company_id=$1 AND status='ACTIVE' AND expires_at>now()`,
      [companyId],
    );
    return row?.total ?? "0";
  }

  async reserve(
    planId: string,
    companyId: string,
    amount: string,
    expiresAt: string,
  ) {
    await this.db.query(
      `INSERT INTO autonomy_spend_reservations(plan_id,company_id,amount_usdg,status,expires_at)
       VALUES($1,$2,$3,'ACTIVE',$4)`,
      [planId, companyId, amount, expiresAt],
    );
  }

  async finishReservation(planId: string, status: "CONSUMED" | "RELEASED") {
    await this.db.query(
      `UPDATE autonomy_spend_reservations SET status=$2,finished_at=now()
       WHERE plan_id=$1 AND status='ACTIVE'`,
      [planId, status],
    );
  }

  async riskStatus(companyId: string): Promise<AutonomyRiskStatus> {
    const rows = await this.db.query<{
      code: AutonomyRiskStatus["circuitBreakers"][number]["code"];
      active: boolean;
      reason: string;
      triggered_at: Date | null;
    }>(
      "SELECT code,active,reason,triggered_at FROM autonomy_circuit_breakers WHERE company_id=$1 AND active=true",
      [companyId],
    );
    const [failures] = await this.db.query<{ count: string }>(
      `SELECT count(*)::text count FROM autonomy_action_plans
       WHERE company_id=$1 AND status='FAILED' AND executed_at>now()-interval '15 minutes'`,
      [companyId],
    );
    const breakers = rows.map((row) => ({
      code: row.code,
      active: row.active,
      reason: row.reason,
      triggeredAt: row.triggered_at?.toISOString() ?? null,
    }));
    if (Number(failures?.count ?? 0) >= 3)
      breakers.push({
        code: "REPEATED_TRANSACTION_FAILURES",
        active: true,
        reason:
          "Three or more autonomous action failures occurred within 15 minutes.",
        triggeredAt: new Date().toISOString(),
      });
    return {
      companyId,
      state: breakers.length ? "BLOCKED" : "CLEAR",
      circuitBreakers: breakers,
      checkedAt: new Date().toISOString(),
    };
  }

  async audit(
    type: string,
    companyId: string,
    resourceId: string | null,
    actor: string,
    details: Record<string, string> = {},
  ) {
    await this.db.query(
      `INSERT INTO audit_events(type,company_id,resource_type,resource_id,action,metadata)
       VALUES($1,$2,'autonomy',$3,$1,$4::jsonb)`,
      [type, companyId, resourceId, JSON.stringify({ actor, ...details })],
    );
  }
}
