import { randomBytes } from "node:crypto";
import { tables, type Database, type Executor } from "@soa/db";
import {
  Package,
  packageLines,
  priceBreakdown,
  pricingConfigFromRow,
  type Contract,
  type CreateContractRequest,
  type CreateProposalRequest,
  type Env,
  type PriceBreakdown,
  type PricingConfig,
  type PricingConfigInput,
  type PricingConfigResponse,
  type PricingConfigVersion,
  type Proposal,
  type ProposalPatch,
  type QuoteRequest,
  type QuoteResponse,
} from "@soa/shared";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex } from "../auth/crypto";
import type { Clock } from "../clock";
import { conflict, HttpError, notFound, unprocessable } from "../errors";
import { JOBS, type JobQueue } from "../jobs/queue";
import type { ESignProvider } from "../providers/esign/types";
import { renderAgreementPdf, renderProposalPdf } from "../providers/pdf";
import type { ObjectStore } from "../providers/storage";
import { auditRepo } from "../repos/audit";
import { activitiesRepo, contactsRepo, tasksRepo } from "../repos/children";
import { suppressionListRepo } from "../repos/outreach";
import {
  contractsRepo,
  lockEditableDeal,
  pricingConfigsRepo,
  proposalsRepo,
  type ContractRow,
  type PricingConfigRow,
  type ProposalRow,
} from "../repos/proposals";
import { researchRepo } from "../repos/research";
import { systemScope, userScope, type Scope, type UserScope } from "../repos/scope";
import { usersRepo } from "../repos/users";
import { advanceDeal } from "./advance";
import { isoDay } from "./mappers";
import type { OutreachService } from "./outreach";

/* Pricing, proposals and contracts (ARCHITECTURE.md §6, §10). Every price is computed here by the pricing engine;
   a proposal stores a snapshot, so a later pricing change never alters it. */

type ProposalConfig = Pick<
  Env,
  | "PUBLIC_URL"
  | "IP_HASH_SALT"
  | "COMPANY_NAME"
  | "COMPANY_POSTAL_ADDRESS"
  | "COMPANY_SIGNER_NAME"
  | "COMPANY_SIGNER_EMAIL"
>;

export interface ProposalDeps {
  db: Database;
  queue: JobQueue;
  store: ObjectStore;
  esign: ESignProvider;
  outreach: OutreachService;
  config: ProposalConfig;
  clock: Clock;
}

const SHARE_DAYS = 30;
const RENDER_STALE_MS = 10 * 60 * 1000;

/** What a proposal stores: the engine's breakdown plus what is needed to show it later without the live config. */
const Snapshot = z.object({
  pricingConfigId: z.string(),
  hoursPerWeek: z.number(),
  hourlyRateCents: z.number(),
  addonsMonthlyCents: z.number(),
  termDiscount: z.number(),
  manualDiscount: z.number(),
  annualCents: z.number(),
  monthlyCents: z.number(),
  addonLabels: z.record(z.string(), z.object({ label: z.string() })),
  maxManualDiscount: z.number(),
});
type Snapshot = z.infer<typeof Snapshot>;

const snapshotOf = (breakdown: PriceBreakdown, config: PricingConfig): Snapshot => ({
  ...breakdown,
  addonLabels: Object.fromEntries(Object.entries(config.addons).map(([key, value]) => [key, { label: value.label }])),
  maxManualDiscount: config.maxManualDiscount,
});

const toVersion = (
  row: PricingConfigRow,
  createdBy: string | null,
  liveId: string | undefined,
): PricingConfigVersion => {
  const config = pricingConfigFromRow(row);
  return {
    id: row.id,
    effectiveFrom: row.effectiveFrom,
    hourlyRateCents: config.hourlyRateCents,
    coverageHoursPerWeek: config.coverageHoursPerWeek,
    supervisorMultiplier: config.supervisorMultiplier,
    addons: config.addons,
    termDiscounts: {
      "12": config.termDiscounts["12"] ?? 0,
      "24": config.termDiscounts["24"] ?? 0,
      "36": config.termDiscounts["36"] ?? 0,
    },
    maxManualDiscount: config.maxManualDiscount,
    createdAt: row.createdAt.toISOString(),
    createdBy,
    live: row.id === liveId,
  };
};

