import { APP_ROLE, createDb } from "@soa/db";
import { MeResponse } from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IdentityProvider } from "../src/providers/identity/types";
import { SESSION_IDLE_MS, SESSION_MAX_MS } from "../src/services/auth";
import { SECURITY_HEADERS } from "../src/security";
import { attemptSignIn, createUser, fakeClock, ownerQuery, resetDatabase, signIn, testApp } from "./helpers";
import { testDatabaseUrl } from "./db-setup";

let app: FastifyInstance | undefined;
beforeEach(resetDatabase);
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const auditActions = async () =>
  (
    await ownerQuery<{ action: string; meta: { reason?: string } }>("SELECT action, meta FROM audit_log ORDER BY id")
  ).map((row) => (row.meta.reason === undefined ? row.action : `${row.action}:${row.meta.reason}`));

describe("sign-in with the fake identity provider", () => {
  it("signs in an active user in the allowed domain and starts a session", async () => {
    const user = await createUser("dana.ae@soa.example");
    app = await testApp();
    const session = await signIn(app, "Dana.AE@soa.example");
    expect(session.callback.headers.location).toBe("http://localhost:5173/");

    const me = await app.inject({ method: "GET", url: "/api/me", cookies: session.cookies });
    expect(me.statusCode).toBe(200);
    const body = MeResponse.parse(me.json());
    expect(body.user.id).toBe(user.id);
    expect(body.mail).toEqual({ provider: "microsoft", connected: true, needsReconnect: false });
    expect(body.csrfToken).toBe(session.csrf);
    expect(await auditActions()).toEqual(["auth.login"]);
  });

  it.each([
    ["a user who is not in users", "nobody@soa.example", "unknown_user"],
    ["an inactive user", "former@soa.example", "inactive"],
    ["an address in another domain", "dana@other.example", "domain"],
  ])("refuses %s", async (_label, email, reason) => {
    await createUser("former@soa.example", "ae", { active: false });
    await createUser("dana@soa.example");
    app = await testApp();
    const callback = await attemptSignIn(app, email);
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("http://localhost:5173/login?error=not_allowed");
    expect(callback.cookies.find((cookie) => cookie.name === "sid")).toBeUndefined();
    expect(await ownerQuery("SELECT 1 FROM sessions")).toHaveLength(0);
    expect(await auditActions()).toEqual([`auth.refused:${reason}`]);
  });

  it("creates the first admin from BOOTSTRAP_ADMIN_EMAIL", async () => {
    app = await testApp();
    const session = await signIn(app, "admin@soa.example");
    const me = MeResponse.parse((await app.inject({ method: "GET", url: "/api/me", cookies: session.cookies })).json());
    expect(me.user.role).toBe("admin");
    expect(await auditActions()).toEqual(["user.create", "auth.login"]);
  });

  it("rejects a callback whose state does not match the login cookie", async () => {
    await createUser("dana@soa.example");
    app = await testApp();
    const login = await app.inject({ method: "GET", url: "/api/auth/login" });
    const callback = await app.inject({
      method: "GET",
      url: "/api/auth/callback?code=forged&state=forged",
      cookies: { login_state: login.cookies.find((cookie) => cookie.name === "login_state")?.value ?? "" },
    });
    expect(callback.headers.location).toBe("http://localhost:5173/login?error=expired");
    expect(await auditActions()).toEqual(["auth.refused:invalid_state"]);
  });
});

