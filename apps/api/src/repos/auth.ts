import { tables, type Executor } from "@soa/db";
import { and, eq, lt, or } from "drizzle-orm";
import { isAdmin, type Scope, type SystemScope, type UserScope } from "./scope";

const { sessions, users, oauthAccounts } = tables;

export type SessionWithUser = typeof sessions.$inferSelect & { user: typeof users.$inferSelect };

export interface OAuthAccountWrite {
  userId: string;
  provider: "microsoft" | "google";
  subject: string;
  scopes: string[];
  accessTokenEnc: Buffer;
  refreshTokenEnc: Buffer;
  expiresAt: Date;
}

/** Sessions and OAuth tokens. Session lookups happen before a user is known, so they take a SystemScope. */
export function authRepo(db: Executor) {
  return {
    async insertSession(
      _scope: SystemScope,
      session: {
        idHash: string;
        userId: string;
        now: Date;
        expiresAt: Date;
        ip: string | null;
        userAgent: string | null;
      },
    ): Promise<void> {
      await db.insert(sessions).values({
        idHash: session.idHash,
        userId: session.userId,
        createdAt: session.now,
        lastSeenAt: session.now,
        expiresAt: session.expiresAt,
        ip: session.ip,
        userAgent: session.userAgent,
      });
    },

    async findSession(_scope: SystemScope, idHash: string): Promise<SessionWithUser | undefined> {
      const [row] = await db
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.idHash, idHash));
      return row === undefined ? undefined : { ...row.session, user: row.user };
    },

    async touchSession(_scope: SystemScope, idHash: string, now: Date): Promise<void> {
      await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.idHash, idHash));
    },

    async deleteSession(_scope: SystemScope, idHash: string): Promise<void> {
      await db.delete(sessions).where(eq(sessions.idHash, idHash));
    },

    /** Admins (and the system) may end anyone's sessions; a user only their own. */
    async deleteSessionsForUser(scope: Scope, userId: string): Promise<void> {
      if (!isAdmin(scope) && scope.kind === "user" && scope.userId !== userId) {
        throw new Error("scope may not end another user's sessions");
      }
      await db.delete(sessions).where(eq(sessions.userId, userId));
    },

    async deleteExpiredSessions(_scope: SystemScope, idleBefore: Date, now: Date): Promise<void> {
      await db.delete(sessions).where(or(lt(sessions.expiresAt, now), lt(sessions.lastSeenAt, idleBefore)));
    },

    /** The user an identity-provider account is already bound to. */
    async findOAuthBySubject(
      _scope: SystemScope,
      provider: "microsoft" | "google",
      subject: string,
    ): Promise<{ userId: string } | undefined> {
      const [row] = await db
        .select({ userId: oauthAccounts.userId })
        .from(oauthAccounts)
        .where(and(eq(oauthAccounts.provider, provider), eq(oauthAccounts.subject, subject)));
      return row;
    },

    async findOAuthForUser(
      _scope: SystemScope,
      userId: string,
      provider: "microsoft" | "google",
    ): Promise<{ subject: string } | undefined> {
      const [row] = await db
        .select({ subject: oauthAccounts.subject })
        .from(oauthAccounts)
        .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)));
      return row;
    },

    /** Stores tokens for a user's bound account. The subject never changes once bound (checked by the caller). */
    async upsertOAuthAccount(_scope: SystemScope, account: OAuthAccountWrite): Promise<void> {
      await db
        .insert(oauthAccounts)
        .values({ ...account, needsReconnect: false })
        .onConflictDoUpdate({
          target: [oauthAccounts.userId, oauthAccounts.provider],
          setWhere: eq(oauthAccounts.subject, account.subject),
          set: {
            scopes: account.scopes,
            accessTokenEnc: account.accessTokenEnc,
            refreshTokenEnc: account.refreshTokenEnc,
            expiresAt: account.expiresAt,
            needsReconnect: false,
            updatedAt: new Date(),
          },
        });
    },

    /** The signed-in user's own mail connection status (no tokens). */
    async mailConnection(
      scope: UserScope,
    ): Promise<{ provider: "microsoft" | "google"; needsReconnect: boolean } | undefined> {
      const [row] = await db
        .select({ provider: oauthAccounts.provider, needsReconnect: oauthAccounts.needsReconnect })
        .from(oauthAccounts)
        .where(and(eq(oauthAccounts.userId, scope.userId)));
      return row;
    },
  };
}
