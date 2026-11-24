import { HealthResponse, ReadyResponse, parseEnv } from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { testEnv } from "./helpers";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("health routes", () => {
  it("GET /healthz returns 200", async () => {
    app = await buildApp({ config: parseEnv(testEnv()), logger: false });
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(HealthResponse.parse(response.json())).toEqual({ status: "ok" });
  });

  it("GET /readyz returns 200 when the database answers", async () => {
    app = await buildApp({ config: parseEnv(testEnv()), logger: false });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(ReadyResponse.parse(response.json())).toEqual({ status: "ok", checks: { database: "up" } });
  });

  it("GET /readyz returns 503 when the database is unreachable", async () => {
    const config = parseEnv(testEnv({ DATABASE_URL: "postgres://crm:crm@127.0.0.1:1/crm" }));
    app = await buildApp({ config, logger: false });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(ReadyResponse.parse(response.json())).toEqual({ status: "unavailable", checks: { database: "down" } });
  });
});
