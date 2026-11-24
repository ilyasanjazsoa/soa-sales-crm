import { createDb } from "@soa/db";
import { seedDatabase } from "@soa/db/seed";
import { AskPlan, AskResponse, TodayResponse, zonedTime } from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeAiAdapter, type FakeResponder } from "../src/providers/ai/fake";
import { createFakeCalendarProvider } from "../src/providers/calendar/fake";
import { testDatabaseUrl } from "./db-setup";
import { ownerQuery, resetDatabase, signIn, testApp, type SignedIn } from "./helpers";

/* Today and Ask Sales AI against the fictional seed. */

const TZ = "America/Chicago";
/** Tuesday 10 March 2026, 10:00 am in Chicago. */
const TUESDAY = zonedTime(2026, 3, 10, 10, 0, TZ);
let now = TUESDAY;
let app: FastifyInstance;
let session: SignedIn;
let respond: FakeResponder | undefined;
const adapter = createFakeAiAdapter({ respond: (request, attempt) => respond?.(request, attempt) });
const as = () => ({ cookies: session.cookies, headers: session.headers });

beforeEach(async () => {
  await resetDatabase();
  respond = undefined;
  adapter.calls.length = 0;
  now = TUESDAY;
  const handle = createDb(testDatabaseUrl(), { max: 1 });
  await seedDatabase(handle.db, { domain: "soa.example", now: TUESDAY });
  await handle.close();
  app = await testApp({ clock: () => now, aiAdapter: adapter, calendar: createFakeCalendarProvider().provider });
  session = await signIn(app, "priya.raman@soa.example");
});
afterEach(async () => {
  await app.close();
});

const ask = async (question: string) => {
  const response = await app.inject({ method: "POST", url: "/api/ask", ...as(), payload: { question } });
  expect(response.statusCode, response.body).toBe(200);
  return AskResponse.parse(response.json());
};
const priyaId = async () =>
  (await ownerQuery<{ id: string }>("SELECT id FROM users WHERE email = 'priya.raman@soa.example'"))[0]?.id ?? "";

describe("GET /today", () => {
  it("returns the four numbers, next best actions sorted by priority then value, and today's schedule", async () => {
    const today = TodayResponse.parse((await app.inject({ method: "GET", url: "/api/today", ...as() })).json());
    const [own] = await ownerQuery<{ open: string }>(
      "SELECT coalesce(sum(annual_value_cents), 0) AS open FROM deals WHERE owner_user_id = $1 AND status = 'open'",
      [await priyaId()],
    );
    expect(today.stats.openPipelineCents).toBe(Number(own?.open));
    expect(today.actions.length).toBeGreaterThan(0);
    const order = today.actions.map((action) => [action.priority, -action.valueCents]);
    expect(order).toEqual([...order].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0)));
    const [weighted] = await ownerQuery<{ w: string }>(
      `SELECT coalesce(round(sum(annual_value_cents * CASE stage WHEN 'lead' THEN 0.05 WHEN 'researched' THEN 0.10
        WHEN 'contacted' THEN 0.20 WHEN 'meeting_set' THEN 0.35 WHEN 'proposal' THEN 0.55 WHEN 'contract_sent' THEN 0.80
        ELSE 1 END)), 0) AS w FROM deals WHERE owner_user_id = $1 AND status = 'open'`,
      [await priyaId()],
    );
    expect(Math.abs(today.stats.weightedForecastCents - Number(weighted?.w))).toBeLessThanOrEqual(1);
    const [won] = await ownerQuery<{ won: string }>(
      `SELECT coalesce(sum(annual_value_cents), 0) AS won FROM deals WHERE owner_user_id = $1 AND status = 'won'
       AND stage_changed_at >= $2 AND stage_changed_at < $3`,
      [await priyaId(), zonedTime(2026, 1, 1, 0, 0, TZ), zonedTime(2026, 4, 1, 0, 0, TZ)],
    );
    expect(today.stats.wonThisQuarterCents).toBe(Number(won?.won));
    expect(today.schedule.label).toBe("today");
    expect(today.schedule.from).toBe(zonedTime(2026, 3, 10, 0, 0, TZ).toISOString());
  });

  it("shows next week on a Saturday", async () => {
    now = zonedTime(2026, 3, 14, 11, 0, TZ);
    session = await signIn(app, "priya.raman@soa.example"); // the old session is past its 12-hour idle limit
    const today = TodayResponse.parse((await app.inject({ method: "GET", url: "/api/today", ...as() })).json());
    expect(today.schedule).toMatchObject({
      label: "next_week",
      from: zonedTime(2026, 3, 16, 0, 0, TZ).toISOString(),
      to: zonedTime(2026, 3, 21, 0, 0, TZ).toISOString(),
    });
    expect(today.schedule.items.some((item) => item.title === "Team stand-up")).toBe(true);
  });
});

