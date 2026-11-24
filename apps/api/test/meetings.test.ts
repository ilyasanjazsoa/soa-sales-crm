import { APP_ROLE, createDb } from "@soa/db";
import { BookedMeeting, Meeting, MeetingList, PrepBriefResponse, SlotResponse } from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTokenCipher } from "../src/auth/crypto";
import { createMemoryQueue } from "../src/jobs/queue";
import { createAiClient } from "../src/providers/ai/client";
import { createFakeAiAdapter } from "../src/providers/ai/fake";
import { createFakeCalendarProvider } from "../src/providers/calendar/fake";
import { createFakeTokenRefresher } from "../src/providers/identity/refresh";
import { createDriveTimes } from "../src/providers/maps/cache";
import { createFakeMapsProvider } from "../src/providers/maps/fake";
import { morningPrepDue, queueMorningPrep, runCalendarSync, runPrepGenerate } from "../src/services/meetings";
import { testDatabaseUrl } from "./db-setup";
import { createUser, ownerQuery, resetDatabase, signIn, testApp, type SignedIn, type TestUser } from "./helpers";

const TOKEN_ENC_KEY = "c".repeat(64);
let app: FastifyInstance;
let ae: TestUser;
let session: SignedIn;
let accountId: string;
let dealId: string;
let calendar = createFakeCalendarProvider();
const queue = createMemoryQueue();
const adapter = createFakeAiAdapter();
const as = (who: SignedIn = session) => ({ cookies: who.cookies, headers: who.headers });

/** Monday 2 March 2026, 9:00 am in Chicago: slot results don't depend on the day the tests run. */
const NOW = new Date("2026-03-02T15:00:00Z");
const clock = () => NOW;

async function start(
  options: { mapsFail?: boolean; calendar?: typeof calendar.provider; env?: Record<string, string> } = {},
) {
  app = await testApp({
    env: { TOKEN_ENC_KEY, ...options.env },
    clock,
    queue,
    aiAdapter: adapter,
    calendar: options.calendar ?? calendar.provider,
    maps: createFakeMapsProvider({ fail: options.mapsFail === true }),
  });
  session = await signIn(app, ae.email);
}

beforeEach(async () => {
  await resetDatabase();
  queue.sent.length = 0;
  adapter.calls.length = 0;
  calendar = createFakeCalendarProvider();
  ae = await createUser("priya@soa.example", "ae", { name: "Priya Raman" });
  await ownerQuery("UPDATE users SET base_address = '100 Example Plaza, Dallas, TX' WHERE id = $1", [ae.id]);
  const [account] = await ownerQuery<{ id: string }>(
    "INSERT INTO accounts (name, property_type, address_line, city, state, owner_user_id) VALUES ('Harbor Freight Yards', 'Industrial', '2400 Harbor Rd', 'Irving', 'TX', $1) RETURNING id",
    [ae.id],
  );
  accountId = account?.id ?? "";
  const [contact] = await ownerQuery<{ id: string }>(
    "INSERT INTO contacts (account_id, first_name, last_name, title, email, is_primary, contact_pref) VALUES ($1, 'Dana', 'Whitfield', 'Property Manager', 'dana@harbor.example', true, 'Best reached after 2 pm') RETURNING id",
    [accountId],
  );
  expect(contact?.id).toBeDefined();
  const [deal] = await ownerQuery<{ id: string }>(
    "INSERT INTO deals (account_id, owner_user_id, name, stage) VALUES ($1, $2, 'Deal', 'contacted') RETURNING id",
    [accountId, ae.id],
  );
  dealId = deal?.id ?? "";
  await start();
});
afterEach(async () => {
  await app.close();
});

