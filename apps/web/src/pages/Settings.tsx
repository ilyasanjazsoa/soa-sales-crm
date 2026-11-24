import { UserProfile, type MeResponse, type UpdateMeRequest } from "@soa/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Mail, Save, User } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { api } from "../api";
import { ME_KEY, useMe } from "../session";
import { Btn, ErrorState, Field, inputClass, Loading, Panel, Pill } from "../ui";

const TIME_ZONES = ["America/Chicago", "America/New_York", "America/Denver", "America/Phoenix", "America/Los_Angeles"];

function SettingsForm({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => ({
    name: me.user.name,
    title: me.user.title,
    phone: me.user.phone ?? "",
    timezone: me.user.timezone,
    baseAddress: me.user.baseAddress ?? "",
    workdayStart: me.user.workdayStart,
    workdayEnd: me.user.workdayEnd,
  }));
  const save = useMutation({
    mutationFn: (body: UpdateMeRequest) => api("/api/me", z.object({ user: UserProfile }), { method: "PATCH", body }),
    onSuccess: ({ user }) => {
      queryClient.setQueryData<MeResponse | null>(ME_KEY, (old) => (old ? { ...old, user } : old));
    },
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => {
    setForm((old) => ({ ...old, [key]: event.target.value }));
    save.reset();
  };
  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    save.mutate({
      ...form,
      phone: form.phone.trim() === "" ? null : form.phone,
      baseAddress: form.baseAddress.trim() === "" ? null : form.baseAddress,
    });
  };
  const zones = TIME_ZONES.includes(form.timezone) ? TIME_ZONES : [form.timezone, ...TIME_ZONES];

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Name">
        <input className={inputClass} value={form.name} onChange={set("name")} required maxLength={120} />
      </Field>
      <Field label="Title">
        <input className={inputClass} value={form.title} onChange={set("title")} required maxLength={120} />
      </Field>
      <Field label="Phone" hint="Shown in your email signature.">
        <input className={inputClass} value={form.phone} onChange={set("phone")} maxLength={40} inputMode="tel" />
      </Field>
      <Field label="Time zone">
        <select className={inputClass} value={form.timezone} onChange={set("timezone")}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replace("America/", "").replace("_", " ")}
            </option>
          ))}
        </select>
      </Field>
      <div className="sm:col-span-2">
        <Field label="Base address" hint="Where your day starts. Used to plan drive time between meetings.">
          <input className={inputClass} value={form.baseAddress} onChange={set("baseAddress")} maxLength={300} />
        </Field>
      </div>
      <Field label="Workday starts">
        <input type="time" className={inputClass} value={form.workdayStart} onChange={set("workdayStart")} required />
      </Field>
      <Field label="Workday ends">
        <input type="time" className={inputClass} value={form.workdayEnd} onChange={set("workdayEnd")} required />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Btn type="submit" kind="primary" icon={Save} busy={save.isPending}>
          Save settings
        </Btn>
        {save.isSuccess && (
          <span className="flex items-center gap-1 text-sm text-emerald-300" role="status">
            <Check size={14} aria-hidden="true" />
            Saved
          </span>
        )}
      </div>
      {save.isError && (
        <div className="sm:col-span-2">
          <ErrorState error={save.error} />
        </div>
      )}
    </form>
  );
}

export function SettingsPage() {
  const me = useMe();
  if (me.isPending) return <Loading />;
  if (me.isError || me.data === null) return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  const { mail } = me.data;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Panel title="My settings" icon={User}>
          <SettingsForm me={me.data} />
        </Panel>
      </div>
      <Panel title="Mailbox and calendar" icon={Mail}>
        <p className="text-sm text-zinc-300">{me.data.user.email}</p>
        <div className="mt-2">
          {mail.needsReconnect ? (
            <Pill tone="amber">Needs reconnecting</Pill>
          ) : mail.connected ? (
            <Pill tone="green">Connected to Microsoft 365</Pill>
          ) : (
            <Pill tone="zinc">Not connected</Pill>
          )}
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          The CRM sends email from your own mailbox only when you click Send, and reads only replies to emails it sent.
        </p>
        <a
          href="/api/auth/login"
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-500"
        >
          Reconnect
        </a>
      </Panel>
    </div>
  );
}
