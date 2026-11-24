import {
  AssignableUsers,
  Deal,
  DEAL_STAGES,
  DealPage,
  ForecastResponse,
  formatMoneyShort,
  plural,
  STAGE_LABELS,
  STAGE_PROBABILITY_BP,
  type DealStage,
} from "@soa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Columns, List } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api";
import { choosableStages, needsOverrideReason, OverrideDialog, StagePill } from "../deal-ui";
import { useMe } from "../session";
import { Btn, Empty, ErrorState, Field, inputClass, Loading, Stat } from "../ui";

/** Every deal the filter matches, page by page (at most 2,000). */
async function allDeals(owner: string) {
  const items: Deal[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const query: string = cursor === null ? "" : `&cursor=${cursor}`;
    const result: DealPage = await api(`/api/deals?owner=${owner}&limit=100${query}`, DealPage);
    items.push(...result.items);
    cursor = result.nextCursor;
    if (cursor === null) break;
  }
  return items;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysSince = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / DAY_MS));
const initials = (name: string) =>
  name
    .split(" ")
    .map((part) => part.charAt(0))
    .join("")
    .slice(0, 2);

export function PipelinePage() {
  const me = useMe();
  const role = me.data?.user.role ?? "ae";
  const isManager = role !== "ae";
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Chosen by the user, else a default that waits for the user's role to load.
  const [ownerChoice, setOwner] = useState<string | null>(null);
  const owner = ownerChoice ?? (isManager ? "all" : "me");
  const [view, setView] = useState<"board" | "list">("board");
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<DealStage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [override, setOverride] = useState<{ id: string; stage: DealStage } | null>(null);

  const deals = useQuery({
    queryKey: ["deals", owner],
    enabled: me.data !== undefined,
    queryFn: () => allDeals(owner),
  });
  const forecast = useQuery({
    queryKey: ["forecast", owner],
    enabled: me.data !== undefined,
    queryFn: () => api(`/api/forecast?owner=${owner}`, ForecastResponse),
  });
  const people = useQuery({
    queryKey: ["assignable-users"],
    enabled: isManager,
    queryFn: () => api("/api/users", AssignableUsers),
  });
  const owners = (people.data?.items ?? []).map((user) => [user.id, user.name] as const);

  const move = useMutation({
    mutationFn: ({ id, stage, reason }: { id: string; stage: DealStage; reason?: string }) =>
      api(`/api/deals/${id}/stage`, Deal, {
        method: "POST",
        body: { stage, ...(reason === undefined ? {} : { reason }) },
      }),
    onError: (error) => {
      setNotice(error.message);
    },
    onSuccess: () => {
      setOverride(null);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["deals"] });
      await queryClient.invalidateQueries({ queryKey: ["forecast"] });
    },
  });

  /** Moves a deal, asking a manager for the reason when the stage is normally set by the system. */
  const requestMove = (id: string, stage: DealStage) => {
    if (!choosableStages(role).includes(stage)) {
      setNotice(`${STAGE_LABELS[stage]} is set automatically by the e-signature system. A manager can override.`);
      return;
    }
    setNotice(null);
    if (needsOverrideReason(stage)) setOverride({ id, stage });
    else move.mutate({ id, stage });
  };

  const drop = (stage: DealStage) => {
    const deal = deals.data?.find((item) => item.id === dragging);
    setDragging(null);
    setOver(null);
    if (deal === undefined || deal.stage === stage || deal.status !== "open") return;
    requestMove(deal.id, stage);
  };

  const visible = (deals.data ?? []).filter((deal) => deal.status !== "lost");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Open pipeline"
          value={forecast.data === undefined ? "…" : formatMoneyShort(forecast.data.openValueCents)}
          sub={forecast.data === undefined ? undefined : plural(forecast.data.openCount, "deal")}
          tone="text-blue-300"
        />
        <Stat
          label="Weighted forecast"
          value={forecast.data === undefined ? "…" : formatMoneyShort(forecast.data.weightedCents)}
          sub="Σ value × stage probability"
          tone="text-amber-300"
        />
        <Stat
          label="Won"
          value={forecast.data === undefined ? "…" : formatMoneyShort(forecast.data.wonValueCents)}
          tone="text-emerald-300"
        />
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          {isManager ? (
            <Field label="Show deals for">
              <select
                className={inputClass}
                value={owner}
                onChange={(event) => {
                  setOwner(event.target.value);
                }}
              >
                <option value="all">Whole team</option>
                <option value="me">Me</option>
                {owners.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <p className="text-xs text-zinc-400">You see your own deals. Your manager sees the whole team's.</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-zinc-500">
          Drag a card to move its stage. “Contract sent” and “Won” are set automatically by the e-signature system.
        </p>
        <div className="ml-auto flex gap-1" role="group" aria-label="View">
          <Btn
            small
            kind={view === "board" ? "default" : "ghost"}
            icon={Columns}
            aria-pressed={view === "board"}
            onClick={() => {
              setView("board");
            }}
          >
            Board
          </Btn>
          <Btn
            small
            kind={view === "list" ? "default" : "ghost"}
            icon={List}
            aria-pressed={view === "list"}
            onClick={() => {
              setView("list");
            }}
          >
            List
          </Btn>
        </div>
      </div>
      {forecast.isError && <ErrorState error={forecast.error} onRetry={() => void forecast.refetch()} />}
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
      {notice !== null && (
        <p role="alert" className="rounded-lg border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          {notice}
        </p>
      )}

      {deals.isPending ? (
        <Loading />
      ) : deals.isError ? (
        <ErrorState error={deals.error} onRetry={() => void deals.refetch()} />
      ) : visible.length === 0 ? (
        <Empty>No deals yet. Claim an account in the Prospect finder to start one.</Empty>
      ) : view === "board" ? (
        <div className="overflow-x-auto pb-2">
          <div className="flex min-w-[1250px] gap-3">
            {DEAL_STAGES.map((stage) => {
              const column = visible.filter((deal) => deal.stage === stage);
              return (
                <section
                  key={stage}
                  aria-label={STAGE_LABELS[stage]}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setOver(stage);
                  }}
                  onDragLeave={() => {
                    setOver(null);
                  }}
                  onDrop={() => {
                    drop(stage);
                  }}
                  className={`w-44 shrink-0 rounded-xl border p-2 ${over === stage ? "border-blue-600 bg-blue-950/20" : "border-zinc-800 bg-zinc-900/40"}`}
                >
                  <div className="mb-2 px-1">
                    <p className="text-xs font-semibold text-zinc-200">
                      {STAGE_LABELS[stage]}{" "}
                      <span className="font-normal text-zinc-500">· {STAGE_PROBABILITY_BP[stage] / 100}%</span>
                    </p>
                    <p className="text-xs text-zinc-500">
                      {column.length} · {formatMoneyShort(column.reduce((sum, deal) => sum + deal.annualValueCents, 0))}
                    </p>
                  </div>
                  <div className="space-y-2">
                    {column.map((deal) => (
                      <div
                        key={deal.id}
                        draggable={deal.status === "open"}
                        onDragStart={() => {
                          setDragging(deal.id);
                        }}
                        onClick={() => void navigate(`/accounts/${deal.accountId}`)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void navigate(`/accounts/${deal.accountId}`);
                        }}
                        role="link"
                        tabIndex={0}
                        className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950 p-2 hover:border-zinc-600"
                      >
                        <p className="text-xs font-medium text-zinc-100">{deal.accountName}</p>
                        <p className="mt-1 text-xs text-zinc-400">{formatMoneyShort(deal.annualValueCents)} a year</p>
                        <p className="mt-1 flex items-center justify-between text-xs text-zinc-600">
                          <span>{daysSince(deal.stageChangedAt)}d in stage</span>
                          <span title={deal.owner.name} className="rounded-full bg-zinc-800 px-1.5 text-zinc-300">
                            {initials(deal.owner.name)}
                          </span>
                        </p>
                      </div>
                    ))}
                    {column.length === 0 && <p className="px-1 py-3 text-center text-xs text-zinc-700">Empty</p>}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/60">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-2 py-2 font-medium">Stage</th>
                <th className="px-2 py-2 font-medium">Value a year</th>
                <th className="px-2 py-2 font-medium">In stage</th>
                <th className="px-2 py-2 font-medium">Owner</th>
                <th className="px-4 py-2 font-medium">Move to</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((deal) => (
                <tr key={deal.id} className="border-t border-zinc-800">
                  <td className="px-4 py-2">
                    <Link to={`/accounts/${deal.accountId}`} className="text-zinc-100 hover:underline">
                      {deal.accountName}
                    </Link>
                  </td>
                  <td className="px-2 py-2">
                    <StagePill stage={deal.stage} status={deal.status} />
                  </td>
                  <td className="px-2 py-2 text-zinc-300">{formatMoneyShort(deal.annualValueCents)}</td>
                  <td className="px-2 py-2 text-xs text-zinc-400">{daysSince(deal.stageChangedAt)}d</td>
                  <td className="px-2 py-2 text-xs text-zinc-400">{deal.owner.name}</td>
                  <td className="px-4 py-2">
                    {deal.status === "open" ? (
                      <select
                        aria-label={`Stage for ${deal.accountName}`}
                        className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
                        value={deal.stage}
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
                    ) : (
                      <span className="text-xs text-zinc-600">Closed</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
