import {
  Draft,
  DraftList,
  EmailList,
  SendResult,
  type Account,
  type Channel,
  type CheckResult,
  type DraftOutcome,
  type EmailMessage,
  type ReplyClass,
  type Tone,
} from "@soa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, Copy, Lock, Mail, RefreshCw, Send, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api, ApiError } from "../api";
import { useMe } from "../session";
import { Btn, Empty, ErrorState, Field, inputClass, Loading, Panel, Pill } from "../ui";

/* The Outreach tab (ARCHITECTURE.md §8, §12): pick a contact, channel and tone; write with AI or by hand; edit with
   live checks; send (email, one message per click) or log the outcome; see the thread with replies. */

const CHANNELS: { id: Channel; label: string }[] = [
  { id: "email", label: "Email" },
  { id: "call", label: "Call script" },
  { id: "voicemail", label: "Voicemail" },
  { id: "linkedin", label: "LinkedIn note" },
];
const OUTCOMES: { id: DraftOutcome; label: string }[] = [
  { id: "connected", label: "Connected" },
  { id: "left_voicemail", label: "Left voicemail" },
  { id: "no_answer", label: "No answer" },
  { id: "wrong_number", label: "Wrong number" },
];
const CLASS_TONE: Record<ReplyClass, "green" | "amber" | "red" | "zinc"> = {
  interested: "green",
  not_now: "amber",
  not_interested: "red",
  unsubscribe: "red",
  out_of_office: "zinc",
  other: "zinc",
};
const Nothing = z.undefined();

