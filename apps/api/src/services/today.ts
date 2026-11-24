import type { Database } from "@soa/db";
import {
  AskAnswer,
  AskPlan,
  formatCentsExact,
  formatTime,
  MEETING_KIND_LABELS,
  nextBestActions,
  quarterWindow,
  scheduleWindow,
  STAGE_LABELS,
  weekWindow,
  weightedForecastCents,
  zonedTime,
  type AskCall,
  type AskItem,
  type AskResponse,
  type NbaDeal,
  type TodayResponse,
} from "@soa/shared";
import type { Clock } from "../clock";
import { notFound } from "../errors";
import type { AiClient } from "../providers/ai/client";
import { askAnswerPrompt, askPlanPrompt, type AskResultData } from "../providers/ai/prompts";
import { tasksRepo } from "../repos/children";
import { insightsRepo } from "../repos/insights";
import { meetingsRepo } from "../repos/meetings";
import type { UserScope } from "../repos/scope";
import { usersRepo } from "../repos/users";
import { localDay, type MeetingsService } from "./meetings";

/* Today (§11.1) and Ask Sales AI (§11.2). Ask: the fast model picks from fixed read-only functions (validated), the
   server runs them under the caller's scope, and the writer answers from those results only (rules 3 to 5). */

const DAY = 86_400_000;
const DRAFT = /\b(draft|write|compose)\b/i;

interface Result {
  fn: AskCall["fn"];
  summary: string;
  items: AskItem[];
}

