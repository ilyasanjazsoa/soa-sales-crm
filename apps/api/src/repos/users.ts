import { tables, type Executor } from "@soa/db";
import type { Role } from "@soa/shared";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import type { Scope, SystemScope, UserScope } from "./scope";

const { users, accounts } = tables;

export type UserRow = typeof users.$inferSelect;

export interface NewUser {
  email: string;
  name: string;
  title?: string | undefined;
  role: Role;
  dailySendCap?: number | undefined;
}

export interface UserPatch {
  name?: string;
  title?: string;
  role?: Role;
  dailySendCap?: number;
  active?: boolean;
  phone?: string | null;
  timezone?: string;
  baseAddress?: string | null;
  workdayStart?: string;
  workdayEnd?: string;
}

/** Admins (and the system) see every user; everyone else sees only themselves. */
const visible = (scope: Scope) =>
  scope.kind === "system" || scope.role === "admin" ? sql`true` : eq(users.id, scope.userId);

export function usersRepo(db: Executor) {
  return {
    async findById(scope: Scope, id: string): Promise<UserRow | undefined> {
      const [row] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, id), visible(scope)));
      return row;
    },

    /** Sign-in lookup by address, before anyone is signed in. */
    async findByEmail(_scope: SystemScope, email: string): Promise<UserRow | undefined> {
      const [row] = await db.select().from(users).where(eq(users.email, email));
      return row;
    },

    /** Users with the number of accounts they own (deleted accounts excluded). */
    async listWithAccountCounts(scope: Scope): Promise<(UserRow & { ownedAccounts: number })[]> {
      const rows = await db
        .select({ user: users, ownedAccounts: count(accounts.id) })
        .from(users)
        .leftJoin(accounts, and(eq(accounts.ownerUserId, users.id), isNull(accounts.deletedAt)))
        .where(visible(scope))
        .groupBy(users.id)
        .orderBy(asc(users.name));
      return rows.map((row) => ({ ...row.user, ownedAccounts: row.ownedAccounts }));
    },

    async listActive(_scope: SystemScope): Promise<UserRow[]> {
      return db.select().from(users).where(eq(users.active, true)).orderBy(asc(users.name));
    },

    async countOwnedAccounts(scope: Scope, userId: string): Promise<number> {
      const [row] = await db
        .select({ value: count() })
        .from(accounts)
        .innerJoin(users, eq(users.id, accounts.ownerUserId))
        .where(and(eq(accounts.ownerUserId, userId), isNull(accounts.deletedAt), visible(scope)));
      return row?.value ?? 0;
    },

    async countActiveAdmins(_scope: Scope): Promise<number> {
      const [row] = await db
        .select({ value: count() })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.active, true)));
      return row?.value ?? 0;
    },

    async insert(_scope: Scope, user: NewUser): Promise<UserRow> {
      const [row] = await db
        .insert(users)
        .values({
          email: user.email,
          name: user.name,
          role: user.role,
          ...(user.title === undefined ? {} : { title: user.title }),
          ...(user.dailySendCap === undefined ? {} : { dailySendCap: user.dailySendCap }),
        })
        .returning();
      if (row === undefined) throw new Error("insert returned no row");
      return row;
    },

    /** Inserts unless the email exists (concurrent first sign-ins); returns undefined if it already existed. */
    async insertIfAbsent(_scope: SystemScope, user: NewUser): Promise<UserRow | undefined> {
      const [row] = await db
        .insert(users)
        .values({
          email: user.email,
          name: user.name,
          role: user.role,
          ...(user.title === undefined ? {} : { title: user.title }),
        })
        .onConflictDoNothing({ target: users.email })
        .returning();
      return row;
    },

    /** Updates a user the scope can see; returns undefined when it can't. */
    async update(scope: Scope, id: string, patch: UserPatch): Promise<UserRow | undefined> {
      const [row] = await db
        .update(users)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(and(eq(users.id, id), visible(scope)))
        .returning();
      return row;
    },

    async updateSelf(scope: UserScope, patch: UserPatch): Promise<UserRow | undefined> {
      const [row] = await db
        .update(users)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(users.id, scope.userId))
        .returning();
      return row;
    },
  };
}
