import { priceBreakdown, type PricingConfig } from "./pricing";
import { defaultPackageFor } from "./properties";

/* Fit score (ARCHITECTURE.md §7.3). Rules, not AI. Pure; takes "now" as a parameter. */

export interface FitInput {
  propertyType: string;
  currentProvider: string | null;
  /** "YYYY-MM-DD" */
  contractEndDate: string | null;
  signals: readonly { kind: string; confirmed: boolean; observedOn: string | null; createdAt: Date }[];
  contacts: readonly { isPrimary: boolean; email: string | null }[];
}

export interface FitResult {
  score: number;
  reasons: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const LARGE_CONTRACT_CENTS = 40_000_000; // $400,000 a year

/** Days from `now` to the start of a calendar date (UTC). */
const daysUntil = (date: string, now: Date) => {
  const target = Date.parse(`${date}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / DAY_MS);
};

export function fitScore(input: FitInput, pricing: PricingConfig | null, now: Date): FitResult {
  let score = 0;
  const reasons: string[] = [];

  const recentIncident = input.signals.some((signal) => {
    if (signal.kind !== "incident" || !signal.confirmed) return false;
    const seen = signal.observedOn === null ? signal.createdAt.getTime() : Date.parse(`${signal.observedOn}T00:00:00Z`);
    return now.getTime() - seen <= 180 * DAY_MS;
  });
  if (recentIncident) {
    score += 30;
    reasons.push("Confirmed security incident in the last 180 days");
  }

  if (input.contractEndDate !== null) {
    const days = daysUntil(input.contractEndDate, now);
    if (days >= 0 && days <= 120) {
      score += 25;
      reasons.push(days === 0 ? "Contract ends today" : `Contract ends in ${String(days)} days`);
    }
  }

  if (/^\s*(none|in-house|in house|cameras)/i.test(input.currentProvider ?? "")) {
    score += 20;
    reasons.push("No professional guard service today");
  }

  if (
    pricing !== null &&
    priceBreakdown(defaultPackageFor(input.propertyType), pricing).annualCents >= LARGE_CONTRACT_CENTS
  ) {
    score += 15;
    reasons.push("Large contract value");
  }

  if (input.contacts.some((contact) => contact.isPrimary && contact.email !== null && contact.email !== "")) {
    score += 10;
    reasons.push("Decision maker with email");
  }

  return { score, reasons };
}
