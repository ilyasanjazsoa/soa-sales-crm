import { describe, expect, it } from "vitest";
import { priceBreakdown, type Package, type PricingConfig } from "./pricing";

export const SEED_PRICING: PricingConfig = {
  id: "config-1",
  hourlyRateCents: { unarmed: 2900, armed: 3800 },
  coverageHoursPerWeek: { "24_7": 168, nights: 84, business_hours: 60 },
  supervisorMultiplier: 1.05,
  addons: {
    patrol: { label: "Mobile patrol, 3 visits a night", monthlyCents: 145000 },
    video: { label: "Remote video monitoring", monthlyCents: 220000 },
    portal: { label: "Client portal with live officer map", monthlyCents: 0 },
  },
  termDiscounts: { "12": 0, "24": 0.03, "36": 0.05 },
  maxManualDiscount: 0.1,
};

const pkg = (overrides: Partial<Package> = {}): Package => ({
  posts: 2,
  armed: false,
  coverage: "24_7",
  supervisor: false,
  addons: ["video"],
  termMonths: 36,
  ...overrides,
});

describe("priceBreakdown", () => {
  it("matches the reference case in ARCHITECTURE.md §6 exactly", () => {
    expect(priceBreakdown(pkg(), SEED_PRICING)).toEqual({
      pricingConfigId: "config-1",
      hoursPerWeek: 336,
      hourlyRateCents: 2900,
      addonsMonthlyCents: 220000,
      termDiscount: 0.05,
      manualDiscount: 0,
      annualCents: 50_643_360,
      monthlyCents: 4_220_280,
    });
  });

  it("applies the supervisor multiplier to the hourly rate, rounded to the cent", () => {
    expect(priceBreakdown(pkg({ supervisor: true }), SEED_PRICING).hourlyRateCents).toBe(3045);
    expect(priceBreakdown(pkg({ supervisor: true, armed: true }), SEED_PRICING).hourlyRateCents).toBe(3990);
  });

  it("prices nights, business hours, armed posts and several add-ons", () => {
    const result = priceBreakdown(
      pkg({ posts: 1, armed: true, coverage: "nights", addons: ["patrol", "portal"], termMonths: 12 }),
      SEED_PRICING,
    );
    expect(result.hoursPerWeek).toBe(84);
    expect(result.annualCents).toBe(84 * 3800 * 52 + 145000 * 12);
    expect(
      priceBreakdown(pkg({ posts: 1, coverage: "business_hours", addons: [], termMonths: 24 }), SEED_PRICING)
        .annualCents,
    ).toBe(Math.round(60 * 2900 * 52 * 0.97));
  });

  it("prices add-ons only when there are no posts", () => {
    const result = priceBreakdown(pkg({ posts: 0, addons: ["patrol", "video"], termMonths: 12 }), SEED_PRICING);
    expect(result.annualCents).toBe((145000 + 220000) * 12);
    expect(result.monthlyCents).toBe(145000 + 220000);
  });

  it("applies a manual discount after the term discount", () => {
    expect(priceBreakdown(pkg(), SEED_PRICING, 0.1).annualCents).toBe(Math.round(50_643_360 * 0.9));
  });

  it("returns integer cents", () => {
    for (const termMonths of [12, 24, 36] as const) {
      for (const supervisor of [false, true]) {
        const result = priceBreakdown(pkg({ termMonths, supervisor, posts: 3 }), SEED_PRICING, 0.07);
        expect(Number.isInteger(result.annualCents)).toBe(true);
        expect(Number.isInteger(result.monthlyCents)).toBe(true);
      }
    }
  });

  it("rejects a manual discount outside [0, 1)", () => {
    expect(() => priceBreakdown(pkg(), SEED_PRICING, 1)).toThrow(RangeError);
    expect(() => priceBreakdown(pkg(), SEED_PRICING, -0.1)).toThrow(RangeError);
  });
});
