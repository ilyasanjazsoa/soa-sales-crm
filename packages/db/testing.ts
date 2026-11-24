/* Helpers for tests that need their own database. Never imported by application code. */
import { randomBytes } from "node:crypto";
import pg from "pg";

export const DEFAULT_TEST_DATABASE_URL = "postgres://crm:crm@localhost:5432/crm";

export function adminDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminDatabaseUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Creates an empty database with a unique name and returns its URL. */
export async function createTestDatabase(prefix: string): Promise<{ name: string; url: string }> {
  const name = `${prefix}_${randomBytes(4).toString("hex")}`;
  await admin((client) => client.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`));
  return { name, url: withDatabase(adminDatabaseUrl(), name) };
}

export async function dropTestDatabase(name: string): Promise<void> {
  await admin((client) => client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`));
}

/** Creates a database as a copy of `template` (which must have no open connections). */
export async function createDatabaseFromTemplate(
  prefix: string,
  template: string,
): Promise<{ name: string; url: string }> {
  const name = `${prefix}_${randomBytes(4).toString("hex")}`;
  await admin((client) =>
    client.query(`CREATE DATABASE ${pg.escapeIdentifier(name)} TEMPLATE ${pg.escapeIdentifier(template)}`),
  );
  return { name, url: withDatabase(adminDatabaseUrl(), name) };
}
