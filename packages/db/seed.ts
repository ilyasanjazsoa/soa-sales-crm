import { sql } from "drizzle-orm";
import { tables, type Database } from "./index";
import { buildSeed } from "./seed-data";

export type SeedSummary = ReturnType<typeof buildSeed>;

/** Inserts the fictional seed data in one transaction. Without `reset` it refuses a database that has users. */
export async function seedDatabase(db: Database, options: { domain: string; reset?: boolean }): Promise<SeedSummary> {
  if (!options.domain.endsWith(".example")) throw new Error("Seed data uses .example email domains only.");
  const data = buildSeed(options.domain);
  await db.transaction(async (tx) => {
    if (options.reset === true) {
      const rows = await tx.execute<{ tablename: string }>(
        sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      );
      const list = rows.rows.map((row) => `"${row.tablename}"`).join(", ");
      await tx.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
    } else {
      const existing = await tx.select({ id: tables.users.id }).from(tables.users).limit(1);
      if (existing.length > 0) {
        throw new Error(
          "The database already has users. Run `pnpm db:seed --reset` to replace everything (local only).",
        );
      }
    }
    await tx.insert(tables.users).values(data.users);
    await tx.insert(tables.pricingConfigs).values(data.pricingConfig);
    await tx.insert(tables.clientReferences).values(data.clientReferences);
    await tx.insert(tables.accounts).values(data.accounts);
    await tx.insert(tables.contacts).values(data.contacts);
    await tx.insert(tables.signals).values(data.signals);
    await tx.insert(tables.deals).values(data.deals);
    await tx.insert(tables.dealStageHistory).values(data.stageHistory);
    await tx.insert(tables.activities).values(data.activities);
  });
  return data;
}
