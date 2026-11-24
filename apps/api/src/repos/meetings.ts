import { tables, type Executor } from "@soa/db";
import { and, asc, eq, gt, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import { accountVisible } from "./visibility";
import { seesEverything, type Scope, type SystemScope, type UserScope } from "./scope";

const { meetings, accounts, users, contacts, aiCalls, activities } = tables;

export type MeetingRow = typeof meetings.$inferSelect;

/* Meetings belong to their owner. Managers see everyone's; an AE sees only their own. A meeting tied to an account
   also needs the account to be visible. */
export function meetingsRepo(db: Executor) {
  const visible = (scope: Scope): SQL => {
    const accountOk = sql`(${meetings.accountId} IS NULL OR EXISTS (SELECT 1 FROM ${accounts} WHERE ${accounts.id} = ${meetings.accountId} AND ${accountVisible(scope)}))`;
    if (seesEverything(scope)) return accountOk;
    return and(eq(meetings.ownerUserId, (scope as UserScope).userId), accountOk) ?? accountOk;
  };
  const base = () =>
    db
      .select({ meeting: meetings, accountName: accounts.name, ownerName: users.name })
      .from(meetings)
      .leftJoin(accounts, eq(accounts.id, meetings.accountId))
      .innerJoin(users, eq(users.id, meetings.ownerUserId));

  return {
    async insert(_scope: UserScope, values: typeof meetings.$inferInsert): Promise<MeetingRow> {
      const [row] = await db.insert(meetings).values(values).returning();
      if (row === undefined) throw new Error("insert returned no row");
      return row;
    },

    async get(scope: Scope, id: string) {
      const [row] = await base().where(and(eq(meetings.id, id), visible(scope)));
      return row;
    },

    /** The caller's own meeting, locked for a change. */
    async lockOwn(scope: UserScope, id: string): Promise<MeetingRow | undefined> {
      const [row] = await db
        .select()
        .from(meetings)
        .where(and(eq(meetings.id, id), eq(meetings.ownerUserId, scope.userId), visible(scope)))
        .for("update");
      return row;
    },

    async between(scope: Scope, from: Date, to: Date, ownerId: string | undefined) {
      const conditions: SQL[] = [visible(scope), lt(meetings.startsAt, to), gt(meetings.endsAt, from)];
      if (ownerId !== undefined) conditions.push(eq(meetings.ownerUserId, ownerId));
      return base()
        .where(and(...conditions))
        .orderBy(asc(meetings.startsAt))
        .limit(500);
    },

    /** Scheduled meetings of the user that overlap the window (a booking must not double-book). */
    async overlapping(_scope: UserScope, userId: string, from: Date, to: Date): Promise<MeetingRow[]> {
      return db
        .select()
        .from(meetings)
        .where(
          and(
            eq(meetings.ownerUserId, userId),
            eq(meetings.status, "scheduled"),
            lt(meetings.startsAt, to),
            gt(meetings.endsAt, from),
          ),
        );
    },

    async update(
      _scope: Scope,
      id: string,
      values: Partial<typeof meetings.$inferInsert>,
    ): Promise<MeetingRow | undefined> {
      const [row] = await db
        .update(meetings)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(meetings.id, id))
        .returning();
      return row;
    },

    /** The user's scheduled CRM meetings with a calendar event, from yesterday on (calendar.sync). */
    async forSync(_scope: SystemScope, userId: string, since: Date): Promise<MeetingRow[]> {
      return db
        .select()
        .from(meetings)
        .where(
          and(
            eq(meetings.ownerUserId, userId),
            eq(meetings.status, "scheduled"),
            isNotNull(meetings.providerEventId),
            gt(meetings.endsAt, since),
          ),
        )
        .limit(200);
    },

    /** Scheduled meetings starting in the window, with the owner's time zone and when the prep was last written. */
    async startingBetween(_scope: SystemScope, from: Date, to: Date) {
      return db
        .select({
          id: meetings.id,
          startsAt: meetings.startsAt,
          timezone: users.timezone,
          prepAt: aiCalls.createdAt,
        })
        .from(meetings)
        .innerJoin(users, eq(users.id, meetings.ownerUserId))
        .leftJoin(aiCalls, eq(aiCalls.id, meetings.prepAiCallId))
        .where(
          and(
            eq(meetings.status, "scheduled"),
            isNotNull(meetings.accountId),
            gt(meetings.startsAt, from),
            lt(meetings.startsAt, to),
          ),
        )
        .limit(500);
    },

    /** Whether a prep brief was already asked for since `since` (one morning attempt per meeting, success or not). */
    async prepRequestedSince(_scope: SystemScope, meetingId: string, since: Date): Promise<boolean> {
      const [row] = await db
        .select({ id: activities.id })
        .from(activities)
        .where(
          and(
            sql`${activities.meta}->>'job' = 'prep.generate'`,
            sql`${activities.meta}->>'meetingId' = ${meetingId}`,
            sql`${activities.meta}->>'state' = 'requested'`,
            gt(activities.occurredAt, since),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    /** When the prep brief was written (its AI call). */
    async prepWrittenAt(_scope: Scope, aiCallId: string | null): Promise<Date | null> {
      if (aiCallId === null) return null;
      const [row] = await db.select({ at: aiCalls.createdAt }).from(aiCalls).where(eq(aiCalls.id, aiCallId));
      return row?.at ?? null;
    },

    async contactsOf(_scope: Scope, ids: string[]) {
      if (ids.length === 0) return [];
      return db
        .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email })
        .from(contacts)
        .where(inArray(contacts.id, ids));
    },
  };
}

/** Coordinates found by geocoding. Not a user change, so no activity or audit row. */
export function locationsRepo(db: Executor) {
  return {
    async setAccount(_scope: Scope, accountId: string, lat: number, lng: number): Promise<void> {
      await db.update(accounts).set({ lat, lng }).where(eq(accounts.id, accountId));
    },
    async setUserBase(_scope: Scope, userId: string, lat: number, lng: number): Promise<void> {
      await db.update(users).set({ baseLat: lat, baseLng: lng }).where(eq(users.id, userId));
    },
  };
}
