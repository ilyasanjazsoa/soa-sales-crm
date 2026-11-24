import { formatCentsExact, PricingConfigResponse, PricingConfigVersion, type PricingConfigInput } from "@soa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DollarSign, History } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { useMe } from "../session";
import { Btn, Empty, ErrorState, Field, inputClass, Loading, Panel, Pill } from "../ui";

/* Admin → Pricing (§6): the live rates and their versions. A new version applies from its date; proposals already
   made keep their numbers. The demo's numbers are unconfirmed until the company confirms them (DECISIONS.md E). */

const dollars = (cents: number) => String(cents / 100);
const toCents = (value: string) => Math.round(Number(value) * 100);
const pct = (rate: number) => String(Math.round(rate * 1000) / 10);

function VersionForm({ base, onDone }: { base: PricingConfigInput; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    effectiveFrom: new Date().toISOString().slice(0, 10),
    unarmed: dollars(base.hourlyRateCents.unarmed),
    armed: dollars(base.hourlyRateCents.armed),
    supervisor: String(base.supervisorMultiplier),
    patrol: dollars(base.addons.patrol.monthlyCents),
    video: dollars(base.addons.video.monthlyCents),
    portal: dollars(base.addons.portal.monthlyCents),
    t24: pct(base.termDiscounts["24"]),
    t36: pct(base.termDiscounts["36"]),
    maxDiscount: pct(base.maxManualDiscount),
  });
  const save = useMutation({
    mutationFn: () =>
      api("/api/pricing/config", PricingConfigVersion, {
        method: "POST",
        body: {
          effectiveFrom: form.effectiveFrom,
          hourlyRateCents: { unarmed: toCents(form.unarmed), armed: toCents(form.armed) },
          coverageHoursPerWeek: base.coverageHoursPerWeek,
          supervisorMultiplier: Number(form.supervisor),
          addons: {
            patrol: { label: base.addons.patrol.label, monthlyCents: toCents(form.patrol) },
            video: { label: base.addons.video.label, monthlyCents: toCents(form.video) },
            portal: { label: base.addons.portal.label, monthlyCents: toCents(form.portal) },
          },
          termDiscounts: { "12": base.termDiscounts["12"], "24": Number(form.t24) / 100, "36": Number(form.t36) / 100 },
          maxManualDiscount: Number(form.maxDiscount) / 100,
        } satisfies PricingConfigInput,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["pricing-config"] });
      onDone();
    },
  });
  const field = (key: keyof typeof form, label: string, type = "number") => (
    <Field label={label}>
      <input
        type={type}
        step="any"
        className={inputClass}
        value={form[key]}
        onChange={(event) => {
          setForm({ ...form, [key]: event.target.value });
        }}
      />
    </Field>
  );
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {field("effectiveFrom", "Applies from", "date")}
        {field("unarmed", "Unarmed, $ an hour")}
        {field("armed", "Armed, $ an hour")}
        {field("supervisor", "Supervisor multiplier")}
        {field("patrol", `${base.addons.patrol.label}, $ a month`)}
        {field("video", `${base.addons.video.label}, $ a month`)}
        {field("portal", `${base.addons.portal.label}, $ a month`)}
        {field("t24", "24-month discount, %")}
        {field("t36", "36-month discount, %")}
        {field("maxDiscount", "Extra discount without approval, up to %")}
      </div>
      {save.isError && <ErrorState error={save.error} />}
      <Btn type="submit" kind="primary" busy={save.isPending}>
        Save new version
      </Btn>
    </form>
  );
}

export function AdminPricingPage() {
  const me = useMe();
  const [editing, setEditing] = useState(false);
  const config = useQuery({
    queryKey: ["pricing-config"],
    queryFn: () => api("/api/pricing/config", PricingConfigResponse),
  });
  const canEdit = me.data?.user.role !== "ae";
  if (config.isPending) return <Loading />;
  if (config.isError) return <ErrorState error={config.error} onRetry={() => void config.refetch()} />;
  const live = config.data.live;
  return (
    <div className="space-y-4">
      <Panel
        title="Live pricing"
        icon={DollarSign}
        right={<Pill tone="amber">Unconfirmed: the demo&apos;s numbers until the company confirms them</Pill>}
      >
        {live === null ? (
          <Empty>No pricing yet.</Empty>
        ) : (
          <dl className="grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-zinc-400">Unarmed / armed</dt>
              <dd className="text-zinc-100">
                {formatCentsExact(live.hourlyRateCents.unarmed)} / {formatCentsExact(live.hourlyRateCents.armed)} an
                hour
              </dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">Supervisor multiplier</dt>
              <dd className="text-zinc-100">×{live.supervisorMultiplier}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">Term discounts (12 / 24 / 36 months)</dt>
              <dd className="text-zinc-100">
                {pct(live.termDiscounts["12"])}% / {pct(live.termDiscounts["24"])}% / {pct(live.termDiscounts["36"])}%
              </dd>
            </div>
            {(["patrol", "video", "portal"] as const).map((addon) => (
              <div key={addon}>
                <dt className="text-xs text-zinc-400">{live.addons[addon].label}</dt>
                <dd className="text-zinc-100">{formatCentsExact(live.addons[addon].monthlyCents)} a month</dd>
              </div>
            ))}
            <div>
              <dt className="text-xs text-zinc-400">Extra discount needing a manager</dt>
              <dd className="text-zinc-100">above {pct(live.maxManualDiscount)}%</dd>
            </div>
          </dl>
        )}
        {canEdit && live !== null && (
          <div className="mt-4">
            {editing ? (
              <VersionForm
                base={live}
                onDone={() => {
                  setEditing(false);
                }}
              />
            ) : (
              <Btn
                onClick={() => {
                  setEditing(true);
                }}
              >
                Create a new version
              </Btn>
            )}
          </div>
        )}
      </Panel>
      <Panel title="Versions" icon={History}>
        <ul className="divide-y divide-zinc-800 text-sm">
          {config.data.versions.map((version) => (
            <li key={version.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="text-zinc-100">From {version.effectiveFrom}</span>
              {version.live && <Pill tone="green">Live</Pill>}
              <span className="text-xs text-zinc-400">
                {formatCentsExact(version.hourlyRateCents.unarmed)} unarmed · {version.createdBy ?? "seed"}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
