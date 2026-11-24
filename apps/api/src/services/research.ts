import type { Database } from "@soa/db";
import {
  automaticAdvance,
  BriefSection,
  BRIEF_SECTIONS,
  briefProblems,
  defaultPackageFor,
  groundedSignals,
  Package,
  priceSentence,
  ResearchBriefOutput,
  SignalExtractOutput,
  STAGE_LABELS,
  withoutDollarAmounts,
  type BriefResponse,
  type ClientReference,
  type ClientReferenceInput,
  type ClientReferencePatch,
  type ResearchSource,
} from "@soa/shared";
import { z } from "zod";
import type { Clock } from "../clock";
import { forbidden, notFound, unprocessable } from "../errors";
import { JOBS, type JobQueue } from "../jobs/queue";
import type { AiClient } from "../providers/ai/client";
import { researchBriefPrompt, signalExtractPrompt, type PromptSource } from "../providers/ai/prompts";
import { FetchRefused, type WebFetcher } from "../providers/web";
import { accountsRepo } from "../repos/accounts";
import { auditRepo } from "../repos/audit";
import { activitiesRepo, contactsRepo, signalsRepo, sourcesRepo } from "../repos/children";
import { dealsRepo } from "../repos/deals";
import { referencesRepo, researchRepo, type ReferenceRow, type SourceRow } from "../repos/research";
import { systemScope, userScope, type UserScope } from "../repos/scope";
import { usersRepo } from "../repos/users";
import { contentHash } from "./accounts";
import { isoDay, livePricing, recomputeFit } from "./mappers";

/* Research: sources, signals from websites, and the research brief (ARCHITECTURE.md §7.3, §14). */

export interface ResearchJob {
  accountId: string;
  userId: string;
}

const toSource = (row: { source: SourceRow; addedByName: string | null }): ResearchSource => ({
  id: row.source.id,
  kind: row.source.kind,
  url: row.source.url,
  title: row.source.title,
  contentText: row.source.contentText,
  fetchedAt: row.source.fetchedAt.toISOString(),
  addedBy: row.source.addedBy === null ? null : { id: row.source.addedBy, name: row.addedByName ?? "Former user" },
});

const toReference = (row: ReferenceRow): ClientReference => ({
  id: row.id,
  labelNamed: row.labelNamed,
  labelAnonymized: row.labelAnonymized,
  propertyTypes: row.propertyTypes,
  stats: row.stats,
  namedPermission: row.namedPermission,
  active: row.active,
  updatedAt: row.updatedAt.toISOString(),
});

