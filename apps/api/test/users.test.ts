import { AdminUser, AdminUserList } from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount, createUser, ownerQuery, resetDatabase, signIn, testApp, type SignedIn } from "./helpers";

let app: FastifyInstance;
let admin: SignedIn;
let adminId: string;

beforeEach(async () => {
  await resetDatabase();
  adminId = (await createUser("admin@soa.example", "admin")).id;
  app = await testApp();
  admin = await signIn(app, "admin@soa.example");
});
afterEach(async () => {
  await app.close();
});

const as = (session: SignedIn) => ({ cookies: session.cookies, headers: session.headers });

const auditRows = () =>
  ownerQuery<{ action: string; entity_id: string; meta: Record<string, unknown> }>(
    "SELECT action, entity_id, meta FROM audit_log WHERE action LIKE 'user.%' ORDER BY id",
  );

describe("Admin → Users", () => {
  it("lists users with how many accounts each owns", async () => {
    const dana = await createUser("dana@soa.example");
    await createAccount("Harbor Freight Yard", dana.id);
    const response = await app.inject({ method: "GET", url: "/api/admin/users", ...as(admin) });
    const { items } = AdminUserList.parse(response.json());
    expect(items.map((user) => [user.email, user.ownedAccounts])).toEqual([
      ["admin@soa.example", 0],
      ["dana@soa.example", 1],
    ]);
  });

  it("adds a user and audits it", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      ...as(admin),
      payload: { email: "New.Rep@soa.example", name: "New Rep", role: "ae" },
    });
    expect(response.statusCode).toBe(201);
    const created = AdminUser.parse(response.json());
    expect(created.email).toBe("new.rep@soa.example");
    expect(await auditRows()).toEqual([{ action: "user.create", entity_id: created.id, meta: { role: "ae" } }]);
    // The new user can now sign in.
    await expect(signIn(app, "new.rep@soa.example")).resolves.toBeDefined();
  });

  it("refuses a duplicate (409 with the existing id) and another domain (422)", async () => {
    const dana = await createUser("dana@soa.example");
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      ...as(admin),
      payload: { email: "DANA@soa.example", name: "Dana" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "duplicate", details: { id: dana.id } } });
    const foreign = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      ...as(admin),
      payload: { email: "x@other.example", name: "X" },
    });
    expect(foreign.statusCode).toBe(422);
  });

  it("changes role and send cap, audited without values other than role and active", async () => {
    const dana = await createUser("dana@soa.example");
    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${dana.id}`,
      ...as(admin),
      payload: { role: "manager", dailySendCap: 40 },
    });
    expect(AdminUser.parse(response.json())).toMatchObject({ role: "manager", dailySendCap: 40 });
    expect(await auditRows()).toEqual([
      { action: "user.update", entity_id: dana.id, meta: { fields: ["dailySendCap", "role"], role: "manager" } },
    ]);
  });

  it("requires reassigning accounts before deactivating, then ends the user's sessions", async () => {
    const dana = await createUser("dana@soa.example");
    const danaSession = await signIn(app, "dana@soa.example");
    const accountId = await createAccount("Lakeside Cold Storage", dana.id);
    const blocked = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${dana.id}`,
      ...as(admin),
      payload: { active: false },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: { code: "reassign_required", details: { ownedAccounts: 1 } } });

    await ownerQuery("UPDATE accounts SET owner_user_id = NULL WHERE id = $1", [accountId]);
    const done = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${dana.id}`,
      ...as(admin),
      payload: { active: false },
    });
    expect(done.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/me", cookies: danaSession.cookies })).statusCode).toBe(401);
  });

  it("stops an admin from locking themselves out", async () => {
    for (const payload of [{ active: false }, { role: "ae" }]) {
      const response = await app.inject({ method: "PATCH", url: `/api/admin/users/${adminId}`, ...as(admin), payload });
      expect(response.statusCode).toBe(422);
    }
  });

  it("returns 404 for an unknown user and 400 for a bad id", async () => {
    const unknown = await app.inject({
      method: "PATCH",
      url: "/api/admin/users/00000000-0000-4000-8000-000000000000",
      ...as(admin),
      payload: { name: "X" },
    });
    expect(unknown.statusCode).toBe(404);
    const bad = await app.inject({ method: "PATCH", url: "/api/admin/users/nope", ...as(admin), payload: {} });
    expect(bad.statusCode).toBe(400);
  });

  it("is closed to managers and AEs", async () => {
    await createUser("manager@soa.example", "manager");
    const manager = await signIn(app, "manager@soa.example");
    expect((await app.inject({ method: "GET", url: "/api/admin/users", ...as(manager) })).statusCode).toBe(403);
  });

  it("shows the audit log to admins, newest first", async () => {
    const response = await app.inject({ method: "GET", url: "/api/admin/audit?limit=10", ...as(admin) });
    const body = response.json<{ items: { action: string }[] }>();
    expect(body.items[0]?.action).toBe("auth.login");
  });
});

describe("My settings", () => {
  it("updates time zone, hours, phone and address, and audits the field names", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/me",
      ...as(admin),
      payload: {
        timezone: "America/Denver",
        workdayStart: "07:30",
        workdayEnd: "16:00",
        phone: "(214) 555-0100",
        baseAddress: "100 Main St, Dallas, TX",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { timezone: "America/Denver", workdayStart: "07:30", workdayEnd: "16:00", phone: "(214) 555-0100" },
    });
    const [row] = await auditRows();
    expect(row?.meta).toEqual({ fields: ["baseAddress", "phone", "timezone", "workdayEnd", "workdayStart"] });
  });

  it.each([
    [{ timezone: "Mars/Olympus" }],
    [{ workdayStart: "25:00" }],
    [{ workdayStart: "18:00", workdayEnd: "09:00" }],
    [{ role: "admin" }],
  ])("rejects %j", async (payload) => {
    const response = await app.inject({ method: "PATCH", url: "/api/me", ...as(admin), payload });
    expect(response.statusCode).toBe(400);
  });

  it("rejects hours that end before they start against the saved value", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/me",
      ...as(admin),
      payload: { workdayEnd: "06:00" },
    });
    expect(response.statusCode).toBe(422);
  });
});