const fullAddress = (account: {
  addressLine: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}) =>
  [account.addressLine, account.city, account.state, account.postalCode]
    .filter((part) => part !== null && part !== "")
    .join(", ") || null;

export const hashToken = (token: string) => sha256Hex(token);

export function createProposalsService(deps: ProposalDeps) {
  const { db, queue, store, esign, config, clock } = deps;

  const livePricing = async (tx: Executor, scope: Scope) => {
    const row = await pricingConfigsRepo(tx).live(scope, isoDay(clock()));
    if (row === undefined)
      throw conflict("no_pricing", "Pricing isn't set up yet. A manager adds it under Admin → Pricing.");
    return pricingConfigFromRow(row);
  };

  const needsApproval = (row: Pick<ProposalRow, "manualDiscount" | "discountApprovedBy">, snapshot: Snapshot) =>
    Number(row.manualDiscount) > snapshot.maxManualDiscount && row.discountApprovedBy === null;

  const renderState = async (scope: Scope, accountId: string, proposalId: string) => {
    const event = await researchRepo(db).lastJobEvent(scope, accountId, JOBS.proposalRender, { proposalId });
    if (event === undefined) return { rendering: false, renderError: null };
    if (event.meta.state === "requested") {
      return clock().getTime() - event.occurredAt.getTime() < RENDER_STALE_MS
        ? { rendering: true, renderError: null }
        : { rendering: false, renderError: "The PDF took too long. Generate it again." };
    }
    if (event.meta.state === "failed")
      return { rendering: false, renderError: "The PDF couldn't be generated. Try again." };
    return { rendering: false, renderError: null };
  };

  const toProposal = async (
    scope: Scope,
    row: { proposal: ProposalRow; accountId: string },
    views?: { count: number; last: Date | null },
  ): Promise<Proposal> => {
    const { proposal } = row;
    const snapshot = Snapshot.parse(proposal.pricing);
    const pkg = Package.parse(proposal.package);
    const state = await renderState(scope, row.accountId, proposal.id);
    const expired = proposal.expiresAt !== null && proposal.expiresAt < clock() && proposal.status !== "accepted";
    return {
      id: proposal.id,
      dealId: proposal.dealId,
      accountId: row.accountId,
      version: proposal.version,
      status: expired ? "expired" : proposal.status,
      package: pkg,
      pricing: {
        pricingConfigId: snapshot.pricingConfigId,
        hoursPerWeek: snapshot.hoursPerWeek,
        hourlyRateCents: snapshot.hourlyRateCents,
        addonsMonthlyCents: snapshot.addonsMonthlyCents,
        termDiscount: snapshot.termDiscount,
        manualDiscount: snapshot.manualDiscount,
        annualCents: snapshot.annualCents,
        monthlyCents: snapshot.monthlyCents,
      },
      manualDiscount: Number(proposal.manualDiscount),
      needsApproval: needsApproval(proposal, snapshot),
      discountApprovedBy: proposal.discountApprovedBy,
      coverNote: proposal.coverNote,
      pdfReady: proposal.pdfObjectKey !== null,
      ...state,
      sentAt: proposal.sentAt?.toISOString() ?? null,
      expiresAt: proposal.expiresAt?.toISOString() ?? null,
      viewCount: views?.count ?? 0,
      lastViewedAt: views?.last?.toISOString() ?? null,
      createdAt: proposal.createdAt.toISOString(),
      lines: packageLines(pkg, snapshot.addonLabels),
    };
  };

  const proposalFor = async (scope: Scope, id: string) => {
    const row = await proposalsRepo(db).get(scope, id);
    if (row === undefined) throw notFound();
    const views = await proposalsRepo(db).views(scope, [id]);
    return toProposal(scope, row, views.get(id));
  };

  const toContract = async (row: ContractRow): Promise<Contract> => {
    const signer =
      row.signerContactId === null
        ? undefined
        : (await db.select().from(tables.contacts).where(eq(tables.contacts.id, row.signerContactId)))[0];
    return {
      id: row.id,
      dealId: row.dealId,
      proposalId: row.proposalId,
      status: row.status,
      signer:
        signer === undefined
          ? null
          : { id: signer.id, name: `${signer.firstName} ${signer.lastName}`.trim(), email: signer.email },
      viewCount: row.viewCount,
      sentAt: row.sentAt?.toISOString() ?? null,
      signedAt: row.signedAt?.toISOString() ?? null,
      signedPdfUrl: row.signedPdfObjectKey === null ? null : `/api/contracts/${row.id}/signed.pdf`,
    };
  };

  return {
    // ───────── pricing ─────────
    async quote(scope: UserScope, request: QuoteRequest): Promise<QuoteResponse> {
      const pricing = await livePricing(db, scope);
      return {
        breakdown: priceBreakdown(request.package, pricing, request.manualDiscount),
        needsApproval: request.manualDiscount > pricing.maxManualDiscount,
        maxManualDiscount: pricing.maxManualDiscount,
      };
    },

    async pricingConfig(scope: UserScope): Promise<PricingConfigResponse> {
      const rows = await pricingConfigsRepo(db).list(scope);
      const live = await pricingConfigsRepo(db).live(scope, isoDay(clock()));
      const versions = rows.map((row) => toVersion(row.config, row.createdByName, live?.id));
      return { live: versions.find((version) => version.live) ?? null, versions };
    },

    /** A new version (managers). It applies from its date; proposals already made keep their numbers. */
    async createPricingConfig(
      scope: UserScope,
      input: PricingConfigInput,
      ip: string | null,
    ): Promise<PricingConfigVersion> {
      if (input.effectiveFrom < isoDay(clock())) {
        throw unprocessable("past_date", "A new version can start today or later, not in the past.");
      }
      return db.transaction(async (tx) => {
        const row = await pricingConfigsRepo(tx).insert(scope, {
          effectiveFrom: input.effectiveFrom,
          hourlyRateCents: input.hourlyRateCents,
          coverageHoursPerWeek: input.coverageHoursPerWeek,
          supervisorMultiplier: input.supervisorMultiplier.toFixed(4),
          addons: input.addons,
          termDiscounts: input.termDiscounts,
          maxManualDiscount: input.maxManualDiscount.toFixed(4),
          createdBy: scope.userId,
        });
        if (row === undefined) throw conflict("version_exists", "A version already starts on that date.");
        await auditRepo(tx).write(scope, {
          action: "pricing.create",
          entityType: "pricing_config",
          entityId: row.id,
          meta: { effectiveFrom: input.effectiveFrom },
          ip,
        });
        const live = await pricingConfigsRepo(tx).live(scope, isoDay(clock()));
        return toVersion(row, null, live?.id);
      });
    },

    // ───────── proposals ─────────
    async list(scope: UserScope, dealId: string): Promise<Proposal[]> {
      const rows = await proposalsRepo(db).listForDeal(scope, dealId);
      const views = await proposalsRepo(db).views(
        scope,
        rows.map((row) => row.proposal.id),
      );
      return Promise.all(rows.map((row) => toProposal(scope, row, views.get(row.proposal.id))));
    },

    get: proposalFor,

    async create(
      scope: UserScope,
      dealId: string,
      request: CreateProposalRequest,
      ip: string | null,
    ): Promise<Proposal> {
      const id = await db.transaction(async (tx) => {
        const deal = await lockEditableDeal(tx, scope, dealId);
        if (deal === undefined) throw notFound();
        if (deal.deal.status !== "open") throw conflict("deal_closed", "This deal is closed.");
        const pricing = await livePricing(tx, scope);
        // The engine's numbers only; nothing price-like from the request is read.
        const breakdown = priceBreakdown(request.package, pricing, request.manualDiscount);
        const row = await proposalsRepo(tx).insertNext(scope, {
          dealId,
          package: request.package,
          pricing: snapshotOf(breakdown, pricing),
          manualDiscount: request.manualDiscount.toFixed(4),
          coverNote: request.coverNote ?? null,
          createdBy: scope.userId,
        });
        await activitiesRepo(tx).insert(scope, {
          accountId: deal.deal.accountId,
          dealId,
          type: "note",
          subject: `Proposal v${String(row.version)} drafted`,
          meta: { proposalId: row.id },
        });
        await auditRepo(tx).write(scope, {
          action: "proposal.create",
          entityType: "proposal",
          entityId: row.id,
          meta: { version: row.version, annualCents: breakdown.annualCents, manualDiscount: request.manualDiscount },
          ip,
        });
        return row.id;
      });
      return proposalFor(scope, id);
    },

    /** Edits a draft and prices it again with the live configuration. */
    async update(scope: UserScope, id: string, patch: ProposalPatch, ip: string | null): Promise<Proposal> {
      await db.transaction(async (tx) => {
        const row = await proposalsRepo(tx).lockEditable(scope, id);
        if (row === undefined) throw notFound();
        if (row.proposal.status !== "draft")
          throw conflict("not_draft", "A sent proposal can't change. Make a new version.");
        const pkg = patch.package ?? Package.parse(row.proposal.package);
        const discount = patch.manualDiscount ?? Number(row.proposal.manualDiscount);
        const pricing = await livePricing(tx, scope);
        const breakdown = priceBreakdown(pkg, pricing, discount);
        const discountChanged = discount !== Number(row.proposal.manualDiscount);
        await proposalsRepo(tx).update(scope, id, {
          package: pkg,
          manualDiscount: discount.toFixed(4),
          pricing: snapshotOf(breakdown, pricing),
          ...(patch.coverNote === undefined ? {} : { coverNote: patch.coverNote }),
          // A changed discount needs approving again; any change makes the PDF out of date.
          ...(discountChanged ? { discountApprovedBy: null } : {}),
          pdfObjectKey: null,
        });
        await auditRepo(tx).write(scope, {
          action: "proposal.update",
          entityType: "proposal",
          entityId: id,
          meta: { fields: Object.keys(patch).sort(), annualCents: breakdown.annualCents },
          ip,
        });
      });
      return proposalFor(scope, id);
    },

    /** Managers approve a manual discount above the limit (audited). */
    async approveDiscount(scope: UserScope, id: string, ip: string | null): Promise<Proposal> {
      await db.transaction(async (tx) => {
        const row = await proposalsRepo(tx).lockEditable(scope, id);
        if (row === undefined) throw notFound();
        if (row.proposal.status !== "draft") throw conflict("not_draft", "Only a draft's discount can be approved.");
        const snapshot = Snapshot.parse(row.proposal.pricing);
        if (Number(row.proposal.manualDiscount) <= snapshot.maxManualDiscount) {
          throw conflict("no_approval_needed", "This discount is within the limit.");
        }
        await proposalsRepo(tx).update(scope, id, { discountApprovedBy: scope.userId });
        await activitiesRepo(tx).insert(scope, {
          accountId: row.accountId,
          dealId: row.proposal.dealId,
          type: "note",
          subject: `Discount of ${String(Math.round(Number(row.proposal.manualDiscount) * 1000) / 10)}% on proposal v${String(row.proposal.version)} approved`,
          meta: { proposalId: id },
        });
        await auditRepo(tx).write(scope, {
          action: "proposal.discount_approve",
          entityType: "proposal",
          entityId: id,
          meta: { manualDiscount: Number(row.proposal.manualDiscount), annualCents: snapshot.annualCents },
          ip,
        });
      });
      return proposalFor(scope, id);
    },

    async render(scope: UserScope, id: string): Promise<void> {
      const row = await proposalsRepo(db).lockEditable(scope, id);
      if (row === undefined) throw notFound();
      if ((await renderState(scope, row.accountId, id)).rendering) {
        throw conflict("already_running", "The PDF is already being generated.");
      }
      await activitiesRepo(db).insert(scope, {
        accountId: row.accountId,
        dealId: row.proposal.dealId,
        type: "note",
        subject: `Generating the PDF for proposal v${String(row.proposal.version)}`,
        meta: { job: JOBS.proposalRender, state: "requested", proposalId: id },
      });
      await queue.send(JOBS.proposalRender, { proposalId: id });
    },

    /** The share link (30 days) and an email draft containing it, for the rep to review and send. */
    async send(scope: UserScope, id: string, contactId: string | undefined, ip: string | null) {
      const now = clock();
      return db.transaction(async (tx) => {
        const row = await proposalsRepo(tx).lockEditable(scope, id);
        if (row === undefined) throw notFound();
        const { proposal } = row;
        if (proposal.status !== "draft") throw conflict("already_sent", "This proposal was already sent.");
        const snapshot = Snapshot.parse(proposal.pricing);
        if (needsApproval(proposal, snapshot)) {
          throw conflict("needs_approval", "The discount is above the limit. A manager must approve it first.");
        }
        if (proposal.pdfObjectKey === null) throw conflict("no_pdf", "Generate the PDF first.");
        const contacts = await contactsRepo(tx).listForAccount(scope, row.accountId);
        const contact =
          contactId === undefined
            ? (contacts.find((entry) => entry.isPrimary && entry.email !== null) ??
              contacts.find((entry) => entry.email !== null))
            : contacts.find((entry) => entry.id === contactId);
        if (contact?.email == null) throw unprocessable("no_contact", "Add a contact with an email address first.");

        const token = randomBytes(32).toString("base64url");
        const expiresAt = new Date(now.getTime() + SHARE_DAYS * 86_400_000);
        await proposalsRepo(tx).update(scope, id, {
          status: "sent",
          sentAt: now,
          expiresAt,
          publicTokenHash: hashToken(token),
        });
        const link = `${config.PUBLIC_URL.replace(/\/$/, "")}/p/${token}`;
        const draftId = await deps.outreach.createWrittenDraft(tx, scope, {
          accountId: row.accountId,
          contactId: contact.id,
          dealId: proposal.dealId,
          subject: `Proposal for ${row.accountName}`,
          body: `Hi ${contact.firstName},\n\nThank you for your time. Here is our proposal for ${row.accountName}:\n${link}\n\nThe link works until ${isoDay(expiresAt)}. I'm happy to walk through it whenever suits you.`,
        });
        await activitiesRepo(tx).insert(scope, {
          accountId: row.accountId,
          dealId: proposal.dealId,
          type: "proposal_sent",
          subject: `Proposal v${String(proposal.version)} ready to send to ${`${contact.firstName} ${contact.lastName}`.trim()}`,
          meta: { proposalId: id, draftId },
        });
        await auditRepo(tx).write(scope, {
          action: "proposal.send",
          entityType: "proposal",
          entityId: id,
          meta: { expiresAt: expiresAt.toISOString(), annualCents: snapshot.annualCents },
          ip,
        });
        await tx
          .update(tables.deals)
          .set({ annualValueCents: snapshot.annualCents, updatedAt: sql`now()` })
          .where(eq(tables.deals.id, proposal.dealId));
        await advanceDeal(tx, scope, row.accountId, "proposal", "proposal_sent", now);
        return { draftId, expiresAt: expiresAt.toISOString() };
      });
    },

    async pdf(scope: UserScope, id: string): Promise<Buffer> {
      const row = await proposalsRepo(db).get(scope, id);
      if (row?.proposal.pdfObjectKey == null) throw notFound();
      return store.get(row.proposal.pdfObjectKey);
    },

    // ───────── contracts ─────────
    async contracts(scope: UserScope, dealId: string): Promise<Contract[]> {
      const rows = await contractsRepo(db).listForDeal(scope, dealId);
      return Promise.all(rows.map((row) => toContract(row.contract)));
    },

    async contract(scope: UserScope, id: string): Promise<Contract> {
      const row = await contractsRepo(db).get(scope, id);
      if (row === undefined) throw notFound();
      return toContract(row.contract);
    },

    async signedPdf(scope: UserScope, id: string): Promise<Buffer> {
      const row = await contractsRepo(db).get(scope, id);
      if (row?.contract.signedPdfObjectKey == null) throw notFound();
      return store.get(row.contract.signedPdfObjectKey);
    },

    /** §10.2: fill the agreement and send the envelope (the client signs first, the company second). */
    async createContract(scope: UserScope, proposalId: string, request: CreateContractRequest, ip: string | null) {
      const now = clock();
      const id = await db.transaction(async (tx) => {
        const row = await proposalsRepo(tx).lockEditable(scope, proposalId);
        if (row === undefined) throw notFound();
        const signerName = config.COMPANY_SIGNER_NAME;
        const signerEmail = config.COMPANY_SIGNER_EMAIL;
        if (signerName === undefined || signerEmail === undefined) {
          throw unprocessable(
            "no_company_signer",
            "The company counter-signer isn't set (COMPANY_SIGNER_NAME and COMPANY_SIGNER_EMAIL).",
          );
        }
        const { proposal } = row;
        if (proposal.status !== "sent" && proposal.status !== "viewed") {
          throw conflict("not_sent", "Send the proposal before sending a contract.");
        }
        const open = (await contractsRepo(tx).listForDeal(scope, proposal.dealId)).filter((entry) =>
          ["draft", "sent", "viewed"].includes(entry.contract.status),
        );
        if (open.length > 0) throw conflict("contract_open", "A contract is already out for signature. Void it first.");
        const contact = (await contactsRepo(tx).listForAccount(scope, row.accountId)).find(
          (entry) => entry.id === request.signerContactId,
        );
        if (contact === undefined) throw notFound("That contact isn't on this account.");
        if (contact.email === null) throw unprocessable("no_email", "The signer needs an email address.");
        if (contact.emailStatus !== "ok" || (await suppressionListRepo(tx).reason(scope, contact.email)) !== null) {
          throw unprocessable("suppressed", "This contact can't be emailed (suppressed, bounced or unsubscribed).");
        }
        const account = await tx.select().from(tables.accounts).where(eq(tables.accounts.id, row.accountId));
        const snapshot = Snapshot.parse(proposal.pricing);
        const pkg = Package.parse(proposal.package);
        const document = await renderAgreementPdf({
          companyName: config.COMPANY_NAME,
          companyAddress: config.COMPANY_POSTAL_ADDRESS ?? null,
          companySigner: signerName,
          accountName: row.accountName,
          accountAddress: account[0] === undefined ? null : fullAddress(account[0]),
          signerName: `${contact.firstName} ${contact.lastName}`.trim(),
          signerEmail: contact.email,
          lines: packageLines(pkg, snapshot.addonLabels),
          monthlyCents: snapshot.monthlyCents,
          annualCents: snapshot.annualCents,
          termMonths: pkg.termMonths,
          startDate: request.startDate,
        });
        const contract = await contractsRepo(tx).insert(scope, {
          dealId: proposal.dealId,
          proposalId,
          esignProvider: esign.name,
          signerContactId: contact.id,
          createdBy: scope.userId,
        });
        const envelope = await esign.createEnvelope({
          title: `Security Services Agreement: ${row.accountName}`,
          subject: `Agreement for ${row.accountName}`,
          message: `Please review and sign the security services agreement for ${row.accountName}.`,
          document,
          signers: [
            { name: `${contact.firstName} ${contact.lastName}`.trim(), email: contact.email },
            { name: signerName, email: signerEmail },
          ],
          contractId: contract.id,
        });
        try {
          await contractsRepo(tx).update(scope, contract.id, {
            status: "sent",
            sentAt: now,
            providerEnvelopeId: envelope.envelopeId,
          });
          await activitiesRepo(tx).insert(scope, {
            accountId: row.accountId,
            dealId: proposal.dealId,
            contactId: contact.id,
            type: "contract_sent",
            subject: `Contract sent to ${`${contact.firstName} ${contact.lastName}`.trim()} for signature`,
            meta: { contractId: contract.id },
          });
          await auditRepo(tx).write(scope, {
            action: "contract.send",
            entityType: "contract",
            entityId: contract.id,
            meta: { proposalId, startDate: request.startDate },
            ip,
          });
          await advanceDeal(tx, scope, row.accountId, "contract_sent", "contract_sent", now);
        } catch (error) {
          await esign.voidEnvelope(envelope.envelopeId).catch(() => undefined);
          throw error;
        }
        return contract.id;
      });
      return this.contract(scope, id);
    },

    async voidContract(scope: UserScope, id: string, ip: string | null): Promise<Contract> {
      await db.transaction(async (tx) => {
        const row = await contractsRepo(tx).lockEditable(scope, id);
        if (row === undefined) throw notFound();
        if (!["draft", "sent", "viewed"].includes(row.contract.status)) {
          throw conflict("not_open", "Only an unsigned contract can be voided.");
        }
        if (row.contract.providerEnvelopeId !== null) await esign.voidEnvelope(row.contract.providerEnvelopeId);
        await contractsRepo(tx).update(scope, id, { status: "voided" });
        await activitiesRepo(tx).insert(scope, {
          accountId: row.accountId,
          dealId: row.contract.dealId,
          type: "note",
          subject: "Contract voided",
          meta: { contractId: id },
        });
        await auditRepo(tx).write(scope, { action: "contract.void", entityType: "contract", entityId: id, ip });
      });
      return this.contract(scope, id);
    },

    /** The e-signature webhook (§10.2). Verified, applied once per event, idempotent by state. */
    async webhook(json: string): Promise<"ok" | "rejected"> {
      const event = esign.verifyWebhook(json);
      if (event === null) return "rejected";
      const scope = systemScope("esign webhook");
      const now = clock();
      await db.transaction(async (tx) => {
        // Replays change nothing: each processed event is recorded in the (append-only) audit log.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`esign:${event.envelopeId}`}))`);
        const [seen] = await tx
          .select({ id: tables.auditLog.id })
          .from(tables.auditLog)
          .where(
            and(
              eq(tables.auditLog.action, "contract.webhook"),
              sql`${tables.auditLog.meta}->>'eventId' = ${event.eventId}`,
            ),
          )
          .limit(1);
        if (seen !== undefined) return;
        const row = await contractsRepo(tx).lockByEnvelope(scope, event.envelopeId);
        if (row === undefined) return; // not ours
        const { contract } = row;
        const deal = await tx.select().from(tables.deals).where(eq(tables.deals.id, contract.dealId));
        const owner = deal[0]?.ownerUserId ?? contract.createdBy;

        if (event.type === "viewed" && ["sent", "viewed"].includes(contract.status)) {
          await contractsRepo(tx).update(scope, contract.id, { viewCount: contract.viewCount + 1, status: "viewed" });
        } else if (event.type === "signed" && contract.status !== "signed") {
          const pdf = await esign.downloadSigned(event.envelopeId);
          const key = `contracts/${contract.dealId}/${contract.id}-signed.pdf`;
          await store.put(key, pdf, "application/pdf");
          await contractsRepo(tx).update(scope, contract.id, {
            status: "signed",
            signedAt: now,
            signedPdfObjectKey: key,
          });
          await activitiesRepo(tx).insert(scope, {
            accountId: row.accountId,
            dealId: contract.dealId,
            type: "contract_signed",
            subject: "Contract signed. Signed copy stored.",
            meta: { contractId: contract.id },
          });
          await advanceDeal(tx, scope, row.accountId, "won", "contract_signed", now);
          await tasksRepo(tx).insert(scope, {
            ownerUserId: owner,
            accountId: row.accountId,
            dealId: contract.dealId,
            title: `Hand off ${row.accountName} to operations`,
            dueAt: now,
          });
        } else if ((event.type === "declined" || event.type === "voided") && contract.status !== "signed") {
          if (contract.status !== event.type) {
            await contractsRepo(tx).update(scope, contract.id, { status: event.type });
            await activitiesRepo(tx).insert(scope, {
              accountId: row.accountId,
              dealId: contract.dealId,
              type: "note",
              subject: `Contract ${event.type}`,
              meta: { contractId: contract.id },
            });
            await tasksRepo(tx).insert(scope, {
              ownerUserId: owner,
              accountId: row.accountId,
              dealId: contract.dealId,
              title: `Follow up: the contract for ${row.accountName} was ${event.type}`,
              dueAt: now,
            });
          }
        }
        await auditRepo(tx).write(scope, {
          action: "contract.webhook",
          entityType: "contract",
          entityId: contract.id,
          meta: { eventId: event.eventId, type: event.type },
        });
      });
      return "ok";
    },

    // ───────── public share link (§10.1, §10.3) ─────────
    /** The proposal behind a share link: undefined for a wrong, expired or withdrawn token. */
    async byToken(token: string) {
      const row = await proposalsRepo(db).byTokenHash(systemScope("share link"), hashToken(token));
      if (row === undefined) return undefined;
      const { proposal } = row;
      if (proposal.expiresAt === null || proposal.expiresAt < clock()) return undefined;
      if (!["sent", "viewed", "accepted"].includes(proposal.status) || proposal.pdfObjectKey === null) return undefined;
      const rep = await usersRepo(db).findById(systemScope("share link"), proposal.createdBy);
      return { row, rep };
    },

    async recordView(proposalId: string, accountId: string, dealId: string, ip: string, userAgent: string | undefined) {
      const scope = systemScope("share link");
      await db.transaction(async (tx) => {
        const { firstToday } = await proposalsRepo(tx).recordView(scope, {
          proposalId,
          ipHash: sha256Hex(`${config.IP_HASH_SALT}:${ip}`),
          userAgent: userAgent?.slice(0, 300) ?? null,
        });
        const [proposal] = await tx.select().from(tables.proposals).where(eq(tables.proposals.id, proposalId));
        if (proposal?.status === "sent") await proposalsRepo(tx).update(scope, proposalId, { status: "viewed" });
        if (firstToday) {
          await activitiesRepo(tx).insert(scope, {
            accountId,
            dealId,
            type: "proposal_viewed",
            subject: `Proposal v${String(proposal?.version ?? 0)} was opened`,
            meta: { proposalId },
          });
        }
      });
    },

    readPdf: (key: string) => store.get(key),

    /** FAKE_PROVIDERS: the envelope of a contract, so the dev-only route can play the provider's callback. */
    async envelopeOf(contractId: string): Promise<string> {
      const row = await contractsRepo(db).get(systemScope("fake e-sign"), contractId);
      if (row?.contract.providerEnvelopeId == null) throw notFound();
      return row.contract.providerEnvelopeId;
    },
  };
}

