import { z } from "zod";

/* Meetings and calendar API shapes (docs/API.md "Meetings", ARCHITECTURE.md §9). */

const timestamp = z.iso.datetime({ offset: true });

export const MeetingKind = z.enum(["site_walk", "call", "video", "internal"]);
export type MeetingKind = z.infer<typeof MeetingKind>;
export const MeetingStatus = z.enum(["scheduled", "done", "cancelled", "no_show"]);
export type MeetingStatus = z.infer<typeof MeetingStatus>;
export const MEETING_KIND_LABELS: Record<MeetingKind, string> = {
  site_walk: "Site walk",
  call: "Phone call",
  video: "Video call",
  internal: "Internal",
};

export const SlotRequest = z
  .object({
    durationMinutes: z.number().int().min(15).max(240),
    kind: z.enum(["site_walk", "call", "video"]),
  })
  .strict();
export type SlotRequest = z.infer<typeof SlotRequest>;

export const SlotOption = z.object({
  start: timestamp,
  end: timestamp,
  reasons: z.array(z.string()),
  estimated: z.boolean(),
  driveInMinutes: z.number(),
});
export type SlotOption = z.infer<typeof SlotOption>;
export const SlotResponse = z.object({ slots: z.array(SlotOption) });

export const BookMeetingRequest = z
  .object({
    accountId: z.uuid(),
    contactId: z.uuid().optional(),
    kind: z.enum(["site_walk", "call", "video"]),
    start: timestamp,
    durationMinutes: z.number().int().min(15).max(240),
  })
  .strict();
export type BookMeetingRequest = z.infer<typeof BookMeetingRequest>;

export const Meeting = z.object({
  id: z.uuid(),
  accountId: z.uuid().nullable(),
  accountName: z.string().nullable(),
  dealId: z.uuid().nullable(),
  owner: z.object({ id: z.uuid(), name: z.string() }),
  title: z.string(),
  kind: MeetingKind,
  status: MeetingStatus,
  startsAt: timestamp,
  endsAt: timestamp,
  locationText: z.string().nullable(),
  contacts: z.array(z.object({ id: z.uuid(), name: z.string(), email: z.string().nullable() })),
  hasPrep: z.boolean(),
});
export type Meeting = z.infer<typeof Meeting>;

/** A booking: the meeting, and whether the contact was invited (never when their address can't be emailed). */
export const BookedMeeting = Meeting.extend({ invited: z.boolean() });
export type BookedMeeting = z.infer<typeof BookedMeeting>;

/** A block of time from the rep's calendar that is not a CRM meeting. Titles only for the calendar's owner. */
export const BusyBlock = z.object({ start: timestamp, end: timestamp, title: z.string().nullable() });
export type BusyBlock = z.infer<typeof BusyBlock>;

export const MeetingList = z.object({
  meetings: z.array(Meeting),
  busy: z.array(BusyBlock),
  /** False when the calendar couldn't be read (e.g. the rep must reconnect); meetings are still listed. */
  calendarRead: z.boolean(),
});
export type MeetingList = z.infer<typeof MeetingList>;

export const MeetingQuery = z.object({
  from: timestamp,
  to: timestamp,
  owner: z.uuid().optional(),
});

export const MeetingPatch = z
  .object({
    status: z.enum(["done", "no_show", "cancelled"]).optional(),
    startsAt: timestamp.optional(),
    endsAt: timestamp.optional(),
  })
  .strict()
  .refine((patch) => (patch.startsAt === undefined) === (patch.endsAt === undefined), {
    error: "Send both startsAt and endsAt to reschedule.",
  })
  .refine((patch) => patch.status === undefined || patch.startsAt === undefined, {
    error: "Either reschedule or set an outcome, not both.",
  })
  .refine((patch) => patch.status !== undefined || patch.startsAt !== undefined, { error: "Nothing to change." });
export type MeetingPatch = z.infer<typeof MeetingPatch>;

// ───────── prep brief (§7.3) ─────────
export const PREP_SECTIONS = [
  { key: "goal", heading: "Goal" },
  { key: "who_you_are_meeting", heading: "Who you're meeting" },
  { key: "agenda", heading: "Agenda" },
  { key: "questions_to_ask", heading: "Questions to ask" },
  { key: "bring", heading: "Bring" },
  { key: "logistics", heading: "Logistics" },
] as const;
export type PrepSectionKey = (typeof PREP_SECTIONS)[number]["key"];

/** What the model writes: every section except logistics, which code writes from the meeting and drive time. */
export const PrepBriefOutput = z.object({
  sections: z
    .array(
      z.object({
        key: z.enum(["goal", "who_you_are_meeting", "agenda", "questions_to_ask", "bring"]),
        text: z.string().max(2000),
      }),
    )
    .length(5),
});
export type PrepBriefOutput = z.infer<typeof PrepBriefOutput>;

export const PrepSection = z.object({ key: z.string(), heading: z.string(), text: z.string() });
export const PrepBriefResponse = z.object({
  sections: z.array(PrepSection).nullable(),
  generatedAt: timestamp.nullable(),
  pending: z.boolean(),
  lastError: z.string().nullable(),
});
export type PrepBriefResponse = z.infer<typeof PrepBriefResponse>;

/** Problems beyond the shape: each section exactly once (§7.1 retry). */
export function prepProblems(output: PrepBriefOutput): string[] {
  const keys = new Set(output.sections.map((section) => section.key));
  return keys.size === 5 ? [] : ["Write each of the five sections exactly once."];
}
