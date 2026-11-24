import { createDb, pingDatabase } from "@soa/db";
import type { Env } from "@soa/shared";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { loggerOptions } from "./logger";
import { registerHealthRoutes } from "./routes/health";
import { createHealthService } from "./services/health";

export interface BuildAppOptions {
  config: Env;
  logger?: FastifyServerOptions["logger"];
}

export async function buildApp({ config, logger }: BuildAppOptions): Promise<FastifyInstance> {
  const database = createDb(config.DATABASE_URL);
  const app = Fastify({ logger: logger ?? loggerOptions(config) });
  app.addHook("onClose", async () => {
    await database.close();
  });

  registerHealthRoutes(app, createHealthService({ isDatabaseUp: () => pingDatabase(database.pool) }));

  try {
    await app.ready();
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}
