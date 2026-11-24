import { tables, type Executor } from "@soa/db";
import type { DealStage, DealStatus } from "@soa/shared";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { actorId, type Scope } from "./scope";
import { accountEditable, accountVisible, dealEditable } from "./visibility";

const { deals, accounts, users, dealStageHistory } = tables;

export type DealRow = typeof deals.$inferSelect;

export interface DealFilter {
  stage?: DealStage | undefined;
  status?: DealStatus | undefined;
  owner?: string | undefined; // "me" | "all" | user id
  offset: number;
  limit: number;
}

const dealSelect = { deal: deals, accountName: accounts.name, ownerName: users.name };

/** The deal's account is one the scope may edit (used in UPDATE ... WHERE, which can't join). */
const accountScoped = (scope: Scope) =>
  sql`EXISTS (SELECT 1 FROM ${accounts} WHERE ${accounts.id} = ${deals.accountId} AND ${accountEditable(scope)})`;

export function dealsRepo(db: Executor) {
  const base = () =>
    db
      .select(dealSelect)
      .from(deals)
      .innerJoin(accounts, eq(accounts.id, deals.accountId))
      .innerJoin(users, eq(users.id, deals.ownerUserId));

  return {
    async list(scope: Scope, filter: DealFilter) {
      const conditions: SQL[] = [accountVisible(scope)];
      if (filter.stage !== undefined) conditions.push(eq(deals.stage, filter.stage));
      if (filter.status !== undefined) conditions.push(eq(deals.status, filter.status));
      if (filter.owner === "me" && scope.kind === "user") conditions.push(eq(deals.ownerUserId, scope.userId));
      else if (filter.owner !== undefined && filter.owner !== "all" && filter.owner !== "me") {
        conditions.push(eq(deals.ownerUserId, filter.owner));
      }
      return base()
        .where(and(...conditions))
        .orderBy(desc(deals.annualValueCents), asc(deals.id))
        .offset(filter.offset)
        .limit(filter.limit + 1);
    },

    /** Every visible deal matching the filter, for forecast totals (≤ thousands of rows at this scale). */
    async forForecast(scope: Scope, owner: string | undefined) {
      const conditions: SQL[] = [accountVisible(scope)];
      if (owner === "me" && scope.kind === "user") conditions.push(eq(deals.ownerUserId, scope.userId));
      else if (owner !== undefined && owner !== "all" && owner !== "me") conditions.push(eq(deals.ownerUserId, owner));
      return db
        .select({ stage: deals.stage, status: deals.status, annualValueCents: deals.annualValueCents })
        .from(deals)
        .innerJoin(accounts, eq(accounts.id, deals.accountId))
        .where(and(...conditions));
    },

    async get(scope: Scope, id: string) {
      const [row] = await base().where(and(eq(deals.id, id), accountVisible(scope)));
      return row;
    },

    /** The account's open deal, or its most recent one. */
    async currentForAccount(scope: Scope, accountId: string) {
      const [row] = await base()
        .where(and(eq(deals.accountId, accountId), accountVisible(scope)))
        .orderBy(sql`(${deals.status} = 'open') DESC`, desc(deals.updatedAt))
        .limit(1);
      return row;
    },

    async getEditable(scope: Scope, id: string): Promise<DealRow | undefined> {
      const [row] = await db
        .select({ deal: deals })
        .from(deals)
        .innerJoin(accounts, eq(accounts.id, deals.accountId))
        .where(and(eq(deals.id, id), dealEditable(scope)))
        .for("update", { of: deals });
      return row?.deal;
    },

    /** Inserts; undefined if the account already has an open deal (deals_one_open_per_account). */
    async insert(_scope: Scope, values: typeof deals.$inferInsert): Promise<DealRow | undefined> {
      const [row] = await db
        .insert(deals)
        .values(values)
        .onConflictDoNothing({ target: deals.accountId, where: sql`status = 'open'` })
        .returning();
      return row;
    },

    async update(scope: Scope, id: string, values: Partial<typeof deals.$inferInsert>): Promise<DealRow | undefined> {
      if ((await this.getEditable(scope, id)) === undefined) return undefined;
      const [row] = await db
        .update(deals)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(deals.id, id))
        .returning();
      return row;
    },

    /** Moves the account's open deals to a new owner (on claim or reassignment). */
    async reassignOpen(scope: Scope, accountId: string, ownerUserId: string): Promise<DealRow[]> {
      return db
        .update(deals)
        .set({ ownerUserId, updatedAt: sql`now()` })
        .where(and(eq(deals.accountId, accountId), eq(deals.status, "open"), accountScoped(scope)))
        .returning();
    },

    async recordStage(scope: Scope, dealId: string, from: DealStage | null, to: DealStage): Promise<void> {
      await db.insert(dealStageHistory).values({ dealId, fromStage: from, toStage: to, changedBy: actorId(scope) });
    },

    async touch(scope: Scope, accountId: string): Promise<void> {
      await db
        .update(deals)
        .set({ lastActivityAt: sql`now()` })
        .where(and(eq(deals.accountId, accountId), eq(deals.status, "open"), accountScoped(scope)));
    },

    async listForExport(scope: Scope) {
      return base().where(accountVisible(scope)).orderBy(asc(accounts.name));
    },
  };
}
