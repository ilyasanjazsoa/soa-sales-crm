import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema";

export * as schema from "./schema";
export { schema as tables };

export type Database = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction; repos accept either. */
export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The role the application runs as (packages/db/migrations/0002_app_role.sql). */
export const APP_ROLE = "crm_app";

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  /** Run every connection as this role. The api and worker use APP_ROLE; migrations and admin tasks use none. */
  role?: string;
  max?: number;
}

export function createDb(databaseUrl: string, options: CreateDbOptions = {}): DbHandle {
  if (options.role !== undefined && !/^[a-z_][a-z0-9_]*$/.test(options.role)) throw new Error("invalid role name");
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5_000,
    // The role is set in the connection's startup packet, so a connection that can't take the role fails
    // instead of silently running as the owner.
    ...(options.role === undefined ? {} : { options: `-c role=${options.role}` }),
  });
  // An idle client losing its connection must not crash the process; the next query reports the failure.
  pool.on("error", () => undefined);
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

/** True when the database answers a trivial query within `timeoutMs`. */
export async function pingDatabase(pool: pg.Pool, timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  const query = pool.query("select 1").then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

/** Applies every migration in packages/db/migrations. Connect as the schema owner, not the app role. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
}
