import { existsSync, unlinkSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";

export type SqlParameter =
  | string
  | number
  | boolean
  | Date
  | null
  | readonly string[]
  | Record<string, unknown>;
export interface SqlExecutor {
  query<TRecord>(
    sql: string,
    parameters?: readonly SqlParameter[],
  ): Promise<TRecord[]>;
}
export interface RuntimeDatabase extends SqlExecutor {
  readonly kind: "postgres" | "pglite";
  exec(sql: string): Promise<void>;
  transaction<T>(operation: (database: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createRuntimeDatabase(
  options: {
    databaseUrl?: string;
    pgliteDataDir?: string;
    allowPglite?: boolean;
  } = {},
): Promise<RuntimeDatabase> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    let protocol: string;
    try {
      protocol = new URL(databaseUrl).protocol;
    } catch {
      throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
    }
    if (protocol !== "postgres:" && protocol !== "postgresql:")
      throw new Error("DATABASE_URL must use postgres: or postgresql:.");
    return createPostgresDatabase(databaseUrl);
  }
  const localEnvironment = ["development", "test"].includes(
    process.env.NODE_ENV ?? "",
  );
  const allowPglite = localEnvironment && options.allowPglite !== false;
  if (!allowPglite)
    throw new Error(
      "DATABASE_URL is required in production or an unspecified environment. PGlite requires NODE_ENV=development or test.",
    );
  const dataDir =
    options.pgliteDataDir ??
    (process.env.PGLITE_DATA_DIR?.trim() ||
      join(findWorkspaceRoot(), ".data", "local-phase3"));
  return createPgliteDatabase(resolve(findWorkspaceRoot(), dataDir));
}

export function createPostgresDatabase(databaseUrl: string): RuntimeDatabase {
  const client = postgres(databaseUrl, {
    max: process.env.VERCEL === "1" ? 1 : 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  type PostgresQueryable = {
    unsafe(sql: string, parameters?: never[]): Promise<unknown>;
  };
  const wrap = (sql: PostgresQueryable): SqlExecutor => ({
    query: async <TRecord>(
      text: string,
      parameters: readonly SqlParameter[] = [],
    ) =>
      (await sql.unsafe(text, [
        ...parameters,
      ] as never[])) as unknown as TRecord[],
  });
  return {
    kind: "postgres",
    ...wrap(client as unknown as PostgresQueryable),
    exec: async (text) => {
      await client.unsafe(text);
    },
    transaction: (operation) =>
      client.begin(async (transaction) =>
        operation(wrap(transaction as unknown as PostgresQueryable)),
      ) as Promise<never>,
    close: () => client.end(),
  };
}

export async function createPgliteDatabase(
  dataDir: string,
): Promise<RuntimeDatabase> {
  if (!["development", "test"].includes(process.env.NODE_ENV ?? ""))
    throw new Error(
      "PGlite requires an explicit development or test environment.",
    );
  const isMemory = dataDir === "memory://";
  if (!isMemory) await mkdir(resolve(dataDir), { recursive: true });
  const lockPath = `${resolve(dataDir)}.runtime-lock`;
  let release = () => {};
  if (!isMemory) {
    let lock;
    try {
      lock = await open(lockPath, "wx");
    } catch {
      throw new Error(
        "This local PGlite directory is already in use. Use PostgreSQL for concurrent web, MCP, and database commands. Remove a stale .runtime-lock only after verifying its process has stopped.",
      );
    }
    await lock.writeFile(String(process.pid));
    await lock.close();
    release = () => {
      try {
        unlinkSync(lockPath);
      } catch {
        /* The owned lock may already be released. */
      }
    };
    process.once("exit", release);
  }
  const url = isMemory
    ? dataDir
    : `file://${resolve(dataDir).replaceAll("\\", "/")}`;
  const client = new PGlite(url);
  try {
    await client.waitReady;
  } catch (error) {
    release();
    process.removeListener("exit", release);
    throw error;
  }
  type PgliteQueryable = {
    query<TRecord>(
      sql: string,
      parameters?: unknown[],
    ): Promise<{ rows: TRecord[] }>;
  };
  const wrap = (database: PgliteQueryable): SqlExecutor => ({
    query: async <TRecord>(
      sql: string,
      parameters: readonly SqlParameter[] = [],
    ) => (await database.query<TRecord>(sql, [...parameters])).rows,
  });
  return {
    kind: "pglite",
    ...wrap(client as unknown as PgliteQueryable),
    exec: async (sql) => {
      await client.exec(sql);
    },
    transaction: (operation) =>
      client.transaction(async (transaction) =>
        operation(wrap(transaction as unknown as PgliteQueryable)),
      ),
    close: async () => {
      try {
        await client.close();
      } finally {
        release();
        process.removeListener("exit", release);
      }
    },
  };
}

export function findWorkspaceRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (!existsSync(join(current, "pnpm-workspace.yaml"))) {
    const parent = dirname(current);
    if (parent === current)
      throw new Error("Could not locate the Normic workspace root.");
    current = parent;
  }
  return current;
}
