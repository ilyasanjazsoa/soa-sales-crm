import { tables, type Executor } from "@soa/db";
import { and, count, desc, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import { accountEditable, accountVisible } from "./visibility";
import { seesEverything, type Scope, type SystemScope, type UserScope } from "./scope";

const { outreachDrafts, emailMessages, suppressions, contacts, accounts, oauthAccounts, users } = tables;

export type DraftRow = typeof outreachDrafts.$inferSelect;
export type EmailRow = typeof emailMessages.$inferSelect;
export type SuppressionRow = typeof suppressions.$inferSelect;

/* Outreach drafts are personal: only their author reads or changes them (a draft goes out from the author's own
   mailbox), and only while the author may still edit the account. */
export function draftsRepo(db: Executor) {
  const own = (scope: UserScope) => and(eq(outreachDrafts.userId, scope.userId), accountEditable(scope));
  const withContact = () =>
    db
      .select({ draft: outreachDrafts, contact: contacts })
      .from(outreachDrafts)
      .innerJoin(accounts, eq(accounts.id, outreachDrafts.accountId))
      .innerJoin(contacts, eq(contacts.id, outreachDrafts.contactId));

  return {
    async insert(_scope: UserScope, values: typeof outreachDrafts.$inferInsert): Promise<DraftRow> {
      const [row] = await db.insert(outreachDrafts).values(values).returning();
      if (row === undefined) throw new Error("insert returned no row");
      return row;
    },

    async get(scope: UserScope, id: string) {
      const [row] = await withContact().where(and(eq(outreachDrafts.id, id), own(scope)));
      return row;
    },

    /** Locks the draft row for the send transaction (a second send waits, then sees status 'sent'). */
    async lockForSend(scope: UserScope, id: string) {
      const [row] = await withContact()
        .where(and(eq(outreachDrafts.id, id), own(scope)))
        .for("update", { of: outreachDrafts });
      return row;
    },

    async openForAccount(scope: UserScope, accountId: string) {
      return withContact()
        .where(and(eq(outreachDrafts.accountId, accountId), eq(outreachDrafts.status, "draft"), own(scope)))
        .orderBy(desc(outreachDrafts.updatedAt))
        .limit(20);
    },

    async update(
      scope: UserScope,
      id: string,
      values: Partial<typeof outreachDrafts.$inferInsert>,
    ): Promise<DraftRow | undefined> {
      const [row] = await db
        .update(outreachDrafts)
        .set({ ...values, updatedAt: sql`now()` })
        .where(
          and(
            eq(outreachDrafts.id, id),
            eq(outreachDrafts.userId, scope.userId),
            sql`EXISTS (SELECT 1 FROM ${accounts} WHERE ${accounts.id} = ${outreachDrafts.accountId} AND ${accountEditable(scope)})`,
          ),
        )
        .returning();
      return row;
    },
  };
}

export function emailsRepo(db: Executor) {
  return {
    async insertQueued(_scope: UserScope, values: typeof emailMessages.$inferInsert): Promise<EmailRow> {
      const [row] = await db.insert(emailMessages).values(values).returning();
      if (row === undefined) throw new Error("insert returned no row");
      return row;
    },

    /** Messages created in the window that count against the daily cap (queued or sent, not failed). */
    async sendsSince(scope: UserScope, since: Date): Promise<number> {
      const [row] = await db
        .select({ value: count() })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.userId, scope.userId),
            eq(emailMessages.direction, "out"),
            ne(emailMessages.status, "failed"),
            gte(emailMessages.createdAt, since),
          ),
        );
      return row?.value ?? 0;
    },

    /** Messages on an account's CRM threads. AEs see their own; managers everyone's. */
    async listForAccount(scope: UserScope, accountId: string) {
      const conditions = [eq(emailMessages.accountId, accountId), accountVisible(scope)];
      if (!seesEverything(scope)) conditions.push(eq(emailMessages.userId, scope.userId));
      return db
        .select({ email: emailMessages })
        .from(emailMessages)
        .innerJoin(accounts, eq(accounts.id, emailMessages.accountId))
        .where(and(...conditions))
        .orderBy(sql`coalesce(${emailMessages.receivedAt}, ${emailMessages.sentAt}, ${emailMessages.createdAt}) DESC`)
        .limit(200);
    },

    /** The caller's own failed message, locked, for Retry. */
    async lockOwnFailed(scope: UserScope, id: string): Promise<EmailRow | undefined> {
      const [row] = await db
        .select({ email: emailMessages })
        .from(emailMessages)
        .innerJoin(accounts, eq(accounts.id, emailMessages.accountId))
        .where(
          and(
            eq(emailMessages.id, id),
            eq(emailMessages.userId, scope.userId),
            eq(emailMessages.direction, "out"),
            accountEditable(scope),
          ),
        )
        .for("update", { of: emailMessages });
      return row?.email;
    },

    async get(_scope: SystemScope, id: string): Promise<EmailRow | undefined> {
      const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, id));
      return row;
    },

    /** The worker's claim on a queued outbound message created by the send route. SKIP LOCKED: one runner at a time. */
    async lockQueued(_scope: SystemScope, id: string): Promise<EmailRow | undefined> {
      const [row] = await db
        .select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.id, id),
            eq(emailMessages.status, "queued"),
            eq(emailMessages.direction, "out"),
            isNotNull(emailMessages.draftId),
          ),
        )
        .for("update", { skipLocked: true });
      return row;
    },

    async update(_scope: Scope, id: string, values: Partial<typeof emailMessages.$inferInsert>): Promise<void> {
      await db.update(emailMessages).set(values).where(eq(emailMessages.id, id));
    },

    /** The CRM message a thread belongs to: an outbound message the CRM sent on it. */
    async outboundOnThread(_scope: SystemScope, provider: "microsoft" | "google", threadId: string, userId: string) {
      const [row] = await db
        .select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.provider, provider),
            eq(emailMessages.providerThreadId, threadId),
            eq(emailMessages.direction, "out"),
            eq(emailMessages.userId, userId),
          ),
        )
        .orderBy(desc(emailMessages.createdAt))
        .limit(1);
      return row;
    },

    /** Stores an inbound message once (UNIQUE provider + provider_message_id). Undefined if already stored. */
    async insertInbound(_scope: SystemScope, values: typeof emailMessages.$inferInsert): Promise<EmailRow | undefined> {
      const [row] = await db.insert(emailMessages).values(values).onConflictDoNothing().returning();
      return row;
    },
  };
}

