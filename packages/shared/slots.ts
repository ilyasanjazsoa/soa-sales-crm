/* Finding meeting times (ARCHITECTURE.md §9.1). Pure: the caller passes the busy events, a drive-time lookup it
   has already filled from the maps provider, and "now". All calendar arithmetic happens in the rep's time zone. */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface BusyEvent {
  start: Date;
  end: Date;
  /** Where the event is, if known. Events without a location don't change drive times. */
  location?: LatLng | null;
  /** Only used in the rep's own reasons ("clear before your 3:00 pm review"). */
  title?: string | null;
}

export interface Drive {
  minutes: number;
  /** True when the maps provider failed and straight-line distance was used. */
  estimated: boolean;
}

export interface SlotInput {
  now: Date;
  /** IANA time zone of the rep, e.g. America/Chicago. */
  timeZone: string;
  /** "HH:MM" in the rep's time zone. */
  workdayStart: string;
  workdayEnd: string;
  durationMinutes: number;
  /** Site walks travel to the account; phone and video meetings don't. */
  travels: boolean;
  base: LatLng | null;
  site: LatLng | null;
  busy: readonly BusyEvent[];
  /** Contact preference text, e.g. "Best reached by phone after 2 pm". */
  preference: string | null;
  /** Drive time leaving at `departAt` (the caller fills this from the maps provider, by time of day). */
  driveMinutes: (from: LatLng, to: LatLng, departAt: Date) => Drive;
  /** How many business days to look ahead (default 10). */
  businessDays?: number;
  /** How many slots to return (default 3). */
  limit?: number;
}

export interface Slot {
  start: Date;
  end: Date;
  score: number;
  driveInMinutes: number;
  driveOutMinutes: number;
  estimated: boolean;
  reasons: string[];
}

const GRID_MINUTES = 30;
const MIN_LEAD_MS = 2 * 60 * 60 * 1000;
const MINUTE = 60_000;

