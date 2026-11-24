import { HealthResponse, ReadyResponse } from "@soa/shared";
import type { FastifyInstance } from "fastify";
import type { HealthService } from "../services/health";

/* Public routes (docs/API.md): /healthz = process up, /readyz = database reachable (ARCHITECTURE.md §16). */
export function registerHealthRoutes(app: FastifyInstance, health: HealthService): void {
  app.get("/healthz", () => HealthResponse.parse({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    const result = ReadyResponse.parse(await health.readiness());
    return reply.code(result.status === "ok" ? 200 : 503).send(result);
  });
}
