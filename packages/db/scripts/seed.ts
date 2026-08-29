import { withDatabase } from "./runtime.js";

if (process.env.NODE_ENV === "production") {
  throw new Error(
    "Seeding is forbidden in production. Phase 5 has no demo financial or portfolio data.",
  );
}

await withDatabase(async (database) => {
  const migrations = await database.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM normic_migrations",
  );
  if ((migrations[0]?.count ?? 0) === 0) {
    throw new Error("Run pnpm db:migrate before seeding the database.");
  }
  console.log(
    "Phase 5 seed is intentionally empty. Use onboarding and finalized mainnet events to create real records.",
  );
});
