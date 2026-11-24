import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Access } from "../src/auth/plugin";
import {
  createAccount,
  createUser,
  ownerQuery,
  resetDatabase,
  signIn,
  testApp,
  type SignedIn,
  type TestUser,
} from "./helpers";

/* ARCHITECTURE.md §4 required test. Every registered /api route must appear in ROUTES. For each non-public route:
   without a session it returns 401, and called by a second AE against the first AE's data it returns 404, 403, or
   only the caller's own data. Adding a route without adding it here fails this test. */

interface Context {
  ae1: TestUser;
  ae2: TestUser;
  ae1AccountId: string;
  ae1ContactId: string;
  ae1SignalId: string;
  ae1DealId: string;
  ae1TaskId: string;
  ae1ImportId: string;
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
  for (const secret of [
    ctx.ae1.id,
    ctx.ae1.email,
    ctx.ae1AccountId,
    AE1_ACCOUNT_NAME,
    ctx.ae1ContactId,
    ctx.ae1DealId,
    ctx.ae1TaskId,
    AE1_TASK_TITLE,
    String(AE1_DEAL_CENTS),
  ]) {
    expect(response.body).not.toContain(secret);
  }
};

const AE1_ACCOUNT_NAME = "First AE Logistics Park";
const AE1_TASK_TITLE = "Call the first AE's prospect";
const AE1_DEAL_CENTS = 98_765_432;

const expectNotFound = (response: LightMyRequestResponse) => {
  expect(response.statusCode).toBe(404);
};

