import type { Executor } from "@soa/db";
import {
  fitScore,
  Package,
  pricingConfigFromRow,
  type Activity,
  type Contact,
  type Deal,
  type PricingConfig,
  type Signal,
  type Task,
} from "@soa/shared";
import { accountsRepo } from "../repos/accounts";
import type { ActivityRow, ContactRow, SignalRow, TaskRow } from "../repos/children";
import { pricingRepo } from "../repos/children";
import type { DealRow } from "../repos/deals";
import type { Scope } from "../repos/scope";

/* Row → API shape. Nothing here decides access; repos already did. */

const iso = (date: Date) => date.toISOString();

export function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    accountId: row.accountId,
    firstName: row.firstName,
    lastName: row.lastName,
    title: row.title,
    email: row.email,
    phone: row.phone,
    phoneType: row.phoneType,
    linkedinUrl: row.linkedinUrl,
    contactPref: row.contactPref,
    isPrimary: row.isPrimary,
    emailStatus: row.emailStatus,
    doNotCall: row.doNotCall,
  };
}

export function toSignal(row: SignalRow): Signal {
  return {
    id: row.id,
    accountId: row.accountId,
    text: row.text,
    kind: row.kind as Signal["kind"],
    sourceId: row.sourceId,
    observedOn: row.observedOn,
    confirmed: row.confirmed,
    byAi: row.createdBy === null,
    createdAt: iso(row.createdAt),
  };
}

export function toDeal(row: { deal: DealRow; accountName: string; ownerName: string }): Deal {
  const { deal } = row;
  const parsed = Package.safeParse(deal.package);
  return {
    id: deal.id,
    accountId: deal.accountId,
    accountName: row.accountName,
    owner: { id: deal.ownerUserId, name: row.ownerName },
    name: deal.name,
    stage: deal.stage,
    status: deal.status,
    stageChangedAt: iso(deal.stageChangedAt),
    package: parsed.success ? parsed.data : null,
    annualValueCents: deal.annualValueCents,
    expectedClose: deal.expectedClose,
    lostReason: deal.lostReason,
    lastActivityAt: iso(deal.lastActivityAt),
    createdAt: iso(deal.createdAt),
  };
}

export function toActivity(row: { activity: ActivityRow; userName: string | null }): Activity {
  const { activity } = row;
  return {
    id: activity.id,
    type: activity.type,
    subject: activity.subject,
    body: activity.body,
    user: activity.userId === null ? null : { id: activity.userId, name: row.userName ?? "Former user" },
    occurredAt: iso(activity.occurredAt),
    meta: activity.meta,
  };
}

export function toTask(row: { task: TaskRow; accountName: string | null }): Task {
  const { task } = row;
  return {
    id: task.id,
    accountId: task.accountId,
    accountName: row.accountName,
    dealId: task.dealId,
    title: task.title,
    dueAt: task.dueAt === null ? null : iso(task.dueAt),
    doneAt: task.doneAt === null ? null : iso(task.doneAt),
    createdAt: iso(task.createdAt),
  };
}

/** YYYY-MM-DD in UTC. */
export const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export async function livePricing(db: Executor, scope: Scope, now: Date): Promise<PricingConfig | null> {
  const row = await pricingRepo(db).live(scope, isoDay(now));
  return row === undefined ? null : pricingConfigFromRow(row);
}

/** Recomputes and stores an account's fit score (§7.3) after its inputs change. */
export async function recomputeFit(
  db: Executor,
  scope: Scope,
  accountId: string,
  now: Date,
  pricing?: PricingConfig | null,
) {
  const repo = accountsRepo(db);
  const inputs = await repo.fitInputs(scope, accountId);
  if (inputs === undefined) return;
  const config = pricing === undefined ? await livePricing(db, scope, now) : pricing;
  const result = fitScore(
    {
      propertyType: inputs.account.propertyType,
      currentProvider: inputs.account.currentProvider,
      contractEndDate: inputs.account.contractEndDate,
      signals: inputs.signals,
      contacts: inputs.contacts,
    },
    config,
    now,
  );
  await repo.setFit(scope, accountId, result.score, result.reasons);
}
