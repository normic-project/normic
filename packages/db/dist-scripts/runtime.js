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
            query: async (sql) => {
                return database.query(sql);
            },
        });
    }
    finally {
        await database.close();
    }
}