const findTimes = async (kind: "site_walk" | "call" = "site_walk") => {
  const response = await app.inject({
    method: "POST",
    url: `/api/accounts/${accountId}/slots`,
    ...as(),
    payload: { kind, durationMinutes: kind === "site_walk" ? 60 : 30 },
  });
  expect(response.statusCode, response.body).toBe(200);
  return SlotResponse.parse(response.json()).slots;
};
const book = (startIso: string, kind: "site_walk" | "call" = "site_walk") =>
  app.inject({
    method: "POST",
    url: "/api/meetings",
    ...as(),
    payload: { accountId, kind, start: startIso, durationMinutes: kind === "site_walk" ? 60 : 30 },
  });

function workerDeps() {
  const handle = createDb(testDatabaseUrl(), { role: APP_ROLE, max: 2 });
  return {
    handle,
    deps: {
      db: handle.db,
      ai: createAiClient({
        db: handle.db,
        adapter,
        config: { AI_MODEL_WRITER: "w", AI_MODEL_FAST: "f" },
        clock: () => new Date(),
      }),
      calendar: calendar.provider,
      driveTimes: createDriveTimes(createFakeMapsProvider(), clock),
      refresher: createFakeTokenRefresher(),
      cipher: createTokenCipher(TOKEN_ENC_KEY),
      clock,
    },
  };
}

describe("finding times", () => {
  it("returns up to 3 slots with reasons, avoiding the rep's calendar", async () => {
    const slots = await findTimes();
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(3);
    for (const slot of slots) {
      expect(slot.estimated).toBe(false);
      expect(slot.reasons.join(" ")).toMatch(/\d+ min drive from your /);
      expect(slot.reasons).toContain("Matches the contact's afternoon preference");
    }
    const [account] = await ownerQuery<{ lat: number | null }>("SELECT lat FROM accounts");
    expect(account?.lat).not.toBeNull(); // geocoded once and stored
  });

  it("still returns slots, marked estimated, when the maps provider fails", async () => {
    await app.close();
    await start({ mapsFail: true });
    await ownerQuery("UPDATE accounts SET lat = 32.85, lng = -96.95");
    await ownerQuery("UPDATE users SET base_lat = 32.78, base_lng = -96.8");
    const slots = await findTimes();
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => slot.estimated && slot.reasons.includes("Drive time estimated"))).toBe(true);
  });
});

describe("booking (§9.2)", () => {
  it("creates the calendar event with the contact invited, stores it, moves the deal and writes a prep brief", async () => {
    const [slot] = await findTimes();
    const response = await book(slot?.start ?? "");
    expect(response.statusCode, response.body).toBe(201);
    const meeting = Meeting.parse(response.json());
    expect(meeting.contacts.map((contact) => contact.name)).toEqual(["Dana Whitfield"]);

    const [row] = await ownerQuery<{ provider_event_id: string }>("SELECT provider_event_id FROM meetings");
    const event = calendar.events.get(row?.provider_event_id ?? "");
    expect(event).toMatchObject({ title: "Site walk: Harbor Freight Yards", start: slot?.start });
    const [deal] = await ownerQuery<{ stage: string }>("SELECT stage FROM deals WHERE id = $1", [dealId]);
    expect(deal?.stage).toBe("meeting_set");
    expect(queue.sent.map((job) => job.name)).toEqual(["prep.generate"]);

    const { handle, deps } = workerDeps();
    await runPrepGenerate(deps, { meetingId: meeting.id });
    await handle.close();
    const prep = PrepBriefResponse.parse(
      (await app.inject({ method: "GET", url: `/api/meetings/${meeting.id}/prep`, ...as() })).json(),
    );
    expect(prep.sections?.map((section) => section.key)).toEqual([
      "goal",
      "who_you_are_meeting",
      "agenda",
      "questions_to_ask",
      "bring",
      "logistics",
    ]);
    expect(prep.sections?.find((section) => section.key === "logistics")?.text).toMatch(
      /Site walk, .* min drive from your base/,
    );
    expect(prep.pending).toBe(false);
  });

  it("invites the calendar event's attendee from the contact only when the address may be emailed", async () => {
    await ownerQuery("INSERT INTO suppressions (email, reason) VALUES ('dana@harbor.example', 'unsubscribe')");
    const [slot] = await findTimes();
    const response = await book(slot?.start ?? "");
    expect(response.statusCode).toBe(201);
    const [activity] = await ownerQuery<{ subject: string }>("SELECT subject FROM activities WHERE type = 'meeting'");
    expect(activity?.subject).toContain("was not invited");
  });

  it("returns 409 with fresh slots when the time became busy", async () => {
    const [slot] = await findTimes();
    calendar.events.add(ae.id, {
      title: "Dentist",
      start: new Date(slot?.start ?? ""),
      end: new Date(slot?.end ?? ""),
      location: null,
    });
    const response = await book(slot?.start ?? "");
    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: { code: string; details: { slots: { start: string }[] } } }>();
    expect(body.error.code).toBe("slot_taken");
    expect(body.error.details.slots.length).toBeGreaterThan(0);
    expect(body.error.details.slots.map((entry) => entry.start)).not.toContain(slot?.start);
    expect(await ownerQuery("SELECT id FROM meetings")).toHaveLength(0);
  });

  it("can't double-book the same time with two clicks", async () => {
    const [slot] = await findTimes("call");
    const results = await Promise.all([book(slot?.start ?? "", "call"), book(slot?.start ?? "", "call")]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
  });
});

