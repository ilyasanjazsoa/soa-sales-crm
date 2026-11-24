import {
  Account,
  AccountPage,
  IMPORT_FIELD_LABELS,
  IMPORT_FIELDS,
  ImportPreviewResponse,
  ImportStatus,
  ImportUploadResponse,
  plural,
  PROPERTY_TYPES,
  type AccountSummary,
  type ColumnMap,
  type CreateAccountRequest,
} from "@soa/shared";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Search, Upload, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, ApiError, csrfHeader } from "../api";
import { FitBadge, StagePill } from "../deal-ui";
import { useMe } from "../session";
import { Btn, Empty, ErrorState, Field, inputClass, Loading, Modal, Panel, Pill } from "../ui";

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return debounced;
}

function AddAccount({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    propertyType: PROPERTY_TYPES[0],
    city: "",
    ownerCompany: "",
    currentProvider: "",
    firstName: "",
    lastName: "",
    title: "",
    email: "",
  });
  const create = useMutation({
    mutationFn: (body: CreateAccountRequest) => api("/api/accounts", Account, { method: "POST", body }),
    onSuccess: async (account) => {
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void navigate(`/accounts/${account.id}`);
    },
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => {
    setForm({ ...form, [key]: event.target.value });
  };
  const submit = () => {
    create.mutate({
      name: form.name,
      propertyType: form.propertyType,
      city: form.city,
      ownerCompany: form.ownerCompany,
      currentProvider: form.currentProvider,
      ...(form.firstName.trim() === ""
        ? {}
        : { contact: { firstName: form.firstName, lastName: form.lastName, title: form.title, email: form.email } }),
    });
  };
  const duplicateError = create.error instanceof ApiError && create.error.code === "duplicate" ? create.error : null;
  const duplicate = duplicateError !== null;
  const duplicateId = (duplicateError?.details as { id?: string } | undefined)?.id;
  return (
    <Modal title="Add account" onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Property or company name">
            <input
              className={inputClass}
              value={form.name}
              onChange={set("name")}
              placeholder="e.g. Riverside Business Park"
            />
          </Field>
        </div>
        <Field label="Property type">
          <select className={inputClass} value={form.propertyType} onChange={set("propertyType")}>
            {PROPERTY_TYPES.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </Field>
        <Field label="City">
          <input className={inputClass} value={form.city} onChange={set("city")} />
        </Field>
        <Field label="Owner or manager">
          <input className={inputClass} value={form.ownerCompany} onChange={set("ownerCompany")} />
        </Field>
        <Field label="Current security">
          <input
            className={inputClass}
            value={form.currentProvider}
            onChange={set("currentProvider")}
            placeholder="None, In-house, a company…"
          />
        </Field>
        <Field label="Contact first name">
          <input className={inputClass} value={form.firstName} onChange={set("firstName")} />
        </Field>
        <Field label="Contact last name">
          <input className={inputClass} value={form.lastName} onChange={set("lastName")} />
        </Field>
        <Field label="Contact title">
          <input className={inputClass} value={form.title} onChange={set("title")} />
        </Field>
        <Field label="Contact email">
          <input
            className={inputClass}
            type="email"
            value={form.email}
            onChange={set("email")}
            placeholder="name@company.example"
          />
        </Field>
      </div>
      {duplicate ? (
        <p role="alert" className="mt-3 text-sm text-amber-300">
          An account with this name and city already exists.{" "}
          {duplicateId !== undefined && (
            <Link className="underline" to={`/accounts/${duplicateId}`}>
              Open it
            </Link>
          )}
        </p>
      ) : (
        create.isError && (
          <div className="mt-3">
            <ErrorState error={create.error} />
          </div>
        )
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" busy={create.isPending} disabled={form.name.trim() === ""} onClick={submit}>
          Create account
        </Btn>
      </div>
    </Modal>
  );
}

async function uploadCsv(file: File): Promise<ImportUploadResponse> {
  const body = new FormData();
  body.append("file", file);
  const response = await fetch("/api/imports", {
    method: "POST",
    body,
    headers: csrfHeader(),
    credentials: "same-origin",
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = (payload as { error?: { message?: string } } | undefined)?.error?.message ?? "Upload failed.";
    throw new ApiError(response.status, "upload_failed", message);
  }
  return ImportUploadResponse.parse(payload);
}

function ImportWizard({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [uploaded, setUploaded] = useState<ImportUploadResponse | null>(null);
  const [map, setMap] = useState<ColumnMap>({});
  const [assignToMe, setAssignToMe] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: uploadCsv,
    onSuccess: (result) => {
      setUploaded(result);
      setMap(result.suggestedMap);
    },
  });
  const preview = useMutation({
    mutationFn: () =>
      api(`/api/imports/${uploaded?.id ?? ""}/preview`, ImportPreviewResponse, {
        method: "POST",
        body: { columnMap: map, assignToMe },
      }),
  });
  const run = useMutation({
    mutationFn: () => api(`/api/imports/${uploaded?.id ?? ""}/run`, ImportStatus, { method: "POST" }),
    onSuccess: (status) => {
      setRunId(status.id);
    },
  });
  const status = useQuery({
    queryKey: ["import", runId],
    enabled: runId !== null,
    queryFn: () => api(`/api/imports/${runId ?? ""}`, ImportStatus),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1000 : false),
  });
  useEffect(() => {
    if (status.data?.status === "done") void queryClient.invalidateQueries({ queryKey: ["accounts"] });
  }, [status.data?.status, queryClient]);

  const loadSample = async () => {
    const text = await (await fetch("/sample-prospects.csv")).text();
    upload.mutate(new File([text], "sample-prospects.csv", { type: "text/csv" }));
  };

  return (
    <Modal title="Import prospects from CSV" onClose={onClose} wide>
      {runId !== null ? (
        status.isPending || status.data?.status === "running" ? (
          <Loading label="Importing… you can close this and keep working." />
        ) : status.isError ? (
          <ErrorState error={status.error} onRetry={() => void status.refetch()} />
        ) : status.data.status === "failed" ? (
          <ErrorState error={new Error(status.data.errors[0]?.reason ?? "The import failed.")} />
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-emerald-300" role="status">
              Imported {plural(status.data.rowsCreated ?? 0, "account")}. {plural(status.data.rowsSkipped ?? 0, "row")}{" "}
              skipped.
            </p>
            <SkippedList rows={status.data.errors} />
            <div className="flex justify-end">
              <Btn kind="primary" onClick={onClose}>
                Done
              </Btn>
            </div>
          </div>
        )
      ) : uploaded === null ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-400">
            Prospect lists must come from a source you've licensed. Upload a CSV file of up to 10 MB, or try the sample.
          </p>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500">
              <Upload size={14} aria-hidden="true" />
              Choose CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) upload.mutate(file);
                }}
              />
            </label>
            <Btn icon={FileText} busy={upload.isPending} onClick={() => void loadSample()}>
              Load sample file
            </Btn>
          </div>
          {upload.isError && <ErrorState error={upload.error} />}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-zinc-300">
            {uploaded.filename} · {plural(uploaded.rowsTotal, "row")}. Check which column is which, then preview.
          </p>
          <div className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
            {uploaded.headers.map((header, index) => (
              <Field key={`${header}-${String(index)}`} label={header === "" ? `Column ${String(index + 1)}` : header}>
                <select
                  className={inputClass}
                  value={map[String(index)] ?? "ignore"}
                  onChange={(event) => {
                    setMap({ ...map, [String(index)]: event.target.value as ColumnMap[string] });
                    preview.reset();
                  }}
                >
                  <option value="ignore">Ignore</option>
                  {IMPORT_FIELDS.map((field) => (
                    <option key={field} value={field}>
                      {IMPORT_FIELD_LABELS[field]}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={assignToMe}
              onChange={(event) => {
                setAssignToMe(event.target.checked);
                preview.reset();
              }}
            />
            Assign the new accounts to me (otherwise they go to the shared pool)
          </label>
          {preview.data !== undefined && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Pill tone="green">{preview.data.newCount} new</Pill>
                <Pill tone="amber">{preview.data.duplicateCount} duplicate</Pill>
                <Pill tone="red">{preview.data.invalidCount} invalid</Pill>
              </div>
              <SkippedList rows={preview.data.skipped} />
            </div>
          )}
          {(preview.isError || run.isError) && <ErrorState error={preview.error ?? run.error} />}
          <div className="flex justify-end gap-2">
            <Btn onClick={onClose}>Cancel</Btn>
            {preview.data === undefined ? (
              <Btn
                kind="primary"
                busy={preview.isPending}
                onClick={() => {
                  preview.mutate();
                }}
              >
                Preview
              </Btn>
            ) : (
              <Btn
                kind="primary"
                icon={Upload}
                busy={run.isPending}
                disabled={preview.data.newCount === 0}
                onClick={() => {
                  run.mutate();
                }}
              >
                Import {preview.data.newCount} accounts
              </Btn>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function SkippedList({ rows }: { rows: { row: number; name: string | null; reason: string }[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
      {rows.map((row) => (
        <li key={row.row} className="flex gap-2 rounded border border-zinc-800 px-2 py-1">
          <span className="w-14 shrink-0 text-zinc-400">Row {row.row}</span>
          <span className="flex-1 truncate text-zinc-300">{row.name ?? "(no name)"}</span>
          <span
            className={
              row.reason.startsWith("Already") || row.reason.startsWith("Repeats") ? "text-amber-300" : "text-red-300"
            }
          >
            {row.reason}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ResultRow({ item }: { item: AccountSummary }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const claim = useMutation({
    mutationFn: () => api(`/api/accounts/${item.id}/claim`, Account, { method: "POST" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["accounts"] }),
  });
  return (
    <tr className="border-t border-zinc-800 hover:bg-zinc-900">
      <td className="px-4 py-3">
        <Link to={`/accounts/${item.id}`} className="block font-medium text-zinc-100 hover:underline">
          {item.name}
        </Link>
        <span className="block text-xs text-zinc-400">
          {item.propertyType}
          {item.city === null ? "" : ` · ${item.city}`}
          {item.ownerCompany === null ? "" : ` · ${item.ownerCompany}`}
        </span>
      </td>
      <td className="px-2 py-3">
        <FitBadge score={item.fitScore} reasons={item.fitReasons} />
      </td>
      <td className="px-2 py-3">
        <div className="flex max-w-xs flex-wrap gap-1">
          {item.fitReasons.length > 0 ? (
            item.fitReasons.map((reason) => <Pill key={reason}>{reason}</Pill>)
          ) : (
            <span className="text-xs text-zinc-400">No signals yet</span>
          )}
        </div>
      </td>
      <td className="px-2 py-3">
        {item.deal === null ? (
          <span className="text-xs text-zinc-400">No deal</span>
        ) : (
          <StagePill stage={item.deal.stage} status={item.deal.status} />
        )}
      </td>
      <td className="px-2 py-3 text-xs text-zinc-400">
        {item.owner === null ? <Pill tone="amber">Unassigned</Pill> : item.owner.name}
      </td>
      <td className="px-4 py-3 text-right">
        {item.owner === null ? (
          <div className="flex flex-col items-end gap-1">
            <Btn
              small
              kind="primary"
              icon={UserPlus}
              busy={claim.isPending}
              onClick={() => {
                claim.mutate();
              }}
            >
              Claim
            </Btn>
            {claim.isError && <span className="text-xs text-red-400">{claim.error.message}</span>}
          </div>
        ) : (
          <Btn small onClick={() => void navigate(`/accounts/${item.id}`)}>
            Open
          </Btn>
        )}
      </td>
    </tr>
  );
}

export function ProspectsPage() {
  const me = useMe();
  const isManager = me.data?.user.role !== "ae";
  const [q, setQ] = useState("");
  const [city, setCity] = useState("");
  const [type, setType] = useState("");
  const [minFit, setMinFit] = useState(0);
  const [owner, setOwner] = useState("");
  const [modal, setModal] = useState<"add" | "import" | null>(null);
  const search = useDebounced(q, 250);
  const cityFilter = useDebounced(city, 250);

  const params = new URLSearchParams();
  if (search.trim() !== "") params.set("q", search.trim());
  if (cityFilter.trim() !== "") params.set("city", cityFilter.trim());
  if (type !== "") params.set("type", type);
  if (minFit > 0) params.set("minFit", String(minFit));
  if (owner !== "") params.set("owner", owner);

  const results = useInfiniteQuery({
    queryKey: ["accounts", params.toString()],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const pageParams = new URLSearchParams(params);
      if (pageParam !== undefined) pageParams.set("cursor", pageParam);
      return api(`/api/accounts?${pageParams.toString()}`, AccountPage);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const items = results.data?.pages.flatMap((page) => page.items) ?? [];
  const hidden = results.data?.pages[0]?.hiddenFromYou ?? null;

  return (
    <div className="space-y-4">
      <Panel
        title="Prospect finder"
        icon={Search}
        right={
          <>
            <Btn
              small
              icon={Upload}
              onClick={() => {
                setModal("import");
              }}
            >
              Import CSV
            </Btn>
            <Btn
              small
              kind="primary"
              icon={Plus}
              onClick={() => {
                setModal("add");
              }}
            >
              Add account
            </Btn>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <Field label="Search">
              <input
                className={inputClass}
                value={q}
                onChange={(event) => {
                  setQ(event.target.value);
                }}
                placeholder="Name, owner or city"
              />
            </Field>
          </div>
          <Field label="City">
            <input
              className={inputClass}
              value={city}
              onChange={(event) => {
                setCity(event.target.value);
              }}
              placeholder="All cities"
            />
          </Field>
          <Field label="Property type">
            <select
              className={inputClass}
              value={type}
              onChange={(event) => {
                setType(event.target.value);
              }}
            >
              <option value="">All types</option>
              {PROPERTY_TYPES.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </Field>
          <Field label="Owner">
            <select
              className={inputClass}
              value={owner}
              onChange={(event) => {
                setOwner(event.target.value);
              }}
            >
              <option value="">{isManager ? "Everyone" : "Mine and unassigned"}</option>
              <option value="me">Mine</option>
              <option value="unassigned">Unassigned pool</option>
            </select>
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-zinc-400">
          <label className="flex items-center gap-2">
            Minimum fit score
            <input
              type="range"
              min={0}
              max={80}
              step={10}
              value={minFit}
              onChange={(event) => {
                setMinFit(Number(event.target.value));
              }}
            />
            <span className="w-6 text-zinc-200">{minFit}</span>
          </label>
          <span className="ml-auto">
            {results.data !== undefined && `${plural(items.length, "account")}${results.hasNextPage ? "+" : ""}`}
            {hidden !== null && hidden > 0 ? ` · ${String(hidden)} owned by other reps are hidden from you` : ""}
          </span>
        </div>
      </Panel>
      <Panel pad={false}>
        {results.isPending ? (
          <div className="px-4">
            <Loading />
          </div>
        ) : results.isError ? (
          <div className="p-4">
            <ErrorState error={results.error} onRetry={() => void results.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="p-4">
            <Empty>No accounts match. Clear the filters, add an account or import a list.</Empty>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-xs text-zinc-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-2 py-2 font-medium">Fit</th>
                  <th className="px-2 py-2 font-medium">Why</th>
                  <th className="px-2 py-2 font-medium">Stage</th>
                  <th className="px-2 py-2 font-medium">Owner</th>
                  <th className="px-4 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <ResultRow key={item.id} item={item} />
                ))}
              </tbody>
            </table>
            {results.hasNextPage && (
              <div className="p-3 text-center">
                <Btn small busy={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>
                  Show more
                </Btn>
              </div>
            )}
          </div>
        )}
      </Panel>
      {modal === "add" && (
        <AddAccount
          onClose={() => {
            setModal(null);
          }}
        />
      )}
      {modal === "import" && (
        <ImportWizard
          onClose={() => {
            setModal(null);
          }}
        />
      )}
    </div>
  );
}
