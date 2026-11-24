import { z } from "zod";
import { formatTime, localParts, zonedTime } from "./slots";
import type { DealStage } from "./stages";

/* Next best actions (ARCHITECTURE.md §11.1). Pure, no AI: computed per rep on request from facts the server loads,
   sorted by priority, then by deal value. "now" and the rep's time zone are parameters. */

export interface NbaMeeting {
  id: string;
  title: string;
  startsAt: Date;
  /** Internal meetings aren't customer meetings. */
  kind: "site_walk" | "call" | "video" | "internal";
  accountId: string | null;
  status: "scheduled" | "done" | "cancelled" | "no_show";
}

export interface NbaDeal {
  id: string;
  accountId: string;
  accountName: string;
  stage: DealStage;
  status: "open" | "won" | "lost";
  annualValueCents: number;
  lastActivityAt: Date;
  contactName: string | null;
  /** Emails on the deal's account sent by the rep. */
  outboundCount: number;
  lastOutboundAt: Date | null;
  /** Calls, voicemails and LinkedIn notes logged (they count as touches). */
  loggedTouches: number;
  lastInboundAt: Date | null;
  /** The latest reply classified `interested`, and who sent it. */
  lastInterestedAt: Date | null;
  interestedContact: string | null;
  proposal: { sentAt: Date | null; viewCount: number } | null;
  contract: { sentAt: Date | null; viewCount: number; signerName: string | null } | null;
  topSignal: string | null;
}

export interface NbaTask {
  id: string;
  title: string;
  dueAt: Date | null;
  doneAt: Date | null;
  accountId: string | null;
}

export const NextAction = z.object({
  key: z.string(),
  priority: z.number().int(),
  rule: z.string(),
  text: z.string(),
  button: z.object({ label: z.string(), href: z.string() }),
  valueCents: z.number().int(),
});
export type NextAction = z.infer<typeof NextAction>;

const DAY = 86_400_000;
const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY);
const sameLocalDay = (a: Date, b: Date, zone: string) => {
  const x = localParts(a, zone);
  const y = localParts(b, zone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
};

/** The next business day after `now`, as a local calendar date (noon UTC stands for the day). */
function nextBusinessDay(now: Date, zone: string): Date {
  const p = localParts(now, zone);
  let day = new Date(Date.UTC(p.year, p.month - 1, p.day + 1, 12));
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day = new Date(day.getTime() + DAY);
  return day;
}
const isLocalDate = (instant: Date, date: Date, zone: string) => {
  const p = localParts(instant, zone);
  return p.year === date.getUTCFullYear() && p.month === date.getUTCMonth() + 1 && p.day === date.getUTCDate();
};

export function nextBestActions(input: {
  now: Date;
  timeZone: string;
  meetings: readonly NbaMeeting[];
  deals: readonly NbaDeal[];
  tasks: readonly NbaTask[];
}): NextAction[] {
  const { now, timeZone: zone } = input;
  const actions: NextAction[] = [];
  const valueOf = new Map(input.deals.map((deal) => [deal.accountId, deal.annualValueCents]));
  const account = (id: string) => `/accounts/${id}`;

  // 0: a customer meeting later today, or on the next business day.
  const nextDay = nextBusinessDay(now, zone);
  const todayParts = localParts(now, zone);
  const todayDate = new Date(Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day, 12));
  const nextDayWord =
    daysBetween(todayDate, nextDay) === 1
      ? "tomorrow"
      : nextDay.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  for (const meeting of input.meetings) {
    if (meeting.status !== "scheduled" || meeting.kind === "internal") continue;
    const today = sameLocalDay(meeting.startsAt, now, zone) && meeting.startsAt > now;
    const next = isLocalDate(meeting.startsAt, nextDay, zone);
    if (!today && !next) continue;
    const when = today ? "today" : nextDayWord;
    actions.push({
      key: `meeting:${meeting.id}`,
      priority: 0,
      rule: "meeting_soon",
      text: `${meeting.title} ${when} at ${formatTime(meeting.startsAt, zone)}. Your prep brief is ready.`,
      button: {
        label: "Open prep brief",
        href: meeting.accountId === null ? "/calendar" : `${account(meeting.accountId)}?tab=meetings`,
      },
      valueCents: meeting.accountId === null ? 0 : (valueOf.get(meeting.accountId) ?? 0),
    });
  }

  for (const deal of input.deals) {
    if (deal.status !== "open") continue;
    const contact = deal.contactName ?? "Your contact";
    const touches = deal.outboundCount + deal.loggedTouches;
    const repliedSince = (since: Date | null) =>
      since !== null && deal.lastInboundAt !== null && deal.lastInboundAt > since;
    const push = (priority: number, rule: string, text: string, label: string, tab: string) => {
      actions.push({
        key: `${rule}:${deal.id}`,
        priority,
        rule,
        text,
        button: { label, href: `${account(deal.accountId)}?tab=${tab}` },
        valueCents: deal.annualValueCents,
      });
    };

    // 1: an interested reply with no outbound email since.
    if (
      deal.lastInterestedAt !== null &&
      (deal.lastOutboundAt === null || deal.lastOutboundAt < deal.lastInterestedAt)
    ) {
      push(
        1,
        "interested_reply",
        `${deal.interestedContact ?? contact} replied and sounds interested.`,
        "Reply",
        "outreach",
      );
    }
    // 1: the contract was viewed but not signed, sent at least 2 days ago.
    if (
      deal.stage === "contract_sent" &&
      deal.contract !== null &&
      deal.contract.viewCount >= 1 &&
      deal.contract.sentAt !== null &&
      daysBetween(deal.contract.sentAt, now) >= 2
    ) {
      const n = deal.contract.viewCount;
      push(
        1,
        "contract_viewed",
        `${deal.contract.signerName ?? contact} viewed the contract ${String(n)} time${n === 1 ? "" : "s"} but hasn't signed.`,
        "Draft nudge",
        "outreach",
      );
    }
    if (deal.stage === "proposal" && deal.proposal !== null) {
      // 2: opened at least twice, and quiet for 2 days.
      if (deal.proposal.viewCount >= 2 && daysBetween(deal.lastActivityAt, now) >= 2) {
        push(
          2,
          "proposal_opened",
          `${contact} has opened the proposal ${String(deal.proposal.viewCount)} times.`,
          "Open call script",
          "outreach",
        );
      }
      // 2: no reply for 5 days after sending.
      const sent = deal.proposal.sentAt;
      if (sent !== null && daysBetween(sent, now) >= 5 && !repliedSince(sent)) {
        push(
          2,
          "proposal_no_reply",
          `Proposal sent ${String(daysBetween(sent, now))} days ago with no reply.`,
          "Draft follow-up",
          "outreach",
        );
      }
    }
    // 3: contacted, no reply for 4 days, fewer than 3 touches.
    if (
      deal.stage === "contacted" &&
      deal.lastOutboundAt !== null &&
      daysBetween(deal.lastOutboundAt, now) >= 4 &&
      !repliedSince(deal.lastOutboundAt) &&
      touches < 3
    ) {
      push(
        3,
        "contacted_no_reply",
        `No reply from ${contact} in ${String(daysBetween(deal.lastOutboundAt, now))} days.`,
        "Draft follow-up",
        "outreach",
      );
    }
    // 3: researched, no outreach yet.
    if (deal.stage === "researched" && touches === 0) {
      push(
        3,
        "researched_no_outreach",
        `${deal.accountName} is researched but not contacted.${deal.topSignal === null ? "" : ` Lead with: ${deal.topSignal}`}`,
        "Start outreach",
        "outreach",
      );
    }
    // 4: a lead needs research.
    if (deal.stage === "lead") {
      push(4, "lead_needs_research", `${deal.accountName} needs research before outreach.`, "Research", "research");
    }
  }

  // 4: tasks due today or overdue.
  const endOfToday = (() => {
    const p = localParts(now, zone);
    return zonedTime(p.year, p.month, p.day, 23, 59, zone);
  })();
  for (const task of input.tasks) {
    if (task.doneAt !== null || task.dueAt === null || task.dueAt > endOfToday) continue;
    actions.push({
      key: `task:${task.id}`,
      priority: 4,
      rule: "task_due",
      text: task.title,
      button: { label: "Open", href: task.accountId === null ? "/" : `${account(task.accountId)}?tab=timeline` },
      valueCents: task.accountId === null ? 0 : (valueOf.get(task.accountId) ?? 0),
    });
  }

  return actions.sort((a, b) => a.priority - b.priority || b.valueCents - a.valueCents || a.key.localeCompare(b.key));
}