/** The company-wide suppression list (§8.4): visible to every user, changed by managers or by the system. */
export function suppressionListRepo(db: Executor) {
  return {
    async list(_scope: Scope): Promise<SuppressionRow[]> {
      return db.select().from(suppressions).orderBy(desc(suppressions.createdAt)).limit(1000);
    },

    async reason(_scope: Scope, email: string): Promise<string | null> {
      const [row] = await db
        .select({ reason: suppressions.reason })
        .from(suppressions)
        .where(eq(suppressions.email, email.toLowerCase()));
      return row?.reason ?? null;
    },

    /** Adds the address; true when it was not on the list before. */
    async add(
      _scope: Scope,
      values: { email: string; reason: SuppressionRow["reason"]; note?: string | null; createdBy: string | null },
    ): Promise<boolean> {
      const rows = await db
        .insert(suppressions)
        .values({ ...values, email: values.email.toLowerCase() })
        .onConflictDoNothing()
        .returning({ email: suppressions.email });
      return rows.length > 0;
    },

    async remove(_scope: UserScope, email: string): Promise<boolean> {
      const rows = await db
        .delete(suppressions)
        .where(eq(suppressions.email, email.toLowerCase()))
        .returning({ email: suppressions.email });
      return rows.length > 0;
    },
  };
}

/** Contact email status, company-wide by address (an unsubscribe or bounce applies to every copy of the address). */
export function contactEmailRepo(db: Executor) {
  return {
    async markByEmail(
      _scope: SystemScope | UserScope,
      email: string,
      status: "unsubscribed" | "bounced",
    ): Promise<{ id: string; accountId: string }[]> {
      return db
        .update(contacts)
        .set({ emailStatus: status, updatedAt: sql`now()` })
        .where(eq(contacts.email, email.toLowerCase()))
        .returning({ id: contacts.id, accountId: contacts.accountId });
    },

    async name(_scope: SystemScope, contactId: string | null): Promise<string | undefined> {
      if (contactId === null) return undefined;
      const [row] = await db
        .select({ first: contacts.firstName, last: contacts.lastName })
        .from(contacts)
        .where(eq(contacts.id, contactId));
      return row === undefined ? undefined : `${row.first} ${row.last}`.trim();
    },
  };
}

/** Mail tokens for the worker. Tokens are never returned by the API (§15). */
export function mailAccountsRepo(db: Executor) {
  return {
    async get(_scope: SystemScope, userId: string) {
      const [row] = await db
        .select({ account: oauthAccounts, user: users })
        .from(oauthAccounts)
        .innerJoin(users, eq(users.id, oauthAccounts.userId))
        .where(eq(oauthAccounts.userId, userId))
        .limit(1);
      return row;
    },

    /** Active users whose mailbox can be synced. */
    async syncable(_scope: SystemScope): Promise<string[]> {
      const rows = await db
        .select({ userId: oauthAccounts.userId })
        .from(oauthAccounts)
        .innerJoin(users, eq(users.id, oauthAccounts.userId))
        .where(and(eq(oauthAccounts.needsReconnect, false), eq(users.active, true)));
      return rows.map((row) => row.userId);
    },

    async update(
      _scope: SystemScope,
      userId: string,
      provider: "microsoft" | "google",
      values: Partial<typeof oauthAccounts.$inferInsert>,
    ): Promise<void> {
      await db
        .update(oauthAccounts)
        .set({ ...values, updatedAt: sql`now()` })
        .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)));
    },
  };
}
