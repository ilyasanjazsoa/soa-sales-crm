import PgBoss from "pg-boss";

/* Background jobs run on pg-boss in Postgres (ARCHITECTURE.md §14). The api only enqueues; the worker runs them. */

export const JOBS = {
  importRun: "import.run",
} as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface JobPayloads {
  "import.run": { importId: string };
}

export interface JobQueue {
  send: <N extends JobName>(name: N, data: JobPayloads[N]) => Promise<void>;
  stop: () => Promise<void>;
}

/** Retries per job (§14): import.run is resumable by row and is not retried automatically. */
export const JOB_OPTIONS: Record<JobName, { retryLimit: number }> = {
  "import.run": { retryLimit: 0 },
};

export async function createPgBossQueue(databaseUrl: string): Promise<JobQueue & { boss: PgBoss }> {
  const boss = new PgBoss({ connectionString: databaseUrl, supervise: false, schedule: false });
  boss.on("error", () => undefined); // surfaced through failed sends
  await boss.start();
  for (const name of Object.values(JOBS)) await boss.createQueue(name, JOB_OPTIONS[name]);
  return {
    boss,
    async send(name, data) {
      await boss.send(name, data, JOB_OPTIONS[name]);
    },
    async stop() {
      await boss.stop({ graceful: true });
    },
  };
}

/** Records jobs instead of running them (tests). */
export function createMemoryQueue(): JobQueue & { sent: { name: JobName; data: unknown }[] } {
  const sent: { name: JobName; data: unknown }[] = [];
  return {
    sent,
    send(name, data) {
      sent.push({ name, data });
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
  };
}
