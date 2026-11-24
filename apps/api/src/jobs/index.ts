/* Entry point for the worker: job names, the queue, and the handlers it runs. The worker reaches AI only through
   the AI client exported here (CLAUDE.md rule 3); it never imports an AI SDK itself. */
export { createPgBossQueue, JOB_OPTIONS, JOBS, type JobPayloads, type JobQueue } from "./queue";
export { runImport } from "../services/imports";
export { runResearchBrief, runResearchFetch } from "../services/research";
export { createS3ObjectStore, type ObjectStore } from "../providers/storage";
export { createAiClient } from "../providers/ai/client";
export { createBedrockAdapter } from "../providers/ai/bedrock";
export { createFakeAiAdapter } from "../providers/ai/fake";
export { createWebFetcher } from "../providers/web";
export { systemClock } from "../clock";
