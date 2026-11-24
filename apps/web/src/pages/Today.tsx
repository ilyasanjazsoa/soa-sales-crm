import { formatMoneyShort, TodayResponse } from "@soa/shared";
import { useQuery } from "@tanstack/react-query";
import { Calendar, ListChecks, Sun } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useMe } from "../session";
import { dayLabel, timeLabel } from "../time";
import { Btn, Empty, ErrorState, Loading, Panel, Pill, Stat } from "../ui";

/* Today (§11.1): the four numbers, next best actions (computed by code, no AI) and today's schedule. From Friday
   3 pm through Sunday the schedule shows next week. */

const VISIBLE = 12;
const PRIORITY_TONE = ["green", "amber", "amber", "blue", "zinc"] as const;

export function TodayPage() {
  const me = useMe();
  const zone = me.data?.user.timezone ?? "America/Chicago";
  const [showAll, setShowAll] = useState(false);
  const today = useQuery({
    queryKey: ["today"],
    queryFn: () => api("/api/today", TodayResponse),
    refetchInterval: 60_000,
  });
  if (today.isPending) return <Loading />;
  if (today.isError) return <ErrorState error={today.error} onRetry={() => void today.refetch()} />;
  const { stats, actions, schedule } = today.data;
  const nextWeek = schedule.label === "next_week";
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Open pipeline" value={formatMoneyShort(stats.openPipelineCents)} />
        <Stat label="Weighted forecast" value={formatMoneyShort(stats.weightedForecastCents)} />
        <Stat label="Customer meetings this week" value={String(stats.meetingsThisWeek)} />
        <Stat label="Won this quarter" value={formatMoneyShort(stats.wonThisQuarterCents)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Next best actions" icon={ListChecks}>
            {actions.length === 0 ? (
              <Empty>Nothing needs you right now. Find new prospects or research a lead.</Empty>
            ) : (
              <ul className="space-y-2">
                {(showAll ? actions : actions.slice(0, VISIBLE)).map((action) => (
                  <li
                    key={action.key}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"
                  >
                    <Pill tone={PRIORITY_TONE[action.priority] ?? "zinc"}>
                      {action.priority === 0 ? "Now" : `P${String(action.priority)}`}
                    </Pill>
                    <p className="min-w-0 flex-1 text-sm text-zinc-200">{action.text}</p>
                    {action.valueCents > 0 && (
                      <span className="text-xs text-zinc-500">{formatMoneyShort(action.valueCents)}</span>
                    )}
                    <Link
                      to={action.button.href}
                      className="whitespace-nowrap rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500"
                    >
                      {action.button.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {!showAll && actions.length > VISIBLE && (
              <Btn
                small
                kind="ghost"
                className="mt-2"
                onClick={() => {
                  setShowAll(true);
                }}
              >
                Show {actions.length - VISIBLE} more
              </Btn>
            )}
          </Panel>
        </div>
        <Panel title={nextWeek ? "Next week" : "Today"} icon={nextWeek ? Calendar : Sun}>
          {!schedule.calendarRead && (
            <p className="mb-2 text-xs text-amber-300">
              The calendar couldn&apos;t be read; only CRM meetings are shown.
            </p>
          )}
          {schedule.items.length === 0 ? (
            <Empty>{nextWeek ? "Nothing booked next week yet." : "Nothing else on your calendar today."}</Empty>
          ) : (
            <ul className="space-y-1.5" aria-label="Schedule">
              {schedule.items.map((item, index) => (
                <li
                  key={`${item.start}-${String(index)}`}
                  className={`rounded border p-2 text-xs ${
                    item.kind === "meeting" ? "border-blue-900 bg-blue-950/30" : "border-zinc-800 bg-zinc-900"
                  }`}
                >
                  <p className="text-zinc-400">
                    {nextWeek ? `${dayLabel(item.start, zone)}, ` : ""}
                    {timeLabel(item.start, zone)} to {timeLabel(item.end, zone)}
                  </p>
                  {item.link === null ? (
                    <p className="text-zinc-200">{item.title}</p>
                  ) : (
                    <Link to={item.link} className="font-medium text-zinc-100 hover:underline">
                      {item.title}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
