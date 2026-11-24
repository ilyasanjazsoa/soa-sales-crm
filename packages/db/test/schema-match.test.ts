import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../index";
import { createTestDatabase, dropTestDatabase } from "../testing";

/* Milestone 1 acceptance: load docs/DATA_MODEL.sql into one database, run the migrations into another,
   and assert that the two schemas are identical. */

const SPEC_SQL = readFileSync(new URL("../../../docs/DATA_MODEL.sql", import.meta.url), "utf8");

const CATALOG_QUERIES = {
  extensions: `SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY 1`,
  enums: `
    SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typnamespace = 'public'::regnamespace
    GROUP BY t.typname ORDER BY 1`,
  columns: `
    SELECT c.relname AS table, a.attnum AS position, a.attname AS column,
           format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS default
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY 1, 2`,
  constraints: `
    SELECT conrelid::regclass::text AS table, conname, contype, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace AND contype IN ('p', 'u', 'f', 'c', 'x')
    ORDER BY 1, 2`,
  indexes: `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`,
  sequences: `SELECT sequencename, data_type FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`,
} as const;

type Snapshot = Record<keyof typeof CATALOG_QUERIES, unknown[]>;

async function snapshot(url: string): Promise<Snapshot> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result: Record<string, unknown[]> = {};
    for (const [key, query] of Object.entries(CATALOG_QUERIES)) result[key] = (await client.query(query)).rows;
    return result as Snapshot;
  } finally {
    await client.end();
  }
}

describe("Drizzle migrations match docs/DATA_MODEL.sql", () => {
  const databases: string[] = [];
  let fromSpec: Snapshot;
  let fromMigrations: Snapshot;

  beforeAll(async () => {
    const spec = await createTestDatabase("crm_schema_spec");
    const migrated = await createTestDatabase("crm_schema_mig");
    databases.push(spec.name, migrated.name);

    const client = new pg.Client({ connectionString: spec.url });
    await client.connect();
    await client.query(SPEC_SQL);
    await client.end();

    await runMigrations(migrated.url);
    [fromSpec, fromMigrations] = await Promise.all([snapshot(spec.url), snapshot(migrated.url)]);
  });

  afterAll(async () => {
    await Promise.all(databases.map((name) => dropTestDatabase(name)));
  });

  it("creates all 24 tables", () => {
    const tables = new Set(fromMigrations.columns.map((row) => (row as { table: string }).table));
    expect(tables.size).toBe(24);
  });

  it.each(Object.keys(CATALOG_QUERIES) as (keyof typeof CATALOG_QUERIES)[])("has identical %s", (key) => {
    expect(fromMigrations[key]).toEqual(fromSpec[key]);
  });
});
