import {
  BookedMeeting,
  Meeting,
  MeetingList,
  MEETING_KIND_LABELS,
  PrepBriefResponse,
  SlotResponse,
  type Account,
  type SlotOption,
} from "@soa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, Car, Clock, FileText, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { api, ApiError } from "../api";
import { useMe } from "../session";
import { dayLabel, timeLabel } from "../time";
import { Btn, Empty, ErrorState, Field, inputClass, Loading, Modal, Panel, Pill } from "../ui";

/* The Meetings tab (ARCHITECTURE.md §9, §12): find times that allow for drive time, book one, read the prep brief,
   mark the outcome. */

const STATUS_TONE = { scheduled: "blue", done: "green", cancelled: "red", no_show: "red" } as const;
const Queued = z.object({ status: z.literal("queued") });

export function PrepBrief({ meetingId }: { meetingId: string }) {
  const queryClient = useQueryClient();
  const prep = useQuery({
    queryKey: ["prep", meetingId],
    queryFn: () => api(`/api/meetings/${meetingId}/prep`, PrepBriefResponse),
    refetchInterval: (query) => (query.state.data?.pending === true ? 2000 : false),
  });
  const regenerate = useMutation({
    mutationFn: () => api(`/api/meetings/${meetingId}/prep`, Queued, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["prep", meetingId] }),
  });
  if (prep.isPending) return <Loading />;
  if (prep.isError) return <ErrorState error={prep.error} onRetry={() => void prep.refetch()} />;
  const data = prep.data;
  return (
    <div className="space-y-3">
      {data.pending && <Loading label="Writing the prep brief…" />}
      {data.lastError !== null && !data.pending && <ErrorState error={new Error(data.lastError)} />}
      {data.sections === null
        ? !data.pending && <Empty>No prep brief yet.</Empty>
        : data.sections.map((section) => (
            <section key={section.key}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{section.heading}</h3>
              <div className="mt-1 space-y-1 text-sm text-zinc-200">
                {section.text.split("\n").map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
              </div>
            </section>
          ))}
      <Btn
        small
        kind="ghost"
        icon={RefreshCw}
        busy={regenerate.isPending || data.pending}
        onClick={() => {
          regenerate.mutate();
        }}
      >
        {data.sections === null ? "Write prep brief" : "Rewrite prep brief"}
      </Btn>
      {regenerate.isError && <ErrorState error={regenerate.error} />}
    </div>
  );
}

function SlotCard({ slot, onBook, busy }: { slot: SlotOption; onBook: () => void; busy: boolean }) {
  const zone = useMe().data?.user.timezone ?? "America/Chicago";
  const day = (iso: string) => dayLabel(iso, zone);
  const time = (iso: string) => timeLabel(iso, zone);
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <p className="text-sm font-semibold text-zinc-100">{day(slot.start)}</p>
      <p className="text-sm text-zinc-300">
        {time(slot.start)} to {time(slot.end)}
      </p>
      <ul className="mt-2 space-y-1 text-xs text-zinc-400">
        {slot.reasons.map((reason, index) => (
          <li key={index} className="flex gap-1.5">
            {reason.includes("drive") ? (
              <Car size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            ) : (
              <Clock size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            )}
            {reason}
          </li>
        ))}
      </ul>
      {slot.estimated && (
        <p className="mt-1">
          <Pill tone="amber">Drive time estimated</Pill>
        </p>
      )}
      <Btn kind="primary" className="mt-3 w-full" busy={busy} onClick={onBook}>
        Book this time
      </Btn>
    </li>
  );
}

