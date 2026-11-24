import type { Database } from "@soa/db";
import {
  checkManualMove,
  DEAL_STAGES,
  defaultPackageFor,
  priceBreakdown,
  STAGE_LABELS,
  STAGE_PROBABILITY_BP,
  stageIndex,
  weightedForecastCents,
  type Deal,
  type DealPage,
  type DealPatch,
  type DealStage,
  type ForecastResponse,
  type LostReason,
  type Package,
} from "@soa/shared";
import type { Clock } from "../clock";
import { conflict, forbidden, notFound, unprocessable } from "../errors";
import { accountsRepo } from "../repos/accounts";
import { auditRepo } from "../repos/audit";
import { activitiesRepo } from "../repos/children";
import { dealsRepo } from "../repos/deals";
import type { UserScope } from "../repos/scope";
import { livePricing, toDeal } from "./mappers";

/* Deals and the pipeline (ARCHITECTURE.md §5). Prices are always computed here (CLAUDE.md rule 6). */

const decodeOffset = (cursor: string | undefined) => {
  const value = cursor === undefined ? 0 : Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isInteger(value) && value >= 0 ? value : 0;
};

export function createDealsService({ db, clock }: { db: Database; clock: Clock }) {
  const valueOf = async (scope: UserScope, pkg: Package): Promise<number> => {
    const pricing = await livePricing(db, scope, clock());
    return pricing === null ? 0 : priceBreakdown(pkg, pricing).annualCents;
  };

  const editableOrError = async (scope: UserScope, id: string) => {
    const repo = dealsRepo(db);
    const deal = await repo.getEditable(scope, id);
    if (deal !== undefined) return deal;
    if ((await repo.get(scope, id)) !== undefined) throw forbidden("Only the deal's owner or a manager can change it.");
    throw notFound();
  };

  const service = {
    async list(
      scope: UserScope,
      query: {
        stage?: DealStage | undefined;
        status?: "open" | "won" | "lost" | undefined;
        owner?: string | undefined;
        cursor?: string | undefined;
        limit: number;
      },
    ): Promise<DealPage> {
      const offset = decodeOffset(query.cursor);
      const rows = await dealsRepo(db).list(scope, { ...query, offset, limit: query.limit });
      return {
        items: rows.slice(0, query.limit).map(toDeal),
        nextCursor: rows.length > query.limit ? Buffer.from(String(offset + query.limit)).toString("base64url") : null,
      };
    },

    async get(scope: UserScope, id: string): Promise<Deal> {
      const row = await dealsRepo(db).get(scope, id);
      if (row === undefined) throw notFound();
      return toDeal(row);
    },

    /** Σ value × stage probability over open deals; AEs see their own deals unless they ask otherwise. */
    async forecast(scope: UserScope, owner: string | undefined): Promise<ForecastResponse> {
      const effectiveOwner = owner ?? (scope.role === "ae" ? "me" : "all");
      const rows = await dealsRepo(db).forForecast(scope, effectiveOwner);
      const open = rows.filter((row) => row.status === "open");
      return {
        stages: DEAL_STAGES.map((stage) => {
          const inStage = rows.filter((row) => row.stage === stage && row.status !== "lost");
          const value = inStage.reduce((sum, row) => sum + row.annualValueCents, 0);
          return {
            stage,
            probabilityBp: STAGE_PROBABILITY_BP[stage],
            count: inStage.length,
            valueCents: value,
            weightedCents: weightedForecastCents(inStage.filter((row) => row.status === "open")),
          };
        }),
        openCount: open.length,
        openValueCents: open.reduce((sum, row) => sum + row.annualValueCents, 0),
        weightedCents: weightedForecastCents(rows),
        wonValueCents: rows.filter((row) => row.status === "won").reduce((sum, row) => sum + row.annualValueCents, 0),
      };
    },

    async create(
      scope: UserScope,
      accountId: string,
      body: { name?: string | undefined; package?: Package | undefined; expectedClose?: string | null | undefined },
      ip: string | null,
    ): Promise<Deal> {
      const id = await db.transaction(async (tx) => {
        const accounts = accountsRepo(tx);
        const account = await accounts.getEditable(scope, accountId);
        if (account === undefined) {
          if ((await accounts.get(scope, accountId)) !== undefined)
            throw forbidden("Claim this account before creating a deal.");
          throw notFound();
        }
        const pkg = body.package ?? defaultPackageFor(account.propertyType);
        const pricing = await livePricing(tx, scope, clock());
        const deal = await dealsRepo(tx).insert(scope, {
          accountId,
          ownerUserId: account.ownerUserId ?? scope.userId,
          name: body.name ?? `${account.name} security`,
          package: pkg,
          annualValueCents: pricing === null ? 0 : priceBreakdown(pkg, pricing).annualCents,
          expectedClose: body.expectedClose ?? null,
        });
        if (deal === undefined) throw conflict("open_deal_exists", "This account already has an open deal.");
        await dealsRepo(tx).recordStage(scope, deal.id, null, "lead");
        await activitiesRepo(tx).insert(scope, {
          accountId,
          dealId: deal.id,
          type: "stage_change",
          subject: "Deal created",
          meta: { from: null, to: "lead" },
        });
        await auditRepo(tx).write(scope, { action: "deal.create", entityType: "deal", entityId: deal.id, ip });
        return deal.id;
      });
      return service.get(scope, id);
    },

    async update(scope: UserScope, id: string, patch: DealPatch): Promise<Deal> {
      await editableOrError(scope, id);
      const values: Record<string, unknown> = {};
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.expectedClose !== undefined) values.expectedClose = patch.expectedClose;
      if (patch.package !== undefined) {
        values.package = patch.package;
        values.annualValueCents = await valueOf(scope, patch.package);
      }
      await dealsRepo(db).update(scope, id, values);
      return service.get(scope, id);
    },

    /** Manual stage move (§5): AEs up to proposal; contract_sent and won are the system's (a manager can override). */
    async moveStage(scope: UserScope, id: string, to: DealStage, ip: string | null): Promise<Deal> {
      await db.transaction(async (tx) => {
        const repo = dealsRepo(tx);
        const deal = await repo.getEditable(scope, id);
        if (deal === undefined) {
          if ((await repo.get(scope, id)) !== undefined)
            throw forbidden("Only the deal's owner or a manager can change it.");
          throw notFound();
        }
        const check = checkManualMove({ role: scope.role, status: deal.status, from: deal.stage, to });
        if (!check.ok) throw unprocessable(check.code, check.message);
        const now = clock();
        await repo.update(scope, id, {
          stage: to,
          status: to === "won" ? "won" : "open",
          stageChangedAt: now,
          lastActivityAt: now,
        });
        await repo.recordStage(scope, id, deal.stage, to);
        const override = stageIndex(to) > stageIndex("proposal");
        await activitiesRepo(tx).insert(scope, {
          accountId: deal.accountId,
          dealId: id,
          type: "stage_change",
          subject: `Stage moved from ${STAGE_LABELS[deal.stage]} to ${STAGE_LABELS[to]}`,
          meta: { from: deal.stage, to, manual: true, ...(override ? { managerOverride: true } : {}) },
        });
        await auditRepo(tx).write(scope, {
          action: "deal.stage",
          entityType: "deal",
          entityId: id,
          meta: { from: deal.stage, to, manual: true, ...(override ? { managerOverride: true } : {}) },
          ip,
        });
      });
      return service.get(scope, id);
    },

    async lose(
      scope: UserScope,
      id: string,
      reason: LostReason,
      note: string | undefined,
      ip: string | null,
    ): Promise<Deal> {
      await db.transaction(async (tx) => {
        const repo = dealsRepo(tx);
        const deal = await repo.getEditable(scope, id);
        if (deal === undefined) {
          if ((await repo.get(scope, id)) !== undefined)
            throw forbidden("Only the deal's owner or a manager can change it.");
          throw notFound();
        }
        if (deal.status !== "open") throw unprocessable("not_open", "Only open deals can be marked lost.");
        const lostReason = note === undefined || note === "" ? reason : `${reason}: ${note}`;
        await repo.update(scope, id, { status: "lost", lostReason, lastActivityAt: clock() });
        await repo.recordStage(scope, id, deal.stage, deal.stage);
        await activitiesRepo(tx).insert(scope, {
          accountId: deal.accountId,
          dealId: id,
          type: "stage_change",
          subject: `Deal marked lost: ${reason}`,
          body: note ?? null,
          meta: { status: "lost", reason },
        });
        await auditRepo(tx).write(scope, {
          action: "deal.lost",
          entityType: "deal",
          entityId: id,
          meta: { reason },
          ip,
        });
      });
      return service.get(scope, id);
    },

    /** Managers: reopen a lost deal at the stage it was lost from. */
    async reopen(scope: UserScope, id: string, ip: string | null): Promise<Deal> {
      await db.transaction(async (tx) => {
        const repo = dealsRepo(tx);
        const deal = await repo.getEditable(scope, id);
        if (deal === undefined) throw notFound();
        if (deal.status !== "lost") throw unprocessable("not_lost", "Only lost deals can be reopened.");
        const current = await repo.currentForAccount(scope, deal.accountId);
        if (current?.deal.status === "open") {
          throw conflict("open_deal_exists", "This account already has an open deal.");
        }
        await repo.update(scope, id, { status: "open", lostReason: null, lastActivityAt: clock() });
        await repo.recordStage(scope, id, deal.stage, deal.stage);
        await activitiesRepo(tx).insert(scope, {
          accountId: deal.accountId,
          dealId: id,
          type: "stage_change",
          subject: "Deal reopened",
          meta: { status: "open" },
        });
        await auditRepo(tx).write(scope, { action: "deal.reopen", entityType: "deal", entityId: id, ip });
      });
      return service.get(scope, id);
    },
  };
  return service;
}

export type DealsService = ReturnType<typeof createDealsService>;