describe("sessions", () => {
  it("sets an HttpOnly, Secure, SameSite=Lax cookie and stores only its hash", async () => {
    await createUser("dana@soa.example");
    app = await testApp();
    const session = await signIn(app, "dana@soa.example");
    const cookie = session.callback.cookies.find((entry) => entry.name === "sid");
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });

    const rows = await ownerQuery<{ id_hash: string }>("SELECT id_hash FROM sessions");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id_hash).not.toBe(session.sid);
    expect(rows[0]?.id_hash).toMatch(/^[0-9a-f]{64}$/);
    const raw = JSON.stringify(await ownerQuery("SELECT * FROM sessions"));
    expect(raw).not.toContain(session.sid);
  });

  it("expires after 12 hours idle (fake clock)", async () => {
    await createUser("dana@soa.example");
    const time = fakeClock();
    app = await testApp({ clock: time.clock });
    const session = await signIn(app, "dana@soa.example");

    time.advance(SESSION_IDLE_MS - 60_000);
    expect((await app.inject({ method: "GET", url: "/api/me", cookies: session.cookies })).statusCode).toBe(200);

    time.advance(SESSION_IDLE_MS - 60_000); // still active: the last request reset the idle timer
    expect((await app.inject({ method: "GET", url: "/api/me", cookies: session.cookies })).statusCode).toBe(200);

    time.advance(SESSION_IDLE_MS + 1);
    const expired = await app.inject({ method: "GET", url: "/api/me", cookies: session.cookies });
    expect(expired.statusCode).toBe(401);
    expect(await ownerQuery("SELECT 1 FROM sessions")).toHaveLength(0);
  });

  it("expires after 7 days even when in use", async () => {
    await createUser("dana@soa.example");
    const time = fakeClock();
    app = await testApp({ clock: time.clock });
    const session = await signIn(app, "dana@soa.example");
    for (let elapsed = 0; elapsed < SESSION_MAX_MS - 6 * 3600_000; elapsed += 6 * 3600_000) {
      time.advance(6 * 3600_000);
      expect((await app.inject({ method: "GET", url: "/api/me", cookies: session.cookies })).statusCode).toBe(200);
    }
    time.advance(6 * 3600_000);
    expect((await app.inject({ method: "GET", url: "/api/me", cookies: session.cookies })).statusCode).toBe(401);
  });

  it("ends the session for a user who is deactivated", async () => {
    const user = await createUser("dana@soa.example");
    app = await testApp();
    const session = await signIn(app, "dana@soa.example");
    await ownerQuery("UPDATE users SET active = false WHERE id = $1", [user.id]);
    expect((await app.inject({ method: "GET", url: "/api/me", cookies: session.cookies })).statusCode).toBe(401);
  });

  it("signs out: deletes the session row, clears cookies, audits", async () => {
    await createUser("dana@soa.example");
    app = await testApp();
    const session = await signIn(app, "dana@soa.example");
    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      cookies: session.cookies,
      headers: session.headers,
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.cookies.find((cookie) => cookie.name === "sid")?.value).toBe("");
    expect(await ownerQuery("SELECT 1 FROM sessions")).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/api/me", cookies: session.cookies })).statusCode).toBe(401);
    expect(await auditActions()).toEqual(["auth.login", "auth.logout"]);
  });
});