export function createResearchService(deps: { db: Database; queue: JobQueue; ai: AiClient }) {
  const { db, queue, ai } = deps;

  const requireEditable = async (scope: UserScope, accountId: string) => {
    const repo = accountsRepo(db);
    const account = await repo.getEditable(scope, accountId);
    if (account !== undefined) return account;
    if ((await repo.get(scope, accountId)) !== undefined) throw forbidden("Claim this account before researching it.");
    throw notFound();
  };

  return {
    async sources(scope: UserScope, accountId: string): Promise<ResearchSource[]> {
      if ((await accountsRepo(db).get(scope, accountId)) === undefined) throw notFound();
      return (await researchRepo(db).sources(scope, accountId)).map(toSource);
    },

    /** A rep's note or pasted text, stored as a source the AI may cite. */
    async addSource(scope: UserScope, accountId: string, input: { text: string; title?: string | undefined }) {
      await requireEditable(scope, accountId);
      return db.transaction(async (tx) => {
        const source = await sourcesRepo(tx).insert(scope, {
          accountId,
          kind: "rep_note",
          title: input.title ?? "Note",
          contentText: input.text,
          contentHash: contentHash(input.text),
          addedBy: scope.userId,
        });
        await activitiesRepo(tx).insert(scope, {
          accountId,
          type: "note",
          subject: "Research note added",
          body: input.text,
        });
        return source;
      });
    },

    async requestFetch(scope: UserScope, accountId: string): Promise<void> {
      const account = await requireEditable(scope, accountId);
      if (account.website === null) throw unprocessable("no_website", "Add the account's website first.");
      await ai.assertWithinLimit(scope.userId);
      await activitiesRepo(db).insert(scope, {
        accountId,
        type: "note",
        subject: "Reading the website",
        meta: { job: JOBS.researchFetch, state: "requested" },
      });
      await queue.send(JOBS.researchFetch, { accountId, userId: scope.userId });
    },

    /** 422 when there is nothing to base a brief on (no sources and no signals). */
    async requestBrief(scope: UserScope, accountId: string): Promise<void> {
      await requireEditable(scope, accountId);
      const [sources, signals] = await Promise.all([
        researchRepo(db).sources(scope, accountId),
        signalsRepo(db).listForAccount(scope, accountId),
      ]);
      if (sources.length === 0 && signals.length === 0) {
        throw unprocessable(
          "no_sources",
          "Add at least one source or signal first. The AI isn't allowed to write a brief from nothing.",
        );
      }
      await ai.assertWithinLimit(scope.userId);
      await activitiesRepo(db).insert(scope, {
        accountId,
        type: "note",
        subject: "Research brief requested",
        meta: { job: JOBS.researchBrief, state: "requested" },
      });
      await queue.send(JOBS.researchBrief, { accountId, userId: scope.userId });
    },

    async brief(scope: UserScope, accountId: string, version?: number): Promise<BriefResponse> {
      if ((await accountsRepo(db).get(scope, accountId)) === undefined) throw notFound();
      const repo = researchRepo(db);
      const [row, versions, event] = await Promise.all([
        repo.brief(scope, accountId, version),
        repo.briefVersions(scope, accountId),
        repo.lastJobEvent(scope, accountId, JOBS.researchBrief),
      ]);
      if (version !== undefined && row === undefined) throw notFound();
      const latest = versions[0]?.createdAt.getTime() ?? 0;
      const eventIsNew = event !== undefined && event.occurredAt.getTime() > latest;
      const state = eventIsNew ? event.meta.state : undefined;
      const parsedPackage = row === undefined ? undefined : Package.safeParse(row.brief.recommendedPackage);
      return {
        brief:
          row === undefined || parsedPackage?.success !== true
            ? null
            : {
                id: row.brief.id,
                version: row.brief.version,
                sections: z.array(BriefSection).parse(row.brief.sections),
                recommendedPackage: parsedPackage.data,
                createdAt: row.brief.createdAt.toISOString(),
                createdBy: { id: row.brief.createdBy, name: row.createdByName },
              },
        versions: versions.map((entry) => ({ version: entry.version, createdAt: entry.createdAt.toISOString() })),
        pending: state === "requested",
        lastError:
          state === "failed"
            ? typeof event?.meta.message === "string"
              ? event.meta.message
              : "The brief could not be generated. Try again."
            : null,
      };
    },

    // ───────── client references (managers) ─────────
    async references(scope: UserScope): Promise<ClientReference[]> {
      return (await referencesRepo(db).list(scope)).map(toReference);
    },

    async createReference(scope: UserScope, input: ClientReferenceInput, ip: string | null): Promise<ClientReference> {
      return db.transaction(async (tx) => {
        const row = await referencesRepo(tx).insert(scope, input);
        await auditRepo(tx).write(scope, {
          action: "reference.create",
          entityType: "client_reference",
          entityId: row.id,
          meta: { namedPermission: row.namedPermission },
          ip,
        });
        return toReference(row);
      });
    },

    async updateReference(
      scope: UserScope,
      id: string,
      patch: ClientReferencePatch,
      ip: string | null,
    ): Promise<ClientReference> {
      return db.transaction(async (tx) => {
        const row = await referencesRepo(tx).update(scope, id, patch);
        if (row === undefined) throw notFound();
        await auditRepo(tx).write(scope, {
          action: "reference.update",
          entityType: "client_reference",
          entityId: id,
          meta: {
            fields: Object.keys(patch).sort(),
            ...(patch.namedPermission === undefined ? {} : { namedPermission: patch.namedPermission }),
          },
          ip,
        });
        return toReference(row);
      });
    },
  };
}

export type ResearchService = ReturnType<typeof createResearchService>;

// ───────── jobs (worker) ─────────

export interface ResearchJobDeps {
  db: Database;
  ai: AiClient;
  fetcher: WebFetcher;
  clock: Clock;
}

async function jobScope(db: Database, userId: string): Promise<UserScope | undefined> {
  const user = await usersRepo(db).findById(systemScope("research job"), userId);
  return user?.active === true ? userScope(user.id, user.role) : undefined;
}

