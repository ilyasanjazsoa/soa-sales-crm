import { tables, type Executor } from "@soa/db";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { actorId, isAdmin, type Scope } from "./scope";

const { auditLog } = tables;

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
  ip?: string | null;
  /** Overrides the actor, e.g. the user who just signed in under a system scope. */
  userId?: string | null;
}

export type AuditRow = typeof auditLog.$inferSelect;

/** audit_log is append-only: the app role has INSERT and SELECT only (packages/db/migrations/0002_app_role.sql). */
export function auditRepo(db: Executor) {
  return {
    async write(scope: Scope, entry: AuditEntry): Promise<void> {
      await db.insert(auditLog).values({
        userId: entry.userId === undefined ? actorId(scope) : entry.userId,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        meta: entry.meta ?? {},
        ip: entry.ip ?? null,
      });
    },

    /** Newest first. Only admins (and the system) can read the audit log. */
    async list(
      scope: Scope,
      filter: {
        entityType?: string | undefined;
        userId?: string | undefined;
        before?: number | undefined;
        limit: number;
      },
    ): Promise<AuditRow[]> {
      if (!isAdmin(scope)) return [];
      const conditions: SQL[] = [];
      if (filter.entityType !== undefined) conditions.push(eq(auditLog.entityType, filter.entityType));
      if (filter.userId !== undefined) conditions.push(eq(auditLog.userId, filter.userId));
      if (filter.before !== undefined) conditions.push(lt(auditLog.id, filter.before));
      return db
        .select()
        .from(auditLog)
        .where(and(...conditions))
        .orderBy(desc(auditLog.id))
        .limit(filter.limit);
    },
  };
}
