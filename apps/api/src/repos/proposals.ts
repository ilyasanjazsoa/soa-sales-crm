import { tables, type Executor } from "@soa/db";
import { and, count, desc, eq, lte, max, sql } from "drizzle-orm";
import { accountVisible, dealEditable } from "./visibility";
import type { Scope, SystemScope, UserScope } from "./scope";

const { pricingConfigs, proposals, proposalViews, contracts, deals, accounts, users } = tables;

export type PricingConfigRow = typeof pricingConfigs.$inferSelect;
export type ProposalRow = typeof proposals.$inferSelect;
export type ContractRow = typeof contracts.$inferSelect;

export function pricingConfigsRepo(db: Executor) {
  return {
    async list(_scope: Scope) {
      return db
        .select({ config: pricingConfigs, createdByName: users.name })
        .from(pricingConfigs)
        .leftJoin(users, eq(users.id, pricingConfigs.createdBy))
        .orderBy(desc(pricingConfigs.effectiveFrom))
        .limit(100);
    },
    async get(_scope: Scope, id: string): Promise<PricingConfigRow | undefined> {
      const [row] = await db.select().from(pricingConfigs).where(eq(pricingConfigs.id, id));
      return row;
    },
    /** The latest version in effect on `today` (YYYY-MM-DD). */
    async live(_scope: Scope, today: string): Promise<PricingConfigRow | undefined> {
      const [row] = await db
        .select()
        .from(pricingConfigs)
        .where(lte(pricingConfigs.effectiveFrom, today))
        .orderBy(desc(pricingConfigs.effectiveFrom))
        .limit(1);
      return row;
    },
    /** Managers only (checked by the route and here). Undefined when a version already starts that day. */
    async insert(scope: UserScope, values: typeof pricingConfigs.$inferInsert): Promise<PricingConfigRow | undefined> {
      if (scope.role === "ae") throw new Error("only managers change pricing");
      const [row] = await db.insert(pricingConfigs).values(values).onConflictDoNothing().returning();
      return row;
    },
  };
}

/* Proposals belong to a deal: visible with its account, changed only on a deal the scope may edit. */
export function proposalsRepo(db: Executor) {
  const base = () =>
    db
      .select({ proposal: proposals, accountId: deals.accountId, accountName: accounts.name, dealOwner: deals.ownerUserId })
      .from(proposals)
      .innerJoin(deals, eq(deals.id, proposals.dealId))
      .innerJoin(accounts, eq(accounts.id, deals.accountId));

  return {
    async get(scope: Scope, id: string) {
      const [row] = await base().where(and(eq(proposals.id, id), accountVisible(scope)));
      return row;
    },
    async lockEditable(scope: Scope, id: string) {
      const [row] = await base()
        .where(and(eq(proposals.id, id), dealEditable(scope)))
        .for("update", { of: proposals });
      return row;
    },
    async listForDeal(scope: Scope, dealId: string) {
      return base()
        .where(and(eq(proposals.dealId, dealId), accountVisible(scope)))
        .orderBy(desc(proposals.version));
    },
    /** The next version for the deal (UNIQUE deal_id, version; the caller holds the deal's row lock). */
    async insertNext(_scope: UserScope, values: Omit<typeof proposals.$inferInsert, "version">): Promise<ProposalRow> {
      const [latest] = await db
        .select({ value: max(proposals.version) })
        .from(proposals)
        .where(eq(proposals.dealId, values.dealId));
      const [row] = await db
        .insert(proposals)
        .values({ ...values, version: (latest?.value ?? 0) + 1 })
        .returning();
      if (row === undefined) throw new Error("insert returned no row");
      return row;
    },
    async update(_scope: Scope, id: string, values: Partial<typeof proposals.$inferInsert>): Promise<ProposalRow | undefined> {
      const [row] = await db.update(proposals).set(values).where(eq(proposals.id, id)).returning();
      return row;
    },
    /** The public share link: a sent proposal by its token hash. */
    async byTokenHash(_scope: SystemScope, hash: string) {
      const [row] = await base().where(eq(proposals.publicTokenHash, hash));
      return row;
    },
    async views(_scope: Scope, ids: string[]) {
      if (ids.length === 0) return new Map<string, { count: number; last: Date | null }>();
      const rows = await db
        .select({ id: proposalViews.proposalId, count: count(), last: max(proposalViews.viewedAt) })
        .from(proposalViews)
        .where(sql`${proposalViews.proposalId} IN ${ids}`)
        .groupBy(proposalViews.proposalId);
      return new Map(rows.map((row) => [row.id, { count: row.count, last: row.last }]));
    },
    async recordView(
      _scope: SystemScope,
      values: typeof proposalViews.$inferInsert,
    ): Promise<{ firstToday: boolean }> {
      const [today] = await db
        .select({ value: count() })
        .from(proposalViews)
        .where(
          and(
            eq(proposalViews.proposalId, values.proposalId),
            sql`${proposalViews.viewedAt} >= date_trunc('day', now())`,
          ),
        );
      await db.insert(proposalViews).values(values);
      return { firstToday: (today?.value ?? 0) === 0 };
    },
  };
}

export function contractsRepo(db: Executor) {
  const base = () =>
    db
      .select({ contract: contracts, accountId: deals.accountId, accountName: accounts.name })
      .from(contracts)
      .innerJoin(deals, eq(deals.id, contracts.dealId))
      .innerJoin(accounts, eq(accounts.id, deals.accountId));
  return {
    async get(scope: Scope, id: string) {
      const [row] = await base().where(and(eq(contracts.id, id), accountVisible(scope)));
      return row;
    },
    async lockEditable(scope: Scope, id: string) {
      const [row] = await base()
        .where(and(eq(contracts.id, id), dealEditable(scope)))
        .for("update", { of: contracts });
      return row;
    },
    async listForDeal(scope: Scope, dealId: string) {
      return base()
        .where(and(eq(contracts.dealId, dealId), accountVisible(scope)))
        .orderBy(desc(contracts.createdAt));
    },
    async insert(_scope: UserScope, values: typeof contracts.$inferInsert): Promise<ContractRow> {
      const [row] = await db.insert(contracts).values(values).returning();
      if (row === undefined) throw new Error("insert returned no row");
      return row;
    },
    async update(_scope: Scope, id: string, values: Partial<typeof contracts.$inferInsert>): Promise<ContractRow | undefined> {
      const [row] = await db.update(contracts).set(values).where(eq(contracts.id, id)).returning();
      return row;
    },
    /** For the webhook: the contract an envelope belongs to, locked. */
    async lockByEnvelope(_scope: SystemScope, envelopeId: string) {
      const [row] = await base().where(eq(contracts.providerEnvelopeId, envelopeId)).for("update", { of: contracts });
      return row;
    },
  };
}

/** The deal a proposal is created on, locked, if the scope may change it. */
export async function lockEditableDeal(db: Executor, scope: Scope, dealId: string) {
  const [row] = await db
    .select({ deal: deals, account: accounts })
    .from(deals)
    .innerJoin(accounts, eq(accounts.id, deals.accountId))
    .where(and(eq(deals.id, dealId), dealEditable(scope)))
    .for("update", { of: deals });
  return row;
}
