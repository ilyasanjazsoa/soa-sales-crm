import type { Database, Executor } from "@soa/db";
import {
  findSlots,
  formatTime,
  localParts,
  MEETING_KIND_LABELS,
  PREP_SECTIONS,
  PrepBriefOutput,
  prepProblems,
  zonedTime,
  type BookedMeeting,
  type BookMeetingRequest,
  type BusyBlock,
  type Drive,
  type LatLng,
  type Meeting,
  type MeetingList,
  type MeetingPatch,
  type PrepBriefResponse,
  type SlotOption,
  type SlotRequest,
} from "@soa/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TokenCipher } from "../auth/crypto";
import type { Clock } from "../clock";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors";
import { JOBS, type JobQueue } from "../jobs/queue";
import { AiOutputError, type AiClient } from "../providers/ai/client";
import { prepBriefPrompt } from "../providers/ai/prompts";
import type { CalendarAccount, CalendarEvent, CalendarProvider } from "../providers/calendar/types";
import type { DriveTimes } from "../providers/maps/cache";
import { MailAuthError } from "../providers/mail/types";
import { accountsRepo, type AccountRow } from "../repos/accounts";
import { auditRepo } from "../repos/audit";
import { activitiesRepo, contactsRepo, signalsRepo } from "../repos/children";
import { dealsRepo } from "../repos/deals";
import { locationsRepo, meetingsRepo, type MeetingRow } from "../repos/meetings";
import { mailAccountsRepo, suppressionListRepo } from "../repos/outreach";
import { referencesRepo, researchRepo } from "../repos/research";
import { systemScope, userScope, type Scope, type UserScope } from "../repos/scope";
import { usersRepo, type UserRow } from "../repos/users";
import { advanceDeal } from "./advance";
import { accessTokenFor, type TokenRefresher } from "./oauth-tokens";

/* Meetings (ARCHITECTURE.md §9): finding times, booking, the calendar view, outcomes, calendar.sync and the prep
   brief. Other reps' non-CRM calendar titles are never returned (§13 GET /meetings). Dates and times shown to a rep
   are in their own time zone. */

export interface MeetingDeps {
  db: Database;
  queue: JobQueue;
  ai: AiClient;
  calendar: CalendarProvider;
  driveTimes: DriveTimes;
  refresher: TokenRefresher;
  cipher: TokenCipher;
  clock: Clock;
  /** Staging (MAIL_ALLOWLIST): an invite is an email, so only allow-listed addresses are invited. */
  allowlist?: readonly string[] | null;
}

const LOOKAHEAD_MS = 16 * 24 * 60 * 60 * 1000; // 10 business days and the weekends between
const RECONNECT = "Reconnect your calendar (sign out and sign in again) to find and book times.";
const reconnect = () => conflict("reconnect_calendar", RECONNECT);

/** Phone, video and online meetings have no place to drive to (§9.1: treated as at the base). */
const VIRTUAL =
  /^\s*(phone|phone call|call|video|video call|online|microsoft teams( meeting)?|teams( meeting)?|zoom( meeting)?|google meet|webex)\b|https?:\/\//i;

const fullAddress = (account: AccountRow) =>
  [account.addressLine, account.city, account.state, account.postalCode]
    .filter((part) => part !== null && part !== "")
    .join(", ");
const hhmm = (time: string) => time.slice(0, 5);

