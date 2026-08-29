import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimeDatabase } from "../dist/database.js";

type ScriptExecutor = {
  exec(sql: string): Promise<void>;
  query<TRecord>(
    sql: string,
    parameters?: readonly string[],
  ): Promise<TRecord[]>;
};

type ScriptDatabase = ScriptExecutor & {
  transaction<T>(operation: (database: ScriptExecutor) => Promise<T>): Promise<T>;
};

export function workspaceRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(current, "pnpm-workspace.yaml"))) {
    const parent = dirname(current);
    if (parent === current)
      throw new Error("Could not locate the Normic workspace root.");
    current = parent;
  }
  return current;
}

export async function withDatabase<T>(
  operation: (database: ScriptDatabase) => Promise<T>,
): Promise<T> {
  const database = await createRuntimeDatabase();
  try {
    return await operation({
      exec: async (sql) => {
        await database.exec(sql);
      },
      query: async <TRecord>(sql: string, parameters = []) => {
        return database.query<TRecord>(sql, parameters);
      },
      transaction: async (transactionOperation) => {
        if (database.kind === "pglite") {
          await database.exec("BEGIN");
          try {
            const value = await transactionOperation({
              exec: (sql) => database.exec(sql),
              query: <TRecord>(sql: string, parameters = []) =>
                database.query<TRecord>(sql, parameters),
            });
            await database.exec("COMMIT");
            return value;
          } catch (error) {
            await database.exec("ROLLBACK");
            throw error;
          }
        }
        return database.transaction((transaction) =>
          transactionOperation({
            exec: async (sql) => {
              await transaction.query(sql);
            },
            query: async <TRecord>(sql: string, parameters = []) =>
              transaction.query<TRecord>(sql, parameters),
          }),
        );
      },
    });
  } finally {
    await database.close();
  }
}
