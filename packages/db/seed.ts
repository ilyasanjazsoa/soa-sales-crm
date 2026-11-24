import { sql } from "drizzle-orm";
import { fitScore, pricingConfigFromRow } from "@soa/shared";
import { eq } from "drizzle-orm";
import { tables, type Database } from "./index";
import { buildSeed } from "./seed-data";

export type SeedSummary = ReturnType<typeof buildSeed>;

/** Inserts the fictional seed data in one transaction. Without `reset` it refuses a database that has users. */
export async function seedDatabase(
  db: Database,
  options: { domain: string; reset?: boolean; now?: Date },
): Promise<SeedSummary> {
  const now = options.now ?? new Date();
  if (!options.domain.endsWith(".example")) throw new Error("Seed data uses .example email domains only.");
  const data = buildSeed(options.domain, now);
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

    // Fit scores with the same rules the app uses (packages/shared/fit.ts).
    const pricing = pricingConfigFromRow({
      ...data.pricingConfig,
      id: data.pricingConfig.id,
      supervisorMultiplier: data.pricingConfig.supervisorMultiplier,
      maxManualDiscount: data.pricingConfig.maxManualDiscount,
    });
    for (const account of data.accounts) {
      const result = fitScore(
        {
          propertyType: account.propertyType,
          currentProvider: account.currentProvider ?? null,
          contractEndDate: account.contractEndDate ?? null,
          signals: data.signals
            .filter((signal) => signal.accountId === account.id)
            .map((signal) => ({
              kind: signal.kind ?? "other",
              confirmed: signal.confirmed ?? false,
              observedOn: signal.observedOn ?? null,
              createdAt: now,
            })),
          contacts: data.contacts
            .filter((contact) => contact.accountId === account.id)
            .map((contact) => ({ isPrimary: contact.isPrimary ?? false, email: contact.email ?? null })),
        },
        pricing,
        now,
      );
      await tx
        .update(tables.accounts)
        .set({ fitScore: result.score, fitReasons: result.reasons })
        .where(eq(tables.accounts.id, account.id ?? ""));
    }
  });
  return data;
}
