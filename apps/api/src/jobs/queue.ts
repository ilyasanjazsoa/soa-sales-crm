import PgBoss from "pg-boss";

/* Background jobs run on pg-boss in Postgres (ARCHITECTURE.md §14). The api only enqueues; the worker runs them. */

export const JOBS = {
  importRun: "import.run",
  researchFetch: "research.fetch",
  researchBrief: "research.brief",
  mailSend: "mail.send",
  mailSync: "mail.sync",
} as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface JobPayloads {
  "import.run": { importId: string };
  "research.fetch": { accountId: string; userId: string };
  "research.brief": { accountId: string; userId: string };
  "mail.send": { messageId: string };
  "mail.sync": { userId: string };
}

export interface JobQueue {
  send: <N extends JobName>(name: N, data: JobPayloads[N]) => Promise<void>;
  stop: () => Promise<void>;
}

/** Retries per job (§14): import.run is resumable by row and is not retried automatically. */
export const JOB_OPTIONS: Record<JobName, { retryLimit: number; retryBackoff?: boolean; retryDelay?: number }> = {
  "import.run": { retryLimit: 0 },
  "research.fetch": { retryLimit: 2 },
  "research.brief": { retryLimit: 1 },
  // 3 retries, exponential; permanent errors fail at once (§14).
  "mail.send": { retryLimit: 3, retryBackoff: true, retryDelay: 30 },
  // The next tick is the retry.
  "mail.sync": { retryLimit: 0 },
};

/** Syncs are per user and disposable: "stately" keeps at most one queued and one running job per user. */
const SYNC_QUEUES = new Set<string>(["mail.sync", "calendar.sync"]);

/** The api only sends; the worker passes `supervise: true` so jobs whose worker died are expired and retried. */
export async function createPgBossQueue(
  databaseUrl: string,
  options: { supervise?: boolean } = {},
): Promise<JobQueue & { boss: PgBoss }> {
  const boss = new PgBoss({ connectionString: databaseUrl, supervise: options.supervise ?? false, schedule: false });
  boss.on("error", () => undefined); // surfaced through failed sends
  await boss.start();
  for (const name of Object.values(JOBS)) {
    const policy = SYNC_QUEUES.has(name) ? "stately" : "standard";
    const existing = await boss.getQueue(name);
    // Sync jobs are disposable, so a queue made with the old policy is replaced.
    if (existing?.policy !== policy) {
      if (existing !== null && SYNC_QUEUES.has(name)) await boss.deleteQueue(name);
      if (existing === null || SYNC_QUEUES.has(name)) await boss.createQueue(name, { ...JOB_OPTIONS[name], policy });
    }
  }
  return {
    boss,
    async send(name, data) {
      // One sync per user at a time: a tick while the last one is still queued is dropped.
      const singleton = name === "mail.sync" ? { singletonKey: (data as { userId: string }).userId } : {};
      await boss.send(name, data, { ...JOB_OPTIONS[name], ...singleton });
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
