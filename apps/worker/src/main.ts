import {
  createCalendarProvider,
  createDriveTimes,
  createFakeWebFetcher,
  createMapsProvider,
  createTokenRefresher,
  queueMorningPrep,
  runCalendarSync,
  runPrepGenerate,
  createPgBossQueue,
  createTokenCipher,
  createWorkerMail,
  createS3ObjectStore,
  createWebFetcher,
  createWorkerAi,
  JOBS,
  runImport,
  runResearchBrief,
  runResearchFetch,
  runMailSend,
  runMaintenance,
  createRdsBackupChecker,
  fakeBackupChecker,
  runProposalRender,
  runMailSync,
  sweepStuckMail,
  syncableUsers,
  systemClock,
} from "@soa/api/jobs";
import { APP_ROLE, appRoleProblems, createDb } from "@soa/db";
import { EnvError, parseEnv, type Env } from "@soa/shared";
import { pino } from "pino";

/* Background jobs run on pg-boss inside Postgres (ARCHITECTURE.md §14). */

function loadConfig(): Env {
  try {
    return parseEnv(process.env);
  } catch (error) {
    if (error instanceof EnvError) {
      process.stderr.write(`worker: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadConfig();
const log = pino({ name: "worker", level: config.LOG_LEVEL ?? "info" });
const database = createDb(config.DATABASE_URL, { role: APP_ROLE });
// Like the api: in production, refuse a database login that could bypass the app role (owner, superuser, or one
// that can change audit_log).
if (config.NODE_ENV === "production") {
  const problems = await appRoleProblems(database.pool);
  if (problems.length > 0) {
    process.stderr.write(`worker: DATABASE_URL must log in as a member of ${APP_ROLE} only: ${problems.join("; ")}\n`);
    process.exit(1);
  }
}
const store = createS3ObjectStore(config);
const queue = await createPgBossQueue(config.DATABASE_URL, { supervise: true });

// Log what failed, never the message: errors can carry job data (CLAUDE.md rule 8).
const failure = (error: unknown) => {
  const code = error instanceof Error ? (error as unknown as { code?: unknown }).code : undefined;
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof code === "string" ? code : undefined,
  };
};
queue.boss.on("error", (error: Error) => {
  log.error({ err: failure(error) }, "pg-boss error");
});

await queue.boss.work<{ importId: string }>(JOBS.importRun, async (jobs) => {
  for (const job of jobs) {
    log.info({ job: JOBS.importRun, id: job.id }, "job started");
    try {
      await runImport({ db: database.db, store, clock: systemClock }, job.data.importId);
      log.info({ job: JOBS.importRun, id: job.id }, "job done");
    } catch (error) {
      log.error({ job: JOBS.importRun, id: job.id, err: failure(error) }, "job failed");
      throw error;
    }
  }
});
const ai = createWorkerAi(database.db, config, systemClock);
// FAKE_PROVIDERS: no request leaves the machine (CLAUDE.md: every external call has a fake).
const fetcher = config.FAKE_PROVIDERS ? createFakeWebFetcher() : createWebFetcher();

const handle = (name: string, run: (data: { accountId: string; userId: string }) => Promise<void>) =>
  queue.boss.work<{ accountId: string; userId: string }>(name, async (jobs) => {
    for (const job of jobs) {
      log.info({ job: name, id: job.id }, "job started");
      try {
        await run(job.data);
        log.info({ job: name, id: job.id }, "job done");
      } catch (error) {
        log.error({ job: name, id: job.id, err: failure(error) }, "job failed");
        throw error;
      }
    }
  });

await handle(JOBS.researchFetch, (data) =>
  runResearchFetch({ db: database.db, ai, fetcher, clock: systemClock }, data),
);
await handle(JOBS.researchBrief, (data) => runResearchBrief({ db: database.db, ai, clock: systemClock }, data));

// ───────── mail (§8.2, §8.4) ─────────
const mailDeps = {
  db: database.db,
  mail: createWorkerMail(config, systemClock),
  cipher: createTokenCipher(config.TOKEN_ENC_KEY),
  ai,
  clock: systemClock,
  config,
};
const MAIL_SEND_RETRIES = 3;
await queue.boss.work<{ messageId: string }>(JOBS.mailSend, { includeMetadata: true }, async (jobs) => {
  for (const job of jobs) {
    log.info({ job: JOBS.mailSend, id: job.id }, "job started");
    try {
      await runMailSend(mailDeps, job.data, { finalAttempt: job.retryCount >= MAIL_SEND_RETRIES });
      log.info({ job: JOBS.mailSend, id: job.id }, "job done");
    } catch (error) {
      log.error({ job: JOBS.mailSend, id: job.id, err: failure(error) }, "job failed");
      throw error;
    }
  }
});
await queue.boss.work<{ userId: string }>(JOBS.mailSync, async (jobs) => {
  for (const job of jobs) {
    try {
      const result = await runMailSync(mailDeps, job.data);
      if (result.stored > 0) log.info({ job: JOBS.mailSync, id: job.id, stored: result.stored }, "mail synced");
    } catch (error) {
      log.error({ job: JOBS.mailSync, id: job.id, err: failure(error) }, "job failed");
    }
  }
});
// Every 2 minutes, one sync per connected user. Users who must reconnect are skipped until they do.
// JOB_TICK_SECONDS (local and CI only) makes the ticks fast enough for the end-to-end journey.
const fastTicks =
  config.FAKE_PROVIDERS && config.JOB_TICK_SECONDS !== undefined ? config.JOB_TICK_SECONDS * 1000 : null;
const SYNC_EVERY_MS = fastTicks ?? 2 * 60 * 1000;
const tick = async () => {
  try {
    const swept = await sweepStuckMail(database.db, systemClock());
    if (swept > 0) log.warn({ job: "mail sweep", swept }, "stuck messages marked failed");
    for (const userId of await syncableUsers(database.db)) await queue.send(JOBS.mailSync, { userId });
  } catch (error) {
    log.error({ job: "mail.sync tick", err: failure(error) }, "tick failed");
  }
};
const syncTimer = setInterval(() => void tick(), SYNC_EVERY_MS);
void tick();

// ───────── meetings (§9.2, §14) ─────────
const meetingDeps = {
  db: database.db,
  ai,
  calendar: createCalendarProvider(config),
  driveTimes: createDriveTimes(createMapsProvider(config), systemClock),
  refresher: createTokenRefresher(config, systemClock),
  cipher: createTokenCipher(config.TOKEN_ENC_KEY),
  clock: systemClock,
};
await queue.boss.work<{ userId: string }>(JOBS.calendarSync, async (jobs) => {
  for (const job of jobs) {
    try {
      const result = await runCalendarSync(meetingDeps, job.data);
      if (result.changed > 0)
        log.info({ job: JOBS.calendarSync, id: job.id, changed: result.changed }, "calendar synced");
    } catch (error) {
      log.error({ job: JOBS.calendarSync, id: job.id, err: failure(error) }, "job failed");
    }
  }
});
await handle(JOBS.prepGenerate, (data) => runPrepGenerate(meetingDeps, data as unknown as { meetingId: string }));
await queue.boss.work<{ proposalId: string }>(JOBS.proposalRender, async (jobs) => {
  for (const job of jobs) {
    log.info({ job: JOBS.proposalRender, id: job.id }, "job started");
    try {
      await runProposalRender({ db: database.db, store, config, clock: systemClock }, job.data);
      log.info({ job: JOBS.proposalRender, id: job.id }, "job done");
    } catch (error) {
      log.error({ job: JOBS.proposalRender, id: job.id, err: failure(error) }, "job failed");
      throw error;
    }
  }
});
// Every 5 minutes: calendar.sync per connected user, and the 6 am prep refresh for today's meetings.
const CALENDAR_EVERY_MS = fastTicks ?? 5 * 60 * 1000;
const calendarTick = async () => {
  try {
    for (const userId of await syncableUsers(database.db)) await queue.send(JOBS.calendarSync, { userId });
    await queueMorningPrep(database.db, queue, systemClock());
  } catch (error) {
    log.error({ job: "calendar tick", err: failure(error) }, "tick failed");
  }
};
const calendarTimer = setInterval(() => void calendarTick(), CALENDAR_EVERY_MS);
void calendarTick();

// ───────── maintenance and health numbers (§14, §16) ─────────
const backups =
  config.FAKE_PROVIDERS || config.RDS_INSTANCE_ID === undefined
    ? fakeBackupChecker
    : createRdsBackupChecker({ region: config.AWS_REGION, instanceId: config.RDS_INSTANCE_ID });
await queue.boss.work<{ day: string }>(JOBS.maintenanceNightly, async (jobs) => {
  for (const job of jobs) {
    const result = await runMaintenance({ db: database.db, clock: systemClock, backups });
    // Numbers only; the backup alarm reads backupOk / backupAgeHours.
    log.info({ job: JOBS.maintenanceNightly, day: job.data.day, ...result }, "maintenance done");
  }
});
const COMPANY_ZONE = "America/Chicago";
const healthTick = async () => {
  try {
    // 3 am company time: the nightly job (one per day: the queue keeps one per key).
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: COMPANY_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(systemClock());
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    if (get("hour") === "03")
      await queue.send(JOBS.maintenanceNightly, { day: `${get("year")}-${get("month")}-${get("day")}` });

    // For the alarms: the oldest waiting job per queue, and mailboxes that need reconnecting.
    const ages = await database.pool.query<{ name: string; age: number }>(
      "SELECT name, extract(epoch FROM now() - min(created_on))::int AS age FROM pgboss.job WHERE state = 'created' GROUP BY name",
    );
    const reconnect = await database.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM oauth_accounts WHERE needs_reconnect",
    );
    log.info(
      {
        metric: "health",
        oldestQueuedSeconds: Math.max(0, ...ages.rows.map((row) => row.age)),
        needsReconnect: reconnect.rows[0]?.count ?? 0,
      },
      "health numbers",
    );
  } catch (error) {
    log.error({ job: "health tick", err: failure(error) }, "tick failed");
  }
};
const healthTimer = setInterval(() => void healthTick(), 5 * 60 * 1000);
void healthTick();

log.info({ jobs: Object.values(JOBS) }, "worker started");

const shutdown = (signal: string) => {
  log.info({ signal }, "shutting down");
  clearInterval(syncTimer);
  clearInterval(calendarTimer);
  clearInterval(healthTimer);
  void queue
    .stop()
    .then(() => database.close())
    .then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
