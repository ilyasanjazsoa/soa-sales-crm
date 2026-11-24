import {
  Contract,
  ContractList,
  formatCentsExact,
  Proposal,
  ProposalList,
  PricingConfigResponse,
  QuoteResponse,
  SendProposalResponse,
  type Account,
  type Addon,
  type Coverage,
  type Package,
} from "@soa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, DollarSign, FileText, Pen, Send, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { z } from "zod";
import { api } from "../api";
import { useMe } from "../session";
import { Btn, Empty, ErrorState, Field, inputClass, Loading, Panel, Pill } from "../ui";

/* The Proposal and Contract tabs (ARCHITECTURE.md §10, §12). Every price on screen comes from the server's pricing
   engine (POST /api/pricing/quote); the browser never sends a price. */

const COVERAGES: { id: Coverage; label: string }[] = [
  { id: "24_7", label: "24/7" },
  { id: "nights", label: "Nights (6 pm to 6 am)" },
  { id: "business_hours", label: "Business hours (Mon to Fri)" },
];
const ADDONS: Addon[] = ["patrol", "video", "portal"];
const STATUS_TONE = { draft: "zinc", sent: "blue", viewed: "green", accepted: "green", expired: "red" } as const;
const CONTRACT_TONE = {
  draft: "zinc",
  sent: "blue",
  viewed: "blue",
  signed: "green",
  declined: "red",
  voided: "red",
} as const;
const DEFAULT_PACKAGE: Package = {
  posts: 1,
  armed: false,
  coverage: "nights",
  supervisor: false,
  addons: [],
  termMonths: 12,
};
const Queued = z.object({ status: z.literal("queued") });
const percent = (rate: number) => `${String(Math.round(rate * 1000) / 10)}%`;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(value);
    }, ms);
    return () => {
      window.clearTimeout(timer);
    };
  }, [value, ms]);
  return debounced;
}