/** YYYY-MM-DD of an instant in the zone. */
export const localDay = (date: Date, timeZone: string) => {
  const p = localParts(date, timeZone);
  return `${String(p.year)}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};
const startOfLocalDay = (date: Date, timeZone: string) => {
  const p = localParts(date, timeZone);
  return zonedTime(p.year, p.month, p.day, 0, 0, timeZone);
};

/** The rep's calendar account (a valid token), or 409 when they must reconnect. */
async function calendarAccount(deps: MeetingDeps, user: Pick<UserRow, "id" | "timezone">): Promise<CalendarAccount> {
  const token = await accessTokenFor(deps, user.id);
  if (token === "reconnect") throw reconnect();
  return { accessToken: token.accessToken, userId: user.id, timeZone: user.timezone };
}

/** Wraps provider calls: an auth failure marks the connection for reconnecting (same consent) and returns 409. */
async function withCalendar<T>(
  deps: MeetingDeps,
  user: Pick<UserRow, "id" | "timezone">,
  run: (account: CalendarAccount) => Promise<T>,
): Promise<T> {
  const account = await calendarAccount(deps, user);
  try {
    return await run(account);
  } catch (error) {
    if (error instanceof MailAuthError) {
      await mailAccountsRepo(deps.db).update(systemScope("calendar auth"), user.id, "microsoft", {
        needsReconnect: true,
      });
      throw reconnect();
    }
    throw error;
  }
}

/** Thrown inside the booking transaction when the time is taken; fresh slots are found after it rolls back. */
class SlotTaken extends Error {}

export function createMeetingsService(deps: MeetingDeps) {
  const { db, queue, calendar, driveTimes, clock } = deps;

  const requireEditable = async (scope: UserScope, accountId: string) => {
    const account = await accountsRepo(db).getEditable(scope, accountId);
    if (account !== undefined) return account;
    if ((await accountsRepo(db).get(scope, accountId)) !== undefined) {
      throw forbidden("Claim this account to book a meeting.");
    }
    throw notFound();
  };

  const rep = async (scope: UserScope): Promise<UserRow> => {
    const user = await usersRepo(db).findById(scope, scope.userId);
    if (user === undefined) throw notFound();
    return user;
  };

  /** Coordinates, geocoding and storing them the first time. Null: no address. Undefined: the map service failed. */
  const siteOf = async (account: AccountRow): Promise<LatLng | null | undefined> => {
    if (account.lat !== null && account.lng !== null) return { lat: account.lat, lng: account.lng };
    const address = fullAddress(account);
    if (address === "") return null;
    const found = await driveTimes.geocode(address);
    if (found == null) return found;
    await locationsRepo(db).setAccount(systemScope("geocode"), account.id, found.lat, found.lng);
    return found;
  };
  const baseOf = async (user: UserRow): Promise<LatLng | null | undefined> => {
    if (user.baseLat !== null && user.baseLng !== null) return { lat: user.baseLat, lng: user.baseLng };
    if (user.baseAddress === null) return null;
    const found = await driveTimes.geocode(user.baseAddress);
    if (found == null) return found;
    await locationsRepo(db).setUserBase(systemScope("geocode"), user.id, found.lat, found.lng);
    return found;
  };

  /** Steps 1 to 6 of §9.1 with real data: the rep's calendar, geocoded places and a filled drive-time table. */
  const slotsFor = async (
    scope: UserScope,
    account: AccountRow,
    request: SlotRequest,
    contactPref: string | null,
  ): Promise<SlotOption[]> => {
    const now = clock();
    const user = await rep(scope);
    // From the start of today, so an event earlier today can still be "the previous stop".
    const from = startOfLocalDay(now, user.timezone);
    const to = new Date(now.getTime() + LOOKAHEAD_MS);
    const events = await withCalendar(deps, user, (account_) => calendar.listEvents(account_, from, to));
    const travels = request.kind === "site_walk";
    const [site, base] = travels ? await Promise.all([siteOf(account), baseOf(user)]) : [null, null];
    const mapsDown = travels && (site === undefined || base === undefined);

    // Where the rep's other events are: CRM site walks have stored coordinates; phone and online events have none.
    const crm = new Map(
      (await meetingsRepo(db).between(scope, from, to, user.id)).flatMap((row) =>
        row.meeting.providerEventId === null
          ? []
          : [
              [
                row.meeting.providerEventId,
                row.meeting.lat !== null && row.meeting.lng !== null
                  ? { lat: row.meeting.lat, lng: row.meeting.lng }
                  : null,
              ] as const,
            ],
      ),
    );
    const located = await Promise.all(
      events
        .filter((event) => !event.cancelled)
        .map(async (event) => {
          let location: LatLng | null = null;
          if (travels && crm.has(event.id)) location = crm.get(event.id) ?? null;
          else if (travels && event.location !== null && !VIRTUAL.test(event.location)) {
            location = (await driveTimes.geocode(event.location)) ?? null;
          }
          return { start: event.start, end: event.end, title: event.title, location };
        }),
    );

    // Drive times by time of day: morning rush, midday and evening rush on the next business day (cached 24 h).
    const table = new Map<string, Drive>();
    const key = (a: LatLng, b: LatLng, band: number) =>
      `${String(a.lat)},${String(a.lng)}>${String(b.lat)},${String(b.lng)}@${String(band)}`;
    const BANDS = [8, 12, 17];
    const band = (date: Date) => {
      const hour = localParts(date, user.timezone).hour;
      return hour < 10 ? 8 : hour < 15 ? 12 : 17;
    };
    if (travels && site != null) {
      const p = localParts(new Date(now.getTime() + 86_400_000), user.timezone);
      const origins = [base ?? null, ...located.map((event) => event.location)].filter(
        (place): place is LatLng => place !== null,
      );
      const pairs: [LatLng, LatLng][] = [
        ...origins.map((origin): [LatLng, LatLng] => [origin, site]),
        ...located.flatMap((event): [LatLng, LatLng][] => (event.location === null ? [] : [[site, event.location]])),
      ];
      await Promise.all(
        pairs.flatMap(([a, b]) =>
          BANDS.map(async (hour) => {
            if (table.has(key(a, b, hour))) return;
            table.set(
              key(a, b, hour),
              await driveTimes.drive(a, b, zonedTime(p.year, p.month, p.day, hour, 0, user.timezone)),
            );
          }),
        ),
      );
    }
    const slots = findSlots({
      now,
      timeZone: user.timezone,
      workdayStart: hhmm(user.workdayStart),
      workdayEnd: hhmm(user.workdayEnd),
      durationMinutes: request.durationMinutes,
      travels,
      base: base ?? null,
      site: site ?? null,
      busy: located,
      preference: contactPref,
      driveMinutes: (a, b, departAt) => table.get(key(a, b, band(departAt))) ?? { minutes: 0, estimated: true },
    });
    return slots.map((slot) => ({
      start: slot.start.toISOString(),
      end: slot.end.toISOString(),
      // The map service failed before any drive could be measured: say so instead of offering a time as if near.
      reasons: mapsDown ? [...slot.reasons, "Drive time not included: the map service is unavailable"] : slot.reasons,
      estimated: slot.estimated || mapsDown,
      driveInMinutes: slot.driveInMinutes,
    }));
  };

  const primaryContact = async (scope: UserScope, accountId: string, contactId: string | undefined) => {
    const list = await contactsRepo(db).listForAccount(scope, accountId);
    if (contactId !== undefined) {
      const found = list.find((contact) => contact.id === contactId);
      if (found === undefined) throw notFound("That contact isn't on this account.");
      return found;
    }
    return list.find((contact) => contact.isPrimary) ?? list[0];
  };

  const toMeeting = async (
    tx: Executor,
    scope: Scope,
    row: { meeting: MeetingRow; accountName: string | null; ownerName: string },
  ): Promise<Meeting> => {
    const people = await meetingsRepo(tx).contactsOf(scope, row.meeting.contactIds);
    return {
      id: row.meeting.id,
      accountId: row.meeting.accountId,
      accountName: row.accountName,
      dealId: row.meeting.dealId,
      owner: { id: row.meeting.ownerUserId, name: row.ownerName },
      title: row.meeting.title,
      kind: row.meeting.kind,
      status: row.meeting.status,
      startsAt: row.meeting.startsAt.toISOString(),
      endsAt: row.meeting.endsAt.toISOString(),
      locationText: row.meeting.locationText,
      contacts: people.map((person) => ({
        id: person.id,
        name: `${person.firstName} ${person.lastName}`.trim(),
        email: person.email,
      })),
      hasPrep: row.meeting.prepBrief !== null,
    };
  };

  /** Whether [start, end) is free for the rep in the CRM and in the calendar (ignoring one event, when moving it). */
  const isFree = async (tx: Executor, scope: UserScope, user: UserRow, start: Date, end: Date, ignore?: MeetingRow) => {
    const crm = (await meetingsRepo(tx).overlapping(scope, user.id, start, end)).filter((row) => row.id !== ignore?.id);
    if (crm.length > 0) return false;
    const events = await withCalendar(deps, user, (account) =>
      calendar.listEvents(account, new Date(start.getTime() - 60_000), new Date(end.getTime() + 60_000)),
    );
    return !events.some(
      (event) => !event.cancelled && event.id !== ignore?.providerEventId && event.start < end && event.end > start,
    );
  };

  return {
    async slots(scope: UserScope, accountId: string, request: SlotRequest): Promise<SlotOption[]> {
      const account = await requireEditable(scope, accountId);
      const contact = await primaryContact(scope, accountId, undefined);
      return slotsFor(scope, account, request, contact?.contactPref ?? null);
    },

    /** §9.2: re-check the slot, create the calendar event with the contact invited, store, advance, queue the prep. */
    async book(scope: UserScope, request: BookMeetingRequest, ip: string | null): Promise<BookedMeeting> {
      const now = clock();
      const account = await requireEditable(scope, request.accountId);
      const contact = await primaryContact(scope, request.accountId, request.contactId);
      const start = new Date(request.start);
      const end = new Date(start.getTime() + request.durationMinutes * 60_000);
      if (start.getTime() < now.getTime()) throw unprocessable("in_the_past", "That time has already passed.");
      const user = await rep(scope);
      const createdEvent: { id: string | null } = { id: null };
      let invited = false;

      let meeting: MeetingRow;
      try {
        meeting = await db.transaction(async (tx) => {
          // One booking at a time per rep, so two clicks can't both take the same free time.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`book:${scope.userId}`}))`);
          if (!(await isFree(tx, scope, user, start, end))) throw new SlotTaken();

          // The invite is an email from Microsoft 365: never to a suppressed, bounced or unsubscribed address, or a
          // do-not-contact account (rule 7).
          invited =
            contact?.email != null &&
            contact.emailStatus === "ok" &&
            !account.doNotContact &&
            (deps.allowlist == null || deps.allowlist.includes(contact.email.toLowerCase())) &&
            (await suppressionListRepo(tx).reason(scope, contact.email)) === null;
          const title = `${MEETING_KIND_LABELS[request.kind]}: ${account.name}`;
          const location =
            request.kind === "site_walk"
              ? fullAddress(account) || account.name
              : request.kind === "call"
                ? "Phone"
                : "Video call";
          const created = await withCalendar(deps, user, (calendarAccountValue) =>
            calendar.createEvent(calendarAccountValue, {
              title,
              start,
              end,
              location,
              body: `${MEETING_KIND_LABELS[request.kind]} with ${user.name}, ${user.title}, Security Of America.${user.phone === null ? "" : ` ${user.phone}`}`,
              attendees:
                invited && contact?.email != null
                  ? [{ email: contact.email, name: `${contact.firstName} ${contact.lastName}`.trim() }]
                  : [],
            }),
          );
          createdEvent.id = created.id;
          const deal = await dealsRepo(tx).currentForAccount(scope, request.accountId);
          const row = await meetingsRepo(tx).insert(scope, {
            accountId: request.accountId,
            dealId: deal?.deal.status === "open" ? deal.deal.id : null,
            ownerUserId: scope.userId,
            contactIds: contact === undefined ? [] : [contact.id],
            title,
            kind: request.kind,
            startsAt: start,
            endsAt: end,
            locationText: location,
            lat: request.kind === "site_walk" ? account.lat : null,
            lng: request.kind === "site_walk" ? account.lng : null,
            provider: "microsoft",
            providerEventId: created.id,
          });
          const who = contact === undefined ? "" : `${contact.firstName} ${contact.lastName}`.trim();
          await activitiesRepo(tx).insert(scope, {
            accountId: request.accountId,
            dealId: row.dealId,
            contactId: contact?.id ?? null,
            type: "meeting",
            subject: `${title} booked for ${formatTime(start, user.timezone)}, ${localDay(start, user.timezone)}${
              who === ""
                ? ""
                : invited
                  ? `. Invite sent to ${who}`
                  : `. ${who} was not invited (their email can't be used)`
            }`,
            meta: { meetingId: row.id, kind: request.kind, invited },
          });
          await auditRepo(tx).write(scope, {
            action: "meeting.book",
            entityType: "meeting",
            entityId: row.id,
            meta: { accountId: request.accountId, kind: request.kind },
            ip,
          });
          await advanceDeal(tx, scope, request.accountId, "meeting_set", "meeting_booked", now);
          return row;
        });
      } catch (error) {
        // The transaction (or its commit) failed after the event was made: don't leave it in the rep's calendar.
        const orphan = createdEvent.id;
        if (orphan !== null) {
          await withCalendar(deps, user, (account_) =>
            calendar.cancelEvent(account_, orphan, "Booking could not be saved."),
          ).catch(() => undefined);
        }
        if (error instanceof SlotTaken) {
          // Fresh times, found after the lock and connection are released.
          const fresh = await slotsFor(
            scope,
            account,
            { kind: request.kind, durationMinutes: request.durationMinutes },
            contact?.contactPref ?? null,
          ).catch(() => []);
          throw new HttpError(409, "slot_taken", "That time was just taken. Here are fresh times.", { slots: fresh });
        }
        throw error;
      }

      await activitiesRepo(db).insert(scope, {
        accountId: request.accountId,
        type: "note",
        subject: "Meeting prep brief requested",
        meta: { job: JOBS.prepGenerate, state: "requested", meetingId: meeting.id },
      });
      await queue.send(JOBS.prepGenerate, { meetingId: meeting.id });
      const row = await meetingsRepo(db).get(scope, meeting.id);
      if (row === undefined) throw notFound();
      return { ...(await toMeeting(db, scope, row)), invited };
    },

    /** CRM meetings plus busy blocks. Titles of non-CRM events are shown only to the calendar's owner. */
    async list(
      scope: UserScope,
      query: { from: string; to: string; owner?: string | undefined },
    ): Promise<MeetingList> {
      const from = new Date(query.from);
      const to = new Date(query.to);
      if (to.getTime() - from.getTime() > 62 * 24 * 3600_000 || to <= from) {
        throw unprocessable("bad_range", "Ask for at most two months at a time.");
      }
      const ownerId = scope.role === "ae" ? scope.userId : (query.owner ?? scope.userId);
      const rows = await meetingsRepo(db).between(scope, from, to, ownerId);
      const meetings = await Promise.all(rows.map((row) => toMeeting(db, scope, row)));

      let busy: BusyBlock[] = [];
      let calendarRead = true;
      try {
        // AEs only ever ask for themselves (above); managers may look at any rep's calendar, titles hidden.
        const owner = await usersRepo(db).findById(systemScope("calendar owner"), ownerId);
        if (owner === undefined) throw notFound();
        const events = await withCalendar(deps, owner, (account) => calendar.listEvents(account, from, to));
        const crmEventIds = new Set(rows.map((row) => row.meeting.providerEventId).filter((id) => id !== null));
        const ownCalendar = ownerId === scope.userId;
        busy = events
          .filter((event) => !event.cancelled && !crmEventIds.has(event.id))
          .map((event) => ({
            start: event.start.toISOString(),
            end: event.end.toISOString(),
            title: ownCalendar ? event.title : null,
          }));
      } catch {
        // Any calendar problem (reconnect, outage, timeout): still show the CRM meetings.
        calendarRead = false;
      }
      return { meetings, busy, calendarRead };
    },

    async patch(scope: UserScope, id: string, patch: MeetingPatch, ip: string | null): Promise<Meeting> {
      const now = clock();
      const user = await rep(scope);
      await db.transaction(async (tx) => {
        const meeting = await meetingsRepo(tx).lockOwn(scope, id);
        if (meeting === undefined) throw notFound();
        if (meeting.status !== "scheduled") throw conflict("not_scheduled", "This meeting is no longer scheduled.");
        const values: Partial<MeetingRow> = {};
        let subject: string;
        if (patch.startsAt !== undefined && patch.endsAt !== undefined) {
          const start = new Date(patch.startsAt);
          const end = new Date(patch.endsAt);
          if (end <= start) throw unprocessable("bad_times", "The meeting must end after it starts.");
          if (start < now) throw unprocessable("in_the_past", "That time has already passed.");
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`book:${scope.userId}`}))`);
          if (!(await isFree(tx, scope, user, start, end, meeting))) {
            throw conflict("slot_taken", "That time is taken in your calendar.");
          }
          if (meeting.providerEventId !== null) {
            const eventId = meeting.providerEventId;
            await withCalendar(deps, user, (account) => calendar.updateEvent(account, eventId, { start, end }));
          }
          values.startsAt = start;
          values.endsAt = end;
          subject = `${meeting.title} moved to ${formatTime(start, user.timezone)}, ${localDay(start, user.timezone)}`;
        } else {
          const status = patch.status ?? "done";
          if (status === "cancelled") {
            if (meeting.providerEventId !== null && meeting.startsAt > now) {
              const eventId = meeting.providerEventId;
              await withCalendar(deps, user, (account) =>
                calendar.cancelEvent(account, eventId, "Cancelled from the CRM."),
              );
            }
          } else if (meeting.startsAt > now) {
            throw conflict("not_started", "An outcome can be set once the meeting has started.");
          }
          values.status = status;
          subject = `${meeting.title}: marked ${status.replace("_", " ")}`;
        }
        await meetingsRepo(tx).update(scope, id, values);
        if (meeting.accountId !== null) {
          await activitiesRepo(tx).insert(scope, {
            accountId: meeting.accountId,
            dealId: meeting.dealId,
            type: "meeting",
            subject,
            meta: { meetingId: id, ...(values.status === undefined ? { moved: true } : { status: values.status }) },
          });
          await dealsRepo(tx).touch(scope, meeting.accountId);
        }
        await auditRepo(tx).write(scope, {
          action: values.status === undefined ? "meeting.move" : "meeting.status",
          entityType: "meeting",
          entityId: id,
          meta: values.status === undefined ? {} : { status: values.status },
          ip,
        });
      });
      const row = await meetingsRepo(db).get(scope, id);
      if (row === undefined) throw notFound();
      return toMeeting(db, scope, row);
    },

    async prep(scope: UserScope, id: string): Promise<PrepBriefResponse> {
      const row = await meetingsRepo(db).get(scope, id);
      if (row === undefined) throw notFound();
      const state =
        row.meeting.accountId === null ? undefined : await prepJobState(db, scope, row.meeting.accountId, id, clock());
      const sections =
        row.meeting.prepBrief === null
          ? null
          : z
              .array(z.object({ key: z.string(), heading: z.string(), text: z.string() }))
              .catch([])
              .parse(row.meeting.prepBrief);
      const writtenAt = await meetingsRepo(db).prepWrittenAt(scope, row.meeting.prepAiCallId);
      return {
        sections,
        generatedAt: sections === null ? null : (writtenAt ?? row.meeting.updatedAt).toISOString(),
        pending: state?.pending ?? false,
        lastError: state?.lastError ?? null,
      };
    },

    async regeneratePrep(scope: UserScope, id: string): Promise<void> {
      await db.transaction(async (tx) => {
        const meeting = await meetingsRepo(tx).lockOwn(scope, id);
        if (meeting?.accountId == null) throw notFound();
        if ((await prepJobState(tx, scope, meeting.accountId, id, clock())).pending) {
          throw conflict("already_running", "The prep brief is already being written.");
        }
        await deps.ai.assertWithinLimit(scope.userId);
        await activitiesRepo(tx).insert(scope, {
          accountId: meeting.accountId,
          type: "note",
          subject: "Meeting prep brief requested",
          meta: { job: JOBS.prepGenerate, state: "requested", meetingId: id },
        });
      });
      await queue.send(JOBS.prepGenerate, { meetingId: id });
    },
  };
}

