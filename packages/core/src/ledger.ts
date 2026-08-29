import { DomainError, LedgerImbalanceError } from "./errors.js";
import type { EconomyRepository } from "./repository.js";
import type {
  LedgerAccount,
  LedgerDirection,
  LedgerEntry,
  LedgerPosting,
} from "./types.js";

export type PostingPlan = {
  account: LedgerAccount;
  direction: LedgerDirection;
  amountCents: number;
};

export class LedgerService {
  constructor(
    private readonly idGenerator: () => string = () => crypto.randomUUID(),
  ) {}

  async post(
    repository: EconomyRepository,
    input: {
      transactionId: string;
      description: string;
      postings: PostingPlan[];
      reversalOfEntryId?: string;
      createdAt: Date;
    },
  ): Promise<LedgerEntry> {
    // No verified financial source is enabled in Phase 3. Keep ledger invariants
    // for migration/reconciliation, but never allow application code to mint events.
    if (process.env.NODE_ENV !== "test")
      throw new DomainError(
        "Financial posting is unavailable until a verified financial source is enabled.",
        "FINANCIAL_EXECUTION_UNAVAILABLE",
      );
    const debits = input.postings
      .filter((posting) => posting.direction === "debit")
      .reduce((sum, posting) => sum + posting.amountCents, 0);
    const credits = input.postings
      .filter((posting) => posting.direction === "credit")
      .reduce((sum, posting) => sum + posting.amountCents, 0);
    if (debits <= 0 || debits !== credits) throw new LedgerImbalanceError();

    const entry: LedgerEntry = {
      id: this.idGenerator(),
      transactionId: input.transactionId,
      description: input.description,
      status: "pending",
      reversalOfEntryId: input.reversalOfEntryId ?? null,
      createdAt: input.createdAt,
      postedAt: null,
    };
    const postings: LedgerPosting[] = input.postings.map((posting) => ({
      id: this.idGenerator(),
      entryId: entry.id,
      accountId: posting.account.id,
      direction: posting.direction,
      amountCents: posting.amountCents,
      createdAt: input.createdAt,
    }));

    await repository.createLedgerEntry(entry);
    await repository.createLedgerPostings(postings);
    await repository.postLedgerEntry(entry.id, input.createdAt);
    return { ...entry, status: "posted", postedAt: input.createdAt };
  }
}

export function accountByCode(
  accounts: LedgerAccount[],
  code: LedgerAccount["code"],
): LedgerAccount {
  const account = accounts.find((candidate) => candidate.code === code);
  if (!account) throw new Error(`Ledger account ${code} was not provisioned.`);
  return account;
}
