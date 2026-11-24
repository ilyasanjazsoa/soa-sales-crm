import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { forbidden, HttpError, unauthorized } from "../errors";
import { rateLimited, type RateLimiter } from "../security";
import type { AuthService, ResolvedSession } from "../services/auth";
import { safeEqual } from "./crypto";

/* Session, CSRF, role and rate-limit enforcement. Every route must declare `config.access`:
   public (no session), session (any signed-in user), manager (manager or admin), admin.
   The guard reads the matched route, never the raw URL, so encoded paths can't skip it. */

export type Access = "public" | "session" | "manager" | "admin";

export interface RouteEntry {
  method: string;
  url: string;
  access: Access;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: ResolvedSession | null;
  }
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyInstance {
    /** Every registered route with its access level; read by the route authorization test. */
    routeRegistry: RouteEntry[];
  }
}

export const SESSION_COOKIE = "sid";
export const CSRF_COOKIE = "csrf";
export const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Must be registered before any route. A route without an access level fails app startup. */
export function registerRouteRegistry(app: FastifyInstance): void {
  const registry: RouteEntry[] = [];
  app.decorate("routeRegistry", registry);
  app.addHook("onRoute", (route) => {
    const access = route.config?.access;
    if (access === undefined) throw new Error(`Route ${route.url} must declare config.access`);
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === "HEAD") continue;
      registry.push({ method, url: route.url, access });
    }
  });
}

export function registerAuthGuard(
  app: FastifyInstance,
  deps: { auth: AuthService; ipLimiter: RateLimiter; sessionLimiter: RateLimiter },
): void {
  const { auth, ipLimiter, sessionLimiter } = deps;
  app.decorateRequest("auth", null);
  app.addHook("preHandler", async (request) => {
    // No matched route (404): nothing to protect.
    if (request.routeOptions.url === undefined) return;
    const access = request.routeOptions.config.access;
    if (access === undefined) throw new Error("route without access level");

    // Per address, before any database work, so floods of invalid cookies are limited too.
    if (!ipLimiter.hit(`ip:${request.ip}`)) throw rateLimited();
    if (access === "public") return;

    const token = request.cookies[SESSION_COOKIE];
    const session = token === undefined ? undefined : await auth.resolveSession(token);
    if (session === undefined) throw unauthorized();
    if (!sessionLimiter.hit(session.idHash)) throw rateLimited();

    if (!SAFE_METHODS.has(request.method)) {
      const header = request.headers[CSRF_HEADER];
      if (typeof header !== "string" || !safeEqual(header, auth.csrfFor(session.idHash))) {
        throw new HttpError(403, "csrf_failed", "Your session check failed. Reload the page and try again.");
      }
    }
    if (access === "admin" && session.user.role !== "admin") throw forbidden();
    if (access === "manager" && session.user.role === "ae") throw forbidden();
    request.auth = session;
  });
}

/** The signed-in session for a non-public route. */
export function sessionOf(request: FastifyRequest): ResolvedSession {
  if (request.auth === null) throw unauthorized();
  return request.auth;
}

const cookieBase = { path: "/", httpOnly: true, secure: true, sameSite: "lax" } as const;

export function setSessionCookies(reply: FastifyReply, sessionToken: string, csrfToken: string, maxAgeSeconds: number) {
  void reply.setCookie(SESSION_COOKIE, sessionToken, { ...cookieBase, maxAge: maxAgeSeconds });
  void reply.setCookie(CSRF_COOKIE, csrfToken, { ...cookieBase, httpOnly: false, maxAge: maxAgeSeconds });
}

export function clearSessionCookies(reply: FastifyReply) {
  void reply.clearCookie(SESSION_COOKIE, cookieBase);
  void reply.clearCookie(CSRF_COOKIE, { ...cookieBase, httpOnly: false });
}
