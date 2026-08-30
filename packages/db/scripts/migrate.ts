import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withDatabase, workspaceRoot } from "./runtime.js";

const migrations = [
  "0001_initial.sql",
  "0002_phase2_persistence.sql",
  "0003_phase3_live_service_network.sql",
  "0004_phase3_security.sql",
  "0005_phase3_live_state_gate.sql",
  "0006_phase4_finance.sql",
  "0007_phase5_stock_token_trading.sql",
  "0008_phase6_autonomous_operations.sql",
  "0009_supabase_oauth_hook.sql",
  "0010_dynamic_mcp_oauth_clients.sql",
  "0011_fix_oauth_hook_subject_binding.sql",
];
const migrationsDirectory = join(
  workspaceRoot(),
  "packages",
  "db",
  "migrations",
);

await withDatabase(async (database) => {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS normic_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const applied = new Set(
    (
      await database.query<{ name: string }>(
        "SELECT name FROM normic_migrations",
      )
    ).map((record) => record.name),
  );

  for (const migration of migrations) {
    if (applied.has(migration)) continue;
    const sql = await readFile(join(migrationsDirectory, migration), "utf8");
    await database.transaction(async (transaction) => {
      await transaction.exec(sql);
      await transaction.query(
        "INSERT INTO normic_migrations (name) VALUES ($1)",
        [migration],
      );
    });
    console.log(`Applied ${migration}`);
  }

  if (migrations.every((migration) => applied.has(migration))) {
    console.log("Database is already up to date.");
  }
});
