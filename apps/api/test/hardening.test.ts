import { randomBytes } from "node:crypto";
import { APP_ROLE, appRoleProblems, createDb } from "@soa/db";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { urlForLog } from "../src/logger";
import type { IdentityProvider } from "../src/providers/identity/types";
import { userScope } from "../src/repos/scope";
import { usersRepo } from "../src/repos/users";
import { testDatabaseUrl } from "./db-setup";
import { attemptSignIn, createUser, ownerQuery, resetDatabase, signIn, testApp } from "./helpers";

/* Regression tests for the milestone 1 security review. */

let app: FastifyInstance | undefined;
beforeEach(resetDatabase);
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const auditReasons = async () =>
  (
    await ownerQuery<{ meta: { reason?: string } }>(
      "SELECT meta FROM audit_log WHERE action = 'auth.refused' ORDER BY id",
    )
  ).map((row) => row.meta.reason);

describe("the guard reads the matched route, not the raw URL", () => {
  it("applies admin access to a percent-encoded path", async () => {
    await createUser("dana@soa.example");
    app = await testApp();
    const session = await signIn(app, "dana@soa.example");
    const encoded = await app.inject({ method: "GET", url: "/%61pi/admin/users", cookies: session.cookies });
    expect(encoded.statusCode).toBe(403);
  });

  it("rate limits a percent-encoded path like the plain one", async () => {
    app = await testApp({ ipRateLimitPerMinute: 5 });
    const statuses: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      statuses.push((await app.inject({ method: "GET", url: "/%61pi/auth/login" })).statusCode);
    }
    expect(statuses.slice(0, 5).every((status) => status === 302)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
  });

  it("limits floods of made-up session cookies by address", async () => {
    app = await testApp({ ipRateLimitPerMinute: 5 });
    const statuses: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      statuses.push(
        (await app.inject({ method: "GET", url: "/api/me", cookies: { sid: `x${String(index)}` } })).statusCode,
      );
    }
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });

  it("refuses to start when a route does not declare its access level", async () => {
    const { default: Fastify } = await import("fastify");
    const { registerRouteRegistry } = await import("../src/auth/plugin");
    const bare = Fastify();
    registerRouteRegistry(bare);
    expect(() => bare.get("/api/undeclared", () => "x")).toThrow(/must declare config.access/);
    await bare.close();
  });
});

describe("the application's database login", () => {
  it("as a dedicated login in crm_app, cannot change audit_log or become the owner", async () => {
    const login = `crm_app_test_${randomBytes(3).toString("hex")}`;
    const password = randomBytes(12).toString("hex");
    await ownerQuery(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE ${APP_ROLE}`);
    const url = new URL(testDatabaseUrl());
    url.username = login;
    url.password = password;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      await ownerQuery("INSERT INTO audit_log (action) VALUES ('test.seed')");
      await expect(client.query("INSERT INTO audit_log (action) VALUES ('test.insert')")).resolves.toBeDefined();
      await expect(client.query("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/permission denied/);
      await expect(client.query("DELETE FROM audit_log")).rejects.toThrow(/permission denied/);
      await expect(client.query(`SET ROLE ${new URL(testDatabaseUrl()).username}`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query("RESET ROLE; UPDATE audit_log SET action = 'x'")).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
    const handle = createDb(url.toString(), { role: APP_ROLE, max: 1 });
    expect(await appRoleProblems(handle.pool)).toEqual([]);
    await handle.close();
    await ownerQuery(`DROP ROLE ${login}`);
  });

  it("reports the owner login as unsafe, and production startup refuses it", async () => {
    const handle = createDb(testDatabaseUrl(), { role: APP_ROLE, max: 1 });
    const problems = await appRoleProblems(handle.pool);
    await handle.close();
    expect(problems).toContain("the login owns the schema");
    await expect(testApp({ enforceAppRoleLogin: true })).rejects.toThrow(
      /must be a login role that is a member of crm_app/,
    );
  });
});

describe("identity binding", () => {
  const identityWith = (subject: string, email: string): IdentityProvider => ({
    provider: "microsoft",
    authorizationUrl: (request) =>
      Promise.resolve(`http://localhost:5173/api/auth/callback?code=c&state=${request.state}`),
    exchangeCode: () =>
      Promise.resolve({
        subject,
        email,
        name: "Someone",
        tokens: { accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 3600_000), scopes: ["openid"] },
      }),
  });

  const signInWith = async (identity: IdentityProvider) => {
    const instance = await testApp({ identity });
    try {
      const login = await instance.inject({ method: "GET", url: "/api/auth/login" });
      const callback = new URL(String(login.headers.location));
      const result = await instance.inject({
        method: "GET",
        url: `${callback.pathname}${callback.search}`,
        cookies: { login_state: login.cookies.find((cookie) => cookie.name === "login_state")?.value ?? "" },
      });
      return String(result.headers.location);
    } finally {
      await instance.close();
    }
  };

  it("refuses a different identity that presents a bound user's email", async () => {
    await createUser("ceo@soa.example", "admin");
    expect(await signInWith(identityWith("oid-real", "ceo@soa.example"))).toBe("http://localhost:5173/");
    expect(await signInWith(identityWith("oid-impostor", "ceo@soa.example"))).toBe(
      "http://localhost:5173/login?error=not_allowed",
    );
    expect(await auditReasons()).toEqual(["identity_mismatch"]);
    expect(await ownerQuery("SELECT subject FROM oauth_accounts")).toEqual([{ subject: "oid-real" }]);
  });

  it("signs a bound identity in as its user even after its email changes", async () => {
    const user = await createUser("dana@soa.example");
    await signInWith(identityWith("oid-dana", "dana@soa.example"));
    expect(await signInWith(identityWith("oid-dana", "dana.renamed@soa.example"))).toBe("http://localhost:5173/");
    const [row] = await ownerQuery<{ user_id: string }>(
      "SELECT user_id FROM audit_log WHERE action = 'auth.login' ORDER BY id DESC LIMIT 1",
    );
    expect(row?.user_id).toBe(user.id);
  });

  it("creates the bootstrap admin only while no admin exists", async () => {
    await createUser("first.admin@soa.example", "admin");
    app = await testApp();
    const callback = await attemptSignIn(app, "admin@soa.example");
    expect(callback.headers.location).toBe("http://localhost:5173/login?error=not_allowed");
    expect(await auditReasons()).toEqual(["unknown_user"]);
  });

  it("ends the previous session when signing in again on the same browser", async () => {
    await createUser("dana@soa.example");
    app = await testApp();
    const first = await signIn(app, "dana@soa.example");
    const login = await app.inject({ method: "GET", url: "/api/auth/login", cookies: first.cookies });
    const location = new URL(String(login.headers.location));
    const form = new URLSearchParams(location.searchParams);
    form.set("other_email", "dana@soa.example");
    const idp = await app.inject({
      method: "POST",
      url: location.pathname,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form.toString(),
    });
    const callback = new URL(String(idp.headers.location));
    await app.inject({
      method: "GET",
      url: `${callback.pathname}${callback.search}`,
      cookies: {
        ...first.cookies,
        login_state: login.cookies.find((cookie) => cookie.name === "login_state")?.value ?? "",
      },
    });
    expect((await app.inject({ method: "GET", url: "/api/me", cookies: first.cookies })).statusCode).toBe(401);
    expect(await ownerQuery("SELECT 1 FROM sessions")).toHaveLength(1);
  });
});