/** The days the Today schedule shows: today, or next week from Friday 3 pm through Sunday (§11.1). */
export function scheduleWindow(now: Date, timeZone: string): { from: Date; to: Date; label: "today" | "next_week" } {
  const p = localParts(now, timeZone);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day, 12)).getUTCDay();
  const weekend = weekday === 6 || weekday === 0 || (weekday === 5 && p.hour >= 15);
  if (!weekend) {
    return {
      from: zonedTime(p.year, p.month, p.day, 0, 0, timeZone),
      to: zonedTime(p.year, p.month, p.day + 1, 0, 0, timeZone),
      label: "today",
    };
  }
  const toMonday = (8 - weekday) % 7 || 7;
  const monday = new Date(Date.UTC(p.year, p.month - 1, p.day + toMonday, 12));
  const [y, m, d] = [monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate()];
  return { from: zonedTime(y, m, d, 0, 0, timeZone), to: zonedTime(y, m, d + 5, 0, 0, timeZone), label: "next_week" };
}

/** Monday 00:00 to the next Monday, in the rep's zone (the "this week" number). */
export function weekWindow(now: Date, timeZone: string): { from: Date; to: Date } {
  const p = localParts(now, timeZone);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day, 12)).getUTCDay();
  const back = (weekday + 6) % 7;
  return {
    from: zonedTime(p.year, p.month, p.day - back, 0, 0, timeZone),
    to: zonedTime(p.year, p.month, p.day - back + 7, 0, 0, timeZone),
  };
}

/** The calendar quarter containing `now`, in the rep's zone. */
export function quarterWindow(now: Date, timeZone: string): { from: Date; to: Date } {
  const p = localParts(now, timeZone);
  const first = Math.floor((p.month - 1) / 3) * 3 + 1;
  return { from: zonedTime(p.year, first, 1, 0, 0, timeZone), to: zonedTime(p.year, first + 3, 1, 0, 0, timeZone) };
}
