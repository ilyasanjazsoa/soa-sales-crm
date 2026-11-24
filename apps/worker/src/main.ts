import {
  createCalendarProvider,
  createDriveTimes,
  createFakeWebFetcher,
  createMapsProvider,
  createTokenRefresher,
  morningPrepDue,
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
  runMailSync,
  syncableUsers,
  systemClock,
} from "@soa/api/jobs";
import { APP_ROLE, createDb } from "@soa/db";
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
const store = createS3ObjectStore(config);
const queue = await createPgBossQueue(config.DATABASE_URL);

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
const SYNC_EVERY_MS = 2 * 60 * 1000;
const tick = async () => {
  try {
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
// Every 5 minutes: calendar.sync per connected user, and the 6 am prep refresh for today's meetings.
const CALENDAR_EVERY_MS = 5 * 60 * 1000;
const calendarTick = async () => {
  try {
    for (const userId of await syncableUsers(database.db)) await queue.send(JOBS.calendarSync, { userId });
    for (const meetingId of await morningPrepDue(database.db, systemClock())) {
      await queue.send(JOBS.prepGenerate, { meetingId });
    }
  } catch (error) {
    log.error({ job: "calendar tick", err: failure(error) }, "tick failed");
  }
};
const calendarTimer = setInterval(() => void calendarTick(), CALENDAR_EVERY_MS);
void calendarTick();

log.info({ jobs: Object.values(JOBS) }, "worker started");

const shutdown = (signal: string) => {
  log.info({ signal }, "shutting down");
  clearInterval(syncTimer);
  clearInterval(calendarTimer);
  void queue
    .stop()
    .then(() => database.close())
    .then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
