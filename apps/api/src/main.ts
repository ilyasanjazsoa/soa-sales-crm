import { EnvError, parseEnv, type Env } from "@soa/shared";
import { buildApp } from "./app";

function loadConfig(): Env {
  try {
    return parseEnv(process.env);
  } catch (error) {
    if (error instanceof EnvError) {
      process.stderr.write(`api: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadConfig();
const app = await buildApp({ config });

const shutdown = (signal: string) => {
  app.log.info({ signal }, "shutting down");
  void app.close().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: config.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1" });
