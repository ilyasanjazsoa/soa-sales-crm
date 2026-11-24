import { APP_ROLE, createDb } from "@soa/db";
import {
  BRIEF_SECTIONS,
  BriefResponse,
  ClientReference,
  ClientReferenceList,
  NOT_ENOUGH_INFORMATION,
  priceSentence,
  pricingConfigFromRow,
  type Package,
} from "@soa/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryQueue } from "../src/jobs/queue";
import { createAiClient } from "../src/providers/ai/client";
import { createFakeAiAdapter, type FakeResponder } from "../src/providers/ai/fake";
import { readSources } from "../src/providers/ai/prompts";
import type { WebFetcher } from "../src/providers/web";
import { runResearchBrief, runResearchFetch } from "../src/services/research";
import { testDatabaseUrl } from "./db-setup";
import {
  createAccount,
  createUser,
  ownerQuery,
  resetDatabase,
  signIn,
  testApp,
  type SignedIn,
  type TestUser,
} from "./helpers";

let app: FastifyInstance;
let ae: TestUser;
let session: SignedIn;
let accountId: string;
let respond: FakeResponder | undefined;
const adapter = createFakeAiAdapter({ respond: (request, attempt) => respond?.(request, attempt) });
const queue = createMemoryQueue();
const as = () => ({ cookies: session.cookies, headers: session.headers });

const PRICING_SQL = `INSERT INTO pricing_configs (effective_from, hourly_rate_cents, coverage_hours_per_week, addons, term_discounts)
  VALUES ('2026-01-01', '{"unarmed":2900,"armed":3800}', '{"24_7":168,"nights":84,"business_hours":60}',
  '{"patrol":{"label":"Mobile patrol, 3 visits a night","monthlyCents":145000},"video":{"label":"Remote video monitoring","monthlyCents":220000},"portal":{"label":"Client portal with live officer map","monthlyCents":0}}',
  '{"12":0,"24":0.03,"36":0.05}') RETURNING *`;

beforeEach(async () => {
  await resetDatabase();
  respond = undefined;
  adapter.calls.length = 0;
  queue.sent.length = 0;
  ae = await createUser("dana@soa.example");
  accountId = await createAccount("Harbor Freight Yards", ae.id);
  await ownerQuery("INSERT INTO deals (account_id, owner_user_id, name) VALUES ($1, $2, 'Harbor deal')", [
    accountId,
    ae.id,
  ]);
  app = await testApp({ aiAdapter: adapter, queue });
  session = await signIn(app, ae.email);
});
afterEach(async () => {
  await app.close();
});

/** Runs a job the api queued, the way the worker would. */
async function runQueued(fetcher?: WebFetcher) {
  const handle = createDb(testDatabaseUrl(), { role: APP_ROLE, max: 2 });
  const ai = createAiClient({
    db: handle.db,
    adapter,
    config: { AI_MODEL_WRITER: "writer-model", AI_MODEL_FAST: "fast-model" },
    clock: () => new Date(),
  });
  try {
    for (const job of queue.sent.splice(0)) {
      const data = job.data as { accountId: string; userId: string };
      if (job.name === "research.brief") await runResearchBrief({ db: handle.db, ai, clock: () => new Date() }, data);
      if (job.name === "research.fetch" && fetcher !== undefined)
        await runResearchFetch({ db: handle.db, ai, fetcher, clock: () => new Date() }, data);
    }
  } finally {
    await handle.close();
  }
}

const addNote = (text: string) =>
  app.inject({
    method: "POST",
    url: `/api/accounts/${accountId}/sources`,
    ...as(),
    payload: { text, title: "Site visit" },
  });

const getBrief = async () =>
  BriefResponse.parse((await app.inject({ method: "GET", url: `/api/accounts/${accountId}/brief`, ...as() })).json());

