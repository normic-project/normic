import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LedgerService, accountByCode, type Transaction } from "@normic/core";
import {
  createIdentity,
  createTestRuntime,
  serviceInput,
} from "../support/runtime.js";

describe("Retained immutable ledger (automated fixtures only)", () => {
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  let owner: Awaited<ReturnType<typeof createIdentity>>;
  let serviceId: string;
  beforeEach(async () => {
    runtime = await createTestRuntime();
    owner = await createIdentity(runtime.repository, "ledger");
    serviceId = (
      await runtime.economy.createService(
        owner.context,
        serviceInput(owner.companyId, "ledger"),
        "ledger-service-key",
      )
    ).id;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await runtime.database.close();
  });
  function transaction(status: Transaction["status"] = "pending"): Transaction {
    return {
      id: crypto.randomUUID(),
      type: "external_sale",
      buyerCompanyId: null,
      buyerLabel: "Automated ledger fixture",
      sellerCompanyId: owner.companyId,
      serviceId,
      amountCents: 100,
      status,
      ledgerEntryId: null,
      reversalOfTransactionId: null,
      failureReason: null,
      createdAt: new Date(),
      postedAt: null,
    };
  }
  it("requires balanced postings and uses a compensating reversal without modifying posted history", async () => {
    const ledger = new LedgerService();
    const original = transaction();
    const posted = await runtime.repository.transaction(async (tx) => {
      const accounts = await tx.ensureLedgerAccounts(
        owner.companyId,
        new Date(),
      );
      await tx.createTransaction(original);
      return ledger.post(tx, {
        transactionId: original.id,
        description: "Automated test fixture only",
        createdAt: new Date(),
        postings: [
          {
            account: accountByCode(accounts, "cash"),
            direction: "debit",
            amountCents: 100,
          },
          {
            account: accountByCode(accounts, "service_revenue"),
            direction: "credit",
            amountCents: 100,
          },
        ],
      });
    });
    expect(
      (await runtime.repository.getMetrics(owner.companyId)).revenueCents,
    ).toBe(100);
    await expect(
      runtime.database.query(
        "UPDATE ledger_entries SET description='changed' WHERE id=$1",
        [posted.id],
      ),
    ).rejects.toThrow(/immutable/i);
    await expect(
      runtime.database.query("DELETE FROM ledger_postings WHERE entry_id=$1", [
        posted.id,
      ]),
    ).rejects.toThrow(/immutable/i);
    await runtime.repository.transaction(async (tx) => {
      const reversal = {
        ...transaction(),
        type: "reversal" as const,
        reversalOfTransactionId: original.id,
      };
      await tx.createTransaction(reversal);
      const accounts = await tx.ensureLedgerAccounts(
        owner.companyId,
        new Date(),
      );
      await ledger.post(tx, {
        transactionId: reversal.id,
        description: "Reversal fixture",
        reversalOfEntryId: posted.id,
        createdAt: new Date(),
        postings: [
          {
            account: accountByCode(accounts, "cash"),
            direction: "credit",
            amountCents: 100,
          },
          {
            account: accountByCode(accounts, "service_revenue"),
            direction: "debit",
            amountCents: 100,
          },
        ],
      });
      await tx.reconcileTreasury(owner.companyId, new Date());
    });
    expect(
      (await runtime.repository.getMetrics(owner.companyId)).cashCents,
    ).toBe(0);
    expect(
      (await runtime.repository.getMetrics(owner.companyId)).revenueCents,
    ).toBe(0);
    expect((await runtime.repository.getLedgerEntry(posted.id))?.status).toBe(
      "posted",
    );
  });
  it("excludes failed transactions and rejects unbalanced entries", async () => {
    await runtime.repository.createTransaction(transaction("failed"));
    expect(
      (await runtime.repository.getMetrics(owner.companyId)).cashCents,
    ).toBe(0);
    const accounts = await runtime.repository.ensureLedgerAccounts(
      owner.companyId,
      new Date(),
    );
    await expect(
      new LedgerService().post(runtime.repository, {
        transactionId: crypto.randomUUID(),
        description: "Invalid test fixture",
        createdAt: new Date(),
        postings: [
          {
            account: accountByCode(accounts, "cash"),
            direction: "debit",
            amountCents: 100,
          },
        ],
      }),
    ).rejects.toThrow(/equal debit and credit/);
  });
  it("rejects application ledger posting outside automated tests until financial sources are enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      new LedgerService().post(runtime.repository, {
        transactionId: crypto.randomUUID(),
        description: "Disabled",
        createdAt: new Date(),
        postings: [],
      }),
    ).rejects.toThrow(/verified financial source/);
  });
});
