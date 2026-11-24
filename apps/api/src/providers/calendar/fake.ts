import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { zonedTime } from "@soa/shared";
import type { CalendarEvent, CalendarProvider } from "./types";

/* FAKE_PROVIDERS calendar. Each rep gets a believable week of recurring busy time (stand-up, pipeline review, a site
   visit) plus the events the CRM creates. With `file`, events are kept in a JSON file so the api and the worker see
   the same calendar locally; without it they live in memory (tests). Tests move or cancel events with `events`. */

type Stored = Omit<CalendarEvent, "start" | "end"> & { start: string; end: string; userId: string };
const ZONE = "America/Chicago";

function recurring(userId: string, from: Date, to: Date): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const first = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() - 1, 12));
  for (let day = new Date(first); day <= to; day = new Date(day.getTime() + 86_400_000)) {
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const key = `${String(y)}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
    const add = (
      slug: string,
      title: string,
      h1: number,
      m1: number,
      h2: number,
      m2: number,
      location: string | null,
    ) => {
      events.push({
        id: `fake-${userId.slice(0, 8)}-${key}-${slug}`,
        title,
        start: zonedTime(y, m, d, h1, m1, ZONE),
        end: zonedTime(y, m, d, h2, m2, ZONE),
        location,
        cancelled: false,
      });
    };
    add("standup", "Team stand-up", 8, 30, 9, 0, null);
    if (weekday === 2 || weekday === 4) add("review", "Pipeline review", 15, 0, 16, 0, null);
    if (weekday === 3) add("visit", "Client site visit", 10, 0, 11, 30, "2200 Commerce St, Dallas, TX");
  }
  return events.filter((event) => event.end > from && event.start < to);
}

export function createFakeCalendarProvider(options: { file?: string } = {}) {
  const memory = new Map<string, Stored>();
  const load = (): Map<string, Stored> => {
    if (options.file === undefined) return memory;
    try {
      return new Map((JSON.parse(readFileSync(options.file, "utf8")) as Stored[]).map((event) => [event.id, event]));
    } catch {
      return new Map();
    }
  };
  const save = (events: Map<string, Stored>) => {
    if (options.file === undefined) return;
    mkdirSync(dirname(options.file), { recursive: true });
    const temporary = `${options.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify([...events.values()]), { mode: 0o600 });
    renameSync(temporary, options.file);
  };
  const toEvent = (stored: Stored): CalendarEvent => ({
    id: stored.id,
    title: stored.title,
    start: new Date(stored.start),
    end: new Date(stored.end),
    location: stored.location,
    cancelled: stored.cancelled,
  });

  const provider: CalendarProvider = {
    listEvents(account, from, to) {
      const own = [...load().values()]
        .filter((event) => event.userId === account.userId && !event.cancelled)
        .map(toEvent)
        .filter((event) => event.end > from && event.start < to);
      return Promise.resolve([...recurring(account.userId, from, to), ...own]);
    },
    getEvent(account, id) {
      const stored = load().get(id);
      return Promise.resolve(stored?.userId === account.userId ? toEvent(stored) : null);
    },
    createEvent(account, event) {
      const events = load();
      const id = `fake-event-${randomUUID()}`;
      events.set(id, {
        id,
        userId: account.userId,
        title: event.title,
        start: event.start.toISOString(),
        end: event.end.toISOString(),
        location: event.location,
        cancelled: false,
      });
      save(events);
      return Promise.resolve({ id });
    },
    updateEvent(account, id, times) {
      const events = load();
      const stored = events.get(id);
      if (stored?.userId === account.userId) {
        events.set(id, { ...stored, start: times.start.toISOString(), end: times.end.toISOString() });
        save(events);
      }
      return Promise.resolve();
    },
    cancelEvent(account, id) {
      const events = load();
      const stored = events.get(id);
      if (stored?.userId === account.userId) {
        events.set(id, { ...stored, cancelled: true });
        save(events);
      }
      return Promise.resolve();
    },
  };

  /** Test hooks: change an event as if the rep did it in Outlook. */
  const events = {
    move(id: string, start: Date, end: Date) {
      const all = load();
      const stored = all.get(id);
      if (stored !== undefined) all.set(id, { ...stored, start: start.toISOString(), end: end.toISOString() });
      save(all);
    },
    cancel(id: string) {
      const all = load();
      const stored = all.get(id);
      if (stored !== undefined) all.set(id, { ...stored, cancelled: true });
      save(all);
    },
    delete(id: string) {
      const all = load();
      all.delete(id);
      save(all);
    },
    add(userId: string, event: Omit<CalendarEvent, "id" | "cancelled">) {
      const all = load();
      const id = `fake-event-${randomUUID()}`;
      all.set(id, {
        id,
        userId,
        title: event.title,
        start: event.start.toISOString(),
        end: event.end.toISOString(),
        location: event.location,
        cancelled: false,
      });
      save(all);
      return id;
    },
    get: (id: string) => load().get(id),
  };
  return { provider, events };
}