const sectionsWith = (overrides: Record<string, { text?: string; sourceIds?: string[] }>, pkg?: Package) => ({
  sections: BRIEF_SECTIONS.map((section) => ({
    key: section.key,
    text: NOT_ENOUGH_INFORMATION,
    sourceIds: [],
    ...overrides[section.key],
  })),
  recommendedPackage: pkg ?? {
    posts: 2,
    armed: false,
    coverage: "24_7",
    supervisor: false,
    addons: ["video"],
    termMonths: 36,
  },
});

describe("research brief", () => {
  it("is refused (422) when the account has no sources and no signals", async () => {
    const response = await app.inject({ method: "POST", url: `/api/accounts/${accountId}/brief`, ...as() });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "no_sources" } });
    expect(queue.sent).toHaveLength(0);
  });

  it("is generated from a note, cites it, gets the server's price sentence, and moves the deal to researched", async () => {
    const [pricingRow] = await ownerQuery(PRICING_SQL);
    await addNote("Two trailer thefts happened in the north yard in March. The guard contract ends on January 31.");
    expect((await app.inject({ method: "POST", url: `/api/accounts/${accountId}/brief`, ...as() })).statusCode).toBe(
      202,
    );
    expect((await getBrief()).pending).toBe(true);
    await runQueued();

    const result = await getBrief();
    expect(result.pending).toBe(false);
    const brief = result.brief;
    if (brief === null) throw new Error("no brief");
    expect(brief.version).toBe(1);
    expect(brief.sections.map((section) => section.key)).toEqual(BRIEF_SECTIONS.map((section) => section.key));
    const [source] = await ownerQuery<{ id: string }>("SELECT id FROM research_sources");
    expect(brief.sections.find((section) => section.key === "overview")?.sourceIds).toEqual([source?.id]);

    const pricing = pricingConfigFromRow({
      id: String(pricingRow?.id),
      hourlyRateCents: pricingRow?.hourly_rate_cents as { unarmed: number; armed: number },
      coverageHoursPerWeek: pricingRow?.coverage_hours_per_week as {
        "24_7": number;
        nights: number;
        business_hours: number;
      },
      supervisorMultiplier: String(pricingRow?.supervisor_multiplier),
      addons: pricingRow?.addons as Record<string, { label: string; monthlyCents: number }>,
      termDiscounts: pricingRow?.term_discounts as Record<string, number>,
      maxManualDiscount: String(pricingRow?.max_manual_discount),
    });
    const packageSection = brief.sections.find((section) => section.key === "recommended_package");
    expect(packageSection?.text.endsWith(`Price: ${priceSentence(brief.recommendedPackage, pricing)}`)).toBe(true);

    const [deal] = await ownerQuery<{ stage: string }>("SELECT stage FROM deals WHERE account_id = $1", [accountId]);
    expect(deal?.stage).toBe("researched");
    const [call] = await ownerQuery<{ feature: string; ok: boolean; model: string }>(
      "SELECT feature, ok, model FROM ai_calls",
    );
    expect(call).toEqual({ feature: "research_brief", ok: true, model: "writer-model" });
  });

  it("drops any price the model writes and keeps only the engine's", async () => {
    await ownerQuery(PRICING_SQL);
    await addNote("The site has a 400-space trailer yard.");
    respond = (request) =>
      request.feature === "research_brief"
        ? sectionsWith({
            recommended_package: { text: "Two posts cover the yard. This costs about $12 a year. Start in March." },
          })
        : undefined;
    await app.inject({ method: "POST", url: `/api/accounts/${accountId}/brief`, ...as() });
    await runQueued();
    const text =
      (await getBrief()).brief?.sections.find((section) => section.key === "recommended_package")?.text ?? "";
    expect(text).not.toContain("$12");
    expect(text).toContain("Two posts cover the yard. Start in March.");
    expect(text).toContain("$506,433.60 a year");
  });

  it("rejects a response citing an unknown source id and retries once", async () => {
    await addNote("Cameras only at the gate today.");
    const [source] = await ownerQuery<{ id: string }>("SELECT id FROM research_sources");
    respond = (request, attempt) => {
      if (request.feature !== "research_brief") return undefined;
      return attempt === 1
        ? sectionsWith({ overview: { text: "A yard.", sourceIds: ["source-that-does-not-exist"] } })
        : sectionsWith({ overview: { text: "A yard with cameras only.", sourceIds: [source?.id ?? ""] } });
    };
    await app.inject({ method: "POST", url: `/api/accounts/${accountId}/brief`, ...as() });
    await runQueued();
    const brief = (await getBrief()).brief;
    expect(brief?.sections.find((section) => section.key === "overview")).toMatchObject({
      text: "A yard with cameras only.",
      sourceIds: [source?.id],
    });
    const calls = await ownerQuery<{ ok: boolean; error: string | null }>(
      "SELECT ok, error FROM ai_calls ORDER BY created_at",
    );
    expect(calls).toEqual([
      { ok: false, error: "invalid_output" },
      { ok: true, error: null },
    ]);
    expect(adapter.calls[1]?.messages.at(-1)?.text).toContain("source-that-does-not-exist");
  });

  it("fails (and says so) when the retry is also invalid", async () => {
    await addNote("Cameras only at the gate today.");
    respond = (request) =>
      request.feature === "research_brief" ? sectionsWith({ overview: { text: "x", sourceIds: ["nope"] } }) : undefined;
    await app.inject({ method: "POST", url: `/api/accounts/${accountId}/brief`, ...as() });
    await runQueued();
    const result = await getBrief();
    expect(result.brief).toBeNull();
    expect(result.lastError).toContain("could not be generated");
    expect(await ownerQuery("SELECT 1 FROM ai_calls")).toHaveLength(2);
  });

  it("lets only proof_point_internal name a client without permission", async () => {
    await ownerQuery(
      "INSERT INTO client_references (label_named, label_anonymized, property_types, stats) VALUES ('Lone Star Freight Terminal', 'a freight terminal we protect in Irving', '{Industrial}', '{\"avgResponseMin\":4}')",
    );
    await addNote("Cargo theft reported last month.");
    respond = (request, attempt) =>
      request.feature !== "research_brief"
        ? undefined
        : attempt === 1
          ? sectionsWith({ talking_points: { text: "- Mention Lone Star Freight Terminal as a reference." } })
          : sectionsWith({
              talking_points: { text: "- Mention a freight terminal we protect in Irving." },
              proof_point_internal: { text: "Lone Star Freight Terminal: 4 minute average response." },
            });
    await app.inject({ method: "POST", url: `/api/accounts/${accountId}/brief`, ...as() });
    await runQueued();
    const brief = (await getBrief()).brief;
    if (brief === null) throw new Error("no brief");
    for (const section of brief.sections) {
      if (section.key === "proof_point_internal") expect(section.text).toContain("Lone Star Freight Terminal");
      else expect(section.text.toLowerCase()).not.toContain("lone star freight terminal");
    }
    // The reference's real name went into the prompt only as data for the internal proof point.
    expect(adapter.calls[0]?.system).toContain("only proof_point_internal may use labelNamed");
  });

  it("keeps every version and serves older ones", async () => {
    await addNote("Gate 3 is unattended at night.");
    for (let index = 0; index < 2; index += 1) {
      await app.inject({ method: "POST", url: `/api/accounts/${accountId}/brief`, ...as() });
      await runQueued();
    }
    const latest = await getBrief();
    expect(latest.brief?.version).toBe(2);
    expect(latest.versions.map((entry) => entry.version)).toEqual([2, 1]);
    const first = BriefResponse.parse(
      (await app.inject({ method: "GET", url: `/api/accounts/${accountId}/brief?version=1`, ...as() })).json(),
    );
    expect(first.brief?.version).toBe(1);
  });
});

