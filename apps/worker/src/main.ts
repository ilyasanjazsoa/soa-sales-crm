import { EnvError, parseEnv, type Env } from "@soa/shared";
import PgBoss from "pg-boss";
import { pino } from "pino";

/* Background jobs run on pg-boss inside Postgres (ARCHITECTURE.md §14). Job handlers arrive with their milestones. */

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
const boss = new PgBoss({ connectionString: config.DATABASE_URL });

// Log what failed, never the message: errors can carry job data (CLAUDE.md rule 8).
boss.on("error", (error: Error & { code?: unknown }) => {
  log.error(
    { err: { name: error.name, code: typeof error.code === "string" ? error.code : undefined } },
    "pg-boss error",
  );
});

await boss.start();
log.info("worker started; no jobs registered yet");

const shutdown = (signal: string) => {
  log.info({ signal }, "shutting down");
  void boss.stop({ graceful: true }).then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
