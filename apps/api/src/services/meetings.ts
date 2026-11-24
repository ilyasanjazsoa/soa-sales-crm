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
import { isoDay } from "./mappers";
import { accessTokenFor, type TokenRefresher } from "./oauth-tokens";

/* Meetings (ARCHITECTURE.md §9): finding times, booking, the calendar view, outcomes, calendar.sync and the prep
   brief. Other reps' non-CRM calendar titles are never returned (§13 GET /meetings). */

export interface MeetingDeps {
  db: Database;
  queue: JobQueue;
  ai: AiClient;
  calendar: CalendarProvider;
  driveTimes: DriveTimes;
  refresher: TokenRefresher;
  cipher: TokenCipher;
  clock: Clock;
}

const LOOKAHEAD_MS = 16 * 24 * 60 * 60 * 1000; // 10 business days and the weekends between
const RECONNECT = "Reconnect your calendar (sign out and sign in again) to find and book times.";
const reconnect = () => conflict("reconnect_calendar", RECONNECT);

const fullAddress = (account: AccountRow) =>
  [account.addressLine, account.city, account.state, account.postalCode]
    .filter((part) => part !== null && part !== "")
    .join(", ");
const hhmm = (time: string) => time.slice(0, 5);

/** The rep's calendar account (a valid token), or 409 when they must reconnect. */
async function calendarAccount(deps: MeetingDeps, userId: string): Promise<CalendarAccount> {
  const token = await accessTokenFor(deps, userId);
  if (token === "reconnect") throw reconnect();
  return { accessToken: token.accessToken, userId };
}

/** Wraps provider calls: an auth failure marks the mailbox for reconnecting (same consent) and returns 409. */
async function withCalendar<T>(deps: MeetingDeps, userId: string, run: (account: CalendarAccount) => Promise<T>) {
  const account = await calendarAccount(deps, userId);
  try {
    return await run(account);
  } catch (error) {
    if (error instanceof MailAuthError) {
      await mailAccountsRepo(deps.db).update(systemScope("calendar auth"), userId, "microsoft", {
        needsReconnect: true,
      });
      throw reconnect();
    }
    throw error;
  }
}

