import { tables, type Executor } from "@soa/db";
import { and, asc, desc, eq, inArray, isNull, lt, lte, ne, sql, type SQL } from "drizzle-orm";
import { actorId, seesEverything, type Scope, type SystemScope, type UserScope } from "./scope";
import { accountEditable, accountVisible, allOf, anyOf } from "./visibility";

/* Rows that belong to an account. Each one is visible exactly when its account is (ARCHITECTURE.md §4). */

const {
  accounts,
  contacts,
  signals,
  researchSources,
  activities,
  users,
  tasks,
  suppressions,
  pricingConfigs,
  imports,
} = tables;

export type ContactRow = typeof contacts.$inferSelect;
export type SignalRow = typeof signals.$inferSelect;
export type ActivityRow = typeof activities.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ImportRow = typeof imports.$inferSelect;

export function contactsRepo(db: Executor) {
  return {
    async listForAccount(scope: Scope, accountId: string): Promise<ContactRow[]> {
      const rows = await db
        .select({ contact: contacts })
        .from(contacts)
        .innerJoin(accounts, eq(accounts.id, contacts.accountId))
        .where(and(eq(contacts.accountId, accountId), accountVisible(scope)))
        .orderBy(desc(contacts.isPrimary), asc(contacts.lastName), asc(contacts.firstName));
      return rows.map((row) => row.contact);
    },

    /** A contact on an account the scope may edit. */
    async getEditable(scope: Scope, id: string): Promise<ContactRow | undefined> {
      const [row] = await db
        .select({ contact: contacts })
        .from(contacts)
        .innerJoin(accounts, eq(accounts.id, contacts.accountId))
        .where(and(eq(contacts.id, id), accountEditable(scope)));
      return row?.contact;
    },

    async get(scope: Scope, id: string): Promise<ContactRow | undefined> {
      const [row] = await db
        .select({ contact: contacts })
        .from(contacts)
        .innerJoin(accounts, eq(accounts.id, contacts.accountId))
        .where(and(eq(contacts.id, id), accountVisible(scope)));
      return row?.contact;
    },

    /** Inserts for an account the caller has already checked it may edit. */
    async insert(_scope: Scope, values: typeof contacts.$inferInsert): Promise<ContactRow> {
      const [row] = await db.insert(contacts).values(values).returning();
      if (row === undefined) throw new Error("insert returned no row");
      return row;
    },

    async update(
      scope: Scope,
      id: string,
      values: Partial<typeof contacts.$inferInsert>,
    ): Promise<ContactRow | undefined> {
      const editable = await this.getEditable(scope, id);
      if (editable === undefined) return undefined;
      const [row] = await db
        .update(contacts)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(contacts.id, id))
        .returning();
      return row;
    },

    /** Clears the primary flag on the account's other contacts. */
    async clearPrimary(scope: Scope, accountId: string, exceptId: string): Promise<void> {
      await db
        .update(contacts)
        .set({ isPrimary: false })
        .where(
          and(
            eq(contacts.accountId, accountId),
            ne(contacts.id, exceptId),
            sql`EXISTS (SELECT 1 FROM ${accounts} WHERE ${accounts.id} = ${contacts.accountId} AND ${accountEditable(scope)})`,
          ),
        );
    },

    async delete(scope: Scope, id: string): Promise<ContactRow | undefined> {
      const editable = await this.getEditable(scope, id);
      if (editable === undefined) return undefined;
      await db.delete(contacts).where(eq(contacts.id, id));
      return editable;
    },
  };
}

export function signalsRepo(db: Executor) {
  return {
    async listForAccount(scope: Scope, accountId: string): Promise<SignalRow[]> {
      const rows = await db
        .select({ signal: signals })
        .from(signals)
        .innerJoin(accounts, eq(accounts.id, signals.accountId))
        .where(and(eq(signals.accountId, accountId), accountVisible(scope)))
        .orderBy(desc(signals.createdAt));
      return rows.map((row) => row.signal);
    },

    async getEditable(scope: Scope, id: string): Promise<SignalRow | undefined> {
      const [row] = await db
        .select({ signal: signals })
        .from(signals)
        .innerJoin(accounts, eq(accounts.id, signals.accountId))
        .where(and(eq(signals.id, id), accountEditable(scope)));
      return row?.signal;
    },

    async insert(_scope: Scope, values: typeof signals.$inferInsert): Promise<SignalRow> {
      const [row] = await db.insert(signals).values(values).returning();
      if (row === undefined) throw new Error("insert returned no row");
      return row;
    },

    async update(
      scope: Scope,
      id: string,
      values: Partial<typeof signals.$inferInsert>,
    ): Promise<SignalRow | undefined> {
      if ((await this.getEditable(scope, id)) === undefined) return undefined;
      const [row] = await db.update(signals).set(values).where(eq(signals.id, id)).returning();
      return row;
    },

    async delete(scope: Scope, id: string): Promise<SignalRow | undefined> {
      const editable = await this.getEditable(scope, id);
      if (editable === undefined) return undefined;
      await db.delete(signals).where(eq(signals.id, id));
      return editable;
    },
  };
}

export function sourcesRepo(db: Executor) {
  return {
    /** Stores a piece of untrusted text the AI may later cite. Same content twice on one account is stored once. */
    async insert(_scope: Scope, values: typeof researchSources.$inferInsert): Promise<{ id: string }> {
      const [row] = await db
        .insert(researchSources)
        .values(values)
        .onConflictDoUpdate({
          target: [researchSources.accountId, researchSources.contentHash],
          set: { fetchedAt: sql`now()` },
        })
        .returning({ id: researchSources.id });
      if (row === undefined) throw new Error("insert returned no row");
      return row;
    },
  };
}