describe("Ask Sales AI", () => {
  it("\"what's stalled?\" lists the rep's deals with no activity in 7 days", async () => {
    const expected = await ownerQuery<{ name: string }>(
      `SELECT a.name FROM deals d JOIN accounts a ON a.id = d.account_id
       WHERE d.owner_user_id = $1 AND d.status = 'open' AND d.last_activity_at < $2 ORDER BY a.name`,
      [await priyaId(), new Date(TUESDAY.getTime() - 7 * 86_400_000)],
    );
    expect(expected.length).toBeGreaterThan(0);
    const result = await ask("What's stalled?");
    expect(result.calls).toEqual(["stalledDeals"]);
    expect(result.items.map((item) => item.label).sort()).toEqual(expected.map((row) => row.name).sort());
  });

  it('"who am I meeting this week?" matches the calendar', async () => {
    const [account] = await ownerQuery<{ id: string }>(
      "SELECT a.id FROM accounts a WHERE a.owner_user_id = $1 LIMIT 1",
      [await priyaId()],
    );
    await ownerQuery(
      `INSERT INTO meetings (account_id, owner_user_id, title, kind, starts_at, ends_at) VALUES
       ($1, $2, 'Site walk: this week', 'site_walk', $3, $4), ($1, $2, 'Call: next week', 'call', $5, $6)`,
      [
        account?.id,
        await priyaId(),
        zonedTime(2026, 3, 12, 14, 0, TZ),
        zonedTime(2026, 3, 12, 15, 0, TZ),
        zonedTime(2026, 3, 17, 9, 0, TZ),
        zonedTime(2026, 3, 17, 9, 30, TZ),
      ],
    );
    const expected = await ownerQuery<{ title: string }>(
      "SELECT title FROM meetings WHERE owner_user_id = $1 AND status = 'scheduled' AND starts_at >= $2 AND starts_at < $3",
      [await priyaId(), zonedTime(2026, 3, 9, 0, 0, TZ), zonedTime(2026, 3, 16, 0, 0, TZ)],
    );
    const result = await ask("Who am I meeting this week?");
    expect(result.calls).toEqual(["meetingsBetween"]);
    expect(result.items.map((item) => item.label).sort()).toEqual(expected.map((row) => row.title).sort());
    expect(result.items.map((item) => item.label)).not.toContain("Call: next week");
  });

  it("an AE asking about another rep's deal learns nothing about it", async () => {
    const [other] = await ownerQuery<{ name: string }>(
      `SELECT a.name FROM accounts a JOIN users u ON u.id = a.owner_user_id
       WHERE u.email <> 'priya.raman@soa.example' AND u.role = 'ae' LIMIT 1`,
    );
    const name = other?.name ?? "";
    expect(name).not.toBe("");
    const response = await app.inject({
      method: "POST",
      url: "/api/ask",
      ...as(),
      payload: { question: `How is the deal for ${name}?` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.toLowerCase()).not.toContain(name.toLowerCase());
    expect(AskResponse.parse(response.json()).items).toEqual([]);
  });

  it("points to the outreach screen instead of drafting", async () => {
    const [account] = await ownerQuery<{ id: string; name: string }>(
      "SELECT id, name FROM accounts WHERE owner_user_id = $1 LIMIT 1",
      [await priyaId()],
    );
    const result = await ask(`Draft an email for ${account?.name ?? ""}.`);
    expect(result.items[0]?.link).toBe(`/accounts/${account?.id ?? ""}?tab=outreach`);
  });

  it("rejects a plan that asks for anything but the fixed functions, and runs nothing", async () => {
    expect(AskPlan.safeParse({ calls: [{ fn: "rawSql", query: "SELECT * FROM users" }] }).success).toBe(false);
    expect(AskPlan.safeParse({ calls: [{ fn: "myOpenDeals", ownerId: "someone-else" }] }).success).toBe(false);
    expect(AskPlan.safeParse({ calls: [{ fn: "stalledDeals", days: 7 }] }).success).toBe(true);

    respond = (request) =>
      request.feature === "ask" && !request.messages.some((message) => message.text.includes('"results"'))
        ? { calls: [{ fn: "deleteAccount", id: "x" }] }
        : undefined;
    const result = await ask("Delete everything please");
    expect(result).toMatchObject({ items: [], calls: [] });
    const calls = await ownerQuery<{ ok: boolean; error: string | null }>(
      "SELECT ok, error FROM ai_calls ORDER BY created_at",
    );
    expect(calls).toEqual([
      { ok: false, error: "invalid_output" },
      { ok: false, error: "invalid_output" },
    ]); // the plan and its one retry; no answer step ran
  });

  it('keeps a manager\'s "my" questions to their own deals', async () => {
    session = await signIn(app, "renee.hartwell@soa.example");
    const result = await ask("Show my deals");
    expect(result.calls).toEqual(["myOpenDeals"]);
    const [own] = await ownerQuery<{ n: number }>(
      "SELECT count(*)::int AS n FROM deals d JOIN users u ON u.id = d.owner_user_id WHERE u.email = 'renee.hartwell@soa.example' AND d.status = 'open'",
    );
    expect(result.items.length).toBe(Math.min(own?.n ?? 0, 10));
  });

  it("shows the CRM's own text for each item, never the model's", async () => {
    respond = (request) => {
      if (request.feature !== "ask" || !request.messages.some((message) => message.text.includes('"results"')))
        return undefined;
      const link = /"link": "(\/accounts\/[^"]+)"/.exec(request.messages.map((m) => m.text).join("\n"))?.[1] ?? "";
      return { answer: "Here.", items: [{ label: "Signed! $900k", sub: "made up", link }] };
    };
    const result = await ask("What's stalled?");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.label).not.toContain("Signed");
    expect(result.items[0]?.sub).not.toBe("made up");
  });

  it("drops links the queries didn't return", async () => {
    respond = (request) =>
      request.feature === "ask" && request.messages.some((message) => message.text.includes('"results"'))
        ? { answer: "See this.", items: [{ label: "Phishing", sub: "", link: "https://evil.example" }] }
        : undefined;
    const result = await ask("What's stalled?");
    expect(result.items.every((item) => item.link.startsWith("/accounts/"))).toBe(true);
  });
});