// ───────── time zone helpers (Intl only, no library) ─────────
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(date: Date, timeZone: string): LocalParts {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  const get = (type: string) => Number(formatter.formatToParts(date).find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** The local calendar date and time of an instant in the zone. */
export const localParts = (date: Date, timeZone: string): LocalParts => partsIn(date, timeZone);

/** Offset of the zone from UTC at that instant, in ms. */
function offsetMs(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(date.getTime() / MINUTE) * MINUTE;
}

/** The instant a local wall-clock time happens in the zone (handles daylight-saving changes). */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(new Date(guess), timeZone);
  const second = guess - offsetMs(new Date(first), timeZone);
  return new Date(second);
}

const hhmm = (value: string) => {
  const [h = "0", m = "0"] = value.split(":");
  return Number(h) * 60 + Number(m);
};

export function formatTime(date: Date, timeZone: string): string {
  const p = partsIn(date, timeZone);
  const suffix = p.hour < 12 ? "am" : "pm";
  const hour = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${String(hour)}:${String(p.minute).padStart(2, "0")} ${suffix}`;
}

/** "morning" / "afternoon" from preference text, if it clearly states one; null when unsure (no bonus or penalty). */
export function timePreference(text: string | null): "morning" | "afternoon" | null {
  if (text === null) return null;
  // "no mornings", "not in the afternoon", "avoid afternoons": a negation flips it.
  const negated = /\b(no|not|never|avoid|except)\s+(in\s+the\s+)?(mornings?|afternoons?)\b/i.exec(text);
  if (negated !== null) return /morning/i.test(negated[3] ?? "") ? "afternoon" : "morning";
  const afternoon =
    /\bafternoons?\b|\bafter lunch\b|\bafter (12|[1-5])(:\d\d)?\s*(pm|p\.m\.)?(?!\s*(am|a\.m\.))\b|\bfrom (12|[1-5])(:\d\d)?\s*pm\b/i.test(
      text,
    );
  const morning = /\bmornings?\b|\bbefore (noon|lunch)\b|\bbefore (9|10|11)(:\d\d)?\s*(am|a\.m\.)?\b|\bearly\b/i.test(
    text,
  );
  if (afternoon === morning) return null;
  return afternoon ? "afternoon" : "morning";
}

// ───────── the slot finder ─────────
type Candidate = Slot & { dayKey: string };

/** Every start that fits (steps 1 to 5), scored, in time order. */
export function slotCandidates(input: SlotInput): Candidate[] {
  const { timeZone } = input;
  const startMinute = hhmm(input.workdayStart);
  const endMinute = hhmm(input.workdayEnd);
  const earliest = input.now.getTime() + MIN_LEAD_MS;
  const preference = timePreference(input.preference);
  const today = partsIn(input.now, timeZone);
  const busy = [...input.busy].sort((a, b) => a.start.getTime() - b.start.getTime());
  const located = busy.filter((event): event is BusyEvent & { location: LatLng } => event.location != null);
  const wantedDays = input.businessDays ?? 10;

  const candidates: Candidate[] = [];
  // Day 0 is today (if a weekday); each later weekday adds one business day.
  let businessDay = 0;
  for (let offset = 0; offset < wantedDays * 2 + 7; offset += 1) {
    const calendar = new Date(Date.UTC(today.year, today.month - 1, today.day + offset, 12));
    const weekday = calendar.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (offset > 0) businessDay += 1;
    if (businessDay > wantedDays) break;
    const dayIndex = businessDay;
    const y = calendar.getUTCFullYear();
    const m = calendar.getUTCMonth() + 1;
    const d = calendar.getUTCDate();
    const dayKey = `${String(y)}-${String(m)}-${String(d)}`;
    const dayStart = zonedTime(y, m, d, 0, 0, timeZone).getTime();
    const dayEnd = zonedTime(y, m, d, 23, 59, timeZone).getTime();

    for (let minute = startMinute; minute + input.durationMinutes <= endMinute; minute += GRID_MINUTES) {
      const start = zonedTime(y, m, d, Math.floor(minute / 60), minute % 60, timeZone);
      const end = new Date(start.getTime() + input.durationMinutes * MINUTE);
      if (start.getTime() < earliest) continue;
      if (busy.some((event) => start < event.end && end > event.start)) continue;

      let driveIn = 0;
      let driveOut = 0;
      let estimated = false;
      const reasons: string[] = [];
      if (input.travels && input.site !== null) {
        const previous = [...located].reverse().find((event) => event.end <= start && event.end.getTime() >= dayStart);
        const origin = previous?.location ?? input.base;
        if (origin !== null) {
          const drive = input.driveMinutes(origin, input.site, previous?.end ?? start);
          driveIn = drive.minutes;
          estimated ||= drive.estimated;
          if (previous !== undefined && previous.end.getTime() + driveIn * MINUTE > start.getTime()) continue;
          reasons.push(
            previous === undefined
              ? `${String(driveIn)} min drive from your base`
              : `${String(driveIn)} min drive from your ${formatTime(previous.start, timeZone)} ${previous.title ?? "meeting"}`,
          );
        }
        const next = located.find((event) => event.start >= end && event.start.getTime() <= dayEnd);
        if (next !== undefined) {
          const drive = input.driveMinutes(input.site, next.location, end);
          driveOut = drive.minutes;
          estimated ||= drive.estimated;
          if (end.getTime() + driveOut * MINUTE > next.start.getTime()) continue;
          reasons.push(
            `${String(driveOut)} min to make your ${formatTime(next.start, timeZone)} ${next.title ?? "meeting"}`,
          );
        }
      }
      const nextAny = busy.find((event) => event.start >= end && event.start.getTime() <= dayEnd);
      if (nextAny !== undefined && !reasons.some((reason) => reason.includes("to make your"))) {
        reasons.push(`Clear before your ${formatTime(nextAny.start, timeZone)} ${nextAny.title ?? "meeting"}`);
      }
      if (nextAny === undefined && busy.every((event) => event.end <= start || event.start.getTime() > dayEnd)) {
        reasons.push("Nothing else after it that day");
      }

      let score = 100 - 6 * dayIndex - driveIn / 3 - driveOut / 3;
      const afternoon = minute >= 12 * 60;
      if (preference !== null) {
        const matches = (preference === "afternoon") === afternoon;
        score += matches ? 15 : -10;
        reasons.push(matches ? `Matches the contact's ${preference} preference` : `The contact prefers ${preference}s`);
      }
      if (estimated) reasons.push("Drive time estimated");
      candidates.push({
        start,
        end,
        score: Math.round(score * 10) / 10,
        driveInMinutes: driveIn,
        driveOutMinutes: driveOut,
        estimated,
        reasons,
        dayKey,
      });
    }
  }
  return candidates;
}

/** Step 6: the best slot of each day, the top days by score, shown in date order. */
export function findSlots(input: SlotInput): Slot[] {
  const candidates = slotCandidates(input);

  // Best per day, then the best days, shown in date order.
  const bestPerDay = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const current = bestPerDay.get(candidate.dayKey);
    if (current === undefined || candidate.score > current.score) bestPerDay.set(candidate.dayKey, candidate);
  }
  return [...bestPerDay.values()]
    .sort((a, b) => b.score - a.score || a.start.getTime() - b.start.getTime())
    .slice(0, input.limit ?? 3)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map(({ dayKey: _dayKey, ...slot }) => slot);
}

/** Fallback drive time when the maps API fails (§9.1): straight line × 1.4 at 30 mph, plus 8 minutes. */
export function estimatedDriveMinutes(from: LatLng, to: LatLng): number {
  const radiusMiles = 3958.8;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) ** 2;
  const miles = 2 * radiusMiles * Math.asin(Math.sqrt(a));
  return Math.round(((miles * 1.4) / 30) * 60 + 8);
}
