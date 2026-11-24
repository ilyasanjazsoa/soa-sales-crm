import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { APP_ROLE, createDb, type DbHandle } from "@soa/db";
import {
  briefProblems,
  groundedSignals,
  NOT_ENOUGH_INFORMATION,
  ResearchBriefOutput,
  SignalExtractOutput,
} from "@soa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBedrockAdapter } from "../src/providers/ai/bedrock";
import { createAiClient, type AiClient } from "../src/providers/ai/client";
import {
  researchBriefPrompt,
  signalExtractPrompt,
  type BriefPromptData,
  type PromptSource,
} from "../src/providers/ai/prompts";
import type { AiAdapter } from "../src/providers/ai/types";
import { testDatabaseUrl } from "./db-setup";

/* AI fixtures (ARCHITECTURE.md §7.2 rule 6). Each feature has 5+ cases with assertions on structure and rules.
   - In CI (default): the assertions run against each fixture's recorded response.
   - `pnpm test:ai` (AI_LIVE=1): the same cases run against the real model in Bedrock (AWS_REGION, AI_MODEL_*).
     Add AI_RECORD=1 to save the real responses as the new recordings.
   The recordings in the repository are hand-written baselines until the first live run records real ones. */

const LIVE = process.env.AI_LIVE === "1";
const RECORD = LIVE && process.env.AI_RECORD === "1";
const root = new URL("./ai-fixtures/", import.meta.url);

interface Fixture<I, E> {
  name: string;
  input: I;
  recorded: unknown;
  expect: E;
}

const load = <I, E>(feature: string) =>
  readdirSync(new URL(`${feature}/`, root))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file: new URL(`${feature}/${file}`, root),
      fixture: JSON.parse(readFileSync(new URL(`${feature}/${file}`, root), "utf8")) as Fixture<I, E>,
    }));

const replay = (response: unknown): AiAdapter => ({
  name: "replay",
  converse: () => Promise.resolve({ toolInput: response, inputTokens: null, outputTokens: null }),
});

let handle: DbHandle;
beforeAll(() => {
  handle = createDb(testDatabaseUrl(), { role: APP_ROLE, max: 2 });
});
afterAll(async () => {
  await handle.close();
});

function clientFor(response: unknown): { ai: AiClient; captured: () => unknown } {
  let last: unknown;
  const base = LIVE ? createBedrockAdapter({ region: process.env.AWS_REGION ?? "us-east-1" }) : replay(response);
  const adapter: AiAdapter = {
    name: base.name,
    converse: async (request, signal) => {
      const result = await base.converse(request, signal);
      last = result.toolInput;
      return result;
    },
  };
  const ai = createAiClient({
    db: handle.db,
    adapter,
    config: {
      AI_MODEL_WRITER: process.env.AI_MODEL_WRITER ?? "recorded-writer",
      AI_MODEL_FAST: process.env.AI_MODEL_FAST ?? "recorded-fast",
    },
    clock: () => new Date(),
  });
  return { ai, captured: () => last };
}

const save = (file: URL, fixture: Fixture<unknown, unknown>, response: unknown) => {
  if (RECORD) writeFileSync(file, `${JSON.stringify({ ...fixture, recorded: response }, null, 2)}\n`);
};

describe(`signal_extract fixtures (${LIVE ? "live model" : "recorded"})`, () => {
  const cases = load<
    { source: PromptSource },
    { minSignals: number; maxSignals?: number; kinds?: string[]; mustNotContain?: string[] }
  >("signal_extract");
  it("has at least 5 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });
  it.each(cases.map((entry) => [entry.fixture.name, entry] as const))("%s", async (_name, { file, fixture }) => {
    const { ai, captured } = clientFor(fixture.recorded);
    const { data } = await ai.generate({
      feature: "signal_extract",
      tier: "fast",
      ...signalExtractPrompt(fixture.input.source, "2026-11-24"),
      schema: SignalExtractOutput,
      userId: null,
    });
    save(file, fixture, captured());
    const kept = groundedSignals(data, fixture.input.source.text);
    expect(kept.length).toBeGreaterThanOrEqual(fixture.expect.minSignals);
    if (fixture.expect.maxSignals !== undefined) expect(kept.length).toBeLessThanOrEqual(fixture.expect.maxSignals);
    for (const kind of fixture.expect.kinds ?? []) expect(kept.map((signal) => signal.kind)).toContain(kind);
    for (const phrase of fixture.expect.mustNotContain ?? []) {
      expect(JSON.stringify(kept).toLowerCase()).not.toContain(phrase.toLowerCase());
    }
    for (const signal of kept) expect(signal.text.length).toBeLessThanOrEqual(300);
  });
});

describe(`research_brief fixtures (${LIVE ? "live model" : "recorded"})`, () => {
  const cases = load<
    { data: BriefPromptData; sources: PromptSource[] },
    {
      citesOnly: string[];
      mustNotContain?: string[];
      mustNotContainOutsideInternal?: string[];
      notEnoughInformationIn?: string[];
      minPosts?: number;
      noDollarAmounts?: boolean;
    }
  >("research_brief");
  it("has at least 5 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });
  it.each(cases.map((entry) => [entry.fixture.name, entry] as const))("%s", async (_name, { file, fixture }) => {
    const { ai, captured } = clientFor(fixture.recorded);
    const allowed = new Set(fixture.input.sources.map((source) => source.id));
    const references =
      fixture.input.data.clientReference === null
        ? []
        : [
            {
              labelNamed: fixture.input.data.clientReference.labelNamed,
              namedPermission: fixture.input.data.clientReference.namedPermission,
            },
          ];
    const { data } = await ai.generate({
      feature: "research_brief",
      tier: "writer",
      ...researchBriefPrompt(fixture.input.data, fixture.input.sources),
      schema: ResearchBriefOutput,
      userId: null,
      check: (output) => briefProblems(output, allowed, references),
    });
    save(file, fixture, captured());

    const cited = new Set(data.sections.flatMap((section) => section.sourceIds));
    for (const id of cited) expect(fixture.expect.citesOnly).toContain(id);
    const allText = data.sections
      .map((section) => section.text)
      .join("\n")
      .toLowerCase();
    for (const phrase of fixture.expect.mustNotContain ?? []) expect(allText).not.toContain(phrase.toLowerCase());
    for (const phrase of fixture.expect.mustNotContainOutsideInternal ?? []) {
      for (const section of data.sections.filter((entry) => entry.key !== "proof_point_internal")) {
        expect(section.text.toLowerCase()).not.toContain(phrase.toLowerCase());
      }
    }
    for (const key of fixture.expect.notEnoughInformationIn ?? []) {
      expect(data.sections.find((section) => section.key === key)?.text).toBe(NOT_ENOUGH_INFORMATION);
    }
    if (fixture.expect.minPosts !== undefined)
      expect(data.recommendedPackage.posts).toBeGreaterThanOrEqual(fixture.expect.minPosts);
    if (fixture.expect.noDollarAmounts === true) expect(allText).not.toMatch(/\$\s?\d/);
    for (const section of data.sections) expect(section.text.length).toBeLessThanOrEqual(2500);
  });
});