describe("calendar.sync", () => {
  it("reflects a move and a cancellation made in the calendar within one sync", async () => {
    const slots = await findTimes("call");
    const first = Meeting.parse((await book(slots[0]?.start ?? "", "call")).json());
    const second = Meeting.parse((await book(slots[1]?.start ?? "", "call")).json());
    const rows = await ownerQuery<{ id: string; provider_event_id: string }>(
      "SELECT id, provider_event_id FROM meetings",
    );
    const eventOf = (id: string) => rows.find((row) => row.id === id)?.provider_event_id ?? "";
    const newStart = new Date(new Date(first.startsAt).getTime() + 60 * 60_000);
    calendar.events.move(eventOf(first.id), newStart, new Date(newStart.getTime() + 30 * 60_000));
    calendar.events.cancel(eventOf(second.id));

    const { handle, deps } = workerDeps();
    expect(await runCalendarSync(deps, { userId: ae.id })).toEqual({ changed: 2 });
    expect(await runCalendarSync(deps, { userId: ae.id })).toEqual({ changed: 0 });
    await handle.close();
    const after = await ownerQuery<{ id: string; status: string; starts_at: Date }>(
      "SELECT id, status, starts_at FROM meetings",
    );
    expect(after.find((row) => row.id === first.id)?.starts_at.toISOString()).toBe(newStart.toISOString());
    expect(after.find((row) => row.id === second.id)?.status).toBe("cancelled");
  });
});

describe("GET /meetings", () => {
  it("never shows another rep's non-CRM event titles", async () => {
    const other = await createUser("lee@soa.example", "ae");
    const manager = await createUser("max@soa.example", "manager");
    const now = NOW.getTime();
    calendar.events.add(ae.id, {
      title: "Secret lunch with a competitor",
      start: new Date(now + 3600_000),
      end: new Date(now + 7200_000),
      location: null,
    });
    const from = new Date(now - 86_400_000).toISOString();
    const to = new Date(now + 7 * 86_400_000).toISOString();
    const url = (owner: string) =>
      `/api/meetings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&owner=${owner}`;

    const own = MeetingList.parse((await app.inject({ method: "GET", url: url(ae.id), ...as() })).json());
    expect(own.busy.some((block) => block.title === "Secret lunch with a competitor")).toBe(true);

    for (const viewer of [other, manager]) {
      const viewerSession = await signIn(app, viewer.email);
      const response = await app.inject({ method: "GET", url: url(ae.id), ...as(viewerSession) });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("Secret lunch");
    }
    const managerSession = await signIn(app, manager.email);
    const managerView = MeetingList.parse(
      (await app.inject({ method: "GET", url: url(ae.id), ...as(managerSession) })).json(),
    );
    expect(managerView.busy.length).toBeGreaterThan(0);
    expect(managerView.busy.every((block) => block.title === null)).toBe(true);
  });
});

