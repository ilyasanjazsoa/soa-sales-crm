import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "../index";
import { seedDatabase } from "../seed";
import { createTestDatabase, dropTestDatabase } from "../testing";

describe("seed data", () => {
  let database: { name: string; url: string };
  const count = async (sql: string) => {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      return (await client.query<{ n: string }>(sql)).rows.map((row) => Object.values(row).join("|"));
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    database = await createTestDatabase("crm_seed");
    await runMigrations(database.url);
    const handle = createDb(database.url, { max: 1 });
    await seedDatabase(handle.db, { domain: "soa.example" });
    await handle.close();
  });
  afterAll(async () => {
    await dropTestDatabase(database.name);
  });

  it("has the milestone 1 shape", async () => {
    expect(await count("SELECT role, count(*) FROM users GROUP BY role ORDER BY role")).toEqual(["ae|5", "manager|1"]);
    expect(await count("SELECT count(*) FROM accounts")).toEqual(["40"]);
    expect(await count("SELECT count(DISTINCT property_type) FROM accounts")).toEqual(["10"]);
    expect(await count("SELECT count(*) FROM deals")).toEqual(["15"]);
    expect(await count("SELECT count(DISTINCT stage) FROM deals")).toEqual(["7"]);
    expect(await count("SELECT count(*) FROM client_references")).toEqual(["4"]);
    expect(await count("SELECT count(*) FROM pricing_configs")).toEqual(["1"]);
    expect(await count("SELECT count(*) > 0 FROM signals")).toEqual(["true"]);
    expect(await count("SELECT count(*) FROM accounts WHERE owner_user_id IS NULL")).toEqual(["15"]);
  });

  it("uses only .example email addresses", async () => {
    expect(await count("SELECT count(*) FROM users WHERE email NOT LIKE '%.example'")).toEqual(["0"]);
    expect(await count("SELECT count(*) FROM contacts WHERE email NOT LIKE '%.example'")).toEqual(["0"]);
  });

  it("matches the pricing reference values in ARCHITECTURE.md §6", async () => {
    expect(
      await count(
        "SELECT hourly_rate_cents->>'unarmed' AS a, hourly_rate_cents->>'armed' AS b, supervisor_multiplier AS c, addons->'video'->>'monthlyCents' AS d, term_discounts->>'36' AS e, max_manual_discount AS f FROM pricing_configs",
      ),
    ).toEqual(["2900|3800|1.0500|220000|0.05|0.1000"]);
  });

  it("refuses to run twice or with a real domain", async () => {
    const handle = createDb(database.url, { max: 1 });
    try {
      await expect(seedDatabase(handle.db, { domain: "soa.example" })).rejects.toThrow(/already has users/);
      await expect(seedDatabase(handle.db, { domain: "securityofamerica.com" })).rejects.toThrow(/\.example/);
    } finally {
      await handle.close();
    }
  });
});

describe("seed fit scores", () => {
  it("are computed for every account", async () => {
    const database = await createTestDatabase("crm_seed_fit");
    try {
      await runMigrations(database.url);
      const handle = createDb(database.url, { max: 1 });
      await seedDatabase(handle.db, { domain: "soa.example" });
      await handle.close();
      const client = new pg.Client({ connectionString: database.url });
      await client.connect();
      const { rows } = await client.query<{ missing: string; scored: string }>(
        "SELECT count(*) FILTER (WHERE fit_score IS NULL) AS missing, count(*) FILTER (WHERE fit_score > 0) AS scored FROM accounts",
      );
      await client.end();
      expect(rows[0]?.missing).toBe("0");
      expect(Number(rows[0]?.scored)).toBeGreaterThan(20);
    } finally {
      await dropTestDatabase(database.name);
    }
  });
});