async function jobFailed(db: Database, scope: UserScope, accountId: string, job: string, message: string) {
  await activitiesRepo(db).insert(scope, {
    accountId,
    type: "note",
    subject: message,
    meta: { job, state: "failed", message },
  });
}

/** research.fetch: read up to 8 pages of the account's website, store them as sources, extract signals. */
export async function runResearchFetch(deps: ResearchJobDeps, job: ResearchJob): Promise<void> {
  const { db, ai, fetcher, clock } = deps;
  const scope = await jobScope(db, job.userId);
  if (scope === undefined) return;
  const account = await accountsRepo(db).getEditable(scope, job.accountId);
  const website = account?.website ?? null;
  if (website === null) return;

  let pages;
  try {
    pages = await fetcher.fetchSite(website);
  } catch (error) {
    const message =
      error instanceof FetchRefused
        ? `The website was not read: ${error.message}`
        : "The website could not be reached.";
    await jobFailed(db, scope, job.accountId, JOBS.researchFetch, message);
    return;
  }

  const existing = new Set(
    (await signalsRepo(db).listForAccount(scope, job.accountId)).map((signal) => signal.text.toLowerCase()),
  );
  let found = 0;
  for (const page of pages) {
    const source = await sourcesRepo(db).insert(scope, {
      accountId: job.accountId,
      kind: "website",
      url: page.url,
      title: page.title ?? page.url,
      contentText: page.text,
      contentHash: contentHash(page.text),
      addedBy: scope.userId,
    });
    const promptSource: PromptSource = {
      id: source.id,
      kind: "website",
      title: page.title,
      url: page.url,
      text: page.text,
    };
    let output: SignalExtractOutput;
    try {
      output = (
        await ai.generate({
          feature: "signal_extract",
          tier: "fast",
          ...signalExtractPrompt(promptSource, isoDay(clock())),
          schema: SignalExtractOutput,
          userId: scope.userId,
        })
      ).data;
    } catch {
      continue; // the page is still stored as a source; signals can be added by hand
    }
    for (const signal of groundedSignals(output, page.text)) {
      if (existing.has(signal.text.toLowerCase())) continue;
      existing.add(signal.text.toLowerCase());
      // AI-extracted: unconfirmed until a rep confirms it (§7.2 rule 3); created_by NULL marks it as AI-found.
      await signalsRepo(db).insert(scope, {
        accountId: job.accountId,
        text: signal.text,
        kind: signal.kind,
        observedOn: signal.observedOn ?? null,
        sourceId: source.id,
        confirmed: false,
        createdBy: null,
      });
      found += 1;
    }
  }
  await db.transaction(async (tx) => {
    await recomputeFit(tx, scope, job.accountId, clock());
    await activitiesRepo(tx).insert(scope, {
      accountId: job.accountId,
      type: "note",
      subject: `Website read: ${String(pages.length)} page${pages.length === 1 ? "" : "s"}, ${String(found)} possible signal${found === 1 ? "" : "s"} to confirm`,
      meta: { job: JOBS.researchFetch, state: "done", pages: pages.length, signals: found },
    });
  });
}

