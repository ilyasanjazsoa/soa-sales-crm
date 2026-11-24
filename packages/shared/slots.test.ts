import { describe, expect, it } from "vitest";
import {
  estimatedDriveMinutes,
  findSlots,
  slotCandidates,
  formatTime,
  timePreference,
  zonedTime,
  type BusyEvent,
  type LatLng,
  type SlotInput,
} from "./slots";

const TZ = "America/Chicago";
const OFFICE: LatLng = { lat: 32.78, lng: -96.8 };
const SITE: LatLng = { lat: 32.85, lng: -96.95 };
const ELSEWHERE: LatLng = { lat: 33.1, lng: -96.6 };
/** Monday 2 March 2026, 9:00 am in Chicago (CST, UTC−6). */
const MONDAY_9AM = zonedTime(2026, 3, 2, 9, 0, TZ);
const at = (day: number, hour: number, minute = 0, month = 3, timeZone = TZ) =>
  zonedTime(2026, month, day, hour, minute, timeZone);

/** Fixed drive table: 20 min between the office or elsewhere and the site. */
const drives =
  (minutes = 20) =>
  () => ({ minutes, estimated: false });

const input = (overrides: Partial<SlotInput> = {}): SlotInput => ({
  now: MONDAY_9AM,
  timeZone: TZ,
  workdayStart: "08:00",
  workdayEnd: "17:30",
  durationMinutes: 60,
  travels: true,
  base: OFFICE,
  site: SITE,
  busy: [],
  preference: null,
  driveMinutes: drives(),
  ...overrides,
});

const local = (date: Date, timeZone = TZ) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);

/** Every possible slot (limit high) on one day, to test which candidates survive. */
const allOn = (day: number, overrides: Partial<SlotInput>) =>
  slotCandidates(input(overrides)).filter((slot) => local(slot.start).includes(`3/${String(day)}`));

