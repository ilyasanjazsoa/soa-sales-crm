import {
  Account,
  ActivityPage,
  AssignableUsers,
  Contact,
  Deal,
  formatMoneyShort,
  STAGE_LABELS,
  Task,
  TaskList,
  type ContactInput,
  type DealStage,
} from "@soa/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Building,
  Calendar,
  Check,
  DollarSign,
  History,
  Pen,
  Plus,
  Send,
  Sparkles,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { z } from "zod";
import { api, ApiError } from "../api";
import { choosableStages, LoseDialog, needsOverrideReason, OverrideDialog, StagePill } from "../deal-ui";
import { useMe } from "../session";
import { MeetingsTab } from "./Meetings";
import { OutreachTab } from "./Outreach";
import { ContractTab, ProposalTab } from "./Proposals";
import { ResearchTab } from "./Research";
import { Btn, Empty, ErrorState, Field, inputClass, Loading, Modal, Panel, Pill } from "../ui";

const TABS: { id: string; label: string; icon: LucideIcon; milestone?: number; what?: string }[] = [
  { id: "research", label: "Research", icon: Sparkles },
  { id: "outreach", label: "Outreach", icon: Send },
  { id: "meetings", label: "Meetings", icon: Calendar },
  { id: "proposal", label: "Proposal", icon: DollarSign },
  { id: "contract", label: "Contract", icon: Pen },
  { id: "timeline", label: "Timeline", icon: History },
];

const ago = (iso: string) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  if (minutes < 1440) return `${String(Math.round(minutes / 60))} h ago`;
  const days = Math.round(minutes / 1440);
  return days === 1 ? "yesterday" : `${String(days)} days ago`;
};

