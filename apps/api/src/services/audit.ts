import type { Database } from "@soa/db";
import type { AuditPage } from "@soa/shared";
import { auditRepo } from "../repos/audit";
import type { UserScope } from "../repos/scope";

export function createAuditService({ db }: { db: Database }) {
  return {
    async list(
      scope: UserScope,
      query: { entity?: string | undefined; user?: string | undefined; cursor?: number | undefined; limit: number },
    ): Promise<AuditPage> {
      const rows = await auditRepo(db).list(scope, {
        entityType: query.entity,
        userId: query.user,
        before: query.cursor,
        limit: query.limit,
      });
      const last = rows.at(-1);
      return {
        items: rows.map((row) => ({
          id: row.id,
          userId: row.userId,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          meta: row.meta,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: rows.length === query.limit && last !== undefined ? String(last.id) : null,
      };
    },
  };
}

export type AuditService = ReturnType<typeof createAuditService>;