function Builder({ account, dealId }: { account: Account; dealId: string }) {
  const queryClient = useQueryClient();
  const [pkg, setPkg] = useState<Package>(account.deal?.package ?? DEFAULT_PACKAGE);
  const [discount, setDiscount] = useState(0);
  const [note, setNote] = useState("");
  const config = useQuery({
    queryKey: ["pricing-config"],
    queryFn: () => api("/api/pricing/config", PricingConfigResponse),
  });
  const wanted = useDebounced({ package: pkg, manualDiscount: discount }, 250);
  const quote = useQuery({
    queryKey: ["quote", wanted],
    queryFn: () => api("/api/pricing/quote", QuoteResponse, { method: "POST", body: wanted }),
    placeholderData: (previous) => previous,
  });
  const create = useMutation({
    mutationFn: () =>
      api(`/api/deals/${dealId}/proposals`, Proposal, {
        method: "POST",
        body: { package: pkg, manualDiscount: discount, ...(note.trim() === "" ? {} : { coverNote: note.trim() }) },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["proposals", dealId] }),
  });
  const labels = config.data?.live?.addons;
  const set = (patch: Partial<Package>) => {
    setPkg({ ...pkg, ...patch });
  };

  return (
    <Panel title="Build a proposal" icon={DollarSign}>
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:col-span-3">
          <Field label="Guard posts">
            <input
              type="number"
              min={0}
              max={20}
              className={inputClass}
              value={pkg.posts}
              onChange={(event) => {
                set({ posts: Math.max(0, Math.min(20, Number(event.target.value) || 0)) });
              }}
            />
          </Field>
          <Field label="Coverage">
            <select
              className={inputClass}
              value={pkg.coverage}
              onChange={(event) => {
                set({ coverage: event.target.value as Coverage });
              }}
            >
              {COVERAGES.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Term">
            <select
              className={inputClass}
              value={pkg.termMonths}
              onChange={(event) => {
                set({ termMonths: Number(event.target.value) as 12 | 24 | 36 });
              }}
            >
              {[12, 24, 36].map((months) => (
                <option key={months} value={months}>
                  {months} months
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Extra discount (%)"
            hint={`Above ${percent(quote.data?.maxManualDiscount ?? 0.1)} needs a manager`}
          >
            <input
              type="number"
              min={0}
              max={50}
              step={0.5}
              className={inputClass}
              value={Math.round(discount * 1000) / 10}
              onChange={(event) => {
                setDiscount(Math.max(0, Math.min(50, Number(event.target.value) || 0)) / 100);
              }}
            />
          </Field>
          <div className="space-y-2 text-sm text-zinc-200 sm:col-span-2">
            <label className="mr-4 inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={pkg.armed}
                onChange={(event) => {
                  set({ armed: event.target.checked });
                }}
              />
              Armed officers
            </label>
            <label className="mr-4 inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={pkg.supervisor}
                onChange={(event) => {
                  set({ supervisor: event.target.checked });
                }}
              />
              Site supervisor
            </label>
            {ADDONS.map((addon) => (
              <label key={addon} className="mr-4 inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={pkg.addons.includes(addon)}
                  onChange={(event) => {
                    set({
                      addons: event.target.checked
                        ? [...pkg.addons, addon]
                        : pkg.addons.filter((entry) => entry !== addon),
                    });
                  }}
                />
                {labels?.[addon].label ?? addon}
              </label>
            ))}
          </div>
          <div className="sm:col-span-2">
            <Field label="Cover note (optional)">
              <textarea
                rows={3}
                className={inputClass}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            </Field>
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 lg:col-span-2" aria-live="polite">
          <p className="text-xs text-zinc-400">Price from the pricing engine</p>
          {quote.isError ? (
            <ErrorState error={quote.error} />
          ) : quote.data === undefined ? (
            <Loading />
          ) : (
            <>
              <p className="mt-1 text-2xl font-semibold text-zinc-100" data-testid="monthly-price">
                {formatCentsExact(quote.data.breakdown.monthlyCents)}{" "}
                <span className="text-sm font-normal text-zinc-400">a month</span>
              </p>
              <p className="text-sm text-zinc-300">{formatCentsExact(quote.data.breakdown.annualCents)} a year</p>
              <dl className="mt-3 space-y-1 text-xs text-zinc-400">
                <div>{quote.data.breakdown.hoursPerWeek} officer hours a week</div>
                <div>{formatCentsExact(quote.data.breakdown.hourlyRateCents)} an hour</div>
                {quote.data.breakdown.termDiscount > 0 && (
                  <div>Term discount {percent(quote.data.breakdown.termDiscount)}</div>
                )}
              </dl>
              {quote.data.needsApproval && (
                <p className="mt-3 text-xs text-amber-300">
                  This discount needs a manager&apos;s approval before sending.
                </p>
              )}
            </>
          )}
          <Btn
            kind="primary"
            className="mt-4 w-full"
            busy={create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            Save as a new version
          </Btn>
          {create.isError && <ErrorState error={create.error} />}
        </div>
      </div>
    </Panel>
  );
}

function ProposalRow({ proposal, accountId }: { proposal: Proposal; accountId: string }) {
  const queryClient = useQueryClient();
  const me = useMe();
  const [, setParams] = useSearchParams();
  const isManager = me.data?.user.role !== "ae";
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["proposals", proposal.dealId] });
  const render = useMutation({
    mutationFn: () => api(`/api/proposals/${proposal.id}/render`, Queued, { method: "POST" }),
    onSuccess: refresh,
  });
  const approve = useMutation({
    mutationFn: () => api(`/api/proposals/${proposal.id}/approve-discount`, Proposal, { method: "POST" }),
    onSuccess: refresh,
  });
  const send = useMutation({
    mutationFn: () => api(`/api/proposals/${proposal.id}/send`, SendProposalResponse, { method: "POST", body: {} }),
    onSuccess: async () => {
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ["drafts", accountId] })]);
      setParams({ tab: "outreach" }); // the email with the link is waiting there for the rep to send
    },
  });
  const error = render.error ?? approve.error ?? send.error;
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-zinc-100">Version {proposal.version}</p>
        <Pill tone={STATUS_TONE[proposal.status]}>{proposal.status}</Pill>
        {proposal.needsApproval && <Pill tone="amber">Discount needs approval</Pill>}
        <span className="text-sm text-zinc-300">
          {formatCentsExact(proposal.pricing.monthlyCents)} a month · {formatCentsExact(proposal.pricing.annualCents)} a
          year
        </span>
        {proposal.viewCount > 0 && (
          <span className="text-xs text-zinc-400">
            Opened {proposal.viewCount} time{proposal.viewCount === 1 ? "" : "s"}
            {proposal.lastViewedAt === null ? "" : `, last ${new Date(proposal.lastViewedAt).toLocaleString()}`}
          </span>
        )}
      </div>
      <ul className="mt-2 list-inside list-disc text-xs text-zinc-400">
        {proposal.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        {proposal.status === "draft" && (
          <Btn
            small
            icon={FileText}
            busy={render.isPending || proposal.rendering}
            onClick={() => {
              render.mutate();
            }}
          >
            {proposal.pdfReady ? "Generate the PDF again" : "Generate PDF"}
          </Btn>
        )}
        {proposal.pdfReady && (
          <a
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500"
            href={`/api/proposals/${proposal.id}/pdf`}
            target="_blank"
            rel="noreferrer"
          >
            View PDF
          </a>
        )}
        {proposal.needsApproval && isManager && (
          <Btn
            small
            icon={ShieldCheck}
            busy={approve.isPending}
            onClick={() => {
              approve.mutate();
            }}
          >
            Approve discount
          </Btn>
        )}
        {proposal.status === "draft" && (
          <Btn
            small
            kind="primary"
            icon={Send}
            busy={send.isPending}
            disabled={!proposal.pdfReady || proposal.needsApproval}
            onClick={() => {
              send.mutate();
            }}
          >
            Send to client
          </Btn>
        )}
      </div>
      {proposal.rendering && <Loading label="Generating the PDF…" />}
      {proposal.renderError !== null && <ErrorState error={new Error(proposal.renderError)} />}
      {error !== null && <ErrorState error={error} />}
    </li>
  );
}

