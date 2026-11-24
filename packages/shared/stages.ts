import type { Role } from "./api";

/* Deal stages and their rules (ARCHITECTURE.md §5). Pure. */

export const DEAL_STAGES = [
  "lead",
  "researched",
  "contacted",
  "meeting_set",
  "proposal",
  "contract_sent",
  "won",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
export type DealStatus = "open" | "won" | "lost";

export const STAGE_LABELS: Record<DealStage, string> = {
  lead: "Lead",
  researched: "Researched",
  contacted: "Contacted",
  meeting_set: "Meeting set",
  proposal: "Proposal",
  contract_sent: "Contract sent",
  won: "Won",
};

/** Win probability in basis points, so forecasts stay in integer arithmetic. */
export const STAGE_PROBABILITY_BP: Record<DealStage, number> = {
  lead: 500,
  researched: 1000,
  contacted: 2000,
  meeting_set: 3500,
  proposal: 5500,
  contract_sent: 8000,
  won: 10000,
};

export const stageIndex = (stage: DealStage): number => DEAL_STAGES.indexOf(stage);

/** The furthest stage a rep can choose by hand. Later stages are set by the system (or a manager, audited). */
export const MAX_MANUAL_STAGE_FOR_AE: DealStage = "proposal";

export type StageMoveCheck =
  { ok: true } | { ok: false; code: "not_open" | "same_stage" | "system_stage" | "manager_only"; message: string };

/** Whether a person may move an open deal to `to` by hand. */
export function checkManualMove(input: {
  role: Role;
  status: DealStatus;
  from: DealStage;
  to: DealStage;
}): StageMoveCheck {
  if (input.status !== "open") return { ok: false, code: "not_open", message: "Only open deals can change stage." };
  if (input.from === input.to) return { ok: false, code: "same_stage", message: "The deal is already at that stage." };
  if (stageIndex(input.to) > stageIndex(MAX_MANUAL_STAGE_FOR_AE) && input.role === "ae") {
    return {
      ok: false,
      code: "system_stage",
      message: `${STAGE_LABELS[input.to]} is set automatically when the contract is ${input.to === "won" ? "signed" : "sent"}. A manager can override.`,
    };
  }
  return { ok: true };
}

/** Automatic moves only go forward, one trigger at a time: `to` applies only if it is ahead of the current stage. */
export function automaticAdvance(current: { status: DealStatus; stage: DealStage }, to: DealStage): DealStage | null {
  if (current.status !== "open") return null;
  return stageIndex(to) > stageIndex(current.stage) ? to : null;
}

/** Σ annual value × stage probability over open deals, in integer cents (rounded once, at the end). */
export function weightedForecastCents(
  deals: readonly { status: DealStatus; stage: DealStage; annualValueCents: number }[],
): number {
  let basisPointCents = 0;
  for (const deal of deals) {
    if (deal.status !== "open") continue;
    basisPointCents += deal.annualValueCents * STAGE_PROBABILITY_BP[deal.stage];
  }
  return Math.round(basisPointCents / 10_000);
}
