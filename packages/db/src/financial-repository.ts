import {
  CANONICAL_USDG,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  type EvmHash,
  type EvmAddress,
  type FinancialRepository,
  type FinancialWallet,
  type SpendingPolicy,
  type FinancialSession,
  type FinancialSessionAuthorization,
  type PaidInvocation,
  type PaymentOperation,
  type VerifiedEscrowEvent,
  type FinancialSummary,
  type FinanceClaim,
} from "@normic/core";
import { PostgresEconomyRepository } from "./repository.js";
import type { RuntimeDatabase, SqlExecutor, SqlParameter } from "./database.js";

export class PostgresFinancialRepository implements FinancialRepository {
  readonly economy: PostgresEconomyRepository;
  constructor(private readonly db: RuntimeDatabase | SqlExecutor) {
    this.economy = new PostgresEconomyRepository(db);
  }
  transaction<T>(
    operation: (tx: FinancialRepository) => Promise<T>,
  ): Promise<T> {
    return "transaction" in this.db
      ? this.db.transaction((tx) =>
          operation(new PostgresFinancialRepository(tx)),
        )
      : operation(this);
  }
  async lockCompany(companyId: string) {
    await this.db.query("SELECT id FROM companies WHERE id=$1 FOR UPDATE", [
      companyId,
    ]);
  }
  async lockIndexer() {
    await this.db.query(
      "SELECT id FROM financial_indexer_lock WHERE id=1 FOR UPDATE",
    );
  }
  async listWallets() {
    return (
      await this.db.query<{ data: FinancialWallet }>(
        "SELECT data FROM financial_wallets ORDER BY company_id",
      )
    ).map((r) => r.data);
  }
  async observeTransfer(
    companyId: string,
    t: {
      transactionHash: EvmHash;
      logIndex: number;
      from: EvmAddress;
      units: string;
      blockNumber: string;
      blockHash: EvmHash;
    },
    kind: "capital" | "unattributed",
  ) {
    await this.db.query(
      "INSERT INTO wallet_transfer_observations(company_id,chain_id,transaction_hash,log_index,block_number,block_hash,from_address,token_units,classification) VALUES($1,4663,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
      [
        companyId,
        t.transactionHash,
        t.logIndex,
        t.blockNumber,
        t.blockHash,
        t.from,
        t.units,
        kind,
      ],
    );
  }
  async claim(
    actor: string,
    operation: string,
    key: string,
    hash: string,
  ): Promise<FinanceClaim> {
    const rows = await this.db.query(
      "INSERT INTO financial_idempotency(actor,operation,key,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING actor",
      [actor, operation, key, hash],
    );
    if (rows.length) return { replay: false };
    const [record] = await this.db.query<{
      request_hash: string;
      response: unknown;
    }>(
      "SELECT request_hash,response FROM financial_idempotency WHERE actor=$1 AND operation=$2 AND key=$3 FOR UPDATE",
      [actor, operation, key],
    );
    if (!record || record.request_hash !== hash)
      throw new IdempotencyConflictError();
    if (record.response === null) throw new IdempotencyInProgressError();
    return { replay: true, response: record.response };
  }
  async complete(
    actor: string,
    operation: string,
    key: string,
    response: unknown,
  ) {
    await this.db.query(
      "UPDATE financial_idempotency SET response=$4::jsonb WHERE actor=$1 AND operation=$2 AND key=$3",
      [actor, operation, key, JSON.stringify(response)],
    );
  }
  private async data<T>(
    sql: string,
    args: readonly SqlParameter[],
  ): Promise<T | null> {
    return (await this.db.query<{ data: T }>(sql, args))[0]?.data ?? null;
  }
  getWallet(id: string) {
    return this.data<FinancialWallet>(
      "SELECT data FROM financial_wallets WHERE company_id=$1",
      [id],
    );
  }
  async saveWallet(w: FinancialWallet) {
    await this.db.query(
      "INSERT INTO financial_wallets(company_id,agent_id,address,owner_address,chain_id,data) VALUES($1,$2,$3,$4,4663,$5::jsonb)",
      [
        w.companyId,
        w.agentId,
        w.address.toLowerCase(),
        w.ownerAddress.toLowerCase(),
        JSON.stringify(w),
      ],
    );
  }
  getPolicy(id: string) {
    return this.data<SpendingPolicy>(
      "SELECT data FROM spending_policies WHERE company_id=$1",
      [id],
    );
  }
  async savePolicy(p: SpendingPolicy) {
    await this.db.query(
      "INSERT INTO spending_policies(company_id,enabled,version,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(company_id) DO UPDATE SET enabled=EXCLUDED.enabled,version=EXCLUDED.version,data=EXCLUDED.data,updated_at=now()",
      [p.companyId, p.enabled, p.version, JSON.stringify(p)],
    );
  }
  getSession(id: string) {
    return this.data<FinancialSession>(
      "SELECT data FROM financial_sessions WHERE company_id=$1 AND revoked_at IS NULL ORDER BY expires_at DESC LIMIT 1",
      [id],
    );
  }
  async saveSession(s: FinancialSession) {
    await this.db.query(
      "INSERT INTO financial_sessions(id,company_id,expires_at,revoked_at,data) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(id) DO UPDATE SET revoked_at=EXCLUDED.revoked_at,data=EXCLUDED.data",
      [s.id, s.companyId, s.expiresAt, s.revokedAt, JSON.stringify(s)],
    );
  }
  getSessionAuthorization(id: string, lock = false) {
    return this.data<FinancialSessionAuthorization>(
      `SELECT data FROM financial_session_authorizations WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    );
  }
  async saveSessionAuthorization(s: FinancialSessionAuthorization) {
    await this.db.query(
      "INSERT INTO financial_session_authorizations(id,company_id,public_key,provider_session_id,signer_ref,owner_authorization_payload,permission_digest,policy_version,expires_at,consumed_at,data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) ON CONFLICT(id) DO UPDATE SET consumed_at=EXCLUDED.consumed_at,data=EXCLUDED.data",
      [
        s.id,
        s.companyId,
        s.publicKey.toLowerCase(),
        s.providerSessionId,
        s.signerRef,
        s.ownerAuthorizationPayload.toLowerCase(),
        s.permissionDigest.toLowerCase(),
        s.policyVersion,
        s.expiresAt,
        s.consumedAt,
        JSON.stringify(s),
        s.createdAt,
      ],
    );
  }
  async createInvocation(i: PaidInvocation) {
    await this.db.query(
      "INSERT INTO paid_invocations(id,onchain_id,service_id,provider_company_id,provider_agent_id,buyer_company_id,buyer_agent_id,buyer_wallet,amount_units,state,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
      [
        i.id,
        i.onchainId,
        i.serviceId,
        i.providerCompanyId,
        i.providerAgentId,
        i.buyerCompanyId,
        i.buyerAgentId,
        i.buyerWallet.toLowerCase(),
        i.terms.amount,
        i.state,
        JSON.stringify(i),
      ],
    );
  }
  getInvocation(id: string, lock = false) {
    return this.data<PaidInvocation>(
      `SELECT data FROM paid_invocations WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    );
  }
  getInvocationByOnchainId(id: EvmHash) {
    return this.data<PaidInvocation>(
      "SELECT data FROM paid_invocations WHERE onchain_id=$1 FOR UPDATE",
      [id],
    );
  }
  async saveInvocation(i: PaidInvocation) {
    await this.db.query(
      "UPDATE paid_invocations SET state=$2,data=$3::jsonb WHERE id=$1",
      [i.id, i.state, JSON.stringify(i)],
    );
  }
  async listInvocations(f: {
    providerAgentId?: string;
    buyerAgentId?: string;
    buyerWallet?: EvmAddress;
  }) {
    const condition = f.providerAgentId
      ? "provider_agent_id=$1 AND state<>'payment_required'"
      : f.buyerAgentId
        ? "buyer_agent_id=$1"
        : "buyer_wallet=$1";
    const value = f.providerAgentId ?? f.buyerAgentId ?? f.buyerWallet;
    if (!value) return [];
    return (
      await this.db.query<{ data: PaidInvocation }>(
        `SELECT data FROM paid_invocations WHERE ${condition} ORDER BY created_at DESC,id LIMIT 100`,
        [value],
      )
    ).map((x) => x.data);
  }
  async saveOperation(o: PaymentOperation) {
    await this.db.query(
      "INSERT INTO payment_operations(id,invocation_id,action,status,data) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,data=EXCLUDED.data",
      [o.id, o.invocationId, o.action, o.status, JSON.stringify(o)],
    );
  }
  getOperation(id: string, lock = false) {
    return this.data<PaymentOperation>(
      `SELECT data FROM payment_operations WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    );
  }
  async reservedToday(companyId: string) {
    const [row] = await this.db.query<{ total: string }>(
      `SELECT COALESCE(sum(i.amount_units),0)::text total FROM payment_operations o JOIN paid_invocations i ON i.id=o.invocation_id WHERE i.buyer_company_id=$1 AND o.action='fund' AND o.status<>'failed' AND o.created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [companyId],
    );
    return row?.total ?? "0";
  }
  getActionOperation(id: string, action: PaymentOperation["action"]) {
    return this.data<PaymentOperation>(
      "SELECT data FROM payment_operations WHERE invocation_id=$1 AND action=$2 AND status<>'failed' LIMIT 1",
      [id, action],
    );
  }
  async listOperations(id: string) {
    return (
      await this.db.query<{ data: PaymentOperation }>(
        "SELECT data FROM payment_operations WHERE invocation_id=$1 ORDER BY created_at,id",
        [id],
      )
    ).map((r) => r.data);
  }
  async insertEvent(e: VerifiedEscrowEvent) {
    const rows = await this.db.query(
      "INSERT INTO escrow_events(chain_id,transaction_hash,log_index,block_number,block_hash,contract_address,invocation_id,event_type,data,observed_at) VALUES(4663,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(chain_id,transaction_hash,log_index) DO NOTHING RETURNING id",
      [
        e.transactionHash,
        e.logIndex,
        e.blockNumber,
        e.blockHash,
        e.contractAddress.toLowerCase(),
        e.invocationId,
        e.name,
        JSON.stringify(e),
        e.observedAt,
      ],
    );
    return rows.length > 0;
  }
  async postJournal(
    e: VerifiedEscrowEvent,
    companyId: string,
    debit: string,
    credit: string,
    units: string,
  ) {
    const entryId = crypto.randomUUID();
    const added = await this.db.query(
      "INSERT INTO ledger_entries(id,description,source_event_id,company_id) SELECT $1,$2,id,$3 FROM escrow_events WHERE chain_id=4663 AND transaction_hash=$4 AND log_index=$5 ON CONFLICT DO NOTHING RETURNING id",
      [entryId, `Verified ${e.name}`, companyId, e.transactionHash, e.logIndex],
    );
    if (!added.length) return;
    const accounts = await this.economy.ensureLedgerAccounts(
      companyId,
      new Date(),
    );
    const account = (code: string) => {
      const a = accounts.find(
        (x) => x.code === (code === "restricted_escrow" ? "other_asset" : code),
      );
      if (!a) throw new Error("Missing ledger account.");
      return a.id;
    };
    await this.db.query(
      "INSERT INTO ledger_postings(entry_id,account_id,direction,token_units) VALUES($1,$2,'debit',$4),($1,$3,'credit',$4)",
      [entryId, account(debit), account(credit), units],
    );
    await this.db.query(
      "UPDATE ledger_entries SET status='posted' WHERE id=$1",
      [entryId],
    );
  }
  async summary(companyId: string): Promise<FinancialSummary> {
    const rows = await this.db.query<{ code: string; balance: string }>(
      "SELECT a.code, COALESCE(sum(CASE WHEN p.direction=a.normal_balance THEN p.token_units ELSE -p.token_units END),0)::text balance FROM ledger_accounts a LEFT JOIN ledger_postings p ON p.account_id=a.id LEFT JOIN ledger_entries e ON e.id=p.entry_id WHERE a.company_id=$1 AND e.status='posted' AND e.source_event_id IS NOT NULL GROUP BY a.code",
      [companyId],
    );
    const value = (code: string) =>
      rows.find((x) => x.code === code)?.balance ?? "0";
    return {
      companyId,
      tokenAddress: CANONICAL_USDG,
      chainId: 4663,
      unit: "token_base_units",
      verifiedServiceRevenue: value("service_revenue"),
      serviceExpenses: value("service_expense"),
      restrictedEscrow: value("other_asset"),
      directTransfersAreRevenue: false,
      source: "finalized_escrow_events",
    };
  }
  async history(companyId: string) {
    return this.db.query<Record<string, unknown>>(
      "SELECT ev.transaction_hash,ev.log_index,ev.block_number::text,ev.block_hash,ev.event_type,ev.invocation_id,ev.observed_at,'finalized' status,4663 chain_id,i.amount_units::text,i.data->>'tokenDecimals' token_decimals,i.buyer_wallet,i.data->'terms'->>'provider' provider_wallet,'https://robinhoodchain.blockscout.com/tx/' || ev.transaction_hash explorer FROM escrow_events ev JOIN paid_invocations i ON i.onchain_id=ev.invocation_id WHERE i.buyer_company_id=$1 OR i.provider_company_id=$1 ORDER BY ev.block_number DESC,ev.log_index DESC LIMIT 100",
      [companyId],
    );
  }
  async leaderboard() {
    return this.db.query<{ companyId: string; verifiedServiceRevenue: string }>(
      `SELECT a.company_id AS "companyId",sum(CASE WHEN p.direction='credit' THEN p.token_units ELSE -p.token_units END)::text AS "verifiedServiceRevenue" FROM ledger_accounts a JOIN ledger_postings p ON p.account_id=a.id JOIN ledger_entries e ON e.id=p.entry_id WHERE a.code='service_revenue' AND e.status='posted' AND e.source_event_id IS NOT NULL GROUP BY a.company_id ORDER BY sum(CASE WHEN p.direction='credit' THEN p.token_units ELSE -p.token_units END) DESC,a.company_id LIMIT 100`,
    );
  }
  async audit(
    type: string,
    companyId: string | null,
    resourceId: string | null,
    actor: string,
    details: Record<string, string> = {},
  ) {
    await this.db.query(
      "INSERT INTO audit_events(type,company_id,resource_type,resource_id,action,metadata) VALUES($1,$2,'finance',$3,$1,$4::jsonb)",
      [type, companyId, resourceId, JSON.stringify({ actor, ...details })],
    );
  }
  async getCheckpoint() {
    return (
      (
        await this.db.query<{ block: string; hash: EvmHash }>(
          "SELECT block_number::text block,block_hash hash FROM financial_checkpoints WHERE chain_id=4663",
        )
      )[0] ?? null
    );
  }
  async setCheckpoint(block: string, hash: EvmHash) {
    await this.db.query(
      "INSERT INTO financial_checkpoints(chain_id,block_number,block_hash) VALUES(4663,$1,$2) ON CONFLICT(chain_id) DO UPDATE SET block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash",
      [block, hash],
    );
  }
  async createChallenge(
    id: string,
    wallet: EvmAddress,
    message: string,
    expiresAt: string,
  ) {
    await this.db.query(
      "INSERT INTO wallet_challenges(id,wallet,message,expires_at) VALUES($1,$2,$3,$4)",
      [id, wallet, message, expiresAt],
    );
  }
  async consumeChallenge(id: string) {
    const [r] = await this.db.query<{
      wallet: EvmAddress;
      message: string;
      expiresAt: Date;
    }>(
      'UPDATE wallet_challenges SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING wallet,message,expires_at AS "expiresAt"',
      [id],
    );
    return r ? { ...r, expiresAt: r.expiresAt.toISOString() } : null;
  }
  async createHumanSession(
    id: string,
    wallet: EvmAddress,
    hash: string,
    expiresAt: string,
  ) {
    await this.db.query(
      "INSERT INTO human_wallet_sessions(id,wallet,secret_hash,expires_at) VALUES($1,$2,$3,$4)",
      [id, wallet, hash, expiresAt],
    );
  }
  async getHumanSession(hash: string) {
    const [r] = await this.db.query<{
      id: string;
      wallet: EvmAddress;
      expiresAt: Date;
    }>(
      'SELECT id,wallet,expires_at AS "expiresAt" FROM human_wallet_sessions WHERE secret_hash=$1 AND expires_at>now()',
      [hash],
    );
    return r ? { ...r, expiresAt: r.expiresAt.toISOString() } : null;
  }
}
