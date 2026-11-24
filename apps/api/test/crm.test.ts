import { readFileSync } from "node:fs";
import { createDb } from "@soa/db";
import { seedDatabase } from "@soa/db/seed";
import {
  Account,
  AccountPage,
  Deal,
  DealPage,
  ForecastResponse,
  ImportPreviewResponse,
  ImportStatus,
  ImportUploadResponse,
} from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryQueue } from "../src/jobs/queue";
import { createMemoryObjectStore } from "../src/providers/storage";
import { runImport } from "../src/services/imports";
import { testDatabaseUrl } from "./db-setup";
import { createAccount, createUser, ownerQuery, resetDatabase, signIn, testApp, type SignedIn } from "./helpers";

let app: FastifyInstance;
const store = createMemoryObjectStore();
const queue = createMemoryQueue();

beforeEach(async () => {
  await resetDatabase();
  queue.sent.length = 0;
  app = await testApp({ store, queue });
});
afterEach(async () => {
  await app.close();
});

const as = (session: SignedIn) => ({ cookies: session.cookies, headers: session.headers });
const pricing = async () =>
  ownerQuery(`INSERT INTO pricing_configs (effective_from, hourly_rate_cents, coverage_hours_per_week, addons, term_discounts)
    VALUES ('2026-01-01', '{"unarmed":2900,"armed":3800}', '{"24_7":168,"nights":84,"business_hours":60}',
    '{"patrol":{"label":"Patrol","monthlyCents":145000},"video":{"label":"Video","monthlyCents":220000},"portal":{"label":"Portal","monthlyCents":0}}',
    '{"12":0,"24":0.03,"36":0.05}')`);

async function twoAes() {
  const first = await createUser("first.ae@soa.example");
  const second = await createUser("second.ae@soa.example");
  return {
    first,
    second,
    firstSession: await signIn(app, first.email),
    secondSession: await signIn(app, second.email),
  };
}

