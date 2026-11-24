/* Entry point for the worker: job names, the queue, and the handlers it runs. The worker reaches AI only through
   the AI client exported here (CLAUDE.md rule 3); it never imports an AI SDK itself. */
export { createPgBossQueue, JOB_OPTIONS, JOBS, type JobPayloads, type JobQueue } from "./queue";
export { runImport } from "../services/imports";
export { runResearchBrief, runResearchFetch } from "../services/research";
export { createS3ObjectStore, type ObjectStore } from "../providers/storage";
export { createWorkerAi } from "./worker-ai";
export { createFakeWebFetcher, createWebFetcher } from "../providers/web";
export { systemClock } from "../clock";
export { runMailSend, runMailSync, sweepStuckMail, syncableUsers } from "../services/mail-jobs";
export { createWorkerMail } from "./worker-mail";
export { createTokenCipher } from "../auth/crypto";
export { morningPrepDue, queueMorningPrep, runCalendarSync, runPrepGenerate } from "../services/meetings";
export { createCalendarProvider, createMapsProvider, createTokenRefresher } from "../providers/factories";
export { createDriveTimes } from "../providers/maps/cache";
export { runProposalRender } from "../services/proposals";
export { runMaintenance } from "../services/maintenance";
export { createRdsBackupChecker, fakeBackupChecker } from "../providers/backups";
