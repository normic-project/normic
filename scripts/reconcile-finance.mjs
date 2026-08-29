import { createRuntimeDatabase, PostgresFinancialRepository } from "@normic/db";
import { createFinancialRuntime } from "@normic/payments";
const database = await createRuntimeDatabase();
try {
  if (!/^[0-9]+$/.test(process.env.NORMIC_ESCROW_DEPLOYMENT_BLOCK ?? ""))
    throw new Error("Missing verified NORMIC_ESCROW_DEPLOYMENT_BLOCK.");
  const finance = createFinancialRuntime(
    new PostgresFinancialRepository(database),
    process.env,
  );
  console.log(
    JSON.stringify(
      await finance.reconcile(process.env.NORMIC_ESCROW_DEPLOYMENT_BLOCK),
    ),
  );
} catch {
  console.error(
    "Financial reconciliation blocked or failed. No fabricated events or balances were created. Check deployment configuration and RPC health.",
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
