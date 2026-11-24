import { describe, expect, it } from "vitest";
import { fitScore, type FitInput } from "./fit";
import { SEED_PRICING } from "./pricing.test";

const NOW = new Date("2026-03-06T21:00:00Z"); // a Friday afternoon in Dallas

const base = (overrides: Partial<FitInput> = {}): FitInput => ({
  propertyType: "Retail", // default package is below $400k
  currentProvider: "National guard company",
  contractEndDate: null,
  signals: [],
  contacts: [],
  ...overrides,
});

const incident = (observedOn: string | null, confirmed = true) => ({
  kind: "incident",
  confirmed,
  observedOn,
  createdAt: new Date("2026-03-01T00:00:00Z"),
});

describe("fitScore", () => {
  it("scores 0 with no reasons when nothing applies", () => {
    expect(fitScore(base(), SEED_PRICING, NOW)).toEqual({ score: 0, reasons: [] });
  });

  it("+30 for a confirmed incident in the last 180 days only", () => {
    expect(fitScore(base({ signals: [incident("2025-09-08")] }), SEED_PRICING, NOW).score).toBe(30);
    expect(fitScore(base({ signals: [incident("2025-09-06")] }), SEED_PRICING, NOW).score).toBe(0);
    expect(fitScore(base({ signals: [incident("2026-02-01", false)] }), SEED_PRICING, NOW).score).toBe(0);
    expect(fitScore(base({ signals: [{ ...incident("2026-02-01"), kind: "timing" }] }), SEED_PRICING, NOW).score).toBe(
      0,
    );
    expect(fitScore(base({ signals: [incident(null)] }), SEED_PRICING, NOW).score).toBe(30);
  });

  it("+25 when the contract ends within 120 days (not after, not in the past)", () => {
    expect(fitScore(base({ contractEndDate: "2026-07-04" }), SEED_PRICING, NOW)).toEqual({
      score: 25,
      reasons: ["Contract ends in 120 days"],
    });
    expect(fitScore(base({ contractEndDate: "2026-07-05" }), SEED_PRICING, NOW).score).toBe(0);
    expect(fitScore(base({ contractEndDate: "2026-03-05" }), SEED_PRICING, NOW).score).toBe(0);
    expect(fitScore(base({ contractEndDate: "2026-03-06" }), SEED_PRICING, NOW).reasons).toEqual([
      "Contract ends today",
    ]);
  });

  it.each(["None", "In-house night watch", "Cameras only", "none"])(
    "+20 when the current provider is %s",
    (provider) => {
      expect(fitScore(base({ currentProvider: provider }), SEED_PRICING, NOW).score).toBe(20);
    },
  );

  it("ignores future-dated incidents, 'Cameras plus …' and unreachable primary contacts", () => {
    expect(fitScore(base({ signals: [incident("2026-04-01")] }), SEED_PRICING, NOW).score).toBe(0);
    expect(fitScore(base({ currentProvider: "Cameras + Allied guards" }), SEED_PRICING, NOW).score).toBe(0);
    expect(
      fitScore(
        base({ contacts: [{ isPrimary: true, email: "a@b.example", emailStatus: "bounced" }] }),
        SEED_PRICING,
        NOW,
      ).score,
    ).toBe(0);
  });

  it("does not add +20 for a professional provider or an unknown one", () => {
    expect(fitScore(base({ currentProvider: "Regional guard company" }), SEED_PRICING, NOW).score).toBe(0);
    expect(fitScore(base({ currentProvider: null }), SEED_PRICING, NOW).score).toBe(0);
  });

  it("+15 when the default package for the property type is worth at least $400,000 a year", () => {
    expect(fitScore(base({ propertyType: "Data center" }), SEED_PRICING, NOW)).toEqual({
      score: 15,
      reasons: ["Large contract value"],
    });
    expect(fitScore(base({ propertyType: "Data center" }), null, NOW).score).toBe(0);
  });

  it("+10 for a primary contact with an email", () => {
    expect(fitScore(base({ contacts: [{ isPrimary: true, email: "a@b.example" }] }), SEED_PRICING, NOW).score).toBe(10);
    expect(fitScore(base({ contacts: [{ isPrimary: false, email: "a@b.example" }] }), SEED_PRICING, NOW).score).toBe(0);
    expect(fitScore(base({ contacts: [{ isPrimary: true, email: null }] }), SEED_PRICING, NOW).score).toBe(0);
  });

  it("adds up to 100 with every reason", () => {
    const result = fitScore(
      base({
        propertyType: "Data center",
        currentProvider: "None",
        contractEndDate: "2026-04-01",
        signals: [incident("2026-02-20")],
        contacts: [{ isPrimary: true, email: "a@b.example" }],
      }),
      SEED_PRICING,
      NOW,
    );
    expect(result.score).toBe(100);
    expect(result.reasons).toHaveLength(5);
  });
});
