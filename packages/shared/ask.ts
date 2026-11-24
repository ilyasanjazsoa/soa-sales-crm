import { z } from "zod";
import { DealStageSchema } from "./crm";
import { NextAction } from "./nba";

/* Today (§11.1) and Ask Sales AI (§11.2). The model never runs a query: the planner may only pick from these fixed,
   read-only functions, with arguments this schema validates; anything else is rejected. */

const isoDate = z.iso.date();

export const ASK_FUNCTIONS = [
  "myOpenDeals",
  "dealsByStage",
  "stalledDeals",
  "meetingsBetween",
  "accountByName",
  "recentReplies",
  "topAccountsByFit",
  "forecast",
] as const;

export const AskCall = z.discriminatedUnion("fn", [
  z.object({ fn: z.literal("myOpenDeals") }).strict(),
  z.object({ fn: z.literal("dealsByStage"), stage: DealStageSchema }).strict(),
  z.object({ fn: z.literal("stalledDeals"), days: z.number().int().min(1).max(90) }).strict(),
  z
    .object({ fn: z.literal("meetingsBetween"), from: isoDate, to: isoDate })
    .strict()
    .refine((call) => call.from <= call.to, { error: "from must not be after to" }),
  z.object({ fn: z.literal("accountByName"), text: z.string().trim().min(2).max(100) }).strict(),
  z.object({ fn: z.literal("recentReplies"), days: z.number().int().min(1).max(30) }).strict(),
  z
    .object({
      fn: z.literal("topAccountsByFit"),
      n: z.number().int().min(1).max(20),
      filters: z
        .object({ propertyType: z.string().max(60).optional(), city: z.string().max(60).optional() })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ fn: z.literal("forecast") }).strict(),
]);
export type AskCall = z.infer<typeof AskCall>;

/** Step 1 (fast model): which functions to call. At most 4. */
export const AskPlan = z.object({ calls: z.array(AskCall).max(4) }).strict();
export type AskPlan = z.infer<typeof AskPlan>;

export const AskItem = z.object({
  label: z.string().max(200),
  sub: z.string().max(300),
  link: z.string().max(300),
});
export type AskItem = z.infer<typeof AskItem>;

/** Step 3 (writer): the answer, citing only items the queries returned. */
export const AskAnswer = z.object({ answer: z.string().min(1).max(2000), items: z.array(AskItem).max(10) });
export type AskAnswer = z.infer<typeof AskAnswer>;

export const AskRequest = z.object({ question: z.string().trim().min(2).max(500) }).strict();
export const AskResponse = AskAnswer.extend({ calls: z.array(z.string()) });
export type AskResponse = z.infer<typeof AskResponse>;

// ───────── Today ─────────
export const ScheduleItem = z.object({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  title: z.string(),
  kind: z.enum(["meeting", "busy"]),
  link: z.string().nullable(),
});
export const TodayResponse = z.object({
  stats: z.object({
    openPipelineCents: z.number().int(),
    weightedForecastCents: z.number().int(),
    meetingsThisWeek: z.number().int(),
    wonThisQuarterCents: z.number().int(),
  }),
  actions: z.array(NextAction),
  schedule: z.object({
    label: z.enum(["today", "next_week"]),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    items: z.array(ScheduleItem),
    calendarRead: z.boolean(),
  }),
});
export type TodayResponse = z.infer<typeof TodayResponse>;