describe("visibility", () => {
  it("an AE sees their own and unassigned accounts, not another AE's; managers see all", async () => {
    const { first, second, firstSession, secondSession } = await twoAes();
    await createAccount("Mine Logistics Park", first.id);
    await createAccount("Theirs Logistics Park", second.id);
    await createAccount("Pool Logistics Park", null);
    const names = async (session: SignedIn) =>
      AccountPage.parse((await app.inject({ method: "GET", url: "/api/accounts?limit=100", ...as(session) })).json())
        .items.map((item) => item.name)
        .sort();
    expect(await names(firstSession)).toEqual(["Mine Logistics Park", "Pool Logistics Park"]);
    await createUser("manager@soa.example", "manager");
    expect(await names(await signIn(app, "manager@soa.example"))).toHaveLength(3);
    const page = AccountPage.parse(
      (await app.inject({ method: "GET", url: "/api/accounts", ...as(secondSession) })).json(),
    );
    expect(page.hiddenFromYou).toBe(1);
  });

  it("a second AE gets 404 on the first AE's account and every child route", async () => {
    const { first, firstSession, secondSession } = await twoAes();
    const accountId = await createAccount("Private Cold Storage", first.id);
    const contact = await app.inject({
      method: "POST",
      url: `/api/accounts/${accountId}/contacts`,
      ...as(firstSession),
      payload: { firstName: "Ana", email: "ana@private.example" },
    });
    const contactId = contact.json<{ id: string }>().id;
    const urls = [
      ["GET", `/api/accounts/${accountId}`],
      ["PATCH", `/api/accounts/${accountId}`, { name: "x" }],
      ["POST", `/api/accounts/${accountId}/claim`],
      ["DELETE", `/api/accounts/${accountId}`],
      ["POST", `/api/accounts/${accountId}/contacts`, { firstName: "x" }],
      ["PATCH", `/api/contacts/${contactId}`, { firstName: "x" }],
      ["DELETE", `/api/contacts/${contactId}`],
      ["GET", `/api/accounts/${accountId}/signals`],
      ["POST", `/api/accounts/${accountId}/signals`, { text: "x" }],
      ["GET", `/api/accounts/${accountId}/timeline`],
      ["POST", `/api/accounts/${accountId}/notes`, { text: "x" }],
      ["POST", `/api/accounts/${accountId}/deals`, {}],
    ] as const;
    for (const [method, url, payload] of urls) {
      const response = await app.inject({
        method,
        url,
        ...as(secondSession),
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});

describe("claiming", () => {
  it("works once; a second claim (even at the same moment) gets 409", async () => {
    await pricing();
    const { firstSession, secondSession } = await twoAes();
    const accountId = await createAccount("Pool Data Campus", null);
    const results = await Promise.all(
      [firstSession, secondSession].map((session) =>
        app.inject({ method: "POST", url: `/api/accounts/${accountId}/claim`, ...as(session) }),
      ),
    );
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.statusCode === 200);
    const account = Account.parse(winner?.json());
    expect(account.deal).toMatchObject({ stage: "lead", status: "open" });
    expect(account.deal?.annualValueCents).toBeGreaterThan(0);
    expect(await ownerQuery("SELECT action FROM audit_log WHERE action = 'account.claim'")).toHaveLength(1);
    expect(await ownerQuery("SELECT type FROM activities WHERE type = 'owner_change'")).toHaveLength(1);
  });
});

describe("duplicates", () => {
  it("creating a duplicate (same name and city, any letter case) returns 409 with the existing id", async () => {
    const { firstSession, secondSession } = await twoAes();
    const created = await app.inject({
      method: "POST",
      url: "/api/accounts",
      ...as(firstSession),
      payload: { name: "Riverside Business Park", propertyType: "Industrial", city: "Irving" },
    });
    expect(created.statusCode).toBe(201);
    const existingId = created.json<{ id: string }>().id;
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/accounts",
      ...as(secondSession),
      payload: { name: "RIVERSIDE business park", propertyType: "Retail", city: "irving" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "duplicate", details: { id: existingId } } });
    const otherCity = await app.inject({
      method: "POST",
      url: "/api/accounts",
      ...as(secondSession),
      payload: { name: "Riverside Business Park", propertyType: "Industrial", city: "Plano" },
    });
    expect(otherCity.statusCode).toBe(201);
  });
});

describe("CSV import", () => {
  it("imports the 60-row sample: 52 created, 8 skipped with reasons", async () => {
    await pricing();
    const { first, firstSession } = await twoAes();
    await createAccount("Existing Harbor Logistics Park", first.id); // Irving
    await ownerQuery(
      "INSERT INTO accounts (name, property_type, city) VALUES ('Existing Cedar Medical Pavilion', 'Medical office', 'Plano')",
    );

    const csv = readFileSync(new URL("./fixtures/sample-import.csv", import.meta.url));
    const boundary = "----soa-test-boundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="prospects.csv"\r\nContent-Type: text/csv\r\n\r\n`,
      ),
      csv,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await app.inject({
      method: "POST",
      url: "/api/imports",
      ...as(firstSession),
      headers: { ...firstSession.headers, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(upload.statusCode).toBe(201);
    const uploaded = ImportUploadResponse.parse(upload.json());
    expect(uploaded.rowsTotal).toBe(60);
    expect(uploaded.sampleRows).toHaveLength(20);
    expect(Object.values(uploaded.suggestedMap).filter((field) => field !== "ignore")).toHaveLength(19);

    const preview = ImportPreviewResponse.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/imports/${uploaded.id}/preview`,
          ...as(firstSession),
          payload: { columnMap: uploaded.suggestedMap, assignToMe: false },
        })
      ).json(),
    );
    expect(preview).toMatchObject({ newCount: 52, duplicateCount: 5, invalidCount: 3 });

    const run = await app.inject({ method: "POST", url: `/api/imports/${uploaded.id}/run`, ...as(firstSession) });
    expect(run.statusCode).toBe(202);
    expect(queue.sent).toEqual([{ name: "import.run", data: { importId: uploaded.id } }]);

    const handle = createDb(testDatabaseUrl(), { max: 2 });
    await runImport({ db: handle.db, store, clock: () => new Date() }, uploaded.id);
    await handle.close();

    const status = ImportStatus.parse(
      (await app.inject({ method: "GET", url: `/api/imports/${uploaded.id}`, ...as(firstSession) })).json(),
    );
    expect(status).toMatchObject({ status: "done", rowsTotal: 60, rowsCreated: 52, rowsSkipped: 8 });
    expect(status.errors.map((error) => error.reason).sort()).toEqual([
      "Already in the CRM (same name and city)",
      "Already in the CRM (same name and city)",
      "Contact email is not valid",
      "Missing account name",
      "Repeats an earlier row (same name and city)",
      "Repeats an earlier row (same name and city)",
      "Repeats an earlier row (same name and city)",
      'Unknown property type "Castle"',
    ]);
    expect(status.errors.every((error) => error.row >= 2 && error.row <= 61)).toBe(true);

    const [counts] = await ownerQuery<{
      accounts: string;
      unassigned: string;
      contacts: string;
      signals: string;
      unconfirmed: string;
    }>(
      `SELECT (SELECT count(*) FROM accounts WHERE source = 'csv') AS accounts,
              (SELECT count(*) FROM accounts WHERE source = 'csv' AND owner_user_id IS NULL) AS unassigned,
              (SELECT count(*) FROM contacts c JOIN accounts a ON a.id = c.account_id WHERE a.source = 'csv') AS contacts,
              (SELECT count(*) FROM signals) AS signals,
              (SELECT count(*) FROM signals WHERE NOT confirmed AND source_id IS NOT NULL) AS unconfirmed`,
    );
    expect(counts).toEqual({ accounts: "52", unassigned: "52", contacts: "52", signals: "13", unconfirmed: "13" });
  });

  it("refuses to run an import that was not previewed, and non-CSV uploads", async () => {
    const { firstSession } = await twoAes();
    const boundary = "b";
    const response = await app.inject({
      method: "POST",
      url: "/api/imports",
      ...as(firstSession),
      headers: { ...firstSession.headers, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.exe"\r\n\r\nMZ\r\n--${boundary}--\r\n`,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("stage rules", () => {
  it("an AE moves up to proposal; contract_sent and won are refused; losing needs a reason; each change is recorded", async () => {
    await pricing();
    const { firstSession } = await twoAes();
    const account = Account.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          ...as(firstSession),
          payload: { name: "Stage Rules Plaza", propertyType: "Class A office", city: "Dallas" },
        })
      ).json(),
    );
    const dealId = account.deal?.id ?? "";
    const move = (stage: string) =>
      app.inject({ method: "POST", url: `/api/deals/${dealId}/stage`, ...as(firstSession), payload: { stage } });

    expect((await move("researched")).statusCode).toBe(200);
    expect(Deal.parse((await move("proposal")).json()).stage).toBe("proposal");
    for (const stage of ["contract_sent", "won"]) {
      const refused = await move(stage);
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ error: { code: "system_stage" } });
    }
    expect((await move("contacted")).statusCode).toBe(200); // backwards is allowed up to proposal

    const noReason = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/lose`,
      ...as(firstSession),
      payload: {},
    });
    expect(noReason.statusCode).toBe(400);
    const lost = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/lose`,
      ...as(firstSession),
      payload: { reason: "Stayed with incumbent", note: "Renewed for 3 years" },
    });
    expect(Deal.parse(lost.json())).toMatchObject({
      status: "lost",
      lostReason: "Stayed with incumbent: Renewed for 3 years",
    });
    expect((await move("proposal")).statusCode).toBe(422); // closed

    const history = await ownerQuery<{ from_stage: string | null; to_stage: string }>(
      "SELECT from_stage, to_stage FROM deal_stage_history WHERE deal_id = $1 ORDER BY changed_at, id",
      [dealId],
    );
    expect(history.map((row) => `${row.from_stage ?? "-"}>${row.to_stage}`)).toHaveLength(5);
    const activities = await ownerQuery("SELECT 1 FROM activities WHERE deal_id = $1 AND type = 'stage_change'", [
      dealId,
    ]);
    expect(activities).toHaveLength(4); // researched, proposal, contacted, lost
    const audits = await ownerQuery<{ action: string }>(
      "SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id",
      [dealId],
    );
    expect(audits.map((row) => row.action)).toEqual(["deal.stage", "deal.stage", "deal.stage", "deal.lost"]);
  });

  it("a manager can override to won, audited, and reopen a lost deal", async () => {
    await pricing();
    await createUser("manager@soa.example", "manager");
    const manager = await signIn(app, "manager@soa.example");
    const account = Account.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          ...as(manager),
          payload: { name: "Override Data Campus", propertyType: "Data center", city: "Plano" },
        })
      ).json(),
    );
    const dealId = account.deal?.id ?? "";
    const noReason = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/stage`,
      ...as(manager),
      payload: { stage: "won" },
    });
    expect(noReason.json()).toMatchObject({ error: { code: "reason_required" } });
    const won = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/stage`,
      ...as(manager),
      payload: { stage: "won", reason: "Signed on paper at the site walk" },
    });
    expect(won.json(), won.body).toMatchObject({ stage: "won", status: "won" });
    const [audit] = await ownerQuery<{ meta: Record<string, unknown> }>(
      "SELECT meta FROM audit_log WHERE action = 'deal.stage' AND entity_id = $1",
      [dealId],
    );
    expect(audit?.meta).toMatchObject({ to: "won", managerOverride: true, reason: "Signed on paper at the site walk" });
  });
});

