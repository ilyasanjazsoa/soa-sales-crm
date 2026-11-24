import type { Executor } from "@soa/db";
import { automaticAdvance, STAGE_LABELS, type DealStage } from "@soa/shared";
import { auditRepo } from "../repos/audit";
import { activitiesRepo } from "../repos/children";
import { dealsRepo } from "../repos/deals";
import type { Scope } from "../repos/scope";

/** Moves the account's current deal forward to `to` (never back, only an open deal the scope may change), with its
    history, activity and audit rows in the caller's transaction (§5). Returns whether it moved. */
export async function advanceDeal(
  tx: Executor,
  scope: Scope,
  accountId: string,
  to: DealStage,
  trigger: string,
  now: Date,
): Promise<boolean> {
  const deal = await dealsRepo(tx).currentForAccount(scope, accountId);
  const next = deal === undefined ? null : automaticAdvance(deal.deal, to);
  if (deal === undefined || next === null) return false;
  const moved = await dealsRepo(tx).update(scope, deal.deal.id, {
    stage: next,
    // A won stage is a won deal (deals_check).
    ...(next === "won" ? { status: "won" as const } : {}),
    stageChangedAt: now,
    lastActivityAt: now,
  });
  if (moved === undefined) return false;
  await dealsRepo(tx).recordStage(scope, deal.deal.id, deal.deal.stage, next);
  await activitiesRepo(tx).insert(scope, {
    accountId,
    dealId: deal.deal.id,
    type: "stage_change",
    subject: `Stage moved from ${STAGE_LABELS[deal.deal.stage]} to ${STAGE_LABELS[next]}`,
    meta: { from: deal.deal.stage, to: next, automatic: true, trigger },
  });
  await auditRepo(tx).write(scope, {
    action: "deal.stage",
    entityType: "deal",
    entityId: deal.deal.id,
    meta: { from: deal.deal.stage, to: next, automatic: true },
  });
  return true;
}
