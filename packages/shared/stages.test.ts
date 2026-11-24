import { describe, expect, it } from "vitest";
import { automaticAdvance, checkManualMove, DEAL_STAGES, weightedForecastCents, type DealStage } from "./stages";

describe("checkManualMove", () => {
  it("lets an AE move an open deal to any stage up to proposal, forwards or back", () => {
    for (const from of DEAL_STAGES.slice(0, 5)) {
      for (const to of DEAL_STAGES.slice(0, 5)) {
        if (from === to) continue;
        expect(checkManualMove({ role: "ae", status: "open", from, to })).toEqual({ ok: true });
      }
    }
  });

  it.each<DealStage>(["contract_sent", "won"])("refuses an AE moving to %s (set by the system)", (to) => {
    expect(checkManualMove({ role: "ae", status: "open", from: "proposal", to })).toMatchObject({
      ok: false,
      code: "system_stage",
    });
  });

  it.each(["manager", "admin"] as const)("lets a %s override to contract_sent and won", (role) => {
    expect(checkManualMove({ role, status: "open", from: "proposal", to: "won" })).toEqual({ ok: true });
    expect(checkManualMove({ role, status: "open", from: "lead", to: "contract_sent" })).toEqual({ ok: true });
  });

  it("refuses closed deals and no-op moves", () => {
    expect(checkManualMove({ role: "manager", status: "lost", from: "lead", to: "contacted" })).toMatchObject({
      code: "not_open",
    });
    expect(checkManualMove({ role: "ae", status: "won", from: "won", to: "lead" })).toMatchObject({ code: "not_open" });
    expect(checkManualMove({ role: "ae", status: "open", from: "lead", to: "lead" })).toMatchObject({
      code: "same_stage",
    });
  });
});

describe("automaticAdvance", () => {
  it("only moves forward", () => {
    expect(automaticAdvance({ status: "open", stage: "lead" }, "researched")).toBe("researched");
    expect(automaticAdvance({ status: "open", stage: "contacted" }, "researched")).toBeNull();
    expect(automaticAdvance({ status: "open", stage: "contacted" }, "contacted")).toBeNull();
    expect(automaticAdvance({ status: "lost", stage: "lead" }, "researched")).toBeNull();
  });
});

describe("weightedForecastCents", () => {
  it("is Σ value × probability over open deals, in integer cents", () => {
    expect(
      weightedForecastCents([
        { status: "open", stage: "lead", annualValueCents: 1_000_000 }, // 50_000
        { status: "open", stage: "proposal", annualValueCents: 2_000_001 }, // 1_100_000.55
        { status: "won", stage: "won", annualValueCents: 9_999_999 }, // excluded
        { status: "lost", stage: "contacted", annualValueCents: 5_000_000 }, // excluded
      ]),
    ).toBe(1_150_001);
    expect(weightedForecastCents([])).toBe(0);
  });
});