describe("client address behind the load balancer", () => {
  it("in production, takes the address the load balancer saw, not one the client wrote", async () => {
    app = await testApp({
      env: {
        NODE_ENV: "production",
        FAKE_PROVIDERS: "false",
        PUBLIC_URL: "https://crm.soa.example",
        APP_URL: "https://crm.soa.example",
        OIDC_CLIENT_ID: "id",
        OIDC_CLIENT_SECRET: "secret",
        OIDC_TENANT_ID: "00000000-0000-4000-8000-000000000000",
        MAPS_PROVIDER: "google",
        MAPS_API_KEY: "k",
        ESIGN_PROVIDER: "dropbox_sign",
        ESIGN_API_KEY: "k",
        ESIGN_WEBHOOK_SECRET: "s",
        ESIGN_TEMPLATE_ID: "t",
      },
      enforceAppRoleLogin: false,
      identity: {
        provider: "microsoft",
        authorizationUrl: () => Promise.resolve("x"),
        exchangeCode: () => Promise.reject(new Error("x")),
      },
    });
    await app.inject({
      method: "GET",
      url: "/api/auth/callback?code=x&state=y",
      headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
    });
    expect(await ownerQuery("SELECT host(ip) AS ip FROM audit_log")).toEqual([{ ip: "203.0.113.9" }]);
  });
});

describe("log and repo safeguards", () => {
  it("drops query strings from sign-in and public token URLs in logs", () => {
    expect(urlForLog("/api/auth/callback?code=secret&state=s")).toBe("/api/auth/callback?[redacted]");
    expect(urlForLog("/u/token?x=1")).toBe("/u/[redacted]?[redacted]");
    expect(urlForLog("/u/ZGFuYUBoYXJib3IuZXhhbXBsZQ.sig")).toBe("/u/[redacted]");
    expect(urlForLog("/api/accounts?q=harbor")).toBe("/api/accounts?q=harbor");
  });

  it("repos refuse admin-only writes from an AE scope", async () => {
    const dana = await createUser("dana@soa.example");
    const handle = createDb(testDatabaseUrl(), { role: APP_ROLE, max: 1 });
    try {
      const repo = usersRepo(handle.db);
      const scope = userScope(dana.id, "ae");
      await expect(repo.insert(scope, { email: "x@soa.example", name: "X", role: "admin" })).rejects.toThrow(/may not/);
      await expect(repo.update(scope, dana.id, { role: "admin" })).rejects.toThrow(/may not/);
      await expect(repo.countActiveAdmins(scope)).rejects.toThrow(/may not/);
    } finally {
      await handle.close();
    }
  });
});