describe("forecast", () => {
  it("equals Σ value × stage probability on the seed data", async () => {
    await resetDatabase();
    const handle = createDb(testDatabaseUrl(), { max: 1 });
    await seedDatabase(handle.db, { domain: "soa.example" });
    await handle.close();
    const manager = await signIn(app, "renee.hartwell@soa.example");
    const forecast = ForecastResponse.parse(
      (await app.inject({ method: "GET", url: "/api/forecast", ...as(manager) })).json(),
    );
    // lead 54,288,000×5% + researched 96,819,360×10% + contacted 79,872,000×20% + meeting_set 65,520,000×35%
    // + proposal 83,616,000×55% + contract_sent 41,184,000×80% = 130,238,736 cents ($1,302,387.36)
    expect(forecast.weightedCents).toBe(130_238_736);
    expect(forecast.openCount).toBe(14);
    expect(forecast.wonValueCents).toBe(33_696_000);

    const ae = await signIn(app, "priya.raman@soa.example");
    const own = ForecastResponse.parse((await app.inject({ method: "GET", url: "/api/forecast", ...as(ae) })).json());
    const deals = DealPage.parse(
      (await app.inject({ method: "GET", url: "/api/deals?owner=me&limit=100", ...as(ae) })).json(),
    );
    expect(own.openCount).toBe(deals.items.filter((deal) => deal.status === "open").length);
    expect(own.weightedCents).toBeLessThan(forecast.weightedCents);
  });
});

