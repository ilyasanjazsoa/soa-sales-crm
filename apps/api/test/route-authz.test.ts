import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Access } from "../src/auth/plugin";
import { createAccount, createUser, resetDatabase, signIn, testApp, type SignedIn, type TestUser } from "./helpers";

/* ARCHITECTURE.md §4 required test. Every registered /api route must appear in ROUTES. For each non-public route:
   without a session it returns 401, and called by a second AE against the first AE's data it returns 404, 403, or
   only the caller's own data. Adding a route without adding it here fails this test. */

interface Context {
  ae1: TestUser;
  ae2: TestUser;
  ae1AccountId: string;
}

interface RouteCase {
  access: Access;
  /** Concrete URL, with the first AE's ids filled in. */
  path: (ctx: Context) => string;
  body?: (ctx: Context) => unknown;
  /** Called with the second AE's response; must prove nothing of the first AE's is returned or changed. */
  asOtherAe?: (response: LightMyRequestResponse, ctx: Context) => void;
}

const expectForbidden = (response: LightMyRequestResponse) => {
  expect(response.statusCode).toBe(403);
};

/** A successful response that contains nothing of the first AE's: user, account id or account name. */
const expectNothingOf = (response: LightMyRequestResponse, ctx: Context) => {
  expect(response.statusCode).toBeLessThan(300);
  for (const secret of [ctx.ae1.id, ctx.ae1.email, ctx.ae1AccountId, AE1_ACCOUNT_NAME]) {
    expect(response.body).not.toContain(secret);
  }
};

const AE1_ACCOUNT_NAME = "First AE Logistics Park";

/* Changing either list needs a security review: these are the only routes reachable without a session. */
const PUBLIC_ROUTES = new Set([
  "GET /healthz",
  "GET /readyz",
  "GET /api/auth/login",
  "GET /api/auth/callback",
  "GET /api/auth/fake-idp",
  "POST /api/auth/fake-idp",
]);
const NON_API_ROUTES = new Set(["GET /healthz", "GET /readyz"]);

const ROUTES: Record<string, RouteCase> = {
  "GET /healthz": { access: "public", path: () => "/healthz" },
  "GET /readyz": { access: "public", path: () => "/readyz" },
  "GET /api/auth/login": { access: "public", path: () => "/api/auth/login" },
  "GET /api/auth/callback": { access: "public", path: () => "/api/auth/callback" },
  "GET /api/auth/fake-idp": { access: "public", path: () => "/api/auth/fake-idp" },
  "POST /api/auth/fake-idp": { access: "public", path: () => "/api/auth/fake-idp" },
  "POST /api/auth/logout": {
    access: "session",
    path: () => "/api/auth/logout",
    asOtherAe: (response) => {
      expect(response.statusCode).toBe(204); // ends only the caller's own session (checked below)
    },
  },
  "GET /api/me": { access: "session", path: () => "/api/me", asOtherAe: expectNothingOf },
  "PATCH /api/me": {
    access: "session",
    path: () => "/api/me",
    body: () => ({ title: "Account Executive" }),
    asOtherAe: expectNothingOf,
  },
  "GET /api/admin/users": { access: "admin", path: () => "/api/admin/users", asOtherAe: expectForbidden },
  "POST /api/admin/users": {
    access: "admin",
    path: () => "/api/admin/users",
    body: () => ({ email: "new@soa.example", name: "New" }),
    asOtherAe: expectForbidden,
  },
  "PATCH /api/admin/users/:id": {
    access: "admin",
    path: (ctx) => `/api/admin/users/${ctx.ae1.id}`,
    body: () => ({ active: false }),
    asOtherAe: expectForbidden,
  },
  "GET /api/admin/audit": { access: "admin", path: () => "/api/admin/audit", asOtherAe: expectForbidden },
};

const keyOf = (method: string, url: string) => `${method} ${url}`;

describe("route authorization (every /api route)", () => {
  let app: FastifyInstance;
  let ctx: Context;
  let ae1Session: SignedIn;
  let ae2Session: SignedIn;

  beforeAll(async () => {
    await resetDatabase();
    const ae1 = await createUser("first.ae@soa.example");
    const ae2 = await createUser("second.ae@soa.example");
    ctx = { ae1, ae2, ae1AccountId: await createAccount(AE1_ACCOUNT_NAME, ae1.id) };
    app = await testApp();
    ae1Session = await signIn(app, ae1.email);
    ae2Session = await signIn(app, ae2.email);
  });

  afterAll(async () => {
    await app.close();
  });

  it("covers every registered route, and nothing else", () => {
    const registered = app.routeRegistry;
    const registeredKeys = registered.map((route) => keyOf(route.method, route.url)).sort();
    expect(registeredKeys).toEqual(Object.keys(ROUTES).sort());
    for (const route of registered) {
      const key = keyOf(route.method, route.url);
      expect(route.access, key).toBe(ROUTES[key]?.access);
      if (!route.url.startsWith("/api/")) expect(NON_API_ROUTES.has(key), `${key} is outside /api`).toBe(true);
      if (route.access === "public") expect(PUBLIC_ROUTES.has(key), `${key} is public but not allow-listed`).toBe(true);
    }
  });

  it("requires a session on every non-public route", async () => {
    for (const [key, route] of Object.entries(ROUTES)) {
      if (route.access === "public") continue;
      const [method] = key.split(" ");
      const response = await app.inject({
        method: method as "GET",
        url: route.path(ctx),
        ...(route.body === undefined ? {} : { payload: route.body(ctx) as object }),
      });
      expect(response.statusCode, key).toBe(401);
    }
  });

  it("never shows or changes the first AE's data to a second AE", async () => {
    const entries = Object.entries(ROUTES).filter(([, route]) => route.access !== "public");
    // Sign-out last so the second AE's session lasts for the other routes.
    entries.sort(([a], [b]) => Number(a.endsWith("/logout")) - Number(b.endsWith("/logout")));
    for (const [key, route] of entries) {
      const [method] = key.split(" ");
      const response = await app.inject({
        method: method as "GET",
        url: route.path(ctx),
        cookies: ae2Session.cookies,
        headers: ae2Session.headers,
        ...(route.body === undefined ? {} : { payload: route.body(ctx) as object }),
      });
      expect(route.asOtherAe, `${key} needs an asOtherAe check`).toBeDefined();
      route.asOtherAe?.(response, ctx);
    }
    // The first AE is untouched: still signed in and still active.
    const me = await app.inject({ method: "GET", url: "/api/me", cookies: ae1Session.cookies });
    expect(me.statusCode).toBe(200);
  });
});
