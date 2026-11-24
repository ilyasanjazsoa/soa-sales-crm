import { tables, type Database } from "@soa/db";
import { and, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { Clock } from "../clock";
import type { BackupChecker } from "../providers/backups";
import { authRepo } from "../repos/auth";
import { systemScope } from "../repos/scope";
import { SESSION_IDLE_MS } from "./auth";

/* maintenance.nightly (§14), 3 am: purge old AI payloads, expire sessions and proposals, verify the last backup.
   It returns what it did so the worker logs it as numbers (CloudWatch metric filters read them for alarms). */

const AI_PAYLOAD_DAYS = 90;
const BACKUP_MAX_AGE_HOURS = 26;
const DAY = 86_400_000;

export interface MaintenanceResult {
  aiPayloadsPurged: number;
  proposalsExpired: number;
  backupAgeHours: number | null;
  backupOk: boolean;
}

export async function runMaintenance(deps: {
  db: Database;
  clock: Clock;
  backups: BackupChecker;
}): Promise<MaintenanceResult> {
  const { db } = deps;
  const now = deps.clock();
  const scope = systemScope("maintenance.nightly");

  // AI payloads (prompts and answers) are kept 90 days; the call row itself stays for usage and limits.
  const purged = await db
    .update(tables.aiCalls)
    .set({ request: { purged: true }, response: null })
    .where(
      and(
        lt(tables.aiCalls.createdAt, new Date(now.getTime() - AI_PAYLOAD_DAYS * DAY)),
        sql`NOT (${tables.aiCalls.request} ? 'purged')`,
      ),
    )
    .returning({ id: tables.aiCalls.id });

  await authRepo(db).deleteExpiredSessions(scope, new Date(now.getTime() - SESSION_IDLE_MS), now);

  // Share links past their 30 days. Accepted proposals stay accepted.
  const expired = await db
    .update(tables.proposals)
    .set({ status: "expired" })
    .where(
      and(
        inArray(tables.proposals.status, ["sent", "viewed"]),
        isNotNull(tables.proposals.expiresAt),
        lt(tables.proposals.expiresAt, now),
      ),
    )
    .returning({ id: tables.proposals.id });

  let backupAgeHours: number | null = null;
  try {
    const latest = await deps.backups.latestRestorableTime();
    backupAgeHours = latest === null ? null : Math.round(((now.getTime() - latest.getTime()) / 3_600_000) * 10) / 10;
  } catch {
    backupAgeHours = null;
  }
  return {
    aiPayloadsPurged: purged.length,
    proposalsExpired: expired.length,
    backupAgeHours,
    backupOk: backupAgeHours !== null && backupAgeHours <= BACKUP_MAX_AGE_HOURS,
  };
}
