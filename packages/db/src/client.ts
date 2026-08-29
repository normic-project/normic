import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: process.env.VERCEL === "1" ? 1 : 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  return { client, db: drizzle(client, { schema }) };
}
export type NormicDatabase = ReturnType<typeof createDatabase>["db"];