export function createMeetingsService(deps: MeetingDeps) {
  const { db, queue, calendar, driveTimes, clock } = deps;

  const requireEditable = async (scope: UserScope, accountId: string) => {
    const account = await accountsRepo(db).getEditable(scope, accountId);
    if (account !== undefined) return account;
    if ((await accountsRepo(db).get(scope, accountId)) !== undefined)
      throw forbidden("Claim this account to book a meeting.");
    throw notFound();
  };

  const rep = async (scope: UserScope): Promise<UserRow> => {
    const user = await usersRepo(db).findById(scope, scope.userId);
    if (user === undefined) throw notFound();
    return user;
  };

  /** Coordinates, geocoding and storing them the first time. Null when unknown. */
  const siteOf = async (account: AccountRow): Promise<LatLng | null> => {
    if (account.lat !== null && account.lng !== null) return { lat: account.lat, lng: account.lng };
    const address = fullAddress(account);
    if (address === "") return null;
    const found = await driveTimes.geocode(address);
    if (found == null) return null;
    await locationsRepo(db).setAccount(systemScope("geocode"), account.id, found.lat, found.lng);
    return found;
  };
  const baseOf = async (user: UserRow): Promise<LatLng | null> => {
    if (user.baseLat !== null && user.baseLng !== null) return { lat: user.baseLat, lng: user.baseLng };
    if (user.baseAddress === null) return null;
    const found = await driveTimes.geocode(user.baseAddress);
    if (found == null) return null;
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
    const events = await withCalendar(deps, scope.userId, (calendarAccountValue) =>
      calendar.listEvents(calendarAccountValue, now, new Date(now.getTime() + LOOKAHEAD_MS)),
    );
    const travels = request.kind === "site_walk";
    const [site, base] = travels ? await Promise.all([siteOf(account), baseOf(user)]) : [null, null];

    // Locate the rep's other events once (cached), then fill the drive-time table the pure finder reads.
    const located = await Promise.all(
      events
        .filter((event) => !event.cancelled)
        .map(async (event) => ({
          start: event.start,
          end: event.end,
          title: event.title,
          location: travels && event.location !== null ? ((await driveTimes.geocode(event.location)) ?? null) : null,
        })),
    );
    const table = new Map<string, Drive>();
    const key = (from: LatLng, to: LatLng) =>
      `${String(from.lat)},${String(from.lng)}>${String(to.lat)},${String(to.lng)}`;
    if (travels && site !== null) {
      const origins = [base, ...located.map((event) => event.location)].filter(
        (place): place is LatLng => place !== null,
      );
      const pairs: [LatLng, LatLng][] = [
        ...origins.map((origin): [LatLng, LatLng] => [origin, site]),
        ...located.flatMap((event): [LatLng, LatLng][] => (event.location === null ? [] : [[site, event.location]])),
      ];
      await Promise.all(
        pairs.map(async ([from, to]) => {
          if (!table.has(key(from, to))) table.set(key(from, to), await driveTimes.drive(from, to, now));
        }),
      );
    }
    const slots = findSlots({
      now,
      timeZone: user.timezone,
      workdayStart: hhmm(user.workdayStart),
      workdayEnd: hhmm(user.workdayEnd),
      durationMinutes: request.durationMinutes,
      travels,
      base,
      site,
      busy: located,
      preference: contactPref,
      driveMinutes: (from, to) => table.get(key(from, to)) ?? { minutes: 0, estimated: true },
    });
    return slots.map((slot) => ({
      start: slot.start.toISOString(),
      end: slot.end.toISOString(),
      reasons: slot.reasons,
      estimated: slot.estimated,
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

  return {
    async slots(scope: UserScope, accountId: string, request: SlotRequest): Promise<SlotOption[]> {
      const account = await requireEditable(scope, accountId);
      const contact = await primaryContact(scope, accountId, undefined);
      return slotsFor(scope, account, request, contact?.contactPref ?? null);
    },

    /** §9.2: re-check the slot, create the calendar event with the contact invited, store, advance, queue the prep. */
    async book(scope: UserScope, request: BookMeetingRequest, ip: string | null): Promise<Meeting> {
      const now = clock();
      const account = await requireEditable(scope, request.accountId);
      const contact = await primaryContact(scope, request.accountId, request.contactId);
      const start = new Date(request.start);
      const end = new Date(start.getTime() + request.durationMinutes * 60_000);
      if (start.getTime() < now.getTime()) throw unprocessable("in_the_past", "That time has already passed.");
      const user = await rep(scope);

      const meeting = await db.transaction(async (tx) => {
        // One booking at a time per rep, so two clicks can't both take the same free time.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`book:${scope.userId}`}))`);
        const takenInCrm = (await meetingsRepo(tx).overlapping(scope, scope.userId, start, end)).length > 0;
        const events = await withCalendar(deps, scope.userId, (calendarAccountValue) =>
          calendar.listEvents(
            calendarAccountValue,
            new Date(start.getTime() - 60_000),
            new Date(end.getTime() + 60_000),
          ),
        );
        const takenInCalendar = events.some((event) => !event.cancelled && event.start < end && event.end > start);
        if (takenInCrm || takenInCalendar) {
          const fresh = await slotsFor(
            scope,
            account,
            { kind: request.kind, durationMinutes: request.durationMinutes },
            contact?.contactPref ?? null,
          ).catch(() => []);
          throw new HttpError(409, "slot_taken", "That time was just taken. Here are fresh times.", { slots: fresh });
        }

        // The invite is an email from Microsoft 365: never invite a suppressed, bounced or unsubscribed address (rule 7).
        const canInvite =
          contact?.email != null &&
          contact.emailStatus === "ok" &&
          (await suppressionListRepo(tx).reason(scope, contact.email)) === null;
        const title = `${MEETING_KIND_LABELS[request.kind]}: ${account.name}`;
        const location =
          request.kind === "site_walk"
            ? fullAddress(account) || account.name
            : request.kind === "call"
              ? "Phone"
              : "Video call";
        const created = await withCalendar(deps, scope.userId, (calendarAccountValue) =>
          calendar.createEvent(calendarAccountValue, {
            title,
            start,
            end,
            location,
            body: `${MEETING_KIND_LABELS[request.kind]} with ${user.name}, ${user.title}, Security Of America.${user.phone === null ? "" : ` ${user.phone}`}`,
            attendees:
              canInvite && contact.email !== null
                ? [{ email: contact.email, name: `${contact.firstName} ${contact.lastName}`.trim() }]
                : [],
          }),
        );
        try {
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
            subject: `${title} booked for ${formatTime(start, user.timezone)}, ${isoDay(start)}${
              who === ""
                ? ""
                : canInvite
                  ? `. Invite sent to ${who}`
                  : `. ${who} was not invited (email address can't be used)`
            }`,
            meta: { meetingId: row.id, kind: request.kind },
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
        } catch (error) {
          // Don't leave an orphan event in the rep's calendar.
          await withCalendar(deps, scope.userId, (calendarAccountValue) =>
            calendar.cancelEvent(calendarAccountValue, created.id, "Booking could not be saved."),
          ).catch(() => undefined);
          throw error;
        }
      });

      await activitiesRepo(db).insert(scope, {
        accountId: request.accountId,
        type: "note",
        subject: "Meeting prep brief requested",
        meta: { job: JOBS.prepGenerate, state: "requested", meetingId: meeting.id },
      });
      await queue.send(JOBS.prepGenerate, { meetingId: meeting.id });
      const row = await meetingsRepo(db).get(scope, meeting.id);
      if (row === undefined) throw notFound();
      return toMeeting(db, scope, row);
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
      const owner = scope.role === "ae" ? scope.userId : (query.owner ?? scope.userId);
      const rows = await meetingsRepo(db).between(scope, from, to, owner);
      const meetings = await Promise.all(rows.map((row) => toMeeting(db, scope, row)));

      let busy: BusyBlock[] = [];
      let calendarRead = true;
      try {
        const events = await withCalendar(deps, owner, (calendarAccountValue) =>
          calendar.listEvents(calendarAccountValue, from, to),
        );
        const crmEventIds = new Set(rows.map((row) => row.meeting.providerEventId).filter((id) => id !== null));
        const ownCalendar = owner === scope.userId;
        busy = events
          .filter((event) => !event.cancelled && !crmEventIds.has(event.id))
          .map((event) => ({
            start: event.start.toISOString(),
            end: event.end.toISOString(),
            title: ownCalendar ? event.title : null,
          }));
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        calendarRead = false;
      }
      return { meetings, busy, calendarRead };
    },

    async patch(scope: UserScope, id: string, patch: MeetingPatch, ip: string | null): Promise<Meeting> {
      const now = clock();
      await db.transaction(async (tx) => {
        const meeting = await meetingsRepo(tx).lockOwn(scope, id);
        if (meeting === undefined) throw notFound();
        const user = await rep(scope);
        const values: Partial<MeetingRow> = {};
        let subject: string;
        if (patch.startsAt !== undefined && patch.endsAt !== undefined) {
          if (meeting.status !== "scheduled") throw conflict("not_scheduled", "Only a scheduled meeting can be moved.");
          const start = new Date(patch.startsAt);
          const end = new Date(patch.endsAt);
          if (end <= start) throw unprocessable("bad_times", "The meeting must end after it starts.");
          if (meeting.providerEventId !== null) {
            const eventId = meeting.providerEventId;
            await withCalendar(deps, scope.userId, (account) => calendar.updateEvent(account, eventId, { start, end }));
          }
          values.startsAt = start;
          values.endsAt = end;
          subject = `${meeting.title} moved to ${formatTime(start, user.timezone)}, ${isoDay(start)}`;
        } else {
          const status = patch.status ?? "done";
          if (status === "cancelled") {
            if (meeting.status !== "scheduled") throw conflict("not_scheduled", "This meeting isn't scheduled.");
            if (meeting.providerEventId !== null && meeting.startsAt > now) {
              const eventId = meeting.providerEventId;
              await withCalendar(deps, scope.userId, (account) =>
                calendar.cancelEvent(account, eventId, "Cancelled from the CRM."),
              );
            }
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
      return {
        sections,
        generatedAt: row.meeting.prepBrief === null ? null : row.meeting.updatedAt.toISOString(),
        pending: state?.pending ?? false,
        lastError: state?.lastError ?? null,
      };
    },

    async regeneratePrep(scope: UserScope, id: string): Promise<void> {
      const meeting = await meetingsRepo(db).lockOwn(scope, id);
      if (meeting?.accountId == null) throw notFound();
      if ((await prepJobState(db, scope, meeting.accountId, id, clock())).pending) {
        throw conflict("already_running", "The prep brief is already being written.");
      }
      await deps.ai.assertWithinLimit(scope.userId);
      await activitiesRepo(db).insert(scope, {
        accountId: meeting.accountId,
        type: "note",
        subject: "Meeting prep brief requested",
        meta: { job: JOBS.prepGenerate, state: "requested", meetingId: id },
      });
      await queue.send(JOBS.prepGenerate, { meetingId: id });
    },
  };
}

export type MeetingsService = ReturnType<typeof createMeetingsService>;

const PREP_STALE_MS = 10 * 60 * 1000;

/** The latest prep job outcome for this meeting, from its timeline events (as research jobs do). */
async function prepJobState(db: Database, scope: Scope, accountId: string, meetingId: string, now: Date) {
  const event = await researchRepo(db).lastJobEvent(scope, accountId, JOBS.prepGenerate, meetingId);
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
  const account = { accessToken: token.accessToken, userId: job.userId };
  const user = await usersRepo(deps.db).findById(scope, job.userId);
  const timeZone = user?.timezone ?? "America/Chicago";
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
      if (meeting.accountId !== null) {
        await activitiesRepo(tx).insert(scope, {
          accountId: meeting.accountId,
          dealId: meeting.dealId,
          type: "meeting",
          subject: cancelled
            ? `${meeting.title} was cancelled in the calendar`
            : `${meeting.title} was moved in the calendar to ${formatTime(event?.start ?? meeting.startsAt, timeZone)}, ${isoDay(event?.start ?? meeting.startsAt)}`,
          meta: {
            meetingId: meeting.id,
            fromCalendar: true,
            ...(cancelled ? { status: "cancelled" } : { moved: true }),
          },
        });
      }
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
  try {
    const row = await meetingsRepo(db).get(scope, job.meetingId);
    if (row === undefined) throw new Error("meeting not visible");
    const meeting = row.meeting;
    const accountRow = await accountsRepo(db).get(scope, accountId);
    if (accountRow === undefined) throw new Error("account not visible");
    const account = accountRow.account;
    const [people, signals, brief, reference, deal] = await Promise.all([
      meetingsRepo(db).contactsOf(scope, meeting.contactIds),
      signalsRepo(db).listForAccount(scope, accountId),
      researchRepo(db).brief(scope, accountId, undefined),
      referencesRepo(db).bestFor(scope, account.propertyType),
      dealsRepo(db).currentForAccount(scope, accountId),
    ]);
    const contactRows = await contactsRepo(db).listForAccount(scope, accountId);
    const titles = new Map(contactRows.map((contact) => [contact.id, contact.title]));
    const durationMinutes = Math.round((meeting.endsAt.getTime() - meeting.startsAt.getTime()) / 60_000);
    const startsLocal = `${isoDay(meeting.startsAt)} ${formatTime(meeting.startsAt, owner.timezone)}`;
    const result = await ai.generate({
      feature: "prep_brief",
      tier: "writer",
      ...prepBriefPrompt({
        today: isoDay(clock()),
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
      drive = ` About ${String(minutes.minutes)} min drive from your base${minutes.estimated ? " (estimated)" : ""}; leave by ${formatTime(new Date(meeting.startsAt.getTime() - (minutes.minutes + 10) * 60_000), owner.timezone)}.`;
    }
    const logistics = `${MEETING_KIND_LABELS[meeting.kind]}, ${startsLocal} to ${formatTime(meeting.endsAt, owner.timezone)} (${String(durationMinutes)} min).${meeting.locationText === null ? "" : ` ${meeting.locationText}.`}${drive}`;
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
      error instanceof HttpError && error.statusCode === 429
        ? "Prep brief not written: today's AI limit is used up."
        : error instanceof AiOutputError
          ? "Prep brief not written: the AI's answer couldn't be used. Try again."
          : "Prep brief not written. Try again.";
    await record(scope, "failed", message).catch(() => undefined);
    if (!(error instanceof HttpError) && !(error instanceof AiOutputError)) throw error;
  }
}

/** The 6 am refresh (§14): meetings today, in the owner's time zone, whose prep was written before 6 am today. */
export async function morningPrepDue(db: Database, now: Date): Promise<string[]> {
  const rows = await meetingsRepo(db).startingBetween(
    systemScope("prep tick"),
    now,
    new Date(now.getTime() + 86_400_000),
  );
  return rows
    .filter((row) => {
      const today = localParts(now, row.timezone);
      const start = localParts(row.startsAt, row.timezone);
      if (today.year !== start.year || today.month !== start.month || today.day !== start.day) return false;
      const sixAm = zonedTime(today.year, today.month, today.day, 6, 0, row.timezone);
      return now >= sixAm && (row.prepAt === null || row.prepAt < sixAm);
    })
    .map((row) => row.id);
}
