import { z } from "zod";

/* Request and response shapes shared by the api and the web app (ARCHITECTURE.md §13). */

export const HealthResponse = z.object({ status: z.literal("ok") });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const ReadyResponse = z.object({
  status: z.enum(["ok", "unavailable"]),
  checks: z.object({ database: z.enum(["up", "down"]) }),
});
export type ReadyResponse = z.infer<typeof ReadyResponse>;