export type ProposalsService = ReturnType<typeof createProposalsService>;

// ───────── job (worker) ─────────

/** proposal.render: the PDF from the proposal's own snapshot, stored in S3. Always records an outcome. */
export async function runProposalRender(
  deps: {
    db: Database;
    store: ObjectStore;
    config: Pick<Env, "COMPANY_NAME" | "COMPANY_POSTAL_ADDRESS">;
    clock: Clock;
  },
  job: { proposalId: string },
): Promise<void> {
  const { db } = deps;
  const system = systemScope("proposal.render");
  const row = await proposalsRepo(db).get(system, job.proposalId);
  if (row === undefined) return;
  const { proposal } = row;
  const record = (scope: Scope, state: "done" | "failed", message: string) =>
    activitiesRepo(db).insert(scope, {
      accountId: row.accountId,
      dealId: proposal.dealId,
      type: "note",
      subject: message,
      meta: { job: JOBS.proposalRender, state, proposalId: proposal.id },
    });
  try {
    const rep = await usersRepo(db).findById(system, proposal.createdBy);
    if (rep === undefined) throw new Error("no rep");
    const scope = userScope(rep.id, rep.role);
    const [account] = await db.select().from(tables.accounts).where(eq(tables.accounts.id, row.accountId));
    const contacts = await contactsRepo(db).listForAccount(system, row.accountId);
    const primary = contacts.find((contact) => contact.isPrimary) ?? contacts[0];
    const snapshot = Snapshot.parse(proposal.pricing);
    const pkg = Package.parse(proposal.package);
    const pdf = await renderProposalPdf({
      companyName: deps.config.COMPANY_NAME,
      companyAddress: deps.config.COMPANY_POSTAL_ADDRESS ?? null,
      accountName: row.accountName,
      accountAddress: account === undefined ? null : fullAddress(account),
      contactName: primary === undefined ? null : `${primary.firstName} ${primary.lastName}`.trim(),
      version: proposal.version,
      date: isoDay(deps.clock()),
      coverNote: proposal.coverNote,
      lines: packageLines(pkg, snapshot.addonLabels),
      monthlyCents: snapshot.monthlyCents,
      annualCents: snapshot.annualCents,
      termMonths: pkg.termMonths,
      termDiscount: snapshot.termDiscount,
      manualDiscount: snapshot.manualDiscount,
      validUntil: proposal.expiresAt === null ? null : isoDay(proposal.expiresAt),
      rep: { name: rep.name, title: rep.title, email: rep.email, phone: rep.phone },
    });
    const key = `proposals/${proposal.dealId}/${proposal.id}-v${String(proposal.version)}.pdf`;
    await deps.store.put(key, pdf, "application/pdf");
    // Only if it is still the same draft text (an edit while rendering makes this PDF stale).
    await db
      .update(tables.proposals)
      .set({ pdfObjectKey: key })
      .where(
        and(
          eq(tables.proposals.id, proposal.id),
          sql`${tables.proposals.package} = ${JSON.stringify(proposal.package)}::jsonb`,
          sql`${tables.proposals.manualDiscount} = ${proposal.manualDiscount}`,
        ),
      );
    await record(scope, "done", `PDF ready for proposal v${String(proposal.version)}`);
  } catch (error) {
    await record(system, "failed", "The proposal PDF couldn't be generated.").catch(() => undefined);
    throw error;
  }
}

export { HttpError };