const money = formatCentsExact;
const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? "" : "s"}`;

export function createTodayService(deps: { db: Database; ai: AiClient; meetings: MeetingsService; clock: Clock }) {
  const { db, ai, meetings, clock } = deps;

  const rep = async (scope: UserScope) => {
    const user = await usersRepo(db).findById(scope, scope.userId);
    if (user === undefined) throw notFound();
    return user;
  };

  /** Runs one validated call under the caller's scope. */
  const run = async (scope: UserScope, call: AskCall, timeZone: string, draftRequested: boolean): Promise<Result> => {
    const repo = insightsRepo(db);
    const now = clock();
    const dealItem = (deal: {
      accountId: string;
      accountName: string;
      stage: keyof typeof STAGE_LABELS;
      annualValueCents: number;
      ownerName: string;
      lastActivityAt: Date;
    }) => ({
      label: deal.accountName,
      sub: `${STAGE_LABELS[deal.stage]} · ${money(deal.annualValueCents)} a year · ${deal.ownerName} · last activity ${localDay(deal.lastActivityAt, timeZone)}`,
      link: `/accounts/${deal.accountId}`,
    });
    switch (call.fn) {
      case "myOpenDeals": {
        const rows = await repo.openDeals(scope, true);
        return { fn: call.fn, summary: `You have ${plural(rows.length, "open deal")}.`, items: rows.map(dealItem) };
      }
      case "dealsByStage": {
        const rows = await repo.dealsByStage(scope, call.stage);
        return {
          fn: call.fn,
          summary: `${plural(rows.length, "deal")} at ${STAGE_LABELS[call.stage]}.`,
          items: rows.map(dealItem),
        };
      }
      case "stalledDeals": {
        const rows = await repo.stalledDeals(scope, new Date(now.getTime() - call.days * DAY));
        return {
          fn: call.fn,
          summary: `${plural(rows.length, "open deal")} with no activity in ${String(call.days)} days.`,
          items: rows.map(dealItem),
        };
      }
      case "meetingsBetween": {
        const [fy, fm, fd] = call.from.split("-").map(Number);
        const [ty, tm, td] = call.to.split("-").map(Number);
        const from = zonedTime(fy ?? 2000, fm ?? 1, fd ?? 1, 0, 0, timeZone);
        const to = new Date(
          Math.min(zonedTime(ty ?? 2000, tm ?? 1, (td ?? 1) + 1, 0, 0, timeZone).getTime(), from.getTime() + 31 * DAY),
        );
        // Always the caller's own meetings.
        const rows = (await meetingsRepo(db).between(scope, from, to, scope.userId)).filter(
          (row) => row.meeting.status === "scheduled" || row.meeting.status === "done",
        );
        return {
          fn: call.fn,
          summary: `${plural(rows.length, "meeting")} from ${call.from} to ${call.to}.`,
          items: rows.map((row) => ({
            label: row.meeting.title,
            sub: `${localDay(row.meeting.startsAt, timeZone)} ${formatTime(row.meeting.startsAt, timeZone)} · ${MEETING_KIND_LABELS[row.meeting.kind]}`,
            link: row.meeting.accountId === null ? "/calendar" : `/accounts/${row.meeting.accountId}?tab=meetings`,
          })),
        };
      }
      case "accountByName": {
        const rows = await repo.accountsByName(scope, call.text);
        return {
          fn: call.fn,
          summary: `${plural(rows.length, "account")} named like "${call.text}".`,
          items: rows.map((row) => ({
            label: draftRequested ? `Write outreach for ${row.name}` : row.name,
            sub: `${row.propertyType}${row.city === null ? "" : ` · ${row.city}`} · ${row.ownerName ?? "Unassigned"}${row.fitScore === null ? "" : ` · fit ${String(row.fitScore)}`}`,
            link: `/accounts/${row.id}${draftRequested ? "?tab=outreach" : ""}`,
          })),
        };
      }
      case "recentReplies": {
        const rows = await repo.recentReplies(scope, new Date(now.getTime() - call.days * DAY));
        return {
          fn: call.fn,
          summary: `${plural(rows.length, "reply")} in the last ${String(call.days)} days.`,
          items: rows.map((row) => ({
            label: `${row.accountName}: ${row.subject}`.slice(0, 200),
            sub: `${row.fromEmail}${row.classification === null ? "" : ` · ${row.classification.replace(/_/g, " ")}`}`,
            link: `/accounts/${row.accountId}?tab=outreach`,
          })),
        };
      }
      case "topAccountsByFit": {
        const rows = await repo.topAccountsByFit(scope, call.n, call.filters ?? {});
        return {
          fn: call.fn,
          summary: `The ${plural(rows.length, "account")} with the best fit.`,
          items: rows.map((row) => ({
            label: row.name,
            sub: `fit ${String(row.fitScore ?? 0)} · ${row.propertyType}${row.city === null ? "" : ` · ${row.city}`} · ${row.ownerName ?? "Unassigned"}`,
            link: `/accounts/${row.id}`,
          })),
        };
      }
      case "forecast": {
        const rows = await repo.forecastDeals(scope);
        const open = rows.reduce((sum, row) => sum + row.annualValueCents, 0);
        const weighted = weightedForecastCents(rows);
        return {
          fn: call.fn,
          summary: `Open pipeline ${money(open)} a year across ${plural(rows.length, "deal")}; weighted forecast ${money(weighted)}.`,
          items: [],
        };
      }
    }
  };

  return {
    async today(scope: UserScope): Promise<TodayResponse> {
      const now = clock();
      const user = await rep(scope);
      const zone = user.timezone;
      const repo = insightsRepo(db);
      const [facts, own, tasks, upcoming] = await Promise.all([
        repo.nbaDeals(scope),
        repo.ownDeals(scope),
        tasksRepo(db).list(scope, { open: true }),
        meetingsRepo(db).between(scope, new Date(now.getTime() - DAY), new Date(now.getTime() + 5 * DAY), scope.userId),
      ]);
      const deals: NbaDeal[] = facts.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        accountName: row.accountName,
        stage: row.stage,
        status: row.status,
        annualValueCents: row.annualValueCents,
        lastActivityAt: row.lastActivityAt,
        contactName: row.contactName,
        outboundCount: row.outboundCount,
        lastOutboundAt: row.lastOutboundAt === null ? null : new Date(row.lastOutboundAt),
        loggedTouches: row.loggedTouches,
        lastInboundAt: row.lastInboundAt === null ? null : new Date(row.lastInboundAt),
        lastInterestedAt: row.lastInterestedAt === null ? null : new Date(row.lastInterestedAt),
        interestedContact: row.interestedContact,
        proposal:
          row.proposalSentAt === null ? null : { sentAt: new Date(row.proposalSentAt), viewCount: row.proposalViews },
        contract:
          row.contractSentAt === null
            ? null
            : {
                sentAt: new Date(row.contractSentAt),
                viewCount: row.contractViews ?? 0,
                signerName: row.contractSigner,
              },
        topSignal: row.topSignal,
      }));
      const actions = nextBestActions({
        now,
        timeZone: zone,
        meetings: upcoming.map((row) => ({
          id: row.meeting.id,
          title: row.meeting.title,
          startsAt: row.meeting.startsAt,
          kind: row.meeting.kind,
          accountId: row.meeting.accountId,
          status: row.meeting.status,
        })),
        deals,
        tasks: tasks.map((row) => ({
          id: row.task.id,
          title: row.task.title,
          dueAt: row.task.dueAt,
          doneAt: row.task.doneAt,
          accountId: row.task.accountId,
        })),
      });

      // The four numbers, for the rep's own deals.
      const open = own.filter((deal) => deal.status === "open");
      const week = weekWindow(now, zone);
      const quarter = quarterWindow(now, zone);
      const weekMeetings = await meetingsRepo(db).between(scope, week.from, week.to, scope.userId);
      const stats = {
        openPipelineCents: open.reduce((sum, deal) => sum + deal.annualValueCents, 0),
        weightedForecastCents: weightedForecastCents(open),
        meetingsThisWeek: weekMeetings.filter(
          (row) => row.meeting.kind !== "internal" && row.meeting.status !== "cancelled",
        ).length,
        wonThisQuarterCents: own
          .filter(
            (deal) => deal.status === "won" && deal.stageChangedAt >= quarter.from && deal.stageChangedAt < quarter.to,
          )
          .reduce((sum, deal) => sum + deal.annualValueCents, 0),
      };

      // The schedule: today, or next week from Friday 3 pm through Sunday.
      const window = scheduleWindow(now, zone);
      const calendar = await meetings.list(scope, { from: window.from.toISOString(), to: window.to.toISOString() });
      const items = [
        ...calendar.meetings
          .filter((meeting) => meeting.status !== "cancelled")
          .map((meeting) => ({
            start: meeting.startsAt,
            end: meeting.endsAt,
            title: meeting.title,
            kind: "meeting" as const,
            link: meeting.accountId === null ? null : `/accounts/${meeting.accountId}?tab=meetings`,
          })),
        ...calendar.busy.map((block) => ({
          start: block.start,
          end: block.end,
          title: block.title ?? "Busy",
          kind: "busy" as const,
          link: null,
        })),
      ].sort((a, b) => a.start.localeCompare(b.start));
      return {
        stats,
        actions,
        schedule: {
          label: window.label,
          from: window.from.toISOString(),
          to: window.to.toISOString(),
          items,
          calendarRead: calendar.calendarRead,
        },
      };
    },

    async ask(scope: UserScope, question: string): Promise<AskResponse> {
      const now = clock();
      const user = await rep(scope);
      const zone = user.timezone;
      const week = weekWindow(now, zone);
      const draftRequested = DRAFT.test(question);

      // Step 1: the plan. Anything outside the fixed functions fails validation (and the retry), so nothing runs.
      let plan: AskPlan;
      try {
        plan = (
          await ai.generate({
            feature: "ask",
            tier: "fast",
            ...askPlanPrompt(question, {
              today: localDay(now, zone),
              weekStart: localDay(week.from, zone),
              weekEnd: localDay(new Date(week.to.getTime() - 1), zone),
              role: user.role,
            }),
            schema: AskPlan,
            userId: scope.userId,
          })
        ).data;
      } catch (error) {
        if (error instanceof Error && error.name === "HttpError") throw error; // e.g. the daily AI limit (429)
        return {
          answer: "I couldn't work out which CRM data answers that. Try asking it another way.",
          items: [],
          calls: [],
        };
      }

      // Step 2: the server runs the calls under the caller's scope.
      const results: Result[] = [];
      for (const call of plan.calls) results.push(await run(scope, call, zone, draftRequested));
      const allowed = new Set(results.flatMap((result) => result.items.map((item) => item.link)));
      const calls = plan.calls.map((call) => call.fn);
      if (results.length === 0) {
        return {
          answer: "That isn't something I can look up. Try asking about deals, meetings, replies or accounts.",
          items: [],
          calls,
        };
      }

      // Step 3: the answer, from those results only; links must be ones the queries returned.
      const data: AskResultData = {
        today: localDay(now, zone),
        results: results.map((result) => ({ ...result, items: result.items.slice(0, 15) })),
        draftRequested,
      };
      try {
        const answer = (
          await ai.generate({
            feature: "ask",
            tier: "writer",
            ...askAnswerPrompt(question, data),
            schema: AskAnswer,
            userId: scope.userId,
            check: (output) =>
              output.items
                .filter((item) => !allowed.has(item.link))
                .map((item) => `The link ${item.link} is not in the results. Use only links from the results.`),
          })
        ).data;
        return { ...answer, calls };
      } catch (error) {
        if (error instanceof Error && error.name === "HttpError") throw error;
        // The model's answer couldn't be used: show the query results as they are.
        return {
          answer: results.map((result) => result.summary).join(" "),
          items: results.flatMap((result) => result.items).slice(0, 10),
          calls,
        };
      }
    },
  };
}

export type TodayService = ReturnType<typeof createTodayService>;