export function MeetingsTab({ account }: { account: Account }) {
  const queryClient = useQueryClient();
  const zone = useMe().data?.user.timezone ?? "America/Chicago";
  const day = (iso: string) => dayLabel(iso, zone);
  const time = (iso: string) => timeLabel(iso, zone);
  const [kind, setKind] = useState<"site_walk" | "call">("site_walk");
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openPrep, setOpenPrep] = useState<string | null>(null);
  const duration = kind === "site_walk" ? 60 : 30;
  const primary = account.contacts.find((contact) => contact.isPrimary) ?? account.contacts[0];

  // The API serves at most two months at a time: the last month and the next.
  const range = {
    from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    to: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  };
  const meetings = useQuery({
    queryKey: ["meetings", "account", account.id],
    queryFn: () =>
      api(`/api/meetings?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, MeetingList),
    select: (data) => data.meetings.filter((meeting) => meeting.accountId === account.id).reverse(),
  });
  const find = useMutation({
    mutationFn: () =>
      api(`/api/accounts/${account.id}/slots`, SlotResponse, {
        method: "POST",
        body: { kind, durationMinutes: duration },
      }),
    onSuccess: (result) => {
      setNotice(null);
      setSlots(result.slots);
    },
  });
  const book = useMutation({
    mutationFn: (slot: SlotOption) =>
      api("/api/meetings", BookedMeeting, {
        method: "POST",
        body: { accountId: account.id, kind, start: slot.start, durationMinutes: duration },
      }),
    onSuccess: async (meeting) => {
      setSlots(null);
      setNotice(
        meeting.invited
          ? "Booked. Calendar invite sent."
          : "Booked in your calendar. No invite was sent (the contact's email can't be used).",
      );
      setOpenPrep(meeting.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["meetings"] }),
        queryClient.invalidateQueries({ queryKey: ["account", account.id] }),
        queryClient.invalidateQueries({ queryKey: ["timeline", account.id] }),
      ]);
    },
    onError: (error) => {
      // 409: the time was just taken; the server offers fresh slots.
      if (error instanceof ApiError && error.code === "slot_taken") {
        const fresh = z.object({ slots: SlotResponse.shape.slots }).safeParse(error.details);
        if (fresh.success) setSlots(fresh.data.slots);
        setNotice("That time was just taken. Here are fresh times.");
      }
    },
  });
  const setStatus = useMutation({
    mutationFn: (input: { id: string; status: "done" | "no_show" | "cancelled" }) =>
      api(`/api/meetings/${input.id}`, Meeting, { method: "PATCH", body: { status: input.status } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["meetings"] }),
  });

  if (!account.canEdit) return <Empty>Claim this account to book meetings.</Empty>;

  return (
    <div className="space-y-4">
      <Panel title="Book a meeting" icon={Calendar}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Field label="Type">
              <select
                className={inputClass}
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as "site_walk" | "call");
                  setSlots(null);
                }}
              >
                <option value="site_walk">Site walk, 60 minutes</option>
                <option value="call">Phone call, 30 minutes</option>
              </select>
            </Field>
          </div>
          <Btn
            kind="blue"
            icon={Sparkles}
            busy={find.isPending}
            onClick={() => {
              find.mutate();
            }}
          >
            Find best times
          </Btn>
        </div>
        <p className="mt-2 text-xs text-zinc-400">
          Reads your calendar for the next two weeks and leaves room to drive between stops
          {primary?.contactPref != null ? `. ${primary.firstName}: ${primary.contactPref}` : ""}.
        </p>
        {notice !== null && (
          <p className="mt-2 text-sm text-amber-300" role="status">
            {notice}
          </p>
        )}
        {find.isError && (
          <div className="mt-3">
            <ErrorState error={find.error} />
          </div>
        )}
        {book.isError && !(book.error instanceof ApiError && book.error.code === "slot_taken") && (
          <div className="mt-3">
            <ErrorState error={book.error} />
          </div>
        )}
        {slots !== null &&
          (slots.length === 0 ? (
            <div className="mt-3">
              <Empty>No free time fits in the next two weeks. Try a shorter meeting.</Empty>
            </div>
          ) : (
            <ul className="mt-3 grid gap-2 md:grid-cols-3">
              {slots.map((slot) => (
                <SlotCard
                  key={slot.start}
                  slot={slot}
                  busy={book.isPending && book.variables.start === slot.start}
                  onBook={() => {
                    book.mutate(slot);
                  }}
                />
              ))}
            </ul>
          ))}
      </Panel>

      <Panel title="Meetings with this account" icon={Clock}>
        {meetings.isPending ? (
          <Loading />
        ) : meetings.isError ? (
          <ErrorState error={meetings.error} onRetry={() => void meetings.refetch()} />
        ) : meetings.data.length === 0 ? (
          <Empty>No meetings yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {meetings.data.map((meeting) => (
              <li key={meeting.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-zinc-100">{meeting.title}</p>
                  <Pill tone={STATUS_TONE[meeting.status]}>{meeting.status.replace("_", " ")}</Pill>
                  <span className="text-xs text-zinc-400">
                    {day(meeting.startsAt)}, {time(meeting.startsAt)} ·{" "}
                    {meeting.locationText ?? MEETING_KIND_LABELS[meeting.kind]}
                  </span>
                  <span className="ml-auto flex flex-wrap gap-2">
                    <Btn
                      small
                      icon={FileText}
                      onClick={() => {
                        setOpenPrep(meeting.id);
                      }}
                    >
                      Prep brief
                    </Btn>
                    {meeting.status === "scheduled" && (
                      <>
                        <Btn
                          small
                          onClick={() => {
                            setStatus.mutate({ id: meeting.id, status: "done" });
                          }}
                        >
                          Done
                        </Btn>
                        <Btn
                          small
                          onClick={() => {
                            setStatus.mutate({ id: meeting.id, status: "no_show" });
                          }}
                        >
                          No-show
                        </Btn>
                        <Btn
                          small
                          kind="ghost"
                          onClick={() => {
                            setStatus.mutate({ id: meeting.id, status: "cancelled" });
                          }}
                        >
                          Cancel
                        </Btn>
                      </>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {setStatus.isError && <ErrorState error={setStatus.error} />}
      </Panel>

      {openPrep !== null && (
        <Modal
          title="Prep brief"
          wide
          onClose={() => {
            setOpenPrep(null);
          }}
        >
          <PrepBrief meetingId={openPrep} />
        </Modal>
      )}
    </div>
  );
}