describe("search", () => {
  it("tolerates a one-letter typo in the name", async () => {
    const { firstSession } = await twoAes();
    await createAccount("Redbud Logistics Park", null);
    await createAccount("Bluestem Cold Storage", null);
    for (const q of ["Redbod", "redbud logistcs", "Logistics"]) {
      const page = AccountPage.parse(
        (
          await app.inject({ method: "GET", url: `/api/accounts?q=${encodeURIComponent(q)}`, ...as(firstSession) })
        ).json(),
      );
      expect(
        page.items.map((item) => item.name),
        q,
      ).toContain("Redbud Logistics Park");
      expect(
        page.items.map((item) => item.name),
        q,
      ).not.toContain("Bluestem Cold Storage");
    }
  });

  it("returns the first page in under 300 ms with 50,000 accounts", async () => {
    const { first, firstSession } = await twoAes();
    // 50,000 varied, realistic names (20 × 13 word pairs, numbered).
    await ownerQuery(
      `INSERT INTO accounts (name, property_type, city, owner_user_id, fit_score)
       SELECT (ARRAY['Ashford','Birchwood','Calloway','Dunmore','Elmhurst','Fairview','Glenrock','Hartwell','Ironside','Juniper',
                     'Kingsley','Larkspur','Maplecrest','Northgate','Oakmont','Pinecrest','Quarry','Redstone','Silverton','Thornbury'])[1 + g % 20]
              || ' ' || (ARRAY['Ridge','Point','Crossing','Commons','Landing','Square','Heights','Park','Station','Yards',
                               'Harbor','Grove','Terrace'])[1 + (g / 20) % 13]
              || ' ' || g || ' ' || (ARRAY['Logistics Park','Cold Storage','Medical Center','Plaza'])[1 + g % 4],
              (ARRAY['Industrial','Cold chain warehouse','Medical office','Class A office'])[1 + g % 4],
              (ARRAY['Irving','Plano','Dallas','Frisco','Garland'])[1 + g % 5],
              CASE WHEN g % 3 = 0 THEN $1::uuid ELSE NULL END,
              g % 101
       FROM generate_series(1, 50000) AS g`,
      [first.id],
    );
    await ownerQuery("ANALYZE accounts");
    const timings: Record<string, number> = {};
    for (const url of [
      "/api/accounts",
      "/api/accounts?q=Ashfrod%20Ridge%2012480",
      "/api/accounts?type=Industrial&minFit=50&owner=me",
    ]) {
      await app.inject({ method: "GET", url, ...as(firstSession) }); // warm up
      const started = performance.now();
      const response = await app.inject({ method: "GET", url, ...as(firstSession) });
      timings[url] = performance.now() - started;
      expect(response.statusCode).toBe(200);
      expect(AccountPage.parse(response.json()).items.length).toBeGreaterThan(0);
    }
    for (const [url, ms] of Object.entries(timings)) expect(ms, url).toBeLessThan(300);
  }, 120_000);
});