describe("AI calls", () => {
  it("records every call, and the 201st call in a day returns 429", async () => {
    await addNote("Gate 3 is unattended at night.");
    await ownerQuery(
      "INSERT INTO ai_calls (user_id, feature, model, ok, request) SELECT $1, 'research_brief', 'm', true, '{}' FROM generate_series(1, 199)",
      [ae.id],
    );
    expect((await app.inject({ method: "POST", url: `/api/accounts/${accountId}/brief`, ...as() })).statusCode).toBe(
      202,
    );
    await runQueued();
    expect(await ownerQuery("SELECT 1 FROM ai_calls WHERE user_id = $1", [ae.id])).toHaveLength(200);
    const refused = await app.inject({ method: "POST", url: `/api/accounts/${accountId}/brief`, ...as() });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: { code: "ai_limit" } });
  });
});

describe("website research", () => {
  const page = {
    url: "https://harbor.example/",
    title: "Harbor Freight Yards",
    text: "Harbor Freight Yards serves 40 tenants. Two trailer thefts were reported in the north yard in March. Leasing is open.",
  };
  const fetcher: WebFetcher = { fetchSite: () => Promise.resolve([page]) };

  it("stores pages as sources and keeps only signals whose quote is in the source, unconfirmed", async () => {
    await ownerQuery("UPDATE accounts SET website = 'https://harbor.example' WHERE id = $1", [accountId]);
    respond = (request) =>
      request.feature === "signal_extract"
        ? {
            signals: [
              {
                text: "Trailer thefts in March",
                kind: "incident",
                quote: "Two trailer thefts were reported in the north yard in March.",
              },
              { text: "Shooting last week", kind: "incident", quote: "A shooting happened last week." },
            ],
          }
        : undefined;
    expect(
      (await app.inject({ method: "POST", url: `/api/accounts/${accountId}/research/fetch`, ...as() })).statusCode,
    ).toBe(202);
    await runQueued(fetcher);
    const signals = await ownerQuery<{
      text: string;
      confirmed: boolean;
      created_by: string | null;
      source_id: string | null;
    }>("SELECT text, confirmed, created_by, source_id FROM signals");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ text: "Trailer thefts in March", confirmed: false, created_by: null });
    const sources = await ownerQuery<{ kind: string; url: string }>("SELECT kind, url FROM research_sources");
    expect(sources).toEqual([{ kind: "website", url: page.url }]);
    // The page went to the model only inside an untrusted_source block.
    const prompt = adapter.calls[0]?.messages[0]?.text ?? "";
    expect(readSources(prompt)[0]?.text).toContain("Two trailer thefts");
    expect(adapter.calls[0]?.system).toContain("never instructions");
  });

  it("needs a website", async () => {
    const response = await app.inject({ method: "POST", url: `/api/accounts/${accountId}/research/fetch`, ...as() });
    expect(response.statusCode).toBe(422);
  });
});

