import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimeDatabase } from "../dist/database.js";
export function workspaceRoot() {
    let current = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(current, "pnpm-workspace.yaml"))) {
        const parent = dirname(current);
        if (parent === current)
            throw new Error("Could not locate the Normic workspace root.");
        current = parent;
    }
    return current;
}
export async function withDatabase(operation) {
    const database = await createRuntimeDatabase();
    try {
        return await operation({
            exec: async (sql) => {
                await database.exec(sql);
            },
            query: async (sql, parameters = []) => {
                return database.query(sql, parameters);
            },
            transaction: async (transactionOperation) => {
                if (database.kind === "pglite") {
                    await database.exec("BEGIN");
                    try {
                        const value = await transactionOperation({
                            exec: (sql) => database.exec(sql),
                            query: (sql, parameters = []) => database.query(sql, parameters),
                        });
                        await database.exec("COMMIT");
                        return value;
                    }
                    catch (error) {
                        await database.exec("ROLLBACK");
                        throw error;
                    }
                }
                return database.transaction((transaction) => transactionOperation({
                    exec: async (sql) => {
                        await transaction.query(sql);
                    },
                    query: async (sql, parameters = []) => transaction.query(sql, parameters),
                }));
            },
        });
    }
    finally {
        await database.close();
    }
}
