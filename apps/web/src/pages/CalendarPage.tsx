import { AssignableUsers, MeetingList, MEETING_KIND_LABELS, type Meeting } from "@soa/shared";
import { useQuery } from "@tanstack/react-query";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useMe } from "../session";
import { dayKey, timeLabel } from "../time";
import { Btn, Empty, ErrorState, inputClass, Loading, Modal, Panel, Pill } from "../ui";
import { PrepBrief } from "./Meetings";

/* The Calendar screen (§12): a week of CRM meetings and busy time. Managers can look at a rep's week; the titles of a
   rep's own (non-CRM) events are only ever shown to that rep. */

const startOfWeek = (date: Date) => {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7)); // Monday
  return result;
};
const STATUS_TONE = { scheduled: "blue", done: "green", cancelled: "red", no_show: "red" } as const;

export function CalendarPage() {
  const me = useMe();
  const [week, setWeek] = useState(() => startOfWeek(new Date()));
  const [owner, setOwner] = useState<string>("");
  const [openPrep, setOpenPrep] = useState<Meeting | null>(null);
  const isManager = me.data?.user.role !== "ae";
  const zone = me.data?.user.timezone ?? "America/Chicago";
  const time = (iso: string) => timeLabel(iso, zone);
  // Days are the rep's days: an event belongs to the date it starts on in their time zone.
  const sameDay = (iso: string, day: Date) =>
    dayKey(iso, zone) === dayKey(new Date(day.getTime() + 12 * 3600_000), zone);
  const from = week.toISOString();
  const to = new Date(week.getTime() + 7 * 86_400_000).toISOString();
  const users = useQuery({
    queryKey: ["assignable-users"],
    queryFn: () => api("/api/users", AssignableUsers),
    enabled: isManager,
  });
  const data = useQuery({
    queryKey: ["meetings", "week", from, owner],
    queryFn: () =>
      api(
        `/api/meetings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${owner === "" ? "" : `&owner=${owner}`}`,
        MeetingList,
      ),
  });
  const days = Array.from({ length: 5 }, (_, index) => new Date(week.getTime() + index * 86_400_000));
  const move = (weeks: number) => {
    setWeek(new Date(week.getTime() + weeks * 7 * 86_400_000));
  };

  return (
    <div className="space-y-4">
      <Panel
        title={`Week of ${week.toLocaleDateString(undefined, { month: "long", day: "numeric" })}`}
        icon={Calendar}
        right={
          <>
            {isManager && (
              <select
                aria-label="Whose calendar"
                className={`${inputClass} w-48`}
                value={owner}
                onChange={(event) => {
                  setOwner(event.target.value);
                }}
              >
                <option value="">My calendar</option>
                {(users.data?.items ?? [])
                  .filter((user) => user.id !== me.data?.user.id)
                  .map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
              </select>
            )}
            <Btn
              small
              kind="ghost"
              icon={ChevronLeft}
              aria-label="Previous week"
              onClick={() => {
                move(-1);
              }}
            />
            <Btn
              small
              onClick={() => {
                setWeek(startOfWeek(new Date()));
              }}
            >
              This week
            </Btn>
            <Btn
              small
              kind="ghost"
              icon={ChevronRight}
              aria-label="Next week"
              onClick={() => {
                move(1);
              }}
            />
          </>
        }
      >
        {data.isPending ? (
          <Loading />
        ) : data.isError ? (
          <ErrorState error={data.error} onRetry={() => void data.refetch()} />
        ) : (
          <>
            {!data.data.calendarRead && (
              <p className="mb-3 text-xs text-amber-300">
                The calendar couldn&apos;t be read (the mailbox needs reconnecting). Only CRM meetings are shown.
              </p>
            )}
            <div className="grid gap-3 md:grid-cols-5">
              {days.map((dayDate) => {
                const meetings = data.data.meetings.filter((meeting) => sameDay(meeting.startsAt, dayDate));
                const busy = data.data.busy.filter((block) => sameDay(block.start, dayDate));
                const items = [
                  ...meetings.map((meeting) => ({ at: meeting.startsAt, meeting, block: null })),
                  ...busy.map((block) => ({ at: block.start, meeting: null, block })),
                ].sort((a, b) => a.at.localeCompare(b.at));
                return (
                  <section key={dayDate.toISOString()} className="min-w-0 rounded-lg border border-zinc-800 p-2">
                    <h3 className="mb-2 text-xs font-semibold text-zinc-300">
                      {dayDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                    </h3>
                    {items.length === 0 ? (
                      <p className="text-xs text-zinc-600">Free</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {items.map((item, index) =>
                          item.meeting !== null ? (
                            <li
                              key={item.meeting.id}
                              className="rounded border border-blue-900 bg-blue-950/30 p-2 text-xs"
                            >
                              <p className="text-zinc-400">
                                {time(item.meeting.startsAt)} to {time(item.meeting.endsAt)}
                              </p>
                              <button
                                type="button"
                                className="text-left font-medium text-zinc-100 hover:underline"
                                onClick={() => {
                                  setOpenPrep(item.meeting);
                                }}
                              >
                                {item.meeting.title}
                              </button>
                              <p className="mt-1 flex flex-wrap gap-1">
                                <Pill tone={STATUS_TONE[item.meeting.status]}>
                                  {item.meeting.status.replace("_", " ")}
                                </Pill>
                                <span className="text-zinc-500">{MEETING_KIND_LABELS[item.meeting.kind]}</span>
                              </p>
                            </li>
                          ) : (
                            <li
                              key={`busy-${String(index)}`}
                              className="rounded border border-zinc-800 bg-zinc-900 p-2 text-xs text-zinc-400"
                            >
                              <p>
                                {time(item.block.start)} to {time(item.block.end)}
                              </p>
                              <p className="text-zinc-300">{item.block.title ?? "Busy"}</p>
                            </li>
                          ),
                        )}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
            {data.data.meetings.length === 0 && data.data.busy.length === 0 && (
              <div className="mt-3">
                <Empty>Nothing this week. Book meetings from an account&apos;s Meetings tab.</Empty>
              </div>
            )}
          </>
        )}
      </Panel>
      {openPrep !== null && (
        <Modal
          title={openPrep.title}
          wide
          onClose={() => {
            setOpenPrep(null);
          }}
        >
          {openPrep.accountId !== null && (
            <p className="mb-3 text-xs">
              <Link className="text-blue-300 hover:underline" to={`/accounts/${openPrep.accountId}?tab=meetings`}>
                Open {openPrep.accountName ?? "the account"}
              </Link>
            </p>
          )}
          <PrepBrief meetingId={openPrep.id} />
        </Modal>
      )}
    </div>
  );
}
