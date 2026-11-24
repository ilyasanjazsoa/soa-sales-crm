import { AdminUserList, AuditPage } from "@soa/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { Btn, Empty, ErrorState, Field, inputClass, Loading, Panel } from "../ui";

/* Admin → Audit log (§15): sign-ins, sends, stage and owner changes, exports, pricing, users, discounts, suppressions. */

const ENTITIES = [
  "",
  "user",
  "account",
  "deal",
  "email_message",
  "proposal",
  "contract",
  "pricing_config",
  "suppression",
  "meeting",
];

export function AdminAuditPage() {
  const [entity, setEntity] = useState("");
  const [user, setUser] = useState("");
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => api("/api/admin/users", AdminUserList) });
  const names = new Map((users.data?.items ?? []).map((entry) => [entry.id, entry.name]));
  const log = useInfiniteQuery({
    queryKey: ["audit", entity, user],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "50" });
      if (entity !== "") params.set("entity", entity);
      if (user !== "") params.set("user", user);
      if (pageParam !== "") params.set("cursor", pageParam);
      return api(`/api/admin/audit?${params.toString()}`, AuditPage);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = log.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Panel title="Audit log" icon={ScrollText}>
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <Field label="What changed">
          <select
            className={inputClass}
            value={entity}
            onChange={(event) => {
              setEntity(event.target.value);
            }}
          >
            {ENTITIES.map((value) => (
              <option key={value} value={value}>
                {value === "" ? "Everything" : value.replace("_", " ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Who">
          <select
            className={inputClass}
            value={user}
            onChange={(event) => {
              setUser(event.target.value);
            }}
          >
            <option value="">Everyone</option>
            {(users.data?.items ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {log.isPending ? (
        <Loading />
      ) : log.isError ? (
        <ErrorState error={log.error} onRetry={() => void log.refetch()} />
      ) : items.length === 0 ? (
        <Empty>Nothing recorded for this filter.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Audit log entries, newest first</caption>
            <thead className="text-zinc-400">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  When
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Who
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Action
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Details
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 text-zinc-300">
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="whitespace-nowrap py-2 pr-3">{new Date(item.createdAt).toLocaleString()}</td>
                  <td className="py-2 pr-3">
                    {item.userId === null ? "System" : (names.get(item.userId) ?? "Former user")}
                  </td>
                  <td className="py-2 pr-3 font-mono">{item.action}</td>
                  <td className="max-w-md truncate py-2 pr-3 font-mono text-zinc-400">
                    {Object.keys(item.meta).length === 0 ? "" : JSON.stringify(item.meta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log.hasNextPage && (
        <Btn className="mt-3" busy={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
          Load older entries
        </Btn>
      )}
    </Panel>
  );
}
