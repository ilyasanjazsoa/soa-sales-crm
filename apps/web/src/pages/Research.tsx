import {
  BriefResponse,
  JobAccepted,
  NOT_ENOUGH_INFORMATION,
  plural,
  Signal,
  SourceList,
  type Account,
  type ResearchSource,
} from "@soa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, FileText, Globe, Loader, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { api } from "../api";
import { Btn, Empty, ErrorState, inputClass, Loading, Panel, Pill } from "../ui";

const SignalList = z.object({ items: z.array(Signal) });
const KIND_TONE = { incident: "red", timing: "amber", tenant: "blue", growth: "green", other: "zinc" } as const;

const ago = (iso: string) => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${String(days)} days ago`;
};

function Lines({ text }: { text: string }) {
  return (
    <div className="space-y-1 text-sm text-zinc-300">
      {text.split("\n").map((line, index) =>
        line.startsWith("- ") ? (
          <p key={index} className="flex gap-2">
            <span className="text-zinc-600">•</span>
            <span>{line.slice(2)}</span>
          </p>
        ) : (
          <p key={index}>{line === "" ? " " : line}</p>
        ),
      )}
    </div>
  );
}

function SourceItem({ source, index }: { source: ResearchSource; index: number }) {
  const [open, setOpen] = useState(false);
  const long = source.contentText.length > 400;
  return (
    <li
      id={`src-${source.id}`}
      className="scroll-mt-24 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 target:border-blue-600"
    >
      <p className="flex items-center gap-2 text-sm text-zinc-200">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-zinc-800 text-xs text-zinc-300">
          {index + 1}
        </span>
        {source.kind === "website" ? (
          <Globe size={14} className="text-zinc-500" />
        ) : (
          <FileText size={14} className="text-zinc-500" />
        )}
        <span className="min-w-0 truncate">{source.title ?? source.kind}</span>
        <span className="ml-auto shrink-0 text-xs text-zinc-600">{ago(source.fetchedAt)}</span>
      </p>
      {source.url !== null && <p className="mt-1 truncate text-xs text-zinc-500">{source.url}</p>}
      <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-400">
        {open || !long ? source.contentText : `${source.contentText.slice(0, 400)}…`}
      </p>
      {long && (
        <button
          type="button"
          className="mt-1 text-xs text-blue-400 hover:text-blue-300"
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </li>
  );
}

export function ResearchTab({ account }: { account: Account }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [signalText, setSignalText] = useState("");
  const [signalKind, setSignalKind] = useState<keyof typeof KIND_TONE>("incident");
  const [version, setVersion] = useState<number | null>(null);
  const [readingUntil, setReadingUntil] = useState(0);
  const id = account.id;

  const sources = useQuery({
    queryKey: ["sources", id],
    queryFn: () => api(`/api/accounts/${id}/sources`, SourceList),
    refetchInterval: () => (Date.now() < readingUntil ? 3000 : false),
  });
  const signals = useQuery({
    queryKey: ["signals", id],
    queryFn: () => api(`/api/accounts/${id}/signals`, SignalList),
    refetchInterval: () => (Date.now() < readingUntil ? 3000 : false),
  });
  const brief = useQuery({
    queryKey: ["brief", id, version],
    queryFn: () =>
      api(`/api/accounts/${id}/brief${version === null ? "" : `?version=${String(version)}`}`, BriefResponse),
    refetchInterval: (query) => (query.state.data?.pending === true ? 2000 : false),
  });
  const wasPending = brief.data?.pending === true;
  useEffect(() => {
    if (!wasPending) void queryClient.invalidateQueries({ queryKey: ["account", id] });
  }, [wasPending, queryClient, id]);

  const refreshAll = async () => {
    await queryClient.invalidateQueries({ queryKey: ["sources", id] });
    await queryClient.invalidateQueries({ queryKey: ["signals", id] });
    await queryClient.invalidateQueries({ queryKey: ["account", id] });
    await queryClient.invalidateQueries({ queryKey: ["timeline", id] });
  };
  const addNote = useMutation({
    mutationFn: (text: string) =>
      api(`/api/accounts/${id}/sources`, z.unknown(), { method: "POST", body: { text, title: "Note" } }),
    onSuccess: async () => {
      setNote("");
      await refreshAll();
    },
  });
  const readSite = useMutation({
    mutationFn: () => api(`/api/accounts/${id}/research/fetch`, JobAccepted, { method: "POST" }),
    onSuccess: () => {
      setReadingUntil(Date.now() + 60_000);
    },
  });
  const addSignal = useMutation({
    mutationFn: () =>
      api(`/api/accounts/${id}/signals`, Signal, { method: "POST", body: { text: signalText, kind: signalKind } }),
    onSuccess: async () => {
      setSignalText("");
      await refreshAll();
    },
  });
  const confirm = useMutation({
    mutationFn: (signalId: string) =>
      api(`/api/signals/${signalId}`, Signal, { method: "PATCH", body: { confirmed: true } }),
    onSettled: refreshAll,
  });
  const remove = useMutation({
    mutationFn: (signalId: string) => api(`/api/signals/${signalId}`, z.undefined(), { method: "DELETE" }),
    onSettled: refreshAll,
  });
  const generate = useMutation({
    mutationFn: () => api(`/api/accounts/${id}/brief`, JobAccepted, { method: "POST" }),
    onSuccess: async () => {
      setVersion(null);
      await queryClient.invalidateQueries({ queryKey: ["brief", id] });
    },
  });

  const sourceItems = sources.data?.items ?? [];
  const signalItems = signals.data?.items ?? [];
  const canBrief = sourceItems.length > 0 || signalItems.length > 0;
  const current = brief.data?.brief ?? null;
  const reading = Date.now() < readingUntil;

  return (
    <div className="space-y-4">
      <Panel
        title="Sources"
        icon={FileText}
        right={
          account.canEdit && (
            <Btn
              small
              kind="blue"
              icon={Globe}
              busy={readSite.isPending || reading}
              disabled={account.website === null}
              onClick={() => {
                readSite.mutate();
              }}
            >
              Read their website
            </Btn>
          )
        }
      >
        <p className="mb-3 text-xs text-zinc-500">
          The AI may only use what's listed here. Each fact in the brief points back to its source.
        </p>
        {account.website === null && account.canEdit && (
          <p className="mb-3 text-xs text-amber-300">Add the account's website to read it.</p>
        )}
        {reading && (
          <p className="mb-3 flex items-center gap-2 text-sm text-blue-300" role="status">
            <Loader size={14} className="animate-spin" />
            Reading the website. New pages and possible signals appear here.
          </p>
        )}
        {readSite.isError && <ErrorState error={readSite.error} />}
        {sources.isPending ? (
          <Loading />
        ) : sources.isError ? (
          <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
        ) : sourceItems.length === 0 ? (
          <Empty>No sources yet. Read their website or add a note from a call or site visit.</Empty>
        ) : (
          <ul className="space-y-2">
            {sourceItems.map((source, index) => (
              <SourceItem key={source.id} source={source} index={index} />
            ))}
          </ul>
        )}
        {account.canEdit && (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (note.trim().length >= 3) addNote.mutate(note.trim());
            }}
          >
            <input
              aria-label="Add a note"
              className={inputClass}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
              placeholder="Add what you learned on a call or site visit"
            />
            <Btn type="submit" icon={Plus} busy={addNote.isPending} disabled={note.trim().length < 3}>
              Add note
            </Btn>
          </form>
        )}
        {addNote.isError && <ErrorState error={addNote.error} />}
      </Panel>

      <Panel title="Security signals" icon={AlertTriangle}>
        {signals.isPending ? (
          <Loading />
        ) : signals.isError ? (
          <ErrorState error={signals.error} onRetry={() => void signals.refetch()} />
        ) : signalItems.length === 0 ? (
          <Empty>No signals yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {signalItems.map((signal) => (
              <li
                key={signal.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2"
              >
                <Pill tone={KIND_TONE[signal.kind]}>{signal.kind}</Pill>
                <span className="min-w-0 flex-1 text-sm text-zinc-200">{signal.text}</span>
                {signal.byAi && (
                  <Pill tone="blue">
                    <Sparkles size={10} />
                    Found by AI
                  </Pill>
                )}
                {signal.confirmed ? (
                  <Pill tone="green">
                    <Check size={10} />
                    Confirmed
                  </Pill>
                ) : (
                  <>
                    <Pill tone="amber">Unconfirmed</Pill>
                    {account.canEdit && (
                      <Btn
                        small
                        kind="primary"
                        busy={confirm.isPending && confirm.variables === signal.id}
                        onClick={() => {
                          confirm.mutate(signal.id);
                        }}
                      >
                        Confirm
                      </Btn>
                    )}
                  </>
                )}
                {account.canEdit && (
                  <button
                    type="button"
                    aria-label={`Remove signal: ${signal.text}`}
                    onClick={() => {
                      remove.mutate(signal.id);
                    }}
                    className="rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {account.canEdit && (
          <form
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (signalText.trim().length >= 3) addSignal.mutate();
            }}
          >
            <select
              aria-label="Signal kind"
              className={`${inputClass} w-auto`}
              value={signalKind}
              onChange={(event) => {
                setSignalKind(event.target.value as keyof typeof KIND_TONE);
              }}
            >
              {Object.keys(KIND_TONE).map((kind) => (
                <option key={kind}>{kind}</option>
              ))}
            </select>
            <input
              aria-label="Add a signal"
              className={`${inputClass} min-w-0 flex-1`}
              value={signalText}
              onChange={(event) => {
                setSignalText(event.target.value);
              }}
              placeholder="Add a signal you know first-hand, e.g. a break-in last week"
            />
            <Btn type="submit" icon={Plus} busy={addSignal.isPending} disabled={signalText.trim().length < 3}>
              Add
            </Btn>
          </form>
        )}
        {(confirm.isError || remove.isError || addSignal.isError) && (
          <ErrorState error={confirm.error ?? remove.error ?? addSignal.error} />
        )}
      </Panel>

      <Panel
        title="AI research brief"
        icon={Sparkles}
        right={
          <>
            {(brief.data?.versions.length ?? 0) > 1 && (
              <select
                aria-label="Brief version"
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-300"
                value={version ?? current?.version ?? ""}
                onChange={(event) => {
                  setVersion(Number(event.target.value));
                }}
              >
                {brief.data?.versions.map((entry) => (
                  <option key={entry.version} value={entry.version}>
                    Version {entry.version}
                  </option>
                ))}
              </select>
            )}
            {account.canEdit && (
              <Btn
                small
                kind="blue"
                icon={current === null ? Sparkles : RefreshCw}
                busy={generate.isPending || brief.data?.pending === true}
                disabled={!canBrief}
                onClick={() => {
                  generate.mutate();
                }}
              >
                {current === null ? "Generate brief" : "Regenerate"}
              </Btn>
            )}
          </>
        }
      >
        {!canBrief && (
          <p role="alert" className="mb-3 text-sm text-amber-300">
            Add at least one source or signal first. The AI isn't allowed to write a brief from nothing.
          </p>
        )}
        {generate.isError && <ErrorState error={generate.error} />}
        {brief.data?.lastError !== null && brief.data?.lastError !== undefined && (
          <ErrorState
            error={new Error(brief.data.lastError)}
            onRetry={
              canBrief
                ? () => {
                    generate.mutate();
                  }
                : undefined
            }
          />
        )}
        {brief.isPending ? (
          <Loading />
        ) : brief.isError ? (
          <ErrorState error={brief.error} onRetry={() => void brief.refetch()} />
        ) : brief.data.pending ? (
          <p className="flex items-center gap-2 text-sm text-blue-300" role="status">
            <Loader size={14} className="animate-spin" />
            Reading {plural(sourceItems.length, "source")} and writing the brief…
          </p>
        ) : current === null ? (
          <Empty>No brief yet.</Empty>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-zinc-500">
              Version {current.version} · {ago(current.createdAt)} · by {current.createdBy.name}
            </p>
            {current.sections.map((section) => (
              <div key={section.key}>
                <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-100">
                  {section.heading}
                  {section.sourceIds.map((sourceId) => {
                    const index = sourceItems.findIndex((source) => source.id === sourceId);
                    return index < 0 ? null : (
                      <a
                        key={sourceId}
                        href={`#src-${sourceId}`}
                        title={sourceItems[index]?.title ?? undefined}
                        className="rounded bg-blue-950 px-1.5 text-xs font-normal text-blue-300 hover:bg-blue-900"
                      >
                        source {index + 1}
                      </a>
                    );
                  })}
                  {section.key === "proof_point_internal" && <Pill tone="amber">Internal only</Pill>}
                </h3>
                <div className="mt-1">
                  {section.text === NOT_ENOUGH_INFORMATION ? (
                    <p className="text-sm text-zinc-500">{section.text} Add a source to fill this in.</p>
                  ) : (
                    <Lines text={section.text} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
