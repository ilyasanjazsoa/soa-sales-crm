import { z } from "zod";
import { Package } from "./pricing";

/* Pricing admin, proposals and contracts (docs/API.md "Pricing, proposals, contracts", ARCHITECTURE.md §6, §10).
   Every price in these shapes is computed by the server; a price sent by a browser is never read (rule 6). */

const timestamp = z.iso.datetime({ offset: true });
const cents = z.number().int().min(0).max(100_000_000);
const rate = z.number().min(0).max(0.9999);

export const PriceBreakdownSchema = z.object({
  pricingConfigId: z.string(),
  hoursPerWeek: z.number(),
  hourlyRateCents: z.number().int(),
  addonsMonthlyCents: z.number().int(),
  termDiscount: z.number(),
  manualDiscount: z.number(),
  annualCents: z.number().int(),
  monthlyCents: z.number().int(),
});

export const QuoteRequest = z.object({ package: Package, manualDiscount: rate.default(0) }).strict();
export type QuoteRequest = z.infer<typeof QuoteRequest>;
export const QuoteResponse = z.object({
  breakdown: PriceBreakdownSchema,
  /** The manual discount is above the limit: sending needs a manager's approval. */
  needsApproval: z.boolean(),
  maxManualDiscount: z.number(),
});
export type QuoteResponse = z.infer<typeof QuoteResponse>;

// ───────── pricing configuration (versions) ─────────
export const PricingConfigInput = z
  .object({
    effectiveFrom: z.iso.date(),
    hourlyRateCents: z.object({ unarmed: cents, armed: cents }),
    coverageHoursPerWeek: z.object({
      "24_7": z.number().int().min(1).max(168),
      nights: z.number().int().min(1).max(168),
      business_hours: z.number().int().min(1).max(168),
    }),
    supervisorMultiplier: z.number().min(1).max(3),
    addons: z.object({
      patrol: z.object({ label: z.string().trim().min(1).max(100), monthlyCents: cents }),
      video: z.object({ label: z.string().trim().min(1).max(100), monthlyCents: cents }),
      portal: z.object({ label: z.string().trim().min(1).max(100), monthlyCents: cents }),
    }),
    termDiscounts: z.object({ "12": rate, "24": rate, "36": rate }),
    maxManualDiscount: rate,
  })
  .strict();
export type PricingConfigInput = z.infer<typeof PricingConfigInput>;

export const PricingConfigVersion = PricingConfigInput.extend({
  id: z.uuid(),
  createdAt: timestamp,
  createdBy: z.string().nullable(),
  live: z.boolean(),
});
export type PricingConfigVersion = z.infer<typeof PricingConfigVersion>;
export const PricingConfigResponse = z.object({
  live: PricingConfigVersion.nullable(),
  versions: z.array(PricingConfigVersion),
});
export type PricingConfigResponse = z.infer<typeof PricingConfigResponse>;

// ───────── proposals ─────────
export const ProposalStatus = z.enum(["draft", "sent", "viewed", "accepted", "expired"]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const CreateProposalRequest = z
  .object({ package: Package, manualDiscount: rate.default(0), coverNote: z.string().trim().max(2000).optional() })
  .strict();
export type CreateProposalRequest = z.infer<typeof CreateProposalRequest>;

export const ProposalPatch = z
  .object({ package: Package, manualDiscount: rate, coverNote: z.string().trim().max(2000).nullable() })
  .partial()
  .strict();
export type ProposalPatch = z.infer<typeof ProposalPatch>;

export const Proposal = z.object({
  id: z.uuid(),
  dealId: z.uuid(),
  accountId: z.uuid(),
  version: z.number().int(),
  status: ProposalStatus,
  package: Package,
  pricing: PriceBreakdownSchema,
  manualDiscount: z.number(),
  needsApproval: z.boolean(),
  discountApprovedBy: z.string().nullable(),
  coverNote: z.string().nullable(),
  pdfReady: z.boolean(),
  /** The PDF is being generated. */
  rendering: z.boolean(),
  renderError: z.string().nullable(),
  sentAt: timestamp.nullable(),
  expiresAt: timestamp.nullable(),
  viewCount: z.number().int(),
  lastViewedAt: timestamp.nullable(),
  createdAt: timestamp,
  /** Lines of the package as they appear in the PDF. */
  lines: z.array(z.string()),
});
export type Proposal = z.infer<typeof Proposal>;
export const ProposalList = z.object({ items: z.array(Proposal) });

export const SendProposalResponse = z.object({ draftId: z.uuid(), expiresAt: timestamp });

// ───────── contracts ─────────
export const ContractStatus = z.enum(["draft", "sent", "viewed", "signed", "declined", "voided"]);
export type ContractStatus = z.infer<typeof ContractStatus>;

export const CreateContractRequest = z.object({ signerContactId: z.uuid(), startDate: z.iso.date() }).strict();
export type CreateContractRequest = z.infer<typeof CreateContractRequest>;

export const Contract = z.object({
  id: z.uuid(),
  dealId: z.uuid(),
  proposalId: z.uuid(),
  status: ContractStatus,
  signer: z.object({ id: z.uuid(), name: z.string(), email: z.string().nullable() }).nullable(),
  viewCount: z.number().int(),
  sentAt: timestamp.nullable(),
  signedAt: timestamp.nullable(),
  /** A short-lived link to the signed PDF (when signed). */
  signedPdfUrl: z.string().nullable(),
});
export type Contract = z.infer<typeof Contract>;
export const ContractList = z.object({ items: z.array(Contract) });

/** Package lines, worded the same in the builder, the PDF and the agreement. */
export function packageLines(
  pkg: Package,
  addonLabels: Record<string, { label: string }>,
  coverageLabels: Record<string, string> = COVERAGE_LABELS,
): string[] {
  const posts = `${String(pkg.posts)} ${pkg.armed ? "armed" : "unarmed"} guard post${pkg.posts === 1 ? "" : "s"}, ${coverageLabels[pkg.coverage] ?? pkg.coverage}`;
  return [
    posts,
    ...(pkg.supervisor ? ["Site supervisor"] : []),
    ...pkg.addons.map((addon) => addonLabels[addon]?.label ?? addon),
    `${String(pkg.termMonths)}-month term`,
  ];
}

export const COVERAGE_LABELS: Record<string, string> = {
  "24_7": "24/7",
  nights: "nights (6 pm to 6 am)",
  business_hours: "business hours (Monday to Friday)",
};

/** Draft proposals may change; once sent, the numbers are frozen (§6: a config change never alters them). */
export const isEditableProposal = (status: ProposalStatus) => status === "draft";