describe("findSlots", () => {
  it("returns 3 slots, at most one per day, in date order", () => {
    const slots = findSlots(input());
    expect(slots).toHaveLength(3);
    const days = slots.map((slot) => local(slot.start).split(",")[1]);
    expect(new Set(days).size).toBe(3);
    expect([...slots].sort((a, b) => a.start.getTime() - b.start.getTime())).toEqual(slots);
  });

  it("offers nothing within 2 hours of now", () => {
    const slots = findSlots({ ...input(), limit: 100 });
    expect(slots.every((slot) => slot.start.getTime() >= MONDAY_9AM.getTime() + 2 * 3600_000)).toBe(true);
    // Today's earliest candidate is 11:00 am, 20 minutes' drive away: the best slot today.
    expect(local(slots[0]?.start ?? new Date(0))).toBe("Mon, 3/2, 11:00");
  });

  it("drops candidates that overlap a busy event", () => {
    const busy: BusyEvent[] = [{ start: at(3, 8), end: at(3, 17, 30) }];
    expect(allOn(3, { busy })).toEqual([]);
    const partial: BusyEvent[] = [{ start: at(3, 10), end: at(3, 11) }];
    const starts = allOn(3, { busy: partial }).map((slot) => local(slot.start));
    expect(starts).not.toContain("Tue, 3/3, 09:30");
    expect(starts).not.toContain("Tue, 3/3, 10:00");
    expect(starts).not.toContain("Tue, 3/3, 10:30");
  });

  it("leaves drive time in from the previous located event and out to the next one", () => {
    const busy: BusyEvent[] = [
      { start: at(3, 9), end: at(3, 10), location: ELSEWHERE, title: "site walk" },
      { start: at(3, 13), end: at(3, 14), location: ELSEWHERE, title: "review" },
    ];
    const starts = allOn(3, { busy, driveMinutes: drives(45) }).map((slot) => local(slot.start));
    expect(starts).not.toContain("Tue, 3/3, 10:00"); // 10:00 end + 45 min > 10:00
    expect(starts).not.toContain("Tue, 3/3, 10:30");
    expect(starts).toContain("Tue, 3/3, 11:00"); // 10:00 + 45 = 10:45 ≤ 11:00; ends 12:00 + 45 = 12:45 ≤ 13:00
    expect(starts).not.toContain("Tue, 3/3, 11:30"); // ends 12:30 + 45 > 13:00
    const slot = allOn(3, { busy, driveMinutes: drives(45) }).find((entry) => local(entry.start) === "Tue, 3/3, 11:00");
    expect(slot?.reasons).toEqual(
      expect.arrayContaining(["45 min drive from your 9:00 am site walk", "45 min to make your 1:00 pm review"]),
    );
    expect(slot?.score).toBeCloseTo(100 - 6 * 1 - 45 / 3 - 45 / 3, 0);
  });

  it("needs no drive time for phone meetings", () => {
    const busy: BusyEvent[] = [{ start: at(3, 9), end: at(3, 10), location: ELSEWHERE, title: "site walk" }];
    const starts = allOn(3, { busy, travels: false, durationMinutes: 30, driveMinutes: drives(45) }).map((slot) =>
      local(slot.start),
    );
    expect(starts).toContain("Tue, 3/3, 10:00");
    const [first] = findSlots(input({ travels: false, durationMinutes: 30, driveMinutes: drives(45) }));
    expect(first?.driveInMinutes).toBe(0);
    expect(first?.reasons.join(" ")).not.toContain("drive");
  });

  it("prefers the stated morning or afternoon", () => {
    const afternoon = findSlots(input({ preference: "Best reached by phone after 2 pm" }));
    expect(afternoon.every((slot) => Number(local(slot.start).split(", ")[2]?.split(":")[0]) >= 12)).toBe(true);
    expect(afternoon[0]?.reasons).toContain("Matches the contact's afternoon preference");
    const morning = findSlots(input({ preference: "Mornings are best", now: at(1, 20) }));
    expect(morning.every((slot) => Number(local(slot.start).split(", ")[2]?.split(":")[0]) < 12)).toBe(true);
    expect(timePreference("call before noon")).toBe("morning");
    expect(timePreference("prefers email")).toBeNull();
  });

  it("rolls a Friday afternoon request into next week", () => {
    const fridayAfternoon = at(6, 15, 30); // 2 hours later is 5:30 pm, the end of the workday
    const slots = findSlots(input({ now: fridayAfternoon }));
    expect(slots.map((slot) => local(slot.start).slice(0, 3))).toEqual(["Mon", "Tue", "Wed"]);
  });

  it("keeps working hours in local time across a daylight-saving change", () => {
    // US clocks spring forward on Sunday 8 March 2026: 8:00 am is 14:00 UTC before and 13:00 UTC after.
    const slots = findSlots({ ...input({ now: at(6, 8), durationMinutes: 60 }), limit: 100, businessDays: 3 });
    const friday = slots.find((slot) => local(slot.start).startsWith("Fri"));
    const monday = slots.find((slot) => local(slot.start).startsWith("Mon"));
    expect(friday).toBeDefined();
    expect(monday).toBeDefined();
    expect(at(6, 8).toISOString()).toBe("2026-03-06T14:00:00.000Z");
    expect(at(9, 8).toISOString()).toBe("2026-03-09T13:00:00.000Z");
    // Every slot starts on the 30-minute grid in local time, inside 8:00 to 17:30.
    for (const slot of slots) {
      const [hours = 0, minutes = 0] = (local(slot.start).split(", ")[2] ?? "").split(":").map(Number);
      expect(minutes % 30).toBe(0);
      expect(hours * 60 + minutes).toBeGreaterThanOrEqual(8 * 60);
      expect(hours * 60 + minutes + 60).toBeLessThanOrEqual(17 * 60 + 30);
    }
  });

  it("uses the rep's time zone, not the server's", () => {
    const LA = "America/Los_Angeles";
    const original = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      const slots = findSlots({
        ...input({ timeZone: LA, now: zonedTime(2026, 3, 2, 6, 0, LA) }),
        limit: 100,
        businessDays: 0,
      });
      expect(local(slots[0]?.start ?? new Date(0), LA)).toBe("Mon, 3/2, 08:00");
      expect(slots[0]?.start.toISOString()).toBe("2026-03-02T16:00:00.000Z");
      expect(formatTime(slots[0]?.start ?? new Date(0), LA)).toBe("8:00 am");
    } finally {
      process.env.TZ = original;
    }
  });

  it("scores later days lower", () => {
    const [today, tomorrow] = findSlots({ ...input(), limit: 100 });
    expect(today?.score).toBeCloseTo(100 - 20 / 3, 0);
    expect(tomorrow?.score).toBeCloseTo(100 - 6 - 20 / 3, 0);
  });

  it("marks slots estimated when the drive time is", () => {
    const slots = findSlots(input({ driveMinutes: () => ({ minutes: 25, estimated: true }) }));
    expect(slots.every((slot) => slot.estimated && slot.reasons.includes("Drive time estimated"))).toBe(true);
  });
});

describe("estimatedDriveMinutes", () => {
  it("is straight-line distance × 1.4 at 30 mph plus 8 minutes", () => {
    expect(estimatedDriveMinutes(OFFICE, OFFICE)).toBe(8);
    // About 10.4 miles apart: 10.4 × 1.4 / 30 × 60 + 8 ≈ 37.
    expect(estimatedDriveMinutes(OFFICE, SITE)).toBeGreaterThan(30);
    expect(estimatedDriveMinutes(OFFICE, SITE)).toBeLessThan(45);
  });
});
