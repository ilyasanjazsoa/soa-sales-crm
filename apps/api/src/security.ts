import type { FastifyInstance } from "fastify";
import type { Clock } from "./clock";
import { HttpError } from "./errors";

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
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      // A server-rendered public page (/u/:token, /p/:token) may set its own value: the same policy plus a style hash,
      // or a PDF that only its own page may frame.
      if (reply.hasHeader(name)) continue;
      void reply.header(name, value);
    }
  });
}

export const rateLimited = () => new HttpError(429, "rate_limited", "Too many requests. Try again shortly.");

/** Fixed one-minute windows, in memory. Each api task counts on its own (two tasks in production). */
export class RateLimiter {
  private window = 0;
  private counts = new Map<string, number>();

  constructor(
    private readonly perMinute: number,
    private readonly clock: Clock,
  ) {}

  /** Counts a request; false when the key is over its limit for this minute. */
  hit(key: string): boolean {
    const window = Math.floor(this.clock().getTime() / 60_000);
    if (window !== this.window) {
      this.window = window;
      this.counts = new Map();
    }
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next <= this.perMinute;
  }
}