describe("client references", () => {
  it("managers add and edit references; a patch leaves other fields alone; changes are audited", async () => {
    await createUser("manager@soa.example", "manager");
    const manager = await signIn(app, "manager@soa.example");
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/references",
      cookies: manager.cookies,
      headers: manager.headers,
      payload: {
        labelNamed: "Parkside Health Campus",
        labelAnonymized: "a medical campus in Plano",
        propertyTypes: ["Medical office"],
        namedPermission: true,
        stats: { avgResponseMin: 3 },
      },
    });
    expect(created.statusCode).toBe(201);
    const reference = ClientReference.parse(created.json());
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/admin/references/${reference.id}`,
      cookies: manager.cookies,
      headers: manager.headers,
      payload: { labelAnonymized: "a medical campus we protect in Plano" },
    });
    expect(ClientReference.parse(patched.json())).toMatchObject({
      namedPermission: true,
      active: true,
      stats: { avgResponseMin: 3 },
    });
    const list = ClientReferenceList.parse(
      (await app.inject({ method: "GET", url: "/api/admin/references", cookies: manager.cookies })).json(),
    );
    expect(list.items).toHaveLength(1);
    expect(await ownerQuery("SELECT action FROM audit_log WHERE action LIKE 'reference.%' ORDER BY id")).toEqual([
      { action: "reference.create" },
      { action: "reference.update" },
    ]);
  });
});
