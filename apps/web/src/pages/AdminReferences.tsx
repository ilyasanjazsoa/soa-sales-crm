import {
  ClientReference,
  ClientReferenceList,
  PROPERTY_TYPES,
  PropertyTypeSchema,
  type ClientReferenceInput,
  type ClientReferencePatch,
} from "@soa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { Btn, Empty, ErrorState, Field, inputClass, Loading, Panel } from "../ui";

const KEY = ["admin", "references"] as const;

function AddReference() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<{
    labelNamed: string;
    labelAnonymized: string;
    propertyType: string;
    compliance: string;
    response: string;
  }>({
    labelNamed: "",
    labelAnonymized: "",
    propertyType: PROPERTY_TYPES[0],
    compliance: "",
    response: "",
  });
  const create = useMutation({
    mutationFn: (body: ClientReferenceInput) => api("/api/admin/references", ClientReference, { method: "POST", body }),
    onSuccess: async () => {
      setForm({
        labelNamed: "",
        labelAnonymized: "",
        propertyType: PROPERTY_TYPES[0],
        compliance: "",
        response: "",
      });
      await queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  const stats: Record<string, number> = {};
  const compliance = Number(form.compliance);
  const response = Number(form.response);
  if (form.compliance !== "" && Number.isFinite(compliance)) stats.patrolCompliancePct = compliance;
  if (form.response !== "" && Number.isFinite(response)) stats.avgResponseMin = response;
  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate({
          labelNamed: form.labelNamed,
          labelAnonymized: form.labelAnonymized,
          propertyTypes: [PropertyTypeSchema.parse(form.propertyType)],
          stats,
          namedPermission: false,
          active: true,
        });
      }}
    >
      <Field label="Client or site name (internal)">
        <input
          required
          className={inputClass}
          value={form.labelNamed}
          onChange={(event) => {
            setForm({ ...form, labelNamed: event.target.value });
          }}
        />
      </Field>
      <Field label="Anonymized wording" hint="What outreach may say, e.g. “a logistics hub we protect in Irving”.">
        <input
          required
          className={inputClass}
          value={form.labelAnonymized}
          onChange={(event) => {
            setForm({ ...form, labelAnonymized: event.target.value });
          }}
        />
      </Field>
      <Field label="Property type">
        <select
          className={inputClass}
          value={form.propertyType}
          onChange={(event) => {
            setForm({ ...form, propertyType: event.target.value });
          }}
        >
          {PROPERTY_TYPES.map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
      </Field>
      <Field label="Patrol compliance %">
        <input
          type="number"
          min={0}
          max={100}
          step={0.1}
          className={inputClass}
          value={form.compliance}
          onChange={(event) => {
            setForm({ ...form, compliance: event.target.value });
          }}
        />
      </Field>
      <Field label="Average response (minutes)">
        <input
          type="number"
          min={0}
          step={1}
          className={inputClass}
          value={form.response}
          onChange={(event) => {
            setForm({ ...form, response: event.target.value });
          }}
        />
      </Field>
      <div className="flex items-end">
        <Btn type="submit" kind="primary" icon={Plus} busy={create.isPending}>
          Add reference
        </Btn>
      </div>
      {create.isError && (
        <div className="sm:col-span-2 lg:col-span-3">
          <ErrorState error={create.error} />
        </div>
      )}
    </form>
  );
}

function ReferenceRow({ reference }: { reference: ClientReference }) {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (body: ClientReferencePatch) =>
      api(`/api/admin/references/${reference.id}`, ClientReference, { method: "PATCH", body }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-zinc-100">{reference.labelNamed}</p>
        <p className="text-xs text-zinc-400">
          Anonymized: “{reference.labelAnonymized}” ·{" "}
          {Object.entries(reference.stats)
            .map(([key, value]) => `${key} ${String(value)}`)
            .join(" · ") || "no statistics"}{" "}
          · used for {reference.propertyTypes.join(", ")}
        </p>
        {update.isError && <p className="text-xs text-red-400">{update.error.message}</p>}
      </div>
      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={reference.namedPermission}
          disabled={update.isPending}
          onChange={(event) => {
            update.mutate({ namedPermission: event.target.checked });
          }}
        />
        Client approved being named
      </label>
      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={reference.active}
          disabled={update.isPending}
          onChange={(event) => {
            update.mutate({ active: event.target.checked });
          }}
        />
        Active
      </label>
    </li>
  );
}

export function AdminReferencesPage() {
  const list = useQuery({ queryKey: KEY, queryFn: () => api("/api/admin/references", ClientReferenceList) });
  return (
    <div className="space-y-4">
      <Panel title="Add a client reference" icon={Plus}>
        <AddReference />
      </Panel>
      <Panel title="Client references used as proof points" icon={ShieldCheck}>
        <p className="mb-3 text-xs text-zinc-400">
          Outreach may only name a client when permission is on. Otherwise it uses the anonymized wording, and the
          compliance check blocks the real name.
        </p>
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <Empty>No references yet. Add the clients reps can point to as proof.</Empty>
        ) : (
          <ul className="space-y-2">
            {list.data.items.map((reference) => (
              <ReferenceRow key={reference.id} reference={reference} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