export type MeetingsService = ReturnType<typeof createMeetingsService>;

const PREP_STALE_MS = 10 * 60 * 1000;

/** The latest prep job outcome for this meeting, from its timeline events (as research jobs do). */
async function prepJobState(db: Executor, scope: Scope, accountId: string, meetingId: string, now: Date) {
  const event = await researchRepo(db).lastJobEvent(scope, accountId, JOBS.prepGenerate, { meetingId });
  if (event === undefined) return { pending: false, lastError: null };
  if (event.meta.state === "requested") {
    return now.getTime() - event.occurredAt.getTime() < PREP_STALE_MS
      ? { pending: true, lastError: null }
      : { pending: false, lastError: "That took too long and was stopped. Try again." };
  }
  if (event.meta.state === "failed") {
    return { pending: false, lastError: typeof event.meta.message === "string" ? event.meta.message : "Try again." };
  }
  return { pending: false, lastError: null };
}

// ───────── jobs (worker) ─────────

/** calendar.sync: reflects moves and cancellations made in the calendar on the user's CRM meetings. */
export async function runCalendarSync(
  deps: Pick<MeetingDeps, "db" | "calendar" | "refresher" | "cipher" | "clock">,
  job: { userId: string },
): Promise<{ changed: number }> {
  const scope = systemScope("calendar.sync");
  const token = await accessTokenFor(deps, job.userId);
  if (token === "reconnect") return { changed: 0 };
  const user = await usersRepo(deps.db).findById(scope, job.userId);
  const timeZone = user?.timezone ?? "America/Chicago";
  const account = { accessToken: token.accessToken, userId: job.userId, timeZone };
  const meetings = await meetingsRepo(deps.db).forSync(
    scope,
    job.userId,
    new Date(deps.clock().getTime() - 86_400_000),
  );
  let changed = 0;
  for (const meeting of meetings) {
    if (meeting.providerEventId === null) continue;
    let event: CalendarEvent | null;
    try {
      event = await deps.calendar.getEvent(account, meeting.providerEventId);
    } catch (error) {
      if (error instanceof MailAuthError) {
        await mailAccountsRepo(deps.db).update(scope, job.userId, token.provider, { needsReconnect: true });
        return { changed };
      }
      throw error;
    }
    const cancelled = event === null || event.cancelled;
    const moved =
      event !== null &&
      !cancelled &&
      (event.start.getTime() !== meeting.startsAt.getTime() || event.end.getTime() !== meeting.endsAt.getTime());
    if (!cancelled && !moved) continue;
    changed += 1;
    await deps.db.transaction(async (tx) => {
      const values = cancelled ? { status: "cancelled" as const } : { startsAt: event?.start, endsAt: event?.end };
      await meetingsRepo(tx).update(scope, meeting.id, values);
      const at = event?.start ?? meeting.startsAt;
      if (meeting.accountId !== null) {
        await activitiesRepo(tx).insert(scope, {
          accountId: meeting.accountId,
          dealId: meeting.dealId,
          type: "meeting",
          subject: cancelled
            ? `${meeting.title} was cancelled in the calendar`
            : `${meeting.title} was moved in the calendar to ${formatTime(at, timeZone)}, ${localDay(at, timeZone)}`,
          meta: {
            meetingId: meeting.id,
            fromCalendar: true,
            ...(cancelled ? { status: "cancelled" } : { moved: true }),
          },
        });
      }
      await auditRepo(tx).write(scope, {
        action: cancelled ? "meeting.status" : "meeting.move",
        entityType: "meeting",
        entityId: meeting.id,
        meta: { fromCalendar: true, ...(cancelled ? { status: "cancelled" } : {}) },
      });
    });
  }
  return { changed };
}

