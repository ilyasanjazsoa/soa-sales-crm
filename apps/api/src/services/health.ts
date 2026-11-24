import type { ReadyResponse } from "@soa/shared";

export interface HealthService {
  readiness: () => Promise<ReadyResponse>;
}

export function createHealthService(deps: { isDatabaseUp: () => Promise<boolean> }): HealthService {
  return {
    async readiness() {
      const databaseUp = await deps.isDatabaseUp();
      return { status: databaseUp ? "ok" : "unavailable", checks: { database: databaseUp ? "up" : "down" } };
    },
  };
}
