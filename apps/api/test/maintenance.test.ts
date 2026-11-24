import { APP_ROLE, createDb } from "@soa/db";
import { beforeEach, describe, expect, it } from "vitest";
import { runMaintenance } from "../src/services/maintenance";
import { testDatabaseUrl } from "./db-setup";
import { createAccount, createUser, ownerQuery, resetDatabase } from "./helpers";

/* maintenance.nightly (§14): purge old AI payloads, expire sessions and proposals, verify the last backup. */

const NOW = new Date("2026-06-01T08:00:00Z");

async function run(latest: Date | null | Error) {
  const handle = createDb(testDatabaseUrl(), { role: APP_ROLE, max: 1 });
  try {
    return await runMaintenance({
      db: handle.db,
      clock: () => NOW,
      backups: {
        latestRestorableTime: () => (latest instanceof Error ? Promise.reject(latest) : Promise.resolve(latest)),
      },
    });
  } finally {
    await handle.close();
  }
}

beforeEach(async () => {
  await resetDatabase();
});

describe("maintenance.nightly", () => {
  it("purges AI payloads older than 90 days and keeps the call rows", async () => {
    const user = await createUser("priya@soa.example");
    await ownerQuery(
      `INSERT INTO ai_calls (user_id, feature, model, ok, request, response, created_at) VALUES
       ($1, 'ask', 'w', true, '{"system":"old prompt"}', '{"a":1}', $2),
       ($1, 'ask', 'w', true, '{"system":"recent prompt"}', '{"a":2}', $3)`,
      [user.id, new Date(NOW.getTime() - 91 * 86_400_000), new Date(NOW.getTime() - 89 * 86_400_000)],
    );
    const result = await run(new Date(NOW.getTime() - 3_600_000));
    expect(result.aiPayloadsPurged).toBe(1);
    const rows = await ownerQuery<{ request: unknown; response: unknown }>(
      "SELECT request, response FROM ai_calls ORDER BY created_at",
    );
    expect(rows).toEqual([
      { request: { purged: true }, response: null },
      { request: { system: "recent prompt" }, response: { a: 2 } },
    ]);
    expect((await run(new Date())).aiPayloadsPurged).toBe(0); // already purged
  });

  it("deletes expired and idle sessions", async () => {
    const user = await createUser("priya@soa.example");
    await ownerQuery(
      `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES
       ('expired', $1, $2, $2, $2), ('idle', $1, $3, $3, $4), ('live', $1, $5, $5, $4)`,
      [
        user.id,
        new Date(NOW.getTime() - 8 * 86_400_000),
        new Date(NOW.getTime() - 13 * 3_600_000),
        new Date(NOW.getTime() + 86_400_000),
        new Date(NOW.getTime() - 3_600_000),
      ],
    );
    await run(new Date());
    expect(await ownerQuery("SELECT id_hash FROM sessions")).toEqual([{ id_hash: "live" }]);
  });

  it("expires sent proposals past their date, not accepted ones", async () => {
    const user = await createUser("priya@soa.example");
    const accountId = await createAccount("Harbor Freight Yards", user.id);
    const [deal] = await ownerQuery<{ id: string }>(
      "INSERT INTO deals (account_id, owner_user_id, name) VALUES ($1, $2, 'Deal') RETURNING id",
      [accountId, user.id],
    );
    const insert = (version: number, status: string, expiresAt: Date) =>
      ownerQuery(
        `INSERT INTO proposals (deal_id, version, status, package, pricing, created_by, expires_at) VALUES ($1, $2, $3, '{}', '{}', $4, $5)`,
        [deal?.id, version, status, user.id, expiresAt],
      );
    await insert(1, "sent", new Date(NOW.getTime() - 1000));
    await insert(2, "viewed", new Date(NOW.getTime() + 86_400_000));
    await insert(3, "accepted", new Date(NOW.getTime() - 1000));
    expect((await run(new Date())).proposalsExpired).toBe(1);
    expect(await ownerQuery("SELECT version, status FROM proposals ORDER BY version")).toEqual([
      { version: 1, status: "expired" },
      { version: 2, status: "viewed" },
      { version: 3, status: "accepted" },
    ]);
  });

  it("reports the backup age, and a stale or unknown backup as not ok", async () => {
    expect(await run(new Date(NOW.getTime() - 2 * 3_600_000))).toMatchObject({ backupAgeHours: 2, backupOk: true });
    expect(await run(new Date(NOW.getTime() - 30 * 3_600_000))).toMatchObject({ backupAgeHours: 30, backupOk: false });
    expect(await run(null)).toMatchObject({ backupAgeHours: null, backupOk: false });
    expect(await run(new Error("AccessDenied"))).toMatchObject({ backupOk: false });
  });
});