/** research.brief: build the brief from stored data only, validate it, price it, save a new version. */
export async function runResearchBrief(deps: Omit<ResearchJobDeps, "fetcher">, job: ResearchJob): Promise<void> {
  const { db, ai, clock } = deps;
  const scope = await jobScope(db, job.userId);
  if (scope === undefined) return;
  const accountRow = await accountsRepo(db).get(scope, job.accountId);
  if (accountRow === undefined) return;
  const account = accountRow.account;
  const now = clock();

  const [sources, signals, contacts, reference, allReferences, pricing] = await Promise.all([
    researchRepo(db).sources(scope, job.accountId),
    signalsRepo(db).listForAccount(scope, job.accountId),
    contactsRepo(db).listForAccount(scope, job.accountId),
    referencesRepo(db).bestFor(scope, account.propertyType),
    referencesRepo(db).allForChecks(scope),
    livePricing(db, scope, now),
  ]);
  if (sources.length === 0 && signals.length === 0) {
    await jobFailed(db, scope, job.accountId, JOBS.researchBrief, "Add at least one source or signal first.");
    return;
  }
  const promptSources: PromptSource[] = sources.map(({ source }) => ({
    id: source.id,
    kind: source.kind,
    title: source.title,
    url: source.url,
    text: source.contentText,
  }));
  const prompt = researchBriefPrompt(
    {
      today: isoDay(now),
      account: {
        name: account.name,
        propertyType: account.propertyType,
        city: account.city,
        state: account.state,
        ownerCompany: account.ownerCompany,
        sizeText: account.sizeText,
        yearBuilt: account.yearBuilt,
        occupancyPct: account.occupancyPct,
        currentProvider: account.currentProvider,
        contractTiming: account.contractTiming,
        contractEndDate: account.contractEndDate,
        website: account.website,
      },
      contacts: contacts.map((contact) => ({
        name: `${contact.firstName} ${contact.lastName}`.trim(),
        title: contact.title,
        contactPref: contact.contactPref,
      })),
      signals: signals.map((signal) => ({
        text: signal.text,
        kind: signal.kind,
        confirmed: signal.confirmed,
        observedOn: signal.observedOn,
        sourceId: signal.sourceId,
      })),
      clientReference:
        reference === undefined
          ? null
          : {
              labelNamed: reference.labelNamed,
              labelAnonymized: reference.labelAnonymized,
              namedPermission: reference.namedPermission,
              stats: reference.stats,
            },
      pricing:
        pricing === null
          ? null
          : {
              hourlyRateCents: pricing.hourlyRateCents,
              coverageHoursPerWeek: pricing.coverageHoursPerWeek,
              supervisorMultiplier: pricing.supervisorMultiplier,
              addons: pricing.addons,
              termMonthsOffered: [12, 24, 36],
            },
      defaultPackage: defaultPackageFor(account.propertyType),
    },
    promptSources,
  );
  const allowed = new Set(promptSources.map((source) => source.id));

  let result;
  try {
    result = await ai.generate({
      feature: "research_brief",
      tier: "writer",
      ...prompt,
      schema: ResearchBriefOutput,
      userId: scope.userId,
      check: (output) => briefProblems(output, allowed, allReferences),
    });
  } catch {
    await jobFailed(
      db,
      scope,
      job.accountId,
      JOBS.researchBrief,
      "The research brief could not be generated. Try again.",
    );
    return;
  }

  const output = result.data;
  const sections = BRIEF_SECTIONS.map((definition) => {
    const section = output.sections.find((entry) => entry.key === definition.key);
    let text = section?.text ?? "";
    if (definition.key === "recommended_package" && pricing !== null) {
      // The price is the pricing engine's, written by the server (§7.3), never the model's.
      text = `${withoutDollarAmounts(text)}\n\nPrice: ${priceSentence(output.recommendedPackage, pricing)}`.trim();
    }
    return { key: definition.key, heading: definition.heading, text, sourceIds: section?.sourceIds ?? [] };
  });

  await db.transaction(async (tx) => {
    const locked = await accountsRepo(tx).getEditable(scope, job.accountId);
    if (locked === undefined) return; // ownership changed while the brief was being written
    const brief = await researchRepo(tx).insertBrief(scope, {
      accountId: job.accountId,
      sections,
      recommendedPackage: output.recommendedPackage,
      aiCallId: result.aiCallId,
      createdBy: scope.userId,
    });
    await activitiesRepo(tx).insert(scope, {
      accountId: job.accountId,
      type: "note",
      subject: `Research brief v${String(brief.version)} generated`,
      meta: { job: JOBS.researchBrief, state: "done", version: brief.version },
    });
    // First brief saved → researched (§5). Automatic moves only go forward.
    const deal = await dealsRepo(tx).currentForAccount(scope, job.accountId);
    if (deal !== undefined) {
      const to = automaticAdvance(deal.deal, "researched");
      if (to !== null) {
        await dealsRepo(tx).update(scope, deal.deal.id, { stage: to, stageChangedAt: now, lastActivityAt: now });
        await dealsRepo(tx).recordStage(scope, deal.deal.id, deal.deal.stage, to);
        await activitiesRepo(tx).insert(scope, {
          accountId: job.accountId,
          dealId: deal.deal.id,
          type: "stage_change",
          subject: `Stage moved from ${STAGE_LABELS[deal.deal.stage]} to ${STAGE_LABELS[to]}`,
          meta: { from: deal.deal.stage, to, automatic: true, trigger: "research_brief" },
        });
        await auditRepo(tx).write(scope, {
          action: "deal.stage",
          entityType: "deal",
          entityId: deal.deal.id,
          meta: { from: deal.deal.stage, to, automatic: true },
        });
      }
    }
  });
}
