import { tables, type Executor } from "@soa/db";
import type { DealStage } from "@soa/shared";
import { and, asc, desc, eq, gte, ilike, lt, sql, type SQL } from "drizzle-orm";
import { accountVisible } from "./visibility";
import { seesEverything, type UserScope } from "./scope";

/* Read-only, scoped queries behind Today (§11.1) and Ask Sales AI (§11.2). An AE sees only their own deals and
   messages (and accounts they may see); managers see everything. Nothing here changes data. */

const { deals, accounts, contacts, emailMessages, activities, proposals, proposalViews, contracts, signals, users } =
  tables;

/** Deals the caller may ask about: an AE's own deals, a manager's any (on visible accounts). */
const askableDeals = (scope: UserScope): SQL => {
  const visible = accountVisible(scope);
  return seesEverything(scope) ? visible : (and(visible, eq(deals.ownerUserId, scope.userId)) ?? visible);
};

const dealColumns = {
  id: deals.id,
  accountId: deals.accountId,
  accountName: accounts.name,
  stage: deals.stage,
  status: deals.status,
  annualValueCents: deals.annualValueCents,
  lastActivityAt: deals.lastActivityAt,
  stageChangedAt: deals.stageChangedAt,
  ownerName: users.name,
};

export function insightsRepo(db: Executor) {
  const dealQuery = () =>
    db
      .select(dealColumns)
      .from(deals)
      .innerJoin(accounts, eq(accounts.id, deals.accountId))
      .innerJoin(users, eq(users.id, deals.ownerUserId));

  return {
    /** Facts for the rep's next best actions: their open deals with what the rules need. */
    async nbaDeals(scope: UserScope) {
      const me = scope.userId;
      return db
        .select({
          ...dealColumns,
          contactName: sql<
            string | null
          >`(SELECT trim(c.first_name || ' ' || c.last_name) FROM ${contacts} c WHERE c.account_id = ${deals.accountId} ORDER BY c.is_primary DESC, c.created_at LIMIT 1)`,
          // Since this deal was created, by anyone on the account (a reply answered by a colleague is answered).
          outboundCount: sql<number>`(SELECT count(*)::int FROM ${emailMessages} e WHERE e.account_id = ${deals.accountId} AND e.direction = 'out' AND e.status IN ('queued', 'sent') AND e.created_at >= ${deals.createdAt})`,
          lastOutboundAt: sql<Date | null>`(SELECT max(coalesce(e.sent_at, e.created_at)) FROM ${emailMessages} e WHERE e.account_id = ${deals.accountId} AND e.direction = 'out' AND e.status IN ('queued', 'sent') AND e.created_at >= ${deals.createdAt})`,
          loggedTouches: sql<number>`(SELECT count(*)::int FROM ${activities} a WHERE a.account_id = ${deals.accountId} AND a.type IN ('call', 'voicemail', 'linkedin') AND a.occurred_at >= ${deals.createdAt})`,
          lastLoggedTouchAt: sql<Date | null>`(SELECT max(a.occurred_at) FROM ${activities} a WHERE a.account_id = ${deals.accountId} AND a.type IN ('call', 'voicemail', 'linkedin') AND a.occurred_at >= ${deals.createdAt})`,
          lastInboundAt: sql<Date | null>`(SELECT max(e.received_at) FROM ${emailMessages} e WHERE e.account_id = ${deals.accountId} AND e.direction = 'in' AND e.status = 'received' AND e.received_at >= ${deals.createdAt})`,
          lastInterestedAt: sql<Date | null>`(SELECT max(e.received_at) FROM ${emailMessages} e WHERE e.account_id = ${deals.accountId} AND e.direction = 'in' AND e.ai_classification = 'interested' AND e.received_at >= ${deals.createdAt})`,
          interestedContact: sql<
            string | null
          >`(SELECT coalesce(trim(c.first_name || ' ' || c.last_name), e.from_email) FROM ${emailMessages} e LEFT JOIN ${contacts} c ON c.id = e.contact_id WHERE e.account_id = ${deals.accountId} AND e.direction = 'in' AND e.ai_classification = 'interested' ORDER BY e.received_at DESC LIMIT 1)`,
          proposalSentAt: sql<Date | null>`(SELECT p.sent_at FROM ${proposals} p WHERE p.deal_id = ${deals.id} AND p.sent_at IS NOT NULL ORDER BY p.version DESC LIMIT 1)`,
          proposalViews: sql<number>`(SELECT count(*)::int FROM ${proposalViews} v WHERE v.proposal_id = (SELECT p.id FROM ${proposals} p WHERE p.deal_id = ${deals.id} AND p.sent_at IS NOT NULL ORDER BY p.version DESC LIMIT 1))`,
          contractSentAt: sql<Date | null>`(SELECT k.sent_at FROM ${contracts} k WHERE k.deal_id = ${deals.id} AND k.status IN ('sent', 'viewed') ORDER BY k.created_at DESC LIMIT 1)`,
          contractViews: sql<
            number | null
          >`(SELECT k.view_count FROM ${contracts} k WHERE k.deal_id = ${deals.id} AND k.status IN ('sent', 'viewed') ORDER BY k.created_at DESC LIMIT 1)`,
          contractSigner: sql<
            string | null
          >`(SELECT trim(c.first_name || ' ' || c.last_name) FROM ${contracts} k JOIN ${contacts} c ON c.id = k.signer_contact_id WHERE k.deal_id = ${deals.id} AND k.status IN ('sent', 'viewed') ORDER BY k.created_at DESC LIMIT 1)`,
          // Only signals a rep confirmed: an AI-found one is "unconfirmed" until then (§7.2 rule 3).
          topSignal: sql<
            string | null
          >`(SELECT s.text FROM ${signals} s WHERE s.account_id = ${deals.accountId} AND s.confirmed ORDER BY (s.kind = 'incident') DESC, s.created_at DESC LIMIT 1)`,
        })
        .from(deals)
        .innerJoin(accounts, eq(accounts.id, deals.accountId))
        .innerJoin(users, eq(users.id, deals.ownerUserId))
        .where(and(eq(deals.ownerUserId, me), eq(deals.status, "open"), accountVisible(scope)))
        .limit(500);
    },

    /** The rep's own open deals (for the pipeline and weighted forecast). */
    async ownOpenDeals(scope: UserScope) {
      return db
        .select({ stage: deals.stage, status: deals.status, annualValueCents: deals.annualValueCents })
        .from(deals)
        .innerJoin(accounts, eq(accounts.id, deals.accountId))
        .where(and(eq(deals.ownerUserId, scope.userId), eq(deals.status, "open"), accountVisible(scope)));
    },

    /** The value of the rep's deals won in the window. */
    async wonBetween(scope: UserScope, from: Date, to: Date): Promise<number> {
      const [row] = await db
        .select({ total: sql<string>`coalesce(sum(${deals.annualValueCents}), 0)` })
        .from(deals)
        .innerJoin(accounts, eq(accounts.id, deals.accountId))
        .where(
          and(
            eq(deals.ownerUserId, scope.userId),
            eq(deals.status, "won"),
            gte(deals.stageChangedAt, from),
            lt(deals.stageChangedAt, to),
            accountVisible(scope),
          ),
        );
      return Number(row?.total ?? 0);
    },

    // ───────── Ask's fixed functions ─────────
    async openDeals(scope: UserScope, onlyMine: boolean) {
      const mine = onlyMine ? eq(deals.ownerUserId, scope.userId) : undefined;
      return dealQuery()
        .where(and(askableDeals(scope), eq(deals.status, "open"), mine))
        .orderBy(desc(deals.annualValueCents))
        .limit(25);
    },
    async dealsByStage(scope: UserScope, stage: DealStage) {
      return dealQuery()
        .where(and(askableDeals(scope), eq(deals.stage, stage), stage === "won" ? undefined : eq(deals.status, "open")))
        .orderBy(desc(deals.annualValueCents))
        .limit(25);
    },
    async stalledDeals(scope: UserScope, before: Date) {
      return dealQuery()
        .where(and(askableDeals(scope), eq(deals.status, "open"), lt(deals.lastActivityAt, before)))
        .orderBy(asc(deals.lastActivityAt))
        .limit(25);
    },
    async accountsByName(scope: UserScope, text: string) {
      const pattern = `%${text.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
      return db
        .select({
          id: accounts.id,
          name: accounts.name,
          city: accounts.city,
          propertyType: accounts.propertyType,
          ownerName: users.name,
          fitScore: accounts.fitScore,
        })
        .from(accounts)
        .leftJoin(users, eq(users.id, accounts.ownerUserId))
        .where(and(accountVisible(scope), ilike(accounts.name, pattern)))
        .orderBy(asc(accounts.name))
        .limit(10);
    },
    async recentReplies(scope: UserScope, since: Date) {
      const conditions: (SQL | undefined)[] = [
        eq(emailMessages.direction, "in"),
        eq(emailMessages.status, "received"),
        gte(emailMessages.receivedAt, since),
        accountVisible(scope),
      ];
      if (!seesEverything(scope)) conditions.push(eq(emailMessages.userId, scope.userId));
      return db
        .select({
          id: emailMessages.id,
          accountId: emailMessages.accountId,
          accountName: accounts.name,
          fromEmail: emailMessages.fromEmail,
          subject: emailMessages.subject,
          classification: emailMessages.aiClassification,
          receivedAt: emailMessages.receivedAt,
        })
        .from(emailMessages)
        .innerJoin(accounts, eq(accounts.id, emailMessages.accountId))
        .where(and(...conditions))
        .orderBy(desc(emailMessages.receivedAt))
        .limit(25);
    },
    async topAccountsByFit(
      scope: UserScope,
      n: number,
      filters: { propertyType?: string | undefined; city?: string | undefined },
    ) {
      return db
        .select({
          id: accounts.id,
          name: accounts.name,
          city: accounts.city,
          propertyType: accounts.propertyType,
          fitScore: accounts.fitScore,
          ownerName: users.name,
        })
        .from(accounts)
        .leftJoin(users, eq(users.id, accounts.ownerUserId))
        .where(
          and(
            accountVisible(scope),
            filters.propertyType === undefined ? undefined : ilike(accounts.propertyType, filters.propertyType),
            filters.city === undefined ? undefined : ilike(accounts.city, filters.city),
          ),
        )
        .orderBy(sql`${accounts.fitScore} DESC NULLS LAST`, asc(accounts.name))
        .limit(n);
    },
    async forecastDeals(scope: UserScope) {
      return dealQuery()
        .where(and(askableDeals(scope), eq(deals.status, "open")))
        .limit(2000);
    },
  };
}
