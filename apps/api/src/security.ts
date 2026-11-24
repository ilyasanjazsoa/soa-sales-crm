import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { sha256Hex } from "./auth/crypto";
import { SESSION_COOKIE } from "./auth/plugin";

/* Security headers and rate limits (ARCHITECTURE.md §15). */

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) void reply.header(name, value);
  });
}

/** 300 requests a minute per session on /api (per IP before sign-in). Public routes get their own limit later. */
export async function registerRateLimits(app: FastifyInstance, options: { apiPerMinute?: number } = {}): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: options.apiPerMinute ?? 300,
    timeWindow: "1 minute",
    allowList: (request) => !request.url.startsWith("/api/"),
    keyGenerator: (request) => {
      const token = request.cookies[SESSION_COOKIE];
      return token === undefined ? `ip:${request.ip}` : `session:${sha256Hex(token)}`;
    },
  });
}
