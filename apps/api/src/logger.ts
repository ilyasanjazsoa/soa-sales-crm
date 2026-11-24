import type { Env } from "@soa/shared";
import type { FastifyServerOptions } from "fastify";

/* Structured JSON logs. Never log tokens, cookies, email bodies or prompt contents (CLAUDE.md rule 8).
   Query strings are dropped from sign-in URLs (they carry one-time codes) and from public token routes. */

const SENSITIVE_QUERY = /^\/(api\/auth|p|u|webhooks)\//;

/** Public token routes carry the token (an encoded email address) in the path. */
const TOKEN_PATH = /^\/(u|p)\/[^/?]+/;

export function urlForLog(url: string): string {
  const [rawPath = "", query] = url.split("?", 2);
  const path = rawPath.replace(TOKEN_PATH, (_match, prefix: string) => `/${prefix}/[redacted]`);
  if (query !== undefined && SENSITIVE_QUERY.test(rawPath)) return `${path}?[redacted]`;
  return query === undefined ? path : `${path}?${query}`;
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
