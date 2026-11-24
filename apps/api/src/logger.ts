import type { FastifyServerOptions } from "fastify";

/* Structured JSON logs. Never log tokens, cookies, email bodies or prompt contents (CLAUDE.md rule 8). */
export const loggerOptions: FastifyServerOptions["logger"] = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]', "*.token", "*.body"],
    censor: "[redacted]",
  },
};