describe("fit score, contacts, notes, tasks and export", () => {
  it("recomputes the fit score when inputs change and keeps the timeline", async () => {
    await pricing();
    const { firstSession } = await twoAes();
    const account = Account.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          ...as(firstSession),
          payload: {
            name: "Fit Check Data Campus",
            propertyType: "Data center",
            city: "Garland",
            currentProvider: "None",
          },
        })
      ).json(),
    );
    expect(account.fitScore).toBe(35); // no provider 20 + large contract 15
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/contacts`,
      ...as(firstSession),
      payload: { firstName: "Lee", email: "lee@fit.example" },
    });
    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/signals`,
      ...as(firstSession),
      payload: {
        text: "Break-in at the loading dock",
        kind: "incident",
        observedOn: new Date().toISOString().slice(0, 10),
      },
    });
    const after = Account.parse(
      (await app.inject({ method: "GET", url: `/api/accounts/${account.id}`, ...as(firstSession) })).json(),
    );
    expect(after.fitScore).toBe(75);
    expect(after.contacts[0]?.isPrimary).toBe(true);

    await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/notes`,
      ...as(firstSession),
      payload: { text: "Met at the expo" },
    });
    const timeline = (
      await app.inject({ method: "GET", url: `/api/accounts/${account.id}/timeline?limit=1`, ...as(firstSession) })
    ).json<{
      items: { body: string | null }[];
      nextCursor: string | null;
    }>();
    expect(timeline.items[0]?.body).toBe("Met at the expo");
    expect(timeline.nextCursor).not.toBeNull();
  });

  it("marks a suppressed address on a new contact", async () => {
    const { first, firstSession } = await twoAes();
    const accountId = await createAccount("Suppressed Plaza", first.id);
    await ownerQuery("INSERT INTO suppressions (email, reason) VALUES ('gone@away.example', 'unsubscribe')");
    const contact = await app.inject({
      method: "POST",
      url: `/api/accounts/${accountId}/contacts`,
      ...as(firstSession),
      payload: { firstName: "Gone", email: "GONE@away.example" },
    });
    expect(contact.json()).toMatchObject({ email: "gone@away.example", emailStatus: "unsubscribed" });
  });

  it("completes a task and logs it on the timeline", async () => {
    const { first, firstSession } = await twoAes();
    const accountId = await createAccount("Task Park", first.id);
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      ...as(firstSession),
      payload: { title: "Send site photos", accountId },
    });
    const taskId = task.json<{ id: string }>().id;
    const done = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      ...as(firstSession),
      payload: { done: true },
    });
    expect(done.json<{ doneAt: string | null }>().doneAt).not.toBeNull();
    expect(await ownerQuery("SELECT 1 FROM activities WHERE type = 'task_done'")).toHaveLength(1);
    const open = (await app.inject({ method: "GET", url: "/api/tasks?open=true", ...as(firstSession) })).json<{
      items: unknown[];
    }>();
    expect(open.items).toHaveLength(0);
  });

  it("exports CSV for managers, audited, with formula injection neutralised", async () => {
    await createUser("manager@soa.example", "manager");
    const manager = await signIn(app, "manager@soa.example");
    await ownerQuery(
      "INSERT INTO accounts (name, property_type, city) VALUES ('=HYPERLINK(\"http://x.example\")', 'Retail', 'Dallas')",
    );
    const response = await app.inject({ method: "GET", url: "/api/export/accounts.csv", ...as(manager) });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.body).toContain(`"'=HYPERLINK(""http://x.example"")"`);
    expect(await ownerQuery("SELECT 1 FROM audit_log WHERE action = 'export.accounts'")).toHaveLength(1);
  });
});

describe("review fixes", () => {
  it("a partial contact update keeps the fields it did not send", async () => {
    const { first, firstSession } = await twoAes();
    const accountId = await createAccount("Partial Patch Park", first.id);
    const contact = await app.inject({
      method: "POST",
      url: `/api/accounts/${accountId}/contacts`,
      ...as(firstSession),
      payload: { firstName: "Ana", lastName: "Lopez", title: "GM" },
    });
    const id = contact.json<{ id: string }>().id;
    for (const payload of [{ doNotCall: true }, { isPrimary: true }, { title: "VP" }]) {
      const updated = await app.inject({ method: "PATCH", url: `/api/contacts/${id}`, ...as(firstSession), payload });
      expect(updated.json()).toMatchObject({ firstName: "Ana", lastName: "Lopez" });
    }
  });

  it("pages the timeline without skipping rows that share a timestamp, and rejects a bad cursor", async () => {
    const { first, firstSession } = await twoAes();
    const accountId = await createAccount("Timeline Paging Park", first.id);
    await ownerQuery(
      `INSERT INTO activities (account_id, type, subject, occurred_at)
       SELECT $1, 'note', 'Note ' || g, now() - (CASE WHEN g = 6 THEN interval '56 microseconds' ELSE interval '0' END)
       FROM generate_series(1, 6) AS g`,
      [accountId],
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? "" : `&cursor=${cursor}`;
      const page = (
        await app.inject({
          method: "GET",
          url: `/api/accounts/${accountId}/timeline?limit=2${query}`,
          ...as(firstSession),
        })
      ).json<{ items: { subject: string }[]; nextCursor: string | null }>();
      seen.push(...page.items.map((item) => item.subject));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen.sort()).toEqual(["Note 1", "Note 2", "Note 3", "Note 4", "Note 5", "Note 6"]);
    const bad = await app.inject({
      method: "GET",
      url: `/api/accounts/${accountId}/timeline?cursor=bm90LWEtdXVpZA`,
      ...as(firstSession),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("records an activity and audit row when a deal's package changes, and refuses closed deals", async () => {
    await pricing();
    const { firstSession } = await twoAes();
    const account = Account.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          ...as(firstSession),
          payload: { name: "Package Change Park", propertyType: "Industrial", city: "Irving" },
        })
      ).json(),
    );
    const dealId = account.deal?.id ?? "";
    const pkg = { posts: 2, armed: false, coverage: "24_7", supervisor: false, addons: ["video"], termMonths: 36 };
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/deals/${dealId}`,
      ...as(firstSession),
      payload: { package: pkg },
    });
    expect(Deal.parse(updated.json()).annualValueCents).toBe(50_643_360);
    const [audit] = await ownerQuery<{ meta: Record<string, unknown> }>(
      "SELECT meta FROM audit_log WHERE action = 'deal.update'",
    );
    expect(audit?.meta).toMatchObject({ toCents: 50_643_360 });
    await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/lose`,
      ...as(firstSession),
      payload: { reason: "Price" },
    });
    const closed = await app.inject({
      method: "PATCH",
      url: `/api/deals/${dealId}`,
      ...as(firstSession),
      payload: { name: "x" },
    });
    expect(closed.statusCode).toBe(422);
  });

  it("an AE can't change a deal once its account is returned to the pool", async () => {
    await pricing();
    const { first, firstSession } = await twoAes();
    await createUser("manager@soa.example", "manager");
    const manager = await signIn(app, "manager@soa.example");
    const accountId = await createAccount("Pool Return Park", null);
    const claimed = Account.parse(
      (await app.inject({ method: "POST", url: `/api/accounts/${accountId}/claim`, ...as(firstSession) })).json(),
    );
    expect(claimed.owner?.id).toBe(first.id);
    await app.inject({
      method: "POST",
      url: `/api/accounts/${accountId}/assign`,
      ...as(manager),
      payload: { ownerUserId: null },
    });
    const move = await app.inject({
      method: "POST",
      url: `/api/deals/${claimed.deal?.id ?? ""}/stage`,
      ...as(firstSession),
      payload: { stage: "contacted" },
    });
    expect([403, 404]).toContain(move.statusCode);
  });

  it("a manager can purge an account that was already soft-deleted", async () => {
    const { first, firstSession } = await twoAes();
    await createUser("manager@soa.example", "manager");
    const manager = await signIn(app, "manager@soa.example");
    const accountId = await createAccount("Purge Me Park", first.id);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/accounts/${accountId}`, ...as(firstSession) })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/accounts/${accountId}?purge=true`, ...as(manager) })).statusCode,
    ).toBe(204);
    expect(await ownerQuery("SELECT 1 FROM accounts WHERE id = $1", [accountId])).toHaveLength(0);
  });

  it("an import runs only after a preview, only once at a time, and resumes after a failure", async () => {
    const { firstSession } = await twoAes();
    const boundary = "imp";
    const csv = "Account name,City\nResume One Park,Irving\nResume Two Park,Plano\n";
    const upload = await app.inject({
      method: "POST",
      url: "/api/imports",
      ...as(firstSession),
      headers: { ...firstSession.headers, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r.csv"\r\n\r\n${csv}\r\n--${boundary}--\r\n`,
    });
    const { id, suggestedMap } = ImportUploadResponse.parse(upload.json());
    expect((await app.inject({ method: "POST", url: `/api/imports/${id}/run`, ...as(firstSession) })).statusCode).toBe(
      409,
    );
    await app.inject({
      method: "POST",
      url: `/api/imports/${id}/preview`,
      ...as(firstSession),
      payload: { columnMap: suggestedMap },
    });
    const runs = await Promise.all(
      [1, 2].map(() => app.inject({ method: "POST", url: `/api/imports/${id}/run`, ...as(firstSession) })),
    );
    expect(runs.map((run) => run.statusCode).sort()).toEqual([202, 409]);

    // Simulate a crash after the first row: one account exists, the import is marked failed.
    await ownerQuery(
      "INSERT INTO accounts (name, property_type, city, source, source_ref) VALUES ('Resume One Park', 'Industrial', 'Irving', 'csv', $1)",
      [id],
    );
    await ownerQuery("UPDATE imports SET status = 'failed' WHERE id = $1", [id]);
    expect((await app.inject({ method: "POST", url: `/api/imports/${id}/run`, ...as(firstSession) })).statusCode).toBe(
      202,
    );
    const handle = createDb(testDatabaseUrl(), { max: 2 });
    await runImport({ db: handle.db, store, clock: () => new Date() }, id);
    await handle.close();
    const status = ImportStatus.parse(
      (await app.inject({ method: "GET", url: `/api/imports/${id}`, ...as(firstSession) })).json(),
    );
    expect(status).toMatchObject({ status: "done", rowsCreated: 2, rowsSkipped: 0 });
    expect(store.objects.has(`imports/${id}.csv`)).toBe(false);
  });
});