/** prep.generate: the prep brief, from stored data only. Logistics are written by code. Always records an outcome. */
export async function runPrepGenerate(
  deps: Pick<MeetingDeps, "db" | "ai" | "driveTimes" | "clock">,
  job: { meetingId: string },
): Promise<void> {
  const { db, ai, clock } = deps;
  const system = systemScope("prep.generate");
  const found = await meetingsRepo(db).get(system, job.meetingId);
  if (found?.meeting.accountId == null) return;
  const accountId = found.meeting.accountId;
  const owner = await usersRepo(db).findById(system, found.meeting.ownerUserId);
  const record = (scope: Scope, state: "done" | "failed", message: string) =>
    activitiesRepo(db).insert(scope, {
      accountId,
      type: "note",
      subject: message,
      meta: { job: JOBS.prepGenerate, state, message, meetingId: job.meetingId },
    });
  if (owner?.active !== true) {
    await record(system, "failed", "Prep brief stopped: the meeting owner is no longer active.");
    return;
  }
  const scope = userScope(owner.id, owner.role);
  const zone = owner.timezone;
  try {
    const row = await meetingsRepo(db).get(scope, job.meetingId);
    if (row === undefined) throw new JobStopped("Prep brief stopped: the account is no longer visible to its owner.");
    const meeting = row.meeting;
    const accountRow = await accountsRepo(db).get(scope, accountId);
    if (accountRow === undefined)
      throw new JobStopped("Prep brief stopped: the account is no longer visible to its owner.");
    const account = accountRow.account;
    const people = await meetingsRepo(db).contactsOf(scope, meeting.contactIds);
    const signals = await signalsRepo(db).listForAccount(scope, accountId);
    const brief = await researchRepo(db).brief(scope, accountId, undefined);
    const reference = await referencesRepo(db).bestFor(scope, account.propertyType);
    const deal = await dealsRepo(db).currentForAccount(scope, accountId);
    const contactRows = await contactsRepo(db).listForAccount(scope, accountId);
    const titles = new Map(contactRows.map((contact) => [contact.id, contact.title]));
    const durationMinutes = Math.round((meeting.endsAt.getTime() - meeting.startsAt.getTime()) / 60_000);
    const startsLocal = `${localDay(meeting.startsAt, zone)} ${formatTime(meeting.startsAt, zone)}`;
    const result = await ai.generate({
      feature: "prep_brief",
      tier: "writer",
      ...prepBriefPrompt({
        today: localDay(clock(), zone),
        meeting: { kind: meeting.kind, startsLocal, durationMinutes, location: meeting.locationText },
        account: {
          name: account.name,
          propertyType: account.propertyType,
          city: account.city,
          currentProvider: account.currentProvider,
          contractTiming: account.contractTiming,
        },
        attendees: people.map((person) => ({
          name: `${person.firstName} ${person.lastName}`.trim(),
          title: titles.get(person.id) ?? null,
        })),
        dealStage: deal?.deal.stage ?? null,
        signals: signals.slice(0, 8).map((signal) => ({ text: signal.text, confirmed: signal.confirmed })),
        research: z
          .array(z.object({ key: z.string(), heading: z.string(), text: z.string() }))
          .catch([])
          .parse(brief?.brief.sections ?? [])
          .filter((section) => section.key !== "proof_point_internal")
          .map((section) => ({ heading: section.heading, text: section.text })),
        reference: reference === undefined ? null : { label: reference.labelAnonymized, stats: reference.stats },
      }),
      schema: PrepBriefOutput,
      userId: owner.id,
      check: prepProblems,
    });

    // Logistics: written by code from the meeting and the drive time (§7.3).
    let drive = "";
    if (
      meeting.kind === "site_walk" &&
      meeting.lat !== null &&
      meeting.lng !== null &&
      owner.baseLat !== null &&
      owner.baseLng !== null
    ) {
      const minutes = await deps.driveTimes.drive(
        { lat: owner.baseLat, lng: owner.baseLng },
        { lat: meeting.lat, lng: meeting.lng },
        meeting.startsAt,
      );
      drive = ` About ${String(minutes.minutes)} min drive from your base${minutes.estimated ? " (estimated)" : ""}; leave by ${formatTime(new Date(meeting.startsAt.getTime() - (minutes.minutes + 10) * 60_000), zone)}.`;
    }
    const logistics = `${MEETING_KIND_LABELS[meeting.kind]}, ${startsLocal} to ${formatTime(meeting.endsAt, zone)} (${String(durationMinutes)} min).${meeting.locationText === null ? "" : ` ${meeting.locationText}.`}${drive}`;
    const sections = PREP_SECTIONS.map((section) => ({
      key: section.key,
      heading: section.heading,
      text:
        section.key === "logistics"
          ? logistics
          : (result.data.sections.find((entry) => entry.key === section.key)?.text ?? ""),
    }));
    await meetingsRepo(db).update(scope, meeting.id, { prepBrief: sections, prepAiCallId: result.aiCallId });
    await record(scope, "done", `Prep brief ready for ${meeting.title}`);
  } catch (error) {
    const message =
      error instanceof JobStopped
        ? error.message
        : error instanceof HttpError && error.statusCode === 429
          ? "Prep brief not written: today's AI limit is used up."
          : error instanceof AiOutputError
            ? "Prep brief not written: the AI's answer couldn't be used. Try again."
            : "Prep brief not written. Try again.";
    await record(scope, "failed", message).catch(() => undefined);
    if (!(error instanceof HttpError) && !(error instanceof AiOutputError) && !(error instanceof JobStopped))
      throw error;
  }
}

