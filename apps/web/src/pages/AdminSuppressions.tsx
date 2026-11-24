import { SuppressionList } from "@soa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { api } from "../api";
import { useMe } from "../session";
import { Btn, Empty, ErrorState, Field, inputClass, Loading, Panel, Pill } from "../ui";

/* Admin → Suppression list (§8.4): addresses the CRM never emails, for every rep. Managers add and remove. */

const REASON_TONE = { unsubscribe: "amber", bounce: "red", complaint: "red", manual: "zinc" } as const;
const Ok = z.object({ ok: z.literal(true) });

export function AdminSuppressionsPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const canChange = me.data?.user.role !== "ae";
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState("");
  const list = useQuery({ queryKey: ["suppressions"], queryFn: () => api("/api/suppressions", SuppressionList) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["suppressions"] });
  const add = useMutation({
    mutationFn: () =>
      api("/api/suppressions", Ok, {
        method: "POST",
        body: { email: email.trim(), ...(note.trim() === "" ? {} : { note: note.trim() }) },
      }),
    onSuccess: async () => {
      setEmail("");
      setNote("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (address: string) =>
      api(`/api/suppressions/${encodeURIComponent(address)}`, z.undefined(), { method: "DELETE" }),
    onSuccess: refresh,
  });
  const items = (list.data?.items ?? []).filter((item) => item.email.includes(filter.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      {canChange && (
        <Panel title="Add an address" icon={Plus}>
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              add.mutate();
            }}
          >
            <Field label="Email address">
              <input
                type="email"
                required
                className={inputClass}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
            </Field>
            <Field label="Note (optional)">
              <input
                className={inputClass}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            </Field>
            <Btn type="submit" kind="primary" busy={add.isPending}>
              Add
            </Btn>
          </form>
          {add.isError && (
            <div className="mt-3">
              <ErrorState error={add.error} />
            </div>
          )}
        </Panel>
      )}
      <Panel
        title="Suppression list"
        icon={Ban}
        right={
          <input
            aria-label="Filter"
            placeholder="Filter"
            className={`${inputClass} w-48`}
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        }
      >
        <p className="mb-3 text-xs text-zinc-500">
          No rep can email these addresses. Unsubscribes and bounces are added automatically.
        </p>
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <Empty>{filter === "" ? "Nobody is on the list yet." : "No address matches."}</Empty>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {items.map((item) => (
              <li key={item.email} className="flex flex-wrap items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{item.email}</span>
                <Pill tone={REASON_TONE[item.reason]}>{item.reason}</Pill>
                {item.note !== null && <span className="text-xs text-zinc-500">{item.note}</span>}
                <span className="text-xs text-zinc-500">{new Date(item.createdAt).toLocaleDateString()}</span>
                {canChange && (
                  <Btn
                    small
                    kind="ghost"
                    icon={Trash2}
                    busy={remove.isPending && remove.variables === item.email}
                    onClick={() => {
                      if (window.confirm(`Allow email to ${item.email} again? This is recorded in the audit log.`)) {
                        remove.mutate(item.email);
                      }
                    }}
                  >
                    Remove
                  </Btn>
                )}
              </li>
            ))}
          </ul>
        )}
        {remove.isError && <ErrorState error={remove.error} />}
      </Panel>
    </div>
  );
}
