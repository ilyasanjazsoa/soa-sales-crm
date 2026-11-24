import { tables, type Executor } from "@soa/db";
import { and, asc, count, desc, eq, gte, max, sql } from "drizzle-orm";
import type { Scope, SystemScope } from "./scope";
import { seesEverything } from "./scope";
import { accountVisible } from "./visibility";

const { aiCalls, researchSources, researchBriefs, clientReferences, accounts, users, activities } = tables;

export type SourceRow = typeof researchSources.$inferSelect;
export type BriefRow = typeof researchBriefs.$inferSelect;
export type ReferenceRow = typeof clientReferences.$inferSelect;

export function aiCallsRepo(db: Executor) {
  return {
    async insert(_scope: SystemScope, values: typeof aiCalls.$inferInsert): Promise<string> {
      const [row] = await db.insert(aiCalls).values(values).returning({ id: aiCalls.id });
      if (row === undefined) throw new Error("insert returned no row");
      return row.id;
    },
    /** Reserves a call against the user's daily limit, atomically (a per-user lock): undefined when the limit is
        used up. The row is filled in by `complete` once the model answers. */
    async reserve(
      _scope: SystemScope,
      values: typeof aiCalls.$inferInsert & { userId: string },
      limit: number,
      since: Date,
    ): Promise<string | undefined> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${values.userId}))`);
        const [used] = await tx
          .select({ value: count() })
          .from(aiCalls)
          .where(and(eq(aiCalls.userId, values.userId), gte(aiCalls.createdAt, since)));
        if ((used?.value ?? 0) >= limit) return undefined;
        const [row] = await tx.insert(aiCalls).values(values).returning({ id: aiCalls.id });
        return row?.id;
      });
    },

    async complete(_scope: SystemScope, id: string, values: Partial<typeof aiCalls.$inferInsert>): Promise<void> {
      await db.update(aiCalls).set(values).where(eq(aiCalls.id, id));
    },

    async countSince(_scope: SystemScope, userId: string, since: Date): Promise<number> {
      const [row] = await db
        .select({ value: count() })
        .from(aiCalls)
        .where(and(eq(aiCalls.userId, userId), gte(aiCalls.createdAt, since)));
      return row?.value ?? 0;
    },
  };
}

export function researchRepo(db: Executor) {
  return {
    /** Sources of an account the scope can see, oldest first (their numbering in the UI). */
    async sources(scope: Scope, accountId: string) {
      return db
        .select({ source: researchSources, addedByName: users.name })
        .from(researchSources)
        .innerJoin(accounts, eq(accounts.id, researchSources.accountId))
        .leftJoin(users, eq(users.id, researchSources.addedBy))
        .where(and(eq(researchSources.accountId, accountId), accountVisible(scope)))
        .orderBy(asc(researchSources.fetchedAt), asc(researchSources.id));
    },

    async briefVersions(scope: Scope, accountId: string) {
      return db
        .select({ version: researchBriefs.version, createdAt: researchBriefs.createdAt })
        .from(researchBriefs)
        .innerJoin(accounts, eq(accounts.id, researchBriefs.accountId))
        .where(and(eq(researchBriefs.accountId, accountId), accountVisible(scope)))
        .orderBy(desc(researchBriefs.version));
    },

    /** A brief version (the latest when `version` is undefined). */
    async brief(scope: Scope, accountId: string, version?: number) {
      const [row] = await db
        .select({ brief: researchBriefs, createdByName: users.name })
        .from(researchBriefs)
        .innerJoin(accounts, eq(accounts.id, researchBriefs.accountId))
        .innerJoin(users, eq(users.id, researchBriefs.createdBy))
        .where(
          and(
            eq(researchBriefs.accountId, accountId),
            accountVisible(scope),
            ...(version === undefined ? [] : [eq(researchBriefs.version, version)]),
          ),
        )
        .orderBy(desc(researchBriefs.version))
        .limit(1);
      return row;
    },

    /** Saves the next version for the account (the caller holds the account row lock). */
    async insertBrief(_scope: Scope, values: Omit<typeof researchBriefs.$inferInsert, "version">): Promise<BriefRow> {
      const [current] = await db
        .select({ value: max(researchBriefs.version) })
        .from(researchBriefs)
        .where(eq(researchBriefs.accountId, values.accountId));
      const [row] = await db
        .insert(researchBriefs)
        .values({ ...values, version: (current?.value ?? 0) + 1 })
        .returning();
      if (row === undefined) throw new Error("insert returned no row");
      return row;
    },

    /** The latest research job event on an account (requested, failed), from the timeline. */
    async lastJobEvent(scope: Scope, accountId: string, job: string) {
      const [row] = await db
        .select({ occurredAt: activities.occurredAt, meta: activities.meta })
        .from(activities)
        .innerJoin(accounts, eq(accounts.id, activities.accountId))
        .where(
          and(eq(activities.accountId, accountId), accountVisible(scope), sql`${activities.meta}->>'job' = ${job}`),
        )
        .orderBy(desc(activities.occurredAt))
        .limit(1);
      return row;
    },
  };
}

export function referencesRepo(db: Executor) {
  const managerOnly = (scope: Scope) => {
    if (!seesEverything(scope)) throw new Error("scope may not manage client references");
  };
  return {
    async list(scope: Scope): Promise<ReferenceRow[]> {
      managerOnly(scope);
      return db.select().from(clientReferences).orderBy(asc(clientReferences.labelAnonymized));
    },
    /** The active reference that best matches a property type (used in prompts; anyone researching may read it). */
    async bestFor(_scope: Scope, propertyType: string): Promise<ReferenceRow | undefined> {
      const [row] = await db
        .select()
        .from(clientReferences)
        .where(eq(clientReferences.active, true))
        .orderBy(
          sql`(${propertyType} = ANY(${clientReferences.propertyTypes})) DESC`,
          asc(clientReferences.labelAnonymized),
        )
        .limit(1);
      return row;
    },
    /** Every reference, for the named-client check (all of them: an inactive one still must not be named). */
    async allForChecks(_scope: Scope): Promise<ReferenceRow[]> {
      return db.select().from(clientReferences);
    },
    async insert(scope: Scope, values: typeof clientReferences.$inferInsert): Promise<ReferenceRow> {
      managerOnly(scope);
      const [row] = await db.insert(clientReferences).values(values).returning();
      if (row === undefined) throw new Error("insert returned no row");
      return row;
    },
    async update(
      scope: Scope,
      id: string,
      values: Partial<typeof clientReferences.$inferInsert>,
    ): Promise<ReferenceRow | undefined> {
      managerOnly(scope);
      const [row] = await db
        .update(clientReferences)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(clientReferences.id, id))
        .returning();
      return row;
    },
  };
}