describe("CSRF", () => {
  it("rejects a POST without the CSRF header, or with a wrong one", async () => {
    await createUser("dana@soa.example");
    app = await testApp();
    const session = await signIn(app, "dana@soa.example");
    for (const headers of [{}, { "x-csrf-token": "wrong" }]) {
      const response = await app.inject({ method: "POST", url: "/api/auth/logout", cookies: session.cookies, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "csrf_failed" } });
    }
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/me",
      cookies: session.cookies,
      payload: { name: "Dana Whit" },
    });
    expect(patch.statusCode).toBe(403);
    expect(await ownerQuery("SELECT 1 FROM sessions")).toHaveLength(1);
  });

  it("does not accept another session's token", async () => {
    await createUser("dana@soa.example");
    await createUser("eli@soa.example");
    app = await testApp();
    const dana = await signIn(app, "dana@soa.example");
    const eli = await signIn(app, "eli@soa.example");
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      cookies: dana.cookies,
      headers: eli.headers,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("OAuth tokens at rest", () => {
  it("stores tokens encrypted: the raw columns never contain the token text", async () => {
    const accessToken = "eyJ-PLAINTEXT-ACCESS-TOKEN-0123456789";
    const refreshToken = "PLAINTEXT-REFRESH-TOKEN-9876543210";
    const identity: IdentityProvider = {
      provider: "microsoft",
      authorizationUrl: (request) =>
        Promise.resolve(`http://localhost:5173/api/auth/callback?code=c&state=${request.state}`),
      exchangeCode: () =>
        Promise.resolve({
          subject: "subject-1",
          email: "dana@soa.example",
          name: "Dana",
          tokens: { accessToken, refreshToken, expiresAt: new Date(Date.now() + 3600_000), scopes: ["openid"] },
        }),
    };
    await createUser("dana@soa.example");
    app = await testApp({ identity });
    const login = await app.inject({ method: "GET", url: "/api/auth/login" });
    const callback = new URL(String(login.headers.location));
    const result = await app.inject({
      method: "GET",
      url: `${callback.pathname}${callback.search}`,
      cookies: { login_state: login.cookies.find((cookie) => cookie.name === "login_state")?.value ?? "" },
    });
    expect(result.headers.location).toBe("http://localhost:5173/");

    const rows = await ownerQuery<{ access_token_enc: Buffer; refresh_token_enc: Buffer }>(
      "SELECT access_token_enc, refresh_token_enc FROM oauth_accounts",
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("no row");
    for (const column of [row.access_token_enc, row.refresh_token_enc]) {
      for (const encoding of ["utf8", "latin1", "base64", "hex"] as const) {
        expect(column.toString(encoding)).not.toContain(accessToken);
        expect(column.toString(encoding)).not.toContain(refreshToken);
      }
    }
    expect(row.access_token_enc.includes(Buffer.from(accessToken))).toBe(false);
  });
});

describe("audit_log", () => {
  it("is append-only for the application database role", async () => {
    await ownerQuery("INSERT INTO audit_log (action) VALUES ('test.seed')");
    const appDb = createDb(testDatabaseUrl(), { role: APP_ROLE, max: 1 });
    try {
      const [role] = (await appDb.pool.query<{ current_user: string }>("SELECT current_user")).rows;
      expect(role?.current_user).toBe(APP_ROLE);
      await expect(appDb.pool.query("INSERT INTO audit_log (action) VALUES ('test.insert')")).resolves.toBeDefined();
      await expect(appDb.pool.query("SELECT count(*) FROM audit_log")).resolves.toBeDefined();
      await expect(appDb.pool.query("UPDATE audit_log SET action = 'tampered'")).rejects.toThrow(/permission denied/);
      await expect(appDb.pool.query("DELETE FROM audit_log")).rejects.toThrow(/permission denied/);
      await expect(appDb.pool.query("TRUNCATE audit_log")).rejects.toThrow(/permission denied/);
    } finally {
      await appDb.close();
    }
  });
});

describe("security headers and rate limits", () => {
  it("sends the security headers on every response", async () => {
    app = await testApp();
    for (const url of ["/healthz", "/api/me", "/api/auth/login"]) {
      const response = await app.inject({ method: "GET", url });
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers[name]).toBe(value);
    }
    const csp = SECURITY_HEADERS["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("limits /api requests per session", async () => {
    await createUser("dana@soa.example");
    // A fixed clock: the one-minute window can't roll over between the requests.
    app = await testApp({ rateLimitPerMinute: 8, clock: fakeClock().clock });
    const session = await signIn(app, "dana@soa.example");
    const statuses: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      statuses.push((await app.inject({ method: "GET", url: "/api/me", cookies: session.cookies })).statusCode);
    }
    expect(statuses).toEqual(Array.from({ length: 8 }, () => 200));
    const limited = await app.inject({ method: "GET", url: "/api/me", cookies: session.cookies });
    expect(limited.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});

describe("concurrent first sign-in", () => {
  it("creates the bootstrap admin once when two sign-ins race", async () => {
    app = await testApp();
    const results = await Promise.all([
      attemptSignIn(app, "admin@soa.example"),
      attemptSignIn(app, "admin@soa.example"),
    ]);
    expect(results.map((result) => result.headers.location)).toEqual([
      "http://localhost:5173/",
      "http://localhost:5173/",
    ]);
    expect(await ownerQuery("SELECT 1 FROM users WHERE email = 'admin@soa.example'")).toHaveLength(1);
    expect((await auditActions()).filter((action) => action === "user.create")).toHaveLength(1);
  });
});