/** Any non-server-error response that reveals nothing (e.g. a rejected upload). */
const expectNoLeak = (response: LightMyRequestResponse, ctx: Context) => {
  expect(response.statusCode).toBeLessThan(500);
  expect(response.body).not.toContain(ctx.ae1AccountId);
  expect(response.body).not.toContain(AE1_ACCOUNT_NAME);
};

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
  "GET /api/users": { access: "manager", path: () => "/api/users", asOtherAe: expectForbidden },
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

  // ───────── accounts ─────────
  "GET /api/accounts": {
    access: "session",
    path: () => "/api/accounts?owner=all&limit=100",
    asOtherAe: expectNothingOf,
  },
  "POST /api/accounts": {
    access: "session",
    path: () => "/api/accounts",
    body: () => ({ name: "Second AE Storage", propertyType: "Self storage", city: "Plano" }),
    asOtherAe: expectNothingOf,
  },
  "GET /api/accounts/:id": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}`,
    asOtherAe: expectNotFound,
  },
  "PATCH /api/accounts/:id": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}`,
    body: () => ({ name: "Taken over" }),
    asOtherAe: expectNotFound,
  },
  "POST /api/accounts/:id/claim": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}/claim`,
    asOtherAe: expectNotFound,
  },
  "POST /api/accounts/:id/assign": {
    access: "manager",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}/assign`,
    body: (ctx) => ({ ownerUserId: ctx.ae2.id }),
    asOtherAe: expectForbidden,
  },
  "DELETE /api/accounts/:id": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}`,
    asOtherAe: expectNotFound,
  },
  "POST /api/accounts/:id/contacts": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}/contacts`,
    body: () => ({ firstName: "Intruder" }),
    asOtherAe: expectNotFound,
  },
  "PATCH /api/contacts/:id": {
    access: "session",
    path: (ctx) => `/api/contacts/${ctx.ae1ContactId}`,
    body: () => ({ firstName: "Changed" }),
    asOtherAe: expectNotFound,
  },
  "DELETE /api/contacts/:id": {
    access: "session",
    path: (ctx) => `/api/contacts/${ctx.ae1ContactId}`,
    asOtherAe: expectNotFound,
  },
  "POST /api/contacts/:id/erase": {
    access: "manager",
    path: (ctx) => `/api/contacts/${ctx.ae1ContactId}/erase`,
    asOtherAe: expectForbidden,
  },
  "GET /api/accounts/:id/signals": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}/signals`,
    asOtherAe: expectNotFound,
  },
  "POST /api/accounts/:id/signals": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}/signals`,
    body: () => ({ text: "Injected" }),
    asOtherAe: expectNotFound,
  },
  "PATCH /api/signals/:id": {
    access: "session",
    path: (ctx) => `/api/signals/${ctx.ae1SignalId}`,
    body: () => ({ confirmed: true }),
    asOtherAe: expectNotFound,
  },
  "DELETE /api/signals/:id": {
    access: "session",
    path: (ctx) => `/api/signals/${ctx.ae1SignalId}`,
    asOtherAe: expectNotFound,
  },
  "GET /api/accounts/:id/timeline": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}/timeline`,
    asOtherAe: expectNotFound,
  },
  "POST /api/accounts/:id/notes": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}/notes`,
    body: () => ({ text: "Planted note" }),
    asOtherAe: expectNotFound,
  },

  // ───────── deals ─────────
  "GET /api/deals": { access: "session", path: () => "/api/deals?owner=all&limit=100", asOtherAe: expectNothingOf },
  "POST /api/accounts/:id/deals": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}/deals`,
    body: () => ({}),
    asOtherAe: expectNotFound,
  },
  "PATCH /api/deals/:id": {
    access: "session",
    path: (ctx) => `/api/deals/${ctx.ae1DealId}`,
    body: () => ({ name: "Hijacked" }),
    asOtherAe: expectNotFound,
  },
  "POST /api/deals/:id/stage": {
    access: "session",
    path: (ctx) => `/api/deals/${ctx.ae1DealId}/stage`,
    body: () => ({ stage: "contacted" }),
    asOtherAe: expectNotFound,
  },
  "POST /api/deals/:id/lose": {
    access: "session",
    path: (ctx) => `/api/deals/${ctx.ae1DealId}/lose`,
    body: () => ({ reason: "Price" }),
    asOtherAe: expectNotFound,
  },
  "POST /api/deals/:id/reopen": {
    access: "manager",
    path: (ctx) => `/api/deals/${ctx.ae1DealId}/reopen`,
    asOtherAe: expectForbidden,
  },
  "GET /api/forecast": { access: "session", path: () => "/api/forecast?owner=all", asOtherAe: expectNothingOf },

  // ───────── tasks ─────────
  "GET /api/tasks": { access: "session", path: () => "/api/tasks", asOtherAe: expectNothingOf },
  "POST /api/tasks": {
    access: "session",
    path: () => "/api/tasks",
    body: (ctx) => ({ title: "Sneaky", accountId: ctx.ae1AccountId }),
    asOtherAe: expectNotFound,
  },
  "PATCH /api/tasks/:id": {
    access: "session",
    path: (ctx) => `/api/tasks/${ctx.ae1TaskId}`,
    body: () => ({ done: true }),
    asOtherAe: expectNotFound,
  },

  // ───────── research ─────────
  "GET /api/accounts/:id/sources": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}/sources`,
    asOtherAe: expectNotFound,
  },
  "POST /api/accounts/:id/sources": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}/sources`,
    body: () => ({ text: "Planted source text" }),
    asOtherAe: expectNotFound,
  },
  "POST /api/accounts/:id/research/fetch": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}/research/fetch`,
    asOtherAe: expectNotFound,
  },
  "POST /api/accounts/:id/brief": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}/brief`,
    asOtherAe: expectNotFound,
  },
  "GET /api/accounts/:id/brief": {
    access: "session",
    path: (ctx) => `/api/accounts/${ctx.ae1AccountId}/brief`,
    asOtherAe: expectNotFound,
  },
  "GET /api/admin/references": { access: "manager", path: () => "/api/admin/references", asOtherAe: expectForbidden },
  "POST /api/admin/references": {
    access: "manager",
    path: () => "/api/admin/references",
    body: () => ({ labelNamed: "X Corp", labelAnonymized: "a client in Dallas", propertyTypes: ["Industrial"] }),
    asOtherAe: expectForbidden,
  },
  "PATCH /api/admin/references/:id": {
    access: "manager",
    path: (ctx) => `/api/admin/references/${ctx.ae1AccountId}`,
    body: () => ({ namedPermission: true }),
    asOtherAe: expectForbidden,
  },

  // ───────── imports and export ─────────
  "POST /api/imports": { access: "session", path: () => "/api/imports", asOtherAe: expectNoLeak },
  "POST /api/imports/:id/preview": {
    access: "session",
    path: (ctx) => `/api/imports/${ctx.ae1ImportId}/preview`,
    body: () => ({ columnMap: { "0": "account_name" } }),
    asOtherAe: expectNotFound,
  },
  "POST /api/imports/:id/run": {
    access: "session",
    path: (ctx) => `/api/imports/${ctx.ae1ImportId}/run`,
    asOtherAe: expectNotFound,
  },
  "GET /api/imports/:id": {
    access: "session",
    path: (ctx) => `/api/imports/${ctx.ae1ImportId}`,
    asOtherAe: expectNotFound,
  },
  "GET /api/export/accounts.csv": {
    access: "manager",
    path: () => "/api/export/accounts.csv",
    asOtherAe: expectForbidden,
  },
  "GET /api/export/deals.csv": { access: "manager", path: () => "/api/export/deals.csv", asOtherAe: expectForbidden },
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
    const accountId = await createAccount(AE1_ACCOUNT_NAME, ae1.id);
    const one = async (sql: string, values: unknown[]) => {
      const [row] = await ownerQuery<{ id: string }>(sql, values);
      if (row === undefined) throw new Error("fixture not created");
      return row.id;
    };
    ctx = {
      ae1,
      ae2,
      ae1AccountId: accountId,
      ae1ContactId: await one(
        "INSERT INTO contacts (account_id, first_name, email, is_primary) VALUES ($1, 'Pat', 'pat@first.example', true) RETURNING id",
        [accountId],
      ),
      ae1SignalId: await one(
        "INSERT INTO signals (account_id, text, kind) VALUES ($1, 'Gate broken', 'incident') RETURNING id",
        [accountId],
      ),
      ae1DealId: await one(
        "INSERT INTO deals (account_id, owner_user_id, name, annual_value_cents) VALUES ($1, $2, 'First deal', $3) RETURNING id",
        [accountId, ae1.id, AE1_DEAL_CENTS],
      ),
      ae1TaskId: await one("INSERT INTO tasks (owner_user_id, account_id, title) VALUES ($1, $2, $3) RETURNING id", [
        ae1.id,
        accountId,
        AE1_TASK_TITLE,
      ]),
      ae1ImportId: await one(
        "INSERT INTO imports (user_id, filename, object_key) VALUES ($1, 'first.csv', 'imports/first.csv') RETURNING id",
        [ae1.id],
      ),
    };
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
      try {
        route.asOtherAe?.(response, ctx);
      } catch (error) {
        throw new Error(`${key} → ${String(response.statusCode)} ${response.body.slice(0, 200)}`, { cause: error });
      }
    }
    // Filters pointed at the first AE's data return nothing of it (a fresh session: the loop ended with sign-out).
    const again = await signIn(app, ctx.ae2.email);
    for (const url of [
      `/api/accounts?owner=${ctx.ae1.id}`,
      `/api/deals?owner=${ctx.ae1.id}`,
      `/api/forecast?owner=${ctx.ae1.id}`,
      `/api/tasks?accountId=${ctx.ae1AccountId}`,
      `/api/accounts?q=${encodeURIComponent(AE1_ACCOUNT_NAME)}`,
    ]) {
      const response = await app.inject({ method: "GET", url, cookies: again.cookies });
      try {
        expectNothingOf(response, ctx);
      } catch (error) {
        throw new Error(`${url} → ${response.body.slice(0, 200)}`, { cause: error });
      }
    }
    // Nothing of the first AE's was changed by any of those requests.
    const [after] = await ownerQuery<Record<string, unknown>>(
      `SELECT a.name, a.owner_user_id, a.deleted_at, c.first_name, s.text, s.confirmed, d.name AS deal_name, d.stage,
              d.status, t.done_at, (SELECT count(*) FROM activities WHERE account_id = a.id) AS activities
       FROM accounts a, contacts c, signals s, deals d, tasks t
       WHERE a.id = $1 AND c.id = $2 AND s.id = $3 AND d.id = $4 AND t.id = $5`,
      [ctx.ae1AccountId, ctx.ae1ContactId, ctx.ae1SignalId, ctx.ae1DealId, ctx.ae1TaskId],
    );
    expect(after).toEqual({
      name: AE1_ACCOUNT_NAME,
      owner_user_id: ctx.ae1.id,
      deleted_at: null,
      first_name: "Pat",
      text: "Gate broken",
      confirmed: false,
      deal_name: "First deal",
      stage: "lead",
      status: "open",
      done_at: null,
      activities: "0",
    });
    // The first AE is untouched: still signed in and still active.
    const me = await app.inject({ method: "GET", url: "/api/me", cookies: ae1Session.cookies });
    expect(me.statusCode).toBe(200);
  });
});
