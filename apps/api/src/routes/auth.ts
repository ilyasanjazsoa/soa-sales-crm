import type { Env } from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { clearSessionCookies, sessionOf, setSessionCookies } from "../auth/plugin";
import { SESSION_MAX_MS, type AuthService } from "../services/auth";

const STATE_COOKIE = "login_state";
const stateCookieOptions = { path: "/api/auth", httpOnly: true, secure: true, sameSite: "lax", maxAge: 600 } as const;

export function registerAuthRoutes(app: FastifyInstance, deps: { auth: AuthService; config: Env }): void {
  const { auth, config } = deps;
  const loginPage = (error: string) => new URL(`/login?error=${error}`, config.APP_URL).toString();

  app.get("/api/auth/login", { config: { access: "public" } }, async (_request, reply) => {
    const { url, stateCookie } = await auth.beginLogin();
    void reply.setCookie(STATE_COOKIE, stateCookie, stateCookieOptions);
    return reply.redirect(url);
  });

  app.get("/api/auth/callback", { config: { access: "public" } }, async (request, reply) => {
    const result = await auth.completeLogin({
      callbackUrl: new URL(request.url, config.APP_URL),
      stateCookie: request.cookies[STATE_COOKIE],
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
    });
    void reply.clearCookie(STATE_COOKIE, stateCookieOptions);
    if (!result.ok) return reply.redirect(loginPage(result.reason === "invalid_state" ? "expired" : "not_allowed"));
    setSessionCookies(reply, result.sessionToken, result.csrfToken, SESSION_MAX_MS / 1000);
    return reply.redirect(new URL("/", config.APP_URL).toString());
  });

  app.post("/api/auth/logout", { config: { access: "session" } }, async (request, reply) => {
    await auth.logout(sessionOf(request), request.ip);
    clearSessionCookies(reply);
    return reply.code(204).send();
  });
}
