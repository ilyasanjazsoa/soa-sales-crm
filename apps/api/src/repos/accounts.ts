import { tables, type Executor } from "@soa/db";
import { dedupeKey } from "@soa/shared";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { Scope, SystemScope } from "./scope";
import { accountEditable, accountVisible, anyOf } from "./visibility";

const { accounts, users, deals, contacts, signals, researchSources, tasks, researchBriefs } = tables;

export type AccountRow = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export interface AccountSearch {
  q?: string | undefined;
  city?: string | undefined;
  type?: string | undefined;
  minFit?: number | undefined;
  owner?: string | undefined; // "me" | "unassigned" | "all" | user id
  offset: number;
  limit: number;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

export function accountsRepo(db: Executor) {
  return {
    /** Prospect finder. Name search tolerates typos through trigram word similarity (pg_trgm). */
    async search(scope: Scope, query: AccountSearch) {
      const conditions: SQL[] = [accountVisible(scope)];
      const q = query.q?.trim();
      let rank: SQL | undefined;
      if (q !== undefined && q !== "") {
        const pattern = `%${escapeLike(q)}%`;
        conditions.push(
          anyOf(
            ilike(accounts.name, pattern),
            sql`${q} <% ${accounts.name}`,
            ilike(accounts.ownerCompany, pattern),
            ilike(accounts.city, pattern),
          ),
        );
        rank = sql`word_similarity(${q}, ${accounts.name})`;
      }
      if (query.city !== undefined && query.city !== "") conditions.push(ilike(accounts.city, escapeLike(query.city)));
      if (query.type !== undefined && query.type !== "") conditions.push(eq(accounts.propertyType, query.type));
      if (query.minFit !== undefined && query.minFit > 0) conditions.push(gte(accounts.fitScore, query.minFit));
      if (query.owner === "unassigned") conditions.push(isNull(accounts.ownerUserId));
      else if (query.owner === "me" && scope.kind === "user") conditions.push(eq(accounts.ownerUserId, scope.userId));
      else if (query.owner !== undefined && query.owner !== "all" && query.owner !== "me") {
        conditions.push(eq(accounts.ownerUserId, query.owner));
      }

      // The deals_one_open_per_account index guarantees at most one open deal per account.
      const run = async (executor: Executor) =>
        executor
          .select({
            account: accounts,
            ownerName: users.name,
            dealId: deals.id,
            dealStage: deals.stage,
            dealStatus: deals.status,
          })
          .from(accounts)
          .leftJoin(users, eq(users.id, accounts.ownerUserId))
          .leftJoin(deals, and(eq(deals.accountId, accounts.id), eq(deals.status, "open")))
          .where(and(...conditions))
          .orderBy(
            ...(rank === undefined ? [] : [desc(rank)]),
            sql`${accounts.fitScore} DESC NULLS LAST`,
            asc(accounts.name),
            asc(accounts.id),
          )
          .offset(query.offset)
          .limit(query.limit + 1);

      if (rank === undefined) return run(db);
      // Use the trigram index for `<%` with a threshold that accepts a one-letter typo.
      return db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL pg_trgm.word_similarity_threshold = 0.4`);
        return run(tx);
      });
    },

    /** How many live accounts are owned by someone else (for "N are hidden from you"). */
    async countHidden(scope: Scope): Promise<number | null> {
      if (scope.kind === "system" || scope.role !== "ae") return null;
      const [row] = await db
        .select({ value: count() })
        .from(accounts)
        .where(
          and(isNull(accounts.deletedAt), isNotNull(accounts.ownerUserId), ne(accounts.ownerUserId, scope.userId)),
        );
      return row?.value ?? 0;
    },

    async get(scope: Scope, id: string) {
      const [row] = await db
        .select({ account: accounts, ownerName: users.name })
        .from(accounts)
        .leftJoin(users, eq(users.id, accounts.ownerUserId))
        .where(and(eq(accounts.id, id), accountVisible(scope)));
      return row;
    },

    async getEditable(scope: Scope, id: string): Promise<AccountRow | undefined> {
      const [row] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, id), accountEditable(scope)))
        .for("update");
      return row;
    },

    async counts(scope: Scope, id: string) {
      const visible = and(eq(accounts.id, id), accountVisible(scope));
      const [row] = await db
        .select({
          signals: sql<number>`(SELECT count(*)::int FROM ${signals} WHERE ${signals.accountId} = ${accounts.id})`,
          sources: sql<number>`(SELECT count(*)::int FROM ${researchSources} WHERE ${researchSources.accountId} = ${accounts.id})`,
          openTasks: sql<number>`(SELECT count(*)::int FROM ${tasks} WHERE ${tasks.accountId} = ${accounts.id} AND ${tasks.doneAt} IS NULL)`,
          latestBriefId: sql<
            string | null
          >`(SELECT ${researchBriefs.id} FROM ${researchBriefs} WHERE ${researchBriefs.accountId} = ${accounts.id} ORDER BY ${researchBriefs.version} DESC LIMIT 1)`,
        })
        .from(accounts)
        .where(visible);
      return row;
    },

    async existsLive(_scope: SystemScope, id: string): Promise<boolean> {
      const rows = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.id, id), isNull(accounts.deletedAt)));
      return rows.length > 0;
    },

    /** Duplicate check across every live account, including ones the caller can't see (§ "409 with the existing id"). */
    async findDuplicate(_scope: SystemScope, name: string, city: string | null): Promise<{ id: string } | undefined> {
      const [row] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            isNull(accounts.deletedAt),
            sql`lower(${accounts.name}) = lower(${name})`,
            sql`lower(coalesce(${accounts.city}, '')) = lower(coalesce(${city}::text, ''))`,
          ),
        );
      return row;
    },

    /** Dedupe keys (see dedupeKey) of live accounts whose lower-case name is in `names`, across all owners. */
    async existingKeys(_scope: SystemScope, names: string[]): Promise<Set<string>> {
      const keys = new Set<string>();
      for (let start = 0; start < names.length; start += 1000) {
        const chunk = names.slice(start, start + 1000);
        const rows = await db
          .select({ name: accounts.name, city: accounts.city })
          .from(accounts)
          .where(and(isNull(accounts.deletedAt), inArray(sql`lower(${accounts.name})`, chunk)));
        for (const row of rows) keys.add(dedupeKey(row.name, row.city));
      }
      return keys;
    },

    /** Inserts; returns undefined when the dedupe index rejects it (same name and city). */
    async insert(_scope: Scope, values: NewAccount): Promise<AccountRow | undefined> {
      const [row] = await db
        .insert(accounts)
        .values(values)
        // No target: the only unique index besides the generated id is accounts_dedupe (Drizzle can't name an
        // expression index as a conflict target).
        .onConflictDoNothing()
        .returning();
      return row;
    },

    async update(scope: Scope, id: string, values: Partial<NewAccount>): Promise<AccountRow | undefined> {
      const [row] = await db
        .update(accounts)
        .set({ ...values, updatedAt: sql`now()` })
        .where(and(eq(accounts.id, id), accountEditable(scope)))
        .returning();
      return row;
    },

    /** Claims an unassigned account atomically; undefined if it is owned (or not visible). */
    async claim(scope: Scope & { kind: "user" }, id: string): Promise<AccountRow | undefined> {
      const [row] = await db
        .update(accounts)
        .set({ ownerUserId: scope.userId, updatedAt: sql`now()` })
        .where(and(eq(accounts.id, id), isNull(accounts.ownerUserId), accountVisible(scope)))
        .returning();
      return row;
    },

    async setOwner(scope: Scope, id: string, ownerUserId: string | null): Promise<AccountRow | undefined> {
      const [row] = await db
        .update(accounts)
        .set({ ownerUserId, updatedAt: sql`now()` })
        .where(and(eq(accounts.id, id), accountEditable(scope)))
        .returning();
      return row;
    },

    async softDelete(scope: Scope, id: string): Promise<AccountRow | undefined> {
      const [row] = await db
        .update(accounts)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(accounts.id, id), accountEditable(scope)))
        .returning();
      return row;
    },

    /** Hard delete with cascade. Managers only (checked by the caller); still scoped. */
    async purge(scope: Scope, id: string): Promise<boolean> {
      if (scope.kind === "user" && scope.role === "ae") return false;
      const rows = await db.delete(accounts).where(eq(accounts.id, id)).returning({ id: accounts.id });
      return rows.length > 0;
    },

    async setFit(_scope: Scope, id: string, score: number, reasons: string[]): Promise<void> {
      await db.update(accounts).set({ fitScore: score, fitReasons: reasons }).where(eq(accounts.id, id));
    },

    /** Inputs for the fit score. */
    async fitInputs(scope: Scope, id: string) {
      const account = await this.get(scope, id);
      if (account === undefined) return undefined;
      const [signalRows, contactRows] = await Promise.all([
        db
          .select({
            kind: signals.kind,
            confirmed: signals.confirmed,
            observedOn: signals.observedOn,
            createdAt: signals.createdAt,
          })
          .from(signals)
          .where(eq(signals.accountId, id)),
        db
          .select({ isPrimary: contacts.isPrimary, email: contacts.email })
          .from(contacts)
          .where(eq(contacts.accountId, id)),
      ]);
      return { account: account.account, signals: signalRows, contacts: contactRows };
    },

    /** For CSV export: every visible account with its owner name. */
    async listForExport(scope: Scope) {
      return db
        .select({ account: accounts, ownerName: users.name })
        .from(accounts)
        .leftJoin(users, eq(users.id, accounts.ownerUserId))
        .where(accountVisible(scope))
        .orderBy(asc(accounts.name));
    },
  };
}
