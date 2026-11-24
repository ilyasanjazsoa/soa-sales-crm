import type { Database } from "@soa/db";
import {
  BriefSection,
  BRIEF_SECTIONS,
  briefProblems,
  defaultPackageFor,
  groundedSignals,
  Package,
  priceSentence,
  ResearchBriefOutput,
  SignalExtractOutput,
  withoutDollarAmounts,
  type BriefResponse,
  type ClientReference,
  type ClientReferenceInput,
  type ClientReferencePatch,
  type ResearchSource,
  type SourceListResponse,
} from "@soa/shared";
import { z } from "zod";
import type { Clock } from "../clock";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors";
import { JOBS, type JobQueue } from "../jobs/queue";
import { AiOutputError, type AiClient } from "../providers/ai/client";
import { includedSources, researchBriefPrompt, signalExtractPrompt, type PromptSource } from "../providers/ai/prompts";
import { FetchRefused, type WebFetcher } from "../providers/web";
import { accountsRepo } from "../repos/accounts";
import { auditRepo } from "../repos/audit";
import { activitiesRepo, contactsRepo, signalsRepo, sourcesRepo } from "../repos/children";
import { referencesRepo, researchRepo, type ReferenceRow, type SourceRow } from "../repos/research";
import { systemScope, userScope, type Scope, type UserScope } from "../repos/scope";
import { usersRepo } from "../repos/users";
import { contentHash } from "./accounts";
import { advanceDeal } from "./advance";
import { isoDay, livePricing, recomputeFit } from "./mappers";

/* Research: sources, signals from websites, and the research brief (ARCHITECTURE.md §7.3, §14). Job state
   (requested → done | failed) is kept on the timeline as activities with meta.job and meta.state. */

export interface ResearchJob {
  accountId: string;
  userId: string;
}

/** A request with no outcome after this long is treated as failed, so the screen never waits forever. */
const JOB_STALE_MS = 10 * 60 * 1000;

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

interface JobState {
  pending: boolean;
  lastError: string | null;
}

/** The state of the latest research job of a kind, from its timeline events. */
async function jobState(
  db: Database,
  scope: Scope,
  accountId: string,
  job: string,
  now: number,
  since = 0,
): Promise<JobState> {
  const event = await researchRepo(db).lastJobEvent(scope, accountId, job);
  if (event === undefined || event.occurredAt.getTime() <= since) return { pending: false, lastError: null };
  const state = event.meta.state;
  if (state === "requested") {
    if (now - event.occurredAt.getTime() < JOB_STALE_MS) return { pending: true, lastError: null };
    return { pending: false, lastError: "That took too long and was stopped. Try again." };
  }
  if (state === "failed") {
    return {
      pending: false,
      lastError: typeof event.meta.message === "string" ? event.meta.message : "That didn't work. Try again.",
    };
  }
  return { pending: false, lastError: null };
}

