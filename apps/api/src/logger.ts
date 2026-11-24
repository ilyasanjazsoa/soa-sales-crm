import type { Env } from "@soa/shared";
import type { FastifyServerOptions } from "fastify";

/* Structured JSON logs. Never log tokens, cookies, email bodies or prompt contents (CLAUDE.md rule 8). */
export function loggerOptions(config: Env): FastifyServerOptions["logger"] {
  return {
    level: config.LOG_LEVEL ?? "info",
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
      censor: "[redacted]",
    },
  };
}