export function ProposalTab({ account }: { account: Account }) {
  const dealId = account.deal?.id;
  const proposals = useQuery({
    queryKey: ["proposals", dealId],
    queryFn: () => api(`/api/deals/${dealId ?? ""}/proposals`, ProposalList),
    enabled: dealId !== undefined,
    refetchInterval: (query) => (query.state.data?.items.some((item) => item.rendering) === true ? 2000 : false),
  });
  if (dealId === undefined) return <Empty>Create a deal first (the stage control above).</Empty>;
  return (
    <div className="space-y-4">
      {account.canEdit && account.deal?.status === "open" && <Builder account={account} dealId={dealId} />}
      <Panel title="Proposal versions" icon={FileText}>
        {proposals.isPending ? (
          <Loading />
        ) : proposals.isError ? (
          <ErrorState error={proposals.error} onRetry={() => void proposals.refetch()} />
        ) : proposals.data.items.length === 0 ? (
          <Empty>No proposals yet. Build one above.</Empty>
        ) : (
          <ul className="space-y-2">
            {proposals.data.items.map((proposal) => (
              <ProposalRow key={proposal.id} proposal={proposal} accountId={account.id} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export function ContractTab({ account }: { account: Account }) {
  const queryClient = useQueryClient();
  const dealId = account.deal?.id;
  const signable = account.contacts.filter((contact) => contact.email !== null);
  const [chosenSigner, setSigner] = useState("");
  const signer = signable.some((contact) => contact.id === chosenSigner)
    ? chosenSigner
    : (signable.find((contact) => contact.isPrimary)?.id ?? signable[0]?.id ?? "");
  const [startDate, setStartDate] = useState(() => new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10));
  const proposals = useQuery({
    queryKey: ["proposals", dealId],
    queryFn: () => api(`/api/deals/${dealId ?? ""}/proposals`, ProposalList),
    enabled: dealId !== undefined,
  });
  const contracts = useQuery({
    queryKey: ["contracts", dealId],
    queryFn: () => api(`/api/deals/${dealId ?? ""}/contracts`, ContractList),
    enabled: dealId !== undefined,
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["contracts", dealId] }),
      queryClient.invalidateQueries({ queryKey: ["account", account.id] }),
      queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      queryClient.invalidateQueries({ queryKey: ["timeline", account.id] }),
    ]);
  const sentProposal = proposals.data?.items.find((item) => item.status === "sent" || item.status === "viewed");
  const send = useMutation({
    mutationFn: () =>
      api(`/api/proposals/${sentProposal?.id ?? ""}/contract`, Contract, {
        method: "POST",
        body: { signerContactId: signer, startDate },
      }),
    onSuccess: refresh,
  });
  const voidContract = useMutation({
    mutationFn: (id: string) => api(`/api/contracts/${id}/void`, Contract, { method: "POST" }),
    onSuccess: refresh,
  });
  const simulate = useMutation({
    mutationFn: (input: { id: string; event: "viewed" | "signed" | "declined" }) =>
      api(`/api/contracts/${input.id}/fake-sign`, z.object({ result: z.string() }), {
        method: "POST",
        body: { event: input.event },
      }),
    onSuccess: refresh,
  });

  if (dealId === undefined) return <Empty>Create a deal first (the stage control above).</Empty>;
  const open = contracts.data?.items.some((item) => ["draft", "sent", "viewed"].includes(item.status)) === true;

  return (
    <div className="space-y-4">
      {account.canEdit && account.deal?.status === "open" && (
        <Panel title="Send a contract" icon={Pen}>
          {sentProposal === undefined ? (
            <Empty>Send a proposal first. The contract uses its package and price.</Empty>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-64">
                <Field label="Signer">
                  <select
                    className={inputClass}
                    value={signer}
                    onChange={(event) => {
                      setSigner(event.target.value);
                    }}
                  >
                    {signable.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {`${contact.firstName} ${contact.lastName}`.trim()}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="w-44">
                <Field label="Start date">
                  <input
                    type="date"
                    className={inputClass}
                    value={startDate}
                    onChange={(event) => {
                      setStartDate(event.target.value);
                    }}
                  />
                </Field>
              </div>
              <Btn
                kind="primary"
                icon={Send}
                busy={send.isPending}
                disabled={open || signer === ""}
                onClick={() => {
                  send.mutate();
                }}
              >
                Send contract for signature
              </Btn>
              <p className="w-full text-xs text-zinc-400">
                Version {sentProposal.version}: {formatCentsExact(sentProposal.pricing.monthlyCents)} a month. Your
                contact signs first, then the company&apos;s signer.
              </p>
            </div>
          )}
          {send.isError && <ErrorState error={send.error} />}
        </Panel>
      )}
      <Panel title="Contracts" icon={FileText}>
        {contracts.isPending ? (
          <Loading />
        ) : contracts.isError ? (
          <ErrorState error={contracts.error} onRetry={() => void contracts.refetch()} />
        ) : contracts.data.items.length === 0 ? (
          <Empty>No contract yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {contracts.data.items.map((contract) => (
              <li key={contract.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={CONTRACT_TONE[contract.status]}>{contract.status}</Pill>
                  <span className="text-sm text-zinc-200">{contract.signer?.name ?? "Signer removed"}</span>
                  {contract.viewCount > 0 && (
                    <span className="text-xs text-zinc-400">Viewed {contract.viewCount}×</span>
                  )}
                  {contract.signedAt !== null && (
                    <span className="flex items-center gap-1 text-xs text-emerald-300">
                      <CheckCircle size={12} aria-hidden="true" />
                      Signed {new Date(contract.signedAt).toLocaleDateString()}
                    </span>
                  )}
                  <span className="ml-auto flex flex-wrap gap-2">
                    {contract.signedPdfUrl !== null && (
                      <a
                        className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500"
                        href={contract.signedPdfUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Signed copy
                      </a>
                    )}
                    {["sent", "viewed"].includes(contract.status) && account.canEdit && (
                      <Btn
                        small
                        kind="ghost"
                        icon={XCircle}
                        onClick={() => {
                          voidContract.mutate(contract.id);
                        }}
                      >
                        Void
                      </Btn>
                    )}
                  </span>
                </div>
                {["sent", "viewed"].includes(contract.status) && import.meta.env.DEV && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-amber-800 bg-amber-950/20 p-2 text-xs text-amber-200">
                    <Sparkles size={12} aria-hidden="true" />
                    Local fake e-signature:
                    {(["viewed", "signed", "declined"] as const).map((event) => (
                      <Btn
                        key={event}
                        small
                        onClick={() => {
                          simulate.mutate({ id: contract.id, event });
                        }}
                      >
                        Client {event}
                      </Btn>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {(voidContract.error ?? simulate.error) !== null && <ErrorState error={voidContract.error ?? simulate.error} />}
      </Panel>
    </div>
  );
}