class JobStopped extends Error {}

/** The 6 am refresh (§14): meetings today, in the owner's time zone, whose prep was written before 6 am today and
    that haven't been asked for since then. One attempt per meeting per morning, whether it works or not. */
export async function morningPrepDue(db: Database, now: Date): Promise<string[]> {
  const scope = systemScope("prep tick");
  const rows = await meetingsRepo(db).startingBetween(scope, now, new Date(now.getTime() + 86_400_000));
  const due: string[] = [];
  for (const row of rows) {
    const today = localParts(now, row.timezone);
    const start = localParts(row.startsAt, row.timezone);
    if (today.year !== start.year || today.month !== start.month || today.day !== start.day) continue;
    const sixAm = zonedTime(today.year, today.month, today.day, 6, 0, row.timezone);
    if (now < sixAm || (row.prepAt !== null && row.prepAt >= sixAm)) continue;
    if (await meetingsRepo(db).prepRequestedSince(scope, row.id, sixAm)) continue;
    due.push(row.id);
  }
  return due;
}

/** Queues the morning refreshes and records each request, so the next tick doesn't ask again. */
export async function queueMorningPrep(db: Database, queue: JobQueue, now: Date): Promise<number> {
  const scope = systemScope("prep tick");
  const due = await morningPrepDue(db, now);
  for (const meetingId of due) {
    const row = await meetingsRepo(db).get(scope, meetingId);
    if (row?.meeting.accountId == null) continue;
    await activitiesRepo(db).insert(scope, {
      accountId: row.meeting.accountId,
      type: "note",
      subject: "Meeting prep brief refreshed for today",
      meta: { job: JOBS.prepGenerate, state: "requested", meetingId },
    });
    await queue.send(JOBS.prepGenerate, { meetingId });
  }
  return due.length;
}