function Timeline({ accountId, canEdit }: { accountId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const timeline = useInfiniteQuery({
    queryKey: ["timeline", accountId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api(
        `/api/accounts/${accountId}/timeline?limit=25${pageParam === undefined ? "" : `&cursor=${pageParam}`}`,
        ActivityPage,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const add = useMutation({
    mutationFn: (text: string) =>
      api(`/api/accounts/${accountId}/notes`, z.unknown(), { method: "POST", body: { text } }),
    onSuccess: async () => {
      setNote("");
      await queryClient.invalidateQueries({ queryKey: ["timeline", accountId] });
    },
  });
  const items = timeline.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Panel title="Timeline" icon={History}>
      {canEdit && (
        <form
          className="mb-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (note.trim() !== "") add.mutate(note.trim());
          }}
        >
          <input
            aria-label="Add a note"
            className={inputClass}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
            placeholder="Add a note"
          />
          <Btn type="submit" icon={Plus} busy={add.isPending} disabled={note.trim() === ""}>
            Add
          </Btn>
        </form>
      )}
      {add.isError && <ErrorState error={add.error} />}
      {timeline.isPending ? (
        <Loading />
      ) : timeline.isError ? (
        <ErrorState error={timeline.error} onRetry={() => void timeline.refetch()} />
      ) : items.length === 0 ? (
        <Empty>Nothing has happened on this account yet.</Empty>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
              {item.subject !== null && <p className="text-sm text-zinc-200">{item.subject}</p>}
              {item.body !== null && <p className="whitespace-pre-wrap text-sm text-zinc-300">{item.body}</p>}
              <p className="text-xs text-zinc-400">
                {item.user?.name ?? "System"} · {ago(item.occurredAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
      {timeline.hasNextPage && (
        <div className="mt-3 text-center">
          <Btn small busy={timeline.isFetchingNextPage} onClick={() => void timeline.fetchNextPage()}>
            Show older
          </Btn>
        </div>
      )}
    </Panel>
  );
}

function ContactsPanel({ account }: { account: Account }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState<{
    firstName: string;
    lastName: string;
    title: string;
    email: string;
    phone: string;
  } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["account", account.id] });
  const add = useMutation({
    mutationFn: (body: ContactInput) => api(`/api/accounts/${account.id}/contacts`, Contact, { method: "POST", body }),
    onSuccess: async () => {
      setAdding(null);
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<ContactInput> }) =>
      api(`/api/contacts/${id}`, Contact, { method: "PATCH", body }),
    onSettled: refresh,
  });
  return (
    <Panel
      title="Contacts"
      icon={Users}
      right={
        account.canEdit && (
          <Btn
            small
            icon={Plus}
            onClick={() => {
              setAdding({ firstName: "", lastName: "", title: "", email: "", phone: "" });
            }}
          >
            Add
          </Btn>
        )
      }
    >
      {account.contacts.length === 0 ? (
        <Empty>No contacts yet. Add the decision maker.</Empty>
      ) : (
        <ul className="space-y-3">
          {account.contacts.map((contact) => (
            <li key={contact.id} className="text-sm">
              <p className="flex flex-wrap items-center gap-1.5 text-zinc-100">
                {contact.firstName} {contact.lastName}
                {contact.isPrimary && <Pill tone="blue">Primary</Pill>}
                {contact.emailStatus !== "ok" && <Pill tone="red">{contact.emailStatus}</Pill>}
                {contact.doNotCall && <Pill tone="red">Do not call</Pill>}
              </p>
              {contact.title !== null && <p className="text-xs text-zinc-400">{contact.title}</p>}
              {contact.email !== null && <p className="truncate text-xs text-zinc-400">{contact.email}</p>}
              {contact.phone !== null && (
                <p className="text-xs text-zinc-400">
                  {contact.phone}
                  {contact.phoneType === "unknown" ? "" : ` · ${contact.phoneType}`}
                </p>
              )}
              {contact.contactPref !== null && <p className="text-xs text-zinc-400">{contact.contactPref}</p>}
              {account.canEdit && (
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-zinc-400">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={contact.doNotCall}
                      onChange={(event) => {
                        update.mutate({ id: contact.id, body: { doNotCall: event.target.checked } });
                      }}
                    />
                    Do not call
                  </label>
                  {!contact.isPrimary && (
                    <button
                      type="button"
                      className="text-blue-400 hover:text-blue-300"
                      onClick={() => {
                        update.mutate({ id: contact.id, body: { isPrimary: true } });
                      }}
                    >
                      Make primary
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {update.isError && <p className="mt-2 text-xs text-red-400">{update.error.message}</p>}
      {adding !== null && (
        <Modal
          title="Add contact"
          onClose={() => {
            setAdding(null);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ["firstName", "First name"],
                ["lastName", "Last name"],
                ["title", "Title"],
                ["email", "Email"],
                ["phone", "Phone"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  className={inputClass}
                  value={adding[key]}
                  onChange={(event) => {
                    setAdding({ ...adding, [key]: event.target.value });
                  }}
                />
              </Field>
            ))}
          </div>
          {add.isError && (
            <div className="mt-3">
              <ErrorState error={add.error} />
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Btn
              onClick={() => {
                setAdding(null);
              }}
            >
              Cancel
            </Btn>
            <Btn
              kind="primary"
              busy={add.isPending}
              disabled={adding.firstName.trim() === ""}
              onClick={() => {
                add.mutate({ ...adding, email: adding.email === "" ? null : adding.email });
              }}
            >
              Add contact
            </Btn>
          </div>
        </Modal>
      )}
    </Panel>
  );
}

function TasksPanel({ accountId, canEdit }: { accountId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const tasks = useQuery({
    queryKey: ["tasks", accountId],
    queryFn: () => api(`/api/tasks?open=true&accountId=${accountId}`, TaskList),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["tasks", accountId] });
  const add = useMutation({
    mutationFn: (text: string) => api("/api/tasks", Task, { method: "POST", body: { title: text, accountId } }),
    onSuccess: async () => {
      setTitle("");
      await refresh();
    },
  });
  const done = useMutation({
    mutationFn: (id: string) => api(`/api/tasks/${id}`, Task, { method: "PATCH", body: { done: true } }),
    onSettled: async () => {
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ["timeline", accountId] });
    },
  });
  return (
    <Panel title="Tasks" icon={Check}>
      {tasks.isPending ? (
        <Loading />
      ) : tasks.isError ? (
        <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />
      ) : tasks.data.items.length === 0 ? (
        <p className="text-xs text-zinc-400">No open tasks.</p>
      ) : (
        <ul className="space-y-2">
          {tasks.data.items.map((task) => (
            <li key={task.id} className="flex items-start gap-2 text-sm text-zinc-200">
              <input
                aria-label={`Complete ${task.title}`}
                type="checkbox"
                className="mt-1"
                onChange={() => {
                  done.mutate(task.id);
                }}
              />
              {task.title}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() !== "") add.mutate(title.trim());
          }}
        >
          <input
            aria-label="New task"
            className={inputClass}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            placeholder="New task"
          />
          <Btn type="submit" icon={Plus} busy={add.isPending} disabled={title.trim() === ""} aria-label="Add task" />
        </form>
      )}
      {(add.isError || done.isError) && (
        <p className="mt-2 text-xs text-red-400">{(add.error ?? done.error)?.message}</p>
      )}
    </Panel>
  );
}

function OwnerSelect({ account }: { account: Account }) {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ["assignable-users"], queryFn: () => api("/api/users", AssignableUsers) });
  const assign = useMutation({
    mutationFn: (ownerUserId: string | null) =>
      api(`/api/accounts/${account.id}/assign`, Account, { method: "POST", body: { ownerUserId } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["account", account.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["timeline", account.id] });
    },
  });
  const problem = users.error ?? assign.error;
  return (
    <Field label="Owner" {...(problem === null ? {} : { hint: problem.message })}>
      <select
        className={inputClass}
        value={account.owner?.id ?? ""}
        disabled={assign.isPending || users.isPending}
        onChange={(event) => {
          assign.mutate(event.target.value === "" ? null : event.target.value);
        }}
      >
        <option value="">Unassigned pool</option>
        {(users.data?.items ?? []).map((user) => (
          <option key={user.id} value={user.id}>
            {user.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function AccountPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "research";
  const me = useMe();
  const role = me.data?.user.role ?? "ae";
  const queryClient = useQueryClient();
  const [losing, setLosing] = useState(false);

  const account = useQuery({ queryKey: ["account", id], queryFn: () => api(`/api/accounts/${id}`, Account) });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["account", id] });
    await queryClient.invalidateQueries({ queryKey: ["timeline", id] });
  };
  const claim = useMutation({
    mutationFn: () => api(`/api/accounts/${id}/claim`, Account, { method: "POST" }),
    onSettled: refresh,
  });
  const [override, setOverride] = useState<{ dealId: string; stage: DealStage } | null>(null);
  const move = useMutation({
    mutationFn: ({ dealId, stage, reason }: { dealId: string; stage: DealStage; reason?: string }) =>
      api(`/api/deals/${dealId}/stage`, Deal, {
        method: "POST",
        body: { stage, ...(reason === undefined ? {} : { reason }) },
      }),
    onSuccess: () => {
      setOverride(null);
    },
    onSettled: refresh,
  });
  const requestMove = (dealId: string, stage: DealStage) => {
    if (needsOverrideReason(stage)) setOverride({ dealId, stage });
    else move.mutate({ dealId, stage });
  };
  const lose = useMutation({
    mutationFn: ({ dealId, reason, note }: { dealId: string; reason: string; note: string }) =>
      api(`/api/deals/${dealId}/lose`, Deal, { method: "POST", body: { reason, ...(note === "" ? {} : { note }) } }),
    onSuccess: () => {
      setLosing(false);
    },
    onSettled: refresh,
  });

  if (account.isPending) return <Loading />;
  if (account.isError) {
    if (account.error instanceof ApiError && account.error.status === 404) {
      return (
        <Panel>
          <Empty>Not found. This account doesn't exist or belongs to another rep.</Empty>
          <div className="mt-3 text-center">
            <Link to="/prospects" className="text-sm text-blue-400 hover:text-blue-300">
              Back to prospects
            </Link>
          </div>
        </Panel>
      );
    }
    return <ErrorState error={account.error} onRetry={() => void account.refetch()} />;
  }

  const a = account.data;
  const deal = a.deal;
  const current = TABS.find((entry) => entry.id === tab) ?? TABS[TABS.length - 1];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <Link to="/prospects" className="mb-2 flex w-fit items-center gap-1 text-xs text-zinc-400 hover:text-zinc-300">
          <ArrowLeft size={12} aria-hidden="true" />
          Prospects
        </Link>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            <h1 className="break-words text-xl font-semibold text-zinc-100">{a.name}</h1>
            <p className="text-sm text-zinc-400">
              {a.propertyType}
              {a.city === null ? "" : ` · ${a.city}`}
              {a.ownerCompany === null ? "" : ` · ${a.ownerCompany}`}
              {a.sizeText === null ? "" : ` · ${a.sizeText}`}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {deal !== null && <StagePill stage={deal.stage} status={deal.status} />}
              {deal !== null && <Pill>{formatMoneyShort(deal.annualValueCents)} a year</Pill>}
              <span title={a.fitReasons.join(" · ")}>
                <Pill tone={(a.fitScore ?? 0) >= 60 ? "green" : (a.fitScore ?? 0) >= 30 ? "amber" : "zinc"}>
                  Fit {a.fitScore ?? "–"}
                </Pill>
              </span>
              <Pill tone={a.owner === null ? "amber" : "zinc"}>
                {a.owner === null ? "Unassigned pool" : `Owner: ${a.owner.name}`}
              </Pill>
            </div>
          </div>
          {a.canEdit && (
            <div className="flex flex-wrap items-end gap-2">
              {deal?.status === "open" && (
                <Field label="Stage">
                  <select
                    aria-label="Deal stage"
                    className={inputClass}
                    value={deal.stage}
                    disabled={move.isPending}
                    onChange={(event) => {
                      requestMove(deal.id, event.target.value as DealStage);
                    }}
                  >
                    {[...new Set([deal.stage, ...choosableStages(role)])].map((stage) => (
                      <option key={stage} value={stage}>
                        {STAGE_LABELS[stage]}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {role !== "ae" && <OwnerSelect account={a} />}
              {deal?.status === "open" && (
                <Btn
                  kind="danger"
                  onClick={() => {
                    setLosing(true);
                  }}
                >
                  Mark lost
                </Btn>
              )}
            </div>
          )}
        </div>
        {move.isError && (
          <p role="alert" className="mt-2 text-sm text-amber-300">
            {move.error.message}
          </p>
        )}
      </div>

      {!a.canEdit && a.owner === null && (
        <Panel>
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex-1 text-sm text-zinc-300">
              This account is in the shared pool. Claim it to research it, reach out and build a deal. Once claimed,
              other reps no longer see it.
            </p>
            <Btn
              kind="primary"
              icon={UserPlus}
              busy={claim.isPending}
              onClick={() => {
                claim.mutate();
              }}
            >
              Claim this account
            </Btn>
          </div>
          {claim.isError && (
            <div className="mt-3">
              <ErrorState error={claim.error} />
            </div>
          )}
        </Panel>
      )}

      <div className="grid gap-4 xl:grid-cols-4">
        <div className="min-w-0 space-y-4 xl:col-span-3">
          <div
            role="tablist"
            aria-label="Account sections"
            className="flex gap-1 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/60 p-1"
          >
            {TABS.map(({ id: tabId, label, icon: Icon }) => (
              <button
                key={tabId}
                type="button"
                role="tab"
                aria-selected={current?.id === tabId}
                onClick={() => {
                  setParams({ tab: tabId });
                }}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm ${
                  current?.id === tabId ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Icon size={14} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          {current?.id === "timeline" ? (
            <Timeline accountId={a.id} canEdit={a.canEdit} />
          ) : current?.id === "research" ? (
            <ResearchTab account={a} />
          ) : current?.id === "outreach" ? (
            <OutreachTab account={a} />
          ) : current?.id === "meetings" ? (
            <MeetingsTab account={a} />
          ) : current?.id === "proposal" ? (
            <ProposalTab account={a} />
          ) : current?.id === "contract" ? (
            <ContractTab account={a} />
          ) : (
            <Panel title={current?.label ?? ""} icon={current?.icon}>
              <p className="text-sm text-zinc-300">{current?.what}</p>
              <p className="mt-1 text-xs text-zinc-400">Arrives in milestone {current?.milestone}.</p>
            </Panel>
          )}
        </div>
        <div className="space-y-4">
          <ContactsPanel account={a} />
          <TasksPanel accountId={a.id} canEdit={a.canEdit} />
          <Panel title="Property" icon={Building}>
            <dl className="space-y-2 text-xs">
              <div>
                <dt className="text-zinc-400">Current security</dt>
                <dd className="text-zinc-200">{a.currentProvider ?? "Unknown"}</dd>
              </div>
              <div>
                <dt className="text-zinc-400">Timing</dt>
                <dd className="text-zinc-200">{a.contractTiming ?? a.contractEndDate ?? "Unknown"}</dd>
              </div>
              <div>
                <dt className="text-zinc-400">Fit reasons</dt>
                <dd className="text-zinc-200">{a.fitReasons.join(" · ") || "None yet"}</dd>
              </div>
              {a.website !== null && (
                <div>
                  <dt className="text-zinc-400">Website</dt>
                  <dd className="truncate text-zinc-200">{a.website}</dd>
                </div>
              )}
            </dl>
          </Panel>
        </div>
      </div>

      {override !== null && (
        <OverrideDialog
          stage={override.stage}
          busy={move.isPending}
          onCancel={() => {
            setOverride(null);
          }}
          onConfirm={(reason) => {
            move.mutate({ ...override, reason });
          }}
        />
      )}
      {losing && deal !== null && (
        <LoseDialog
          name={a.name}
          busy={lose.isPending}
          onCancel={() => {
            setLosing(false);
          }}
          onConfirm={(reason, note) => {
            lose.mutate({ dealId: deal.id, reason, note });
          }}
        />
      )}
      {lose.isError && <ErrorState error={lose.error} />}
    </div>
  );
}
