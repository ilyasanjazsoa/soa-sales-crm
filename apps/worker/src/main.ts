import { createPgBossQueue, createS3ObjectStore, JOBS, runImport, systemClock } from "@soa/api/jobs";
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
log.info({ jobs: Object.values(JOBS) }, "worker started");

const shutdown = (signal: string) => {
  log.info({ signal }, "shutting down");
  void queue
    .stop()
    .then(() => database.close())
    .then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