export function createResearchService(deps: { db: Database; queue: JobQueue; ai: AiClient; clock?: Clock }) {
  const { db, queue, ai } = deps;
  const now = () => (deps.clock ?? (() => new Date()))().getTime();

  const requireEditable = async (scope: UserScope, accountId: string) => {
    const repo = accountsRepo(db);
    const account = await repo.getEditable(scope, accountId);
    if (account !== undefined) return account;
    if ((await repo.get(scope, accountId)) !== undefined) throw forbidden("Claim this account before researching it.");
    throw notFound();
  };

  /** Queues a research job unless one is already running for this account. */
  const request = async (
    scope: UserScope,
    accountId: string,
    job: "research.fetch" | "research.brief",
    subject: string,
  ) => {
    if ((await jobState(db, scope, accountId, job, now())).pending) {
      throw conflict("already_running", "This is already in progress. It will appear here when it's done.");
    }
    await ai.assertWithinLimit(scope.userId);
    await activitiesRepo(db).insert(scope, { accountId, type: "note", subject, meta: { job, state: "requested" } });
    await queue.send(job, { accountId, userId: scope.userId });
  };

  return {
    async sources(scope: UserScope, accountId: string): Promise<SourceListResponse> {
      if ((await accountsRepo(db).get(scope, accountId)) === undefined) throw notFound();
      const [rows, fetch] = await Promise.all([
        researchRepo(db).sources(scope, accountId),
        jobState(db, scope, accountId, JOBS.researchFetch, now()),
      ]);
      return { items: rows.map(toSource), fetch };
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
      await request(scope, accountId, JOBS.researchFetch, "Reading the website");
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
      await request(scope, accountId, JOBS.researchBrief, "Research brief requested");
    },

    async brief(scope: UserScope, accountId: string, version?: number): Promise<BriefResponse> {
      if ((await accountsRepo(db).get(scope, accountId)) === undefined) throw notFound();
      const repo = researchRepo(db);
      const [row, versions] = await Promise.all([
        repo.brief(scope, accountId, version),
        repo.briefVersions(scope, accountId),
      ]);
      if (version !== undefined && row === undefined) throw notFound();
      const latest = versions[0]?.createdAt.getTime() ?? 0;
      const state = await jobState(db, scope, accountId, JOBS.researchBrief, now(), latest);
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
        pending: state.pending,
        lastError: state.lastError,
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

class JobStopped extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "JobStopped";
  }
}

/** Runs a research job so it always ends with a recorded outcome (done or failed) on the timeline. */
async function withOutcome(
  db: Database,
  job: ResearchJob,
  name: string,
  run: (scope: UserScope) => Promise<string>,
): Promise<void> {
  const record = (scope: Scope, state: "done" | "failed", message: string) =>
    activitiesRepo(db).insert(scope, {
      accountId: job.accountId,
      type: "note",
      subject: message,
      meta: { job: name, state, message },
    });
  const user = await usersRepo(db).findById(systemScope("research job"), job.userId);
  if (user?.active !== true) {
    await record(systemScope("research job"), "failed", "Stopped: the person who asked for this is no longer active.");
    return;
  }
  const scope = userScope(user.id, user.role);
  try {
    const message = await run(scope);
    await record(scope, "done", message);
  } catch (error) {
    const message =
      error instanceof JobStopped
        ? error.userMessage
        : error instanceof HttpError && error.statusCode === 429
          ? "Today's AI limit is used up. Try again tomorrow."
          : error instanceof AiOutputError
            ? "The AI's answer couldn't be used. Try again."
            : "Something went wrong. Try again.";
    await record(scope, "failed", message).catch(() => undefined);
    if (!(error instanceof JobStopped) && !(error instanceof AiOutputError) && !(error instanceof HttpError))
      throw error;
  }
}

/** research.fetch: read up to 8 pages of the account's website, store them as sources, extract signals. */
export async function runResearchFetch(deps: ResearchJobDeps, job: ResearchJob): Promise<void> {
  const { db, ai, fetcher, clock } = deps;
  await withOutcome(db, job, JOBS.researchFetch, async (scope) => {
    const account = await accountsRepo(db).getEditable(scope, job.accountId);
    if (account === undefined) throw new JobStopped("Stopped: this account is no longer yours to research.");
    if (account.website === null) throw new JobStopped("Add the account's website first.");

    let pages;
    try {
      pages = await fetcher.fetchSite(account.website);
    } catch (error) {
      throw new JobStopped(
        error instanceof FetchRefused
          ? `The website was not read: ${error.message}`
          : "The website could not be reached.",
      );
    }

    const existing = new Set(
      (await signalsRepo(db).listForAccount(scope, job.accountId)).map((signal) => signal.text.toLowerCase()),
    );
    let found = 0;
    let unanalysed = 0;
    let limitReached = false;
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
      if (limitReached) {
        unanalysed += 1;
        continue;
      }
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
      } catch (error) {
        unanalysed += 1;
        if (error instanceof HttpError && error.statusCode === 429) limitReached = true;
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
    await recomputeFit(db, scope, job.accountId, clock());
    const summary = `Website read: ${String(pages.length)} page${pages.length === 1 ? "" : "s"}, ${String(found)} possible signal${found === 1 ? "" : "s"} to confirm`;
    if (unanalysed === 0) return `${summary}.`;
    return `${summary}. ${String(unanalysed)} page${unanalysed === 1 ? " was" : "s were"} stored but not analysed${limitReached ? " (today's AI limit is used up)" : ""}.`;
  });
}

/** research.brief: build the brief from stored data only, validate it, price it, save a new version. */
export async function runResearchBrief(deps: Omit<ResearchJobDeps, "fetcher">, job: ResearchJob): Promise<void> {
  const { db, ai, clock } = deps;
  await withOutcome(db, job, JOBS.researchBrief, async (scope) => {
    const accountRow = await accountsRepo(db).get(scope, job.accountId);
    if (accountRow === undefined) throw new JobStopped("Stopped: this account is no longer yours to research.");
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
    if (sources.length === 0 && signals.length === 0) throw new JobStopped("Add at least one source or signal first.");

    // Newest first, so recent notes are never the ones cut by the prompt budget; only included ones may be cited.
    const promptSources: PromptSource[] = [...sources]
      .sort((a, b) => b.source.fetchedAt.getTime() - a.source.fetchedAt.getTime())
      .map(({ source }) => ({
        id: source.id,
        kind: source.kind,
        title: source.title,
        url: source.url,
        text: source.contentText,
      }));
    const allowed = new Set(includedSources(promptSources).ids);
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

    const result = await ai.generate({
      feature: "research_brief",
      tier: "writer",
      ...prompt,
      schema: ResearchBriefOutput,
      userId: scope.userId,
      check: (output) => briefProblems(output, allowed, allReferences),
    });

    const output = result.data;
    const sections = BRIEF_SECTIONS.map((definition) => {
      const section = output.sections.find((entry) => entry.key === definition.key);
      // Prices come only from the pricing engine, written by the server (§7.3): drop any the model wrote.
      let text = withoutDollarAmounts(section?.text ?? "");
      if (definition.key === "recommended_package" && pricing !== null) {
        text = `${text}\n\nPrice: ${priceSentence(output.recommendedPackage, pricing)}`.trim();
      }
      return { key: definition.key, heading: definition.heading, text, sourceIds: section?.sourceIds ?? [] };
    });

    return db.transaction(async (tx) => {
      const locked = await accountsRepo(tx).getEditable(scope, job.accountId);
      if (locked === undefined)
        throw new JobStopped("Stopped: this account changed owner while the brief was being written.");
      const brief = await researchRepo(tx).insertBrief(scope, {
        accountId: job.accountId,
        sections,
        recommendedPackage: output.recommendedPackage,
        aiCallId: result.aiCallId,
        createdBy: scope.userId,
      });
      // First brief saved → researched (§5). Automatic moves only go forward, and only on a deal we can change.
      await advanceDeal(tx, scope, job.accountId, "researched", "research_brief", now);
      return `Research brief v${String(brief.version)} generated`;
    });
  });
}