describe("outcomes and the 6 am prep", () => {
  it("marks an outcome with activity and audit, and cancels in the calendar", async () => {
    const [slot] = await findTimes("call");
    const meeting = Meeting.parse((await book(slot?.start ?? "", "call")).json());
    const cancelled = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${meeting.id}`,
      ...as(),
      payload: { status: "cancelled" },
    });
    expect(Meeting.parse(cancelled.json()).status).toBe("cancelled");
    const [row] = await ownerQuery<{ provider_event_id: string }>("SELECT provider_event_id FROM meetings");
    expect(calendar.events.get(row?.provider_event_id ?? "")?.cancelled).toBe(true);
    const audit = await ownerQuery<{ action: string }>(
      "SELECT action FROM audit_log WHERE action LIKE 'meeting.%' ORDER BY created_at",
    );
    expect(audit.map((entry) => entry.action)).toEqual(["meeting.book", "meeting.status"]);
  });

  it("refreshes the prep brief at 6 am on the meeting day", async () => {
    const meetingStart = new Date("2026-03-03T15:00:00Z"); // 9:00 am in Chicago
    const [row] = await ownerQuery<{ id: string }>(
      "INSERT INTO meetings (account_id, owner_user_id, title, kind, starts_at, ends_at) VALUES ($1, $2, 'Call', 'call', $3, $4) RETURNING id",
      [accountId, ae.id, meetingStart, new Date(meetingStart.getTime() + 1800_000)],
    );
    const { handle } = workerDeps();
    expect(await morningPrepDue(handle.db, new Date("2026-03-03T11:30:00Z"))).toEqual([]); // 5:30 am
    expect(await morningPrepDue(handle.db, new Date("2026-03-03T12:10:00Z"))).toEqual([row?.id]); // 6:10 am
    expect(await morningPrepDue(handle.db, new Date("2026-03-02T12:10:00Z"))).toEqual([]); // the day before
    await handle.close();
  });
});

describe("review fixes", () => {
  it("marks slots estimated when the account can't be geocoded because the maps service is down", async () => {
    await app.close();
    await start({ mapsFail: true }); // nothing stored: geocoding itself fails
    const slots = await findTimes();
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.estimated).toBe(true);
      expect(slot.reasons).toContain("Drive time not included: the map service is unavailable");
    }
  });

  it("treats phone and online events as no place to drive from", async () => {
    calendar.events.add(ae.id, {
      title: "Call with a supplier",
      start: new Date("2026-03-03T15:00:00Z"),
      end: new Date("2026-03-03T15:30:00Z"),
      location: "Microsoft Teams Meeting",
    });
    const slots = await findTimes();
    expect(slots.flatMap((slot) => slot.reasons).join(" ")).not.toContain("Call with a supplier");
  });

  it("still lists CRM meetings when the calendar can't be read", async () => {
    await app.close();
    const broken = { ...calendar.provider, listEvents: () => Promise.reject(new Error("Graph 503")) };
    await start({ calendar: broken });
    await ownerQuery(
      "INSERT INTO meetings (account_id, owner_user_id, title, kind, starts_at, ends_at) VALUES ($1, $2, 'Call', 'call', $3, $4)",
      [accountId, ae.id, new Date("2026-03-04T15:00:00Z"), new Date("2026-03-04T15:30:00Z")],
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/meetings?from=${encodeURIComponent("2026-03-01T00:00:00Z")}&to=${encodeURIComponent("2026-03-08T00:00:00Z")}`,
      ...as(),
    });
    expect(response.statusCode).toBe(200);
    const body = MeetingList.parse(response.json());
    expect(body.calendarRead).toBe(false);
    expect(body.meetings).toHaveLength(1);
  });

  it("doesn't invite a do-not-contact account's contact, and says so", async () => {
    await ownerQuery("UPDATE accounts SET do_not_contact = true");
    const [slot] = await findTimes("call");
    const booked = BookedMeeting.parse((await book(slot?.start ?? "", "call")).json());
    expect(booked.invited).toBe(false);
  });

  it("asks for the morning prep once per meeting, even when it fails", async () => {
    const meetingStart = new Date("2026-03-03T19:00:00Z"); // 1 pm in Chicago
    await ownerQuery(
      "INSERT INTO meetings (account_id, owner_user_id, title, kind, starts_at, ends_at) VALUES ($1, $2, 'Call', 'call', $3, $4)",
      [accountId, ae.id, meetingStart, new Date(meetingStart.getTime() + 1800_000)],
    );
    const { handle } = workerDeps();
    const jobs = createMemoryQueue();
    expect(await queueMorningPrep(handle.db, jobs, new Date("2026-03-03T12:10:00Z"))).toBe(1);
    // The job failed (no prep stored); five minutes later nothing is asked again.
    expect(await queueMorningPrep(handle.db, jobs, new Date("2026-03-03T12:15:00Z"))).toBe(0);
    expect(await queueMorningPrep(handle.db, jobs, new Date("2026-03-03T18:00:00Z"))).toBe(0);
    await handle.close();
    expect(jobs.sent).toHaveLength(1);
  });

  it("checks moves and outcomes", async () => {
    const slots = await findTimes("call");
    const first = Meeting.parse((await book(slots[0]?.start ?? "", "call")).json());
    const second = Meeting.parse((await book(slots[1]?.start ?? "", "call")).json());
    const patch = (payload: Record<string, string>) =>
      app.inject({ method: "PATCH", url: `/api/meetings/${first.id}`, ...as(), payload });
    expect((await patch({ status: "done" })).statusCode).toBe(409); // not started yet
    expect((await patch({ startsAt: second.startsAt, endsAt: second.endsAt })).statusCode).toBe(409); // taken
    expect((await patch({ status: "cancelled", startsAt: second.startsAt, endsAt: second.endsAt })).statusCode).toBe(
      400,
    );
  });

  it("writes an audit row when the calendar moves a meeting, and dates in the rep's time zone", async () => {
    await ownerQuery("UPDATE users SET timezone = 'America/Los_Angeles' WHERE id = $1", [ae.id]);
    const [slot] = await findTimes("call");
    const meeting = Meeting.parse((await book(slot?.start ?? "", "call")).json());
    const [row] = await ownerQuery<{ provider_event_id: string }>("SELECT provider_event_id FROM meetings");
    // 4:30 pm in Los Angeles on Tuesday 3 March is already Wednesday in UTC.
    const later = new Date("2026-03-04T00:30:00Z");
    calendar.events.move(row?.provider_event_id ?? "", later, new Date(later.getTime() + 1800_000));
    const { handle, deps } = workerDeps();
    await runCalendarSync(deps, { userId: ae.id });
    await handle.close();
    const [moved] = await ownerQuery<{ subject: string }>(
      "SELECT subject FROM activities WHERE meta->>'fromCalendar' = 'true'",
    );
    expect(moved?.subject).toContain("4:30 pm, 2026-03-03");
    const audit = await ownerQuery<{ action: string }>(
      "SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY created_at",
      [meeting.id],
    );
    expect(audit.map((entry) => entry.action)).toEqual(["meeting.book", "meeting.move"]);
  });
});

describe("security review fixes", () => {
  it("staging (MAIL_ALLOWLIST) never invites an address outside the list", async () => {
    await app.close();
    await start({ env: { MAIL_ALLOWLIST: "tester@soa.example" } });
    const [slot] = await findTimes("call");
    const booked = BookedMeeting.parse((await book(slot?.start ?? "", "call")).json());
    expect(booked.invited).toBe(false);
  });
});