export function activitiesRepo(db: Executor) {
  return {
    async insert(scope: Scope, values: Omit<typeof activities.$inferInsert, "userId">): Promise<void> {
      await db.insert(activities).values({ ...values, userId: actorId(scope) });
    },

    /** Newest first; cursor is "<iso time>|<id>" of the last item. */
    async timeline(scope: Scope, accountId: string, before: { at: Date; id: string } | undefined, limit: number) {
      const conditions: SQL[] = [eq(activities.accountId, accountId), accountVisible(scope)];
      if (before !== undefined) {
        conditions.push(
          anyOf(
            lt(activities.occurredAt, before.at),
            allOf(eq(activities.occurredAt, before.at), lt(activities.id, before.id)),
          ),
        );
      }
      return db
        .select({ activity: activities, userName: users.name })
        .from(activities)
        .innerJoin(accounts, eq(accounts.id, activities.accountId))
        .leftJoin(users, eq(users.id, activities.userId))
        .where(and(...conditions))
        .orderBy(desc(activities.occurredAt), desc(activities.id))
        .limit(limit + 1);
    },
  };
}

export function tasksRepo(db: Executor) {
  const own = (scope: UserScope) => eq(tasks.ownerUserId, scope.userId);
  /** A task's account, if any, must still be visible. */
  const accountStillVisible = (scope: Scope) =>
    anyOf(
      isNull(tasks.accountId),
      sql`EXISTS (SELECT 1 FROM ${accounts} WHERE ${accounts.id} = ${tasks.accountId} AND ${accountVisible(scope)})`,
    );

  return {
    async list(scope: UserScope, filter: { open?: boolean | undefined; accountId?: string | undefined }) {
      const conditions: SQL[] = [own(scope), accountStillVisible(scope)];
      if (filter.open === true) conditions.push(isNull(tasks.doneAt));
      if (filter.open === false) conditions.push(sql`${tasks.doneAt} IS NOT NULL`);
      if (filter.accountId !== undefined) conditions.push(eq(tasks.accountId, filter.accountId));
      return db
        .select({ task: tasks, accountName: accounts.name })
        .from(tasks)
        .leftJoin(accounts, eq(accounts.id, tasks.accountId))
        .where(and(...conditions))
        .orderBy(sql`${tasks.dueAt} ASC NULLS LAST`, asc(tasks.createdAt))
        .limit(200);
    },

    async get(scope: UserScope, id: string): Promise<TaskRow | undefined> {
      const [row] = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, id), own(scope), accountStillVisible(scope)));
      return row;
    },

    async insert(_scope: Scope, values: typeof tasks.$inferInsert): Promise<TaskRow> {
      const [row] = await db.insert(tasks).values(values).returning();
      if (row === undefined) throw new Error("insert returned no row");
      return row;
    },

    async update(
      scope: UserScope,
      id: string,
      values: Partial<typeof tasks.$inferInsert>,
    ): Promise<TaskRow | undefined> {
      const [row] = await db
        .update(tasks)
        .set(values)
        .where(and(eq(tasks.id, id), own(scope), accountStillVisible(scope)))
        .returning();
      return row;
    },
  };
}

export function suppressionsRepo(db: Executor) {
  return {
    /** Which of these addresses are on the company-wide suppression list (visible to every user, §4). */
    async reasons(_scope: Scope, emails: string[]): Promise<Map<string, string>> {
      const list = [...new Set(emails.map((email) => email.toLowerCase()))];
      if (list.length === 0) return new Map();
      const rows = await db
        .select({ email: suppressions.email, reason: suppressions.reason })
        .from(suppressions)
        .where(inArray(suppressions.email, list));
      return new Map(rows.map((row) => [row.email.toLowerCase(), row.reason]));
    },
  };
}

export function pricingRepo(db: Executor) {
  return {
    /** The live configuration: the latest one in effect on `today` (YYYY-MM-DD). */
    async live(_scope: Scope, today: string) {
      const [row] = await db
        .select()
        .from(pricingConfigs)
        .where(lte(pricingConfigs.effectiveFrom, today))
        .orderBy(desc(pricingConfigs.effectiveFrom))
        .limit(1);
      return row;
    },
  };
}

export function importsRepo(db: Executor) {
  /** Managers see every import; everyone else their own. */
  const visible = (scope: Scope) =>
    seesEverything(scope) || scope.kind === "system" ? sql`true` : eq(imports.userId, scope.userId);
  return {
    async insert(_scope: UserScope, values: typeof imports.$inferInsert): Promise<ImportRow> {
      const [row] = await db.insert(imports).values(values).returning();
      if (row === undefined) throw new Error("insert returned no row");
      return row;
    },
    async get(scope: Scope, id: string): Promise<ImportRow | undefined> {
      const [row] = await db
        .select()
        .from(imports)
        .where(and(eq(imports.id, id), visible(scope)));
      return row;
    },
    async update(
      scope: Scope | SystemScope,
      id: string,
      values: Partial<typeof imports.$inferInsert>,
    ): Promise<ImportRow | undefined> {
      const [row] = await db
        .update(imports)
        .set(values)
        .where(and(eq(imports.id, id), visible(scope)))
        .returning();
      return row;
    },
  };
}
