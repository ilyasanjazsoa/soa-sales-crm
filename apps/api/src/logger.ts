import type { Env } from "@soa/shared";
import type { FastifyServerOptions } from "fastify";

/* Structured JSON logs. Never log tokens, cookies, email bodies or prompt contents (CLAUDE.md rule 8).
   Query strings are dropped from sign-in URLs (they carry one-time codes) and from public token routes. */

const SENSITIVE_QUERY = /^\/(api\/auth|p|u|webhooks)\//;

export function urlForLog(url: string): string {
  const [path = "", query] = url.split("?", 2);
  return query !== undefined && SENSITIVE_QUERY.test(path) ? `${path}?[redacted]` : url;
}

export function loggerOptions(config: Env): FastifyServerOptions["logger"] {
  return {
    level: config.LOG_LEVEL ?? "info",
    serializers: {
      req: (request: { method: string; url: string; ip: string }) => ({
        method: request.method,
        url: urlForLog(request.url),
        remoteAddress: request.ip,
      }),
    },
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
      censor: "[redacted]",
    },
  };
}
