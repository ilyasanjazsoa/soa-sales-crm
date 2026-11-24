import { z } from "zod";

/* Pricing engine (ARCHITECTURE.md §6). Pure. All money is integer cents. The server is the only caller whose
   result is ever stored; a price sent by a browser is ignored (CLAUDE.md rule 6). */

export const Coverage = z.enum(["24_7", "nights", "business_hours"]);
export type Coverage = z.infer<typeof Coverage>;

export const Addon = z.enum(["patrol", "video", "portal"]);
export type Addon = z.infer<typeof Addon>;

export const Package = z.object({
  posts: z.number().int().min(0).max(20),
  armed: z.boolean(),
  coverage: Coverage,
  supervisor: z.boolean(),
  addons: z
    .array(Addon)
    .max(3)
    .refine((list) => new Set(list).size === list.length, "Each add-on once"),
  termMonths: z.union([z.literal(12), z.literal(24), z.literal(36)]),
});
export type Package = z.infer<typeof Package>;

export interface PricingConfig {
  id: string;
  hourlyRateCents: { unarmed: number; armed: number };
  coverageHoursPerWeek: Record<Coverage, number>;
  /** e.g. 1.05 */
  supervisorMultiplier: number;
  addons: Record<Addon, { label: string; monthlyCents: number }>;
  /** keyed by "12" | "24" | "36", e.g. 0.03 */
  termDiscounts: Record<string, number>;
  maxManualDiscount: number;
}

export interface PriceBreakdown {
  pricingConfigId: string;
  hoursPerWeek: number;
  hourlyRateCents: number;
  addonsMonthlyCents: number;
  termDiscount: number;
  manualDiscount: number;
  annualCents: number;
  monthlyCents: number;
}

/** A decimal rate (at most 4 places) in basis points. */
const bp = (rate: number) => BigInt(Math.round(rate * 10_000));

/** value × rate, rounded half up to a whole number, in exact integer arithmetic. */
const timesRounded = (value: number, rate: number) => Number((BigInt(value) * bp(rate) + 5_000n) / 10_000n);

export function priceBreakdown(pkg: Package, config: PricingConfig, manualDiscount = 0): PriceBreakdown {
  if (manualDiscount < 0 || manualDiscount >= 1) throw new RangeError("manualDiscount must be in [0, 1)");
  const hoursPerWeek = pkg.posts * config.coverageHoursPerWeek[pkg.coverage];
  const baseRate = config.hourlyRateCents[pkg.armed ? "armed" : "unarmed"];
  const hourlyRateCents = pkg.supervisor ? timesRounded(baseRate, config.supervisorMultiplier) : baseRate;
  const addonsMonthlyCents = pkg.addons.reduce((sum, addon) => sum + config.addons[addon].monthlyCents, 0);
  const termDiscount = config.termDiscounts[String(pkg.termMonths)] ?? 0;
  const gross = hoursPerWeek * hourlyRateCents * 52 + addonsMonthlyCents * 12;
  // gross × (1 − term) × (1 − manual), rounded once, half up, with no floating-point intermediate.
  const annualCents = Number(
    (BigInt(gross) * (10_000n - bp(termDiscount)) * (10_000n - bp(manualDiscount)) + 50_000_000n) / 100_000_000n,
  );
  return {
    pricingConfigId: config.id,
    hoursPerWeek,
    hourlyRateCents,
    addonsMonthlyCents,
    termDiscount,
    manualDiscount,
    annualCents,
    monthlyCents: Number((BigInt(annualCents) * 2n + 12n) / 24n), // annual / 12, rounded half up
  };
}

/** Turns a pricing_configs row (numerics come back from Postgres as strings) into a PricingConfig. */
export function pricingConfigFromRow(row: {
  id: string;
  hourlyRateCents: { unarmed: number; armed: number };
  coverageHoursPerWeek: Record<Coverage, number>;
  supervisorMultiplier: string;
  addons: Record<string, { label: string; monthlyCents: number }>;
  termDiscounts: Record<string, number>;
  maxManualDiscount: string;
}): PricingConfig {
  return {
    id: row.id,
    hourlyRateCents: row.hourlyRateCents,
    coverageHoursPerWeek: row.coverageHoursPerWeek,
    supervisorMultiplier: Number(row.supervisorMultiplier),
    addons: row.addons,
    termDiscounts: row.termDiscounts,
    maxManualDiscount: Number(row.maxManualDiscount),
  };
}