function Checks({ checks }: { checks: CheckResult[] }) {
  return (
    <ul className="space-y-1.5" aria-label="Compliance check">
      {checks.map((check) => {
        const blocked = check.blocking && !check.pass;
        const warning = !check.pass && !check.blocking;
        return (
          <li
            key={check.id}
            className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 text-xs ${
              blocked
                ? "border-red-900 bg-red-950/30 text-red-300"
                : warning
                  ? "border-amber-900 bg-amber-950/30 text-amber-300"
                  : "border-zinc-800 text-zinc-300"
            }`}
          >
            {blocked ? (
              <Ban size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            ) : warning ? (
              <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            ) : (
              <Check size={13} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden="true" />
            )}
            <span>
              {check.label}
              {!check.pass && <span className="ml-1 opacity-70">{blocked ? "· blocks sending" : "· warning"}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Editor(props: { draft: Draft; accountId: string; sends: { used: number; cap: number } }) {
  const { draft, accountId, sends } = props;
  const queryClient = useQueryClient();
  const me = useMe();
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [body, setBody] = useState(draft.body);
  const [outcome, setOutcome] = useState<DraftOutcome>(draft.channel === "voicemail" ? "left_voicemail" : "connected");
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<Draft>(draft);
  const first = draft.contact.name.split(" ")[0] ?? draft.contact.name;

  // Saves (and re-checks) shortly after typing stops.
  // Saves run one after another; only the answer to the newest one is kept, so an older, slower reply can't
  // overwrite newer text or leave the editor stuck on "Saving…".
  const sequence = useRef(0);
  const save = useMutation({
    mutationFn: async (patch: { subject?: string | null; body?: string }) => {
      sequence.current += 1;
      const mine = sequence.current;
      const next = await api(`/api/drafts/${draft.id}`, Draft, { method: "PATCH", body: patch });
      return { next, mine };
    },
    onSuccess: ({ next, mine }) => {
      if (mine === sequence.current) setSaved(next);
    },
  });
  const timer = useRef<number | undefined>(undefined);
  const saveNow = () => {
    save.mutate({ ...(draft.channel === "email" ? { subject } : {}), body });
  };
  useEffect(() => {
    if (subject === (saved.subject ?? "") && body === saved.body) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(saveNow, 600);
    return () => {
      window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the text changes
  }, [subject, body]);
  const checkWording = useMutation({
    mutationFn: () => api(`/api/drafts/${draft.id}/claims`, Draft, { method: "POST" }),
    onSuccess: (next) => {
      setSaved(next);
    },
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["drafts", accountId] }),
      queryClient.invalidateQueries({ queryKey: ["emails", accountId] }),
      queryClient.invalidateQueries({ queryKey: ["account", accountId] }),
      queryClient.invalidateQueries({ queryKey: ["timeline", accountId] }),
    ]);
  };
  const send = useMutation({
    mutationFn: () => api(`/api/drafts/${draft.id}/send`, SendResult, { method: "POST" }),
    onSuccess: refresh,
  });
  const log = useMutation({
    mutationFn: () =>
      api(`/api/drafts/${draft.id}/log`, Draft, {
        method: "POST",
        body: { outcome: draft.channel === "linkedin" ? "sent" : outcome, ...(note.trim() === "" ? {} : { note }) },
      }),
    onSuccess: refresh,
  });
  const regenerate = useMutation({
    mutationFn: () => api(`/api/drafts/${draft.id}/regenerate`, Draft, { method: "POST" }),
    onSuccess: (next) => {
      setSaved(next);
      setSubject(next.subject ?? "");
      setBody(next.body);
    },
  });
  const discard = useMutation({
    mutationFn: () => api(`/api/drafts/${draft.id}`, Nothing, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const pending = save.isPending || subject !== (saved.subject ?? "") || body !== saved.body;
  const blocked = saved.checks.filter((check) => check.blocking && !check.pass);
  const capHit = sends.used >= sends.cap;
  const reconnect = me.data?.mail.needsReconnect === true || me.data?.mail.connected === false;
  const failedChecks =
    send.error instanceof ApiError && send.error.code === "checks_failed"
      ? z.object({ checks: z.array(z.object({ label: z.string() })) }).safeParse(send.error.details)
      : undefined;

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-5">
      <div className="space-y-2 lg:col-span-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          {saved.byAi && (
            <Pill tone="blue">
              <Sparkles size={11} aria-hidden="true" />
              AI draft: read it before you send
            </Pill>
          )}
          <span role="status">{pending ? "Saving…" : "Saved"}</span>
          <span className="ml-auto flex gap-2">
            <Btn
              small
              kind="ghost"
              icon={RefreshCw}
              busy={regenerate.isPending}
              onClick={() => {
                regenerate.mutate();
              }}
            >
              Rewrite with AI
            </Btn>
            <Btn
              small
              kind="ghost"
              icon={Trash2}
              busy={discard.isPending}
              onClick={() => {
                discard.mutate();
              }}
            >
              Discard
            </Btn>
          </span>
        </div>
        {regenerate.isError && <ErrorState error={regenerate.error} />}
        {draft.channel === "email" && (
          <input
            aria-label="Subject"
            className={inputClass}
            value={subject}
            placeholder="Subject"
            onChange={(event) => {
              setSubject(event.target.value);
            }}
          />
        )}
        <textarea
          aria-label="Message"
          rows={draft.channel === "email" ? 10 : 8}
          className={inputClass}
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />
        {saved.footer !== null && (
          <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-950/50 p-3">
            <p className="mb-1 flex items-center gap-1 text-xs text-zinc-500">
              <Lock size={11} aria-hidden="true" />
              Added automatically. Can&apos;t be removed.
            </p>
            <pre className="whitespace-pre-wrap break-all font-sans text-xs text-zinc-400">{saved.footer}</pre>
          </div>
        )}
      </div>
      <div className="space-y-3 lg:col-span-2">
        <p className="text-xs font-semibold text-zinc-300">Compliance check</p>
        {save.isError ? <ErrorState error={save.error} onRetry={saveNow} /> : <Checks checks={saved.checks} />}
        {!saved.checks.some((check) => check.id === "claims") && (
          <Btn
            small
            kind="ghost"
            icon={Sparkles}
            busy={checkWording.isPending}
            disabled={pending}
            onClick={() => {
              checkWording.mutate();
            }}
          >
            Check wording for guarantees
          </Btn>
        )}
        {checkWording.isError && <ErrorState error={checkWording.error} />}
        {draft.channel === "email" ? (
          <div className="space-y-2">
            <Btn
              kind="primary"
              icon={Send}
              className="w-full"
              busy={send.isPending}
              disabled={pending || blocked.length > 0 || capHit || reconnect || body.trim() === ""}
              onClick={() => {
                send.mutate();
              }}
            >
              Send to {first}
            </Btn>
            {capHit && <p className="text-xs text-red-300">Daily limit reached ({sends.cap} emails in 24 hours).</p>}
            {reconnect && (
              <p className="text-xs text-amber-300">Reconnect your mailbox (the banner at the top) to send.</p>
            )}
            {send.isError && (
              <ErrorState
                error={
                  failedChecks?.success === true
                    ? new Error(`${send.error.message} ${failedChecks.data.checks.map((c) => c.label).join("; ")}`)
                    : send.error
                }
              />
            )}
            <p className="text-xs text-zinc-500">
              Goes from your own mailbox, one message per click. Nothing is ever sent automatically.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {draft.channel === "linkedin" ? (
              <Btn
                icon={Copy}
                className="w-full"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(body)
                    .then(() => {
                      setCopied(true);
                    })
                    .catch(() => {
                      setCopied(false);
                    });
                }}
              >
                {copied ? "Copied. Paste it into LinkedIn yourself." : "Copy note"}
              </Btn>
            ) : (
              draft.channel === "call" && (
                <Field label="Outcome">
                  <select
                    className={inputClass}
                    value={outcome}
                    onChange={(event) => {
                      setOutcome(event.target.value as DraftOutcome);
                    }}
                  >
                    {OUTCOMES.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )
            )}
            <Field label="Note (optional)">
              <input
                className={inputClass}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            </Field>
            <Btn
              kind="primary"
              className="w-full"
              busy={log.isPending}
              disabled={pending || blocked.length > 0}
              onClick={() => {
                log.mutate();
              }}
            >
              {draft.channel === "linkedin"
                ? "Log as sent"
                : draft.channel === "voicemail"
                  ? "Log voicemail left"
                  : "Log outcome"}
            </Btn>
            {log.isError && <ErrorState error={log.error} />}
          </div>
        )}
      </div>
    </div>
  );
}

function Thread({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const emails = useQuery({
    queryKey: ["emails", accountId],
    queryFn: () => api(`/api/accounts/${accountId}/emails`, EmailList),
    refetchInterval: (query) =>
      query.state.data?.items.some((email) => email.status === "queued") === true ? 2000 : 30_000,
  });
  const retry = useMutation({
    mutationFn: (id: string) =>
      api(`/api/emails/${id}/retry`, z.object({ status: z.literal("queued") }), { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["emails", accountId] }),
  });
  const [open, setOpen] = useState<string | null>(null);

  const statusPill = (email: EmailMessage) =>
    email.direction === "in" ? (
      <Pill tone="green">Reply</Pill>
    ) : email.status === "queued" ? (
      <Pill tone="amber">Sending…</Pill>
    ) : email.status === "failed" ? (
      <Pill tone="red">Not sent</Pill>
    ) : email.status === "bounced" ? (
      <Pill tone="red">Bounced</Pill>
    ) : (
      <Pill>Sent</Pill>
    );

  return (
    <Panel title="Email thread" icon={Mail}>
      {emails.isPending ? (
        <Loading />
      ) : emails.isError ? (
        <ErrorState error={emails.error} onRetry={() => void emails.refetch()} />
      ) : emails.data.items.length === 0 ? (
        <Empty>
          No email yet. Replies to emails sent from the CRM show up here; the rest of your inbox is never read.
        </Empty>
      ) : (
        <ul className="space-y-2">
          {emails.data.items.map((email) => (
            <li
              key={email.id}
              className={`rounded-lg border p-3 ${
                email.direction === "in" ? "border-emerald-900 bg-emerald-950/20" : "border-zinc-800 bg-zinc-950/60"
              }`}
            >
              <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                {statusPill(email)}
                {email.classification !== null && (
                  <Pill tone={CLASS_TONE[email.classification]}>
                    <Sparkles size={11} aria-hidden="true" />
                    {email.classification.replace(/_/g, " ")}
                  </Pill>
                )}
                <span>
                  {email.direction === "in" ? `From ${email.fromEmail}` : `To ${email.toEmail}`} ·{" "}
                  {new Date(email.at).toLocaleString()}
                </span>
              </p>
              <button
                type="button"
                className="mt-1 block text-left text-sm font-medium text-zinc-100 hover:underline"
                onClick={() => {
                  setOpen(open === email.id ? null : email.id);
                }}
              >
                {email.subject}
              </button>
              {open === email.id && (
                <pre className="mt-2 whitespace-pre-wrap font-sans text-xs text-zinc-400">{email.bodyText}</pre>
              )}
              {email.status === "failed" && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-300">
                  <span>{email.error}</span>
                  <Btn
                    small
                    icon={RefreshCw}
                    busy={retry.isPending}
                    onClick={() => {
                      retry.mutate(email.id);
                    }}
                  >
                    Retry
                  </Btn>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {retry.isError && <ErrorState error={retry.error} />}
    </Panel>
  );
}

export function OutreachTab({ account }: { account: Account }) {
  const queryClient = useQueryClient();
  const contacts = account.contacts;
  // The chosen contact, or the primary one while nothing valid is chosen (contacts can arrive after the first render).
  const [chosenContact, setContactId] = useState("");
  const contactId = contacts.some((c) => c.id === chosenContact)
    ? chosenContact
    : (contacts.find((c) => c.isPrimary)?.id ?? contacts[0]?.id ?? "");
  const [channel, setChannel] = useState<Channel>("email");
  const [tone, setTone] = useState<Tone>("professional");
  const drafts = useQuery({
    queryKey: ["drafts", account.id],
    queryFn: () => api(`/api/accounts/${account.id}/drafts`, DraftList),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (useAi: boolean) =>
      api(`/api/accounts/${account.id}/drafts`, Draft, { method: "POST", body: { contactId, channel, tone, useAi } }),
    onSuccess: async (draft) => {
      setSelected(draft.id);
      await queryClient.invalidateQueries({ queryKey: ["drafts", account.id] });
    },
  });
  const contact = contacts.find((c) => c.id === contactId);

  if (contacts.length === 0) {
    return <Empty>Add a contact first (right-hand panel). Outreach needs someone to reach.</Empty>;
  }
  if (!account.canEdit) {
    return <Empty>Claim this account to reach out.</Empty>;
  }
  const current = drafts.data?.items.find((item) => item.id === selected) ?? drafts.data?.items[0];

  return (
    <div className="space-y-4">
      <Panel
        title="Write outreach"
        icon={Send}
        right={
          drafts.data !== undefined && (
            <Pill tone={drafts.data.sendsLast24h >= drafts.data.dailySendCap ? "red" : "zinc"}>
              {drafts.data.sendsLast24h} of {drafts.data.dailySendCap} emails sent in the last 24 h
            </Pill>
          )
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="To">
            <select
              className={inputClass}
              value={contactId}
              onChange={(event) => {
                setContactId(event.target.value);
              }}
            >
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {`${c.firstName} ${c.lastName}`.trim()}
                  {c.title === null ? "" : `, ${c.title}`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Channel">
            <select
              className={inputClass}
              value={channel}
              onChange={(event) => {
                setChannel(event.target.value as Channel);
              }}
            >
              {CHANNELS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tone">
            <select
              className={inputClass}
              value={tone}
              onChange={(event) => {
                setTone(event.target.value as Tone);
              }}
            >
              <option value="professional">Professional</option>
              <option value="friendly">Friendly</option>
              <option value="direct">Direct</option>
            </select>
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Btn
            kind="blue"
            icon={Sparkles}
            busy={create.isPending && create.variables}
            disabled={create.isPending}
            onClick={() => {
              create.mutate(true);
            }}
          >
            Write with AI
          </Btn>
          <Btn
            disabled={create.isPending}
            onClick={() => {
              create.mutate(false);
            }}
          >
            Write it myself
          </Btn>
          {contact?.contactPref !== null && contact?.contactPref !== undefined && (
            <span className="text-xs text-zinc-500">
              {contact.firstName}: {contact.contactPref}
            </span>
          )}
        </div>
        {create.isError && (
          <div className="mt-3">
            <ErrorState error={create.error} />
          </div>
        )}
        {drafts.isPending ? (
          <Loading />
        ) : drafts.isError ? (
          <ErrorState error={drafts.error} onRetry={() => void drafts.refetch()} />
        ) : current === undefined ? null : (
          <>
            {drafts.data.items.length > 1 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <span>Unsent drafts:</span>
                {drafts.data.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={item.id === current.id}
                    className={`rounded-full border px-2 py-0.5 ${
                      item.id === current.id ? "border-blue-700 text-blue-300" : "border-zinc-700 hover:text-zinc-200"
                    }`}
                    onClick={() => {
                      setSelected(item.id);
                    }}
                  >
                    {CHANNELS.find((entry) => entry.id === item.channel)?.label} to {item.contact.name}
                  </button>
                ))}
              </div>
            )}
            <p className="mt-3 text-xs text-zinc-400">
              {CHANNELS.find((entry) => entry.id === current.channel)?.label} to {current.contact.name}
              {current.channel === "email" && current.contact.email !== null ? ` (${current.contact.email})` : ""}
              {current.channel !== "email" && current.channel !== "linkedin" && current.contact.phone !== null
                ? ` · ${current.contact.phone}`
                : ""}
            </p>
            <Editor
              key={current.id}
              draft={current}
              accountId={account.id}
              sends={{ used: drafts.data.sendsLast24h, cap: drafts.data.dailySendCap }}
            />
          </>
        )}
      </Panel>
      <Thread accountId={account.id} />
    </div>
  );
}
