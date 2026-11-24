import { BRIEF_SECTIONS, NOT_ENOUGH_INFORMATION, type Package } from "@soa/shared";
import { readCrmData, readSources, type BriefPromptData } from "./prompts";
import type { AdapterRequest, AiAdapter } from "./types";

/* Fake AI adapter for local development and tests (FAKE_PROVIDERS=true). It answers from the structured input it
   is given, deterministically, so screens and tests behave predictably; it never invents facts. Tests can script
   specific answers (e.g. an unknown citation on the first attempt) with `respond`. */

export type FakeResponder = (request: AdapterRequest, attempt: number) => unknown;

const KEYWORDS: { kind: "incident" | "timing" | "tenant" | "growth"; pattern: RegExp }[] = [
  {
    kind: "incident",
    pattern: /\b(theft|thefts|stolen|break-in|break-ins|burglar|vandal|trespass|robbery|assault|incident)/i,
  },
  { kind: "timing", pattern: /\b(contract (ends|expires)|renewal|renews|expires|audit|deadline|opens in|opening)/i },
  { kind: "tenant", pattern: /\b(tenant|tenants|occupant|lease[sd]?)\b/i },
  { kind: "growth", pattern: /\b(construction|expansion|expanding|new building|phase \d|groundbreaking)/i },
];

const sentencesOf = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12 && sentence.length <= 400);

function fakeSignals(request: AdapterRequest) {
  const text = request.messages.map((message) => message.text).join("\n");
  const [source] = readSources(text);
  if (source === undefined) return { signals: [] };
  const body = source.text.split("\n").slice(1).join("\n"); // first line is the title
  const signals = sentencesOf(body)
    .flatMap((sentence) => {
      const match = KEYWORDS.find((keyword) => keyword.pattern.test(sentence));
      return match === undefined
        ? []
        : [
            {
              text: sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence,
              kind: match.kind,
              quote: sentence,
            },
          ];
    })
    .slice(0, 8);
  return { signals };
}

const describeType = (type: unknown) => {
  const text = typeof type === "string" ? `${type.toLowerCase()} property` : "a property";
  return typeof type === "string" ? `${/^[aeiou]/i.test(type) ? "an" : "a"} ${text}` : text;
};

function fakeBrief(request: AdapterRequest): unknown {
  const text = request.messages.map((message) => message.text).join("\n");
  const data = readCrmData(text) as BriefPromptData | undefined;
  const sources = readSources(text);
  const firstSourceIds = sources.slice(0, 1).map((source) => source.id);
  const sentence = (source: { text: string } | undefined) =>
    sentencesOf(source?.text.split("\n").slice(1).join(" ") ?? "")[0];
  const account = data?.account ?? {};
  const name = typeof account.name === "string" ? account.name : "The property";
  const signals = data?.signals ?? [];
  const confirmed = signals.filter((signal) => signal.confirmed);

  const sectionText: Record<string, { text: string; sourceIds: string[] }> = {
    overview: {
      text: [
        `${name} is ${describeType(account.propertyType)}${typeof account.city === "string" ? ` in ${account.city}` : ""}.`,
        sentence(sources[0]),
      ]
        .filter(Boolean)
        .join(" "),
      sourceIds: firstSourceIds,
    },
    decision_makers: {
      text:
        (data?.contacts ?? []).length === 0
          ? NOT_ENOUGH_INFORMATION
          : (data?.contacts ?? [])
              .map((contact) => `- ${contact.name}${contact.title === null ? "" : `, ${contact.title}`}`)
              .join("\n"),
      sourceIds: [],
    },
    security_signals: {
      text:
        signals.length === 0
          ? NOT_ENOUGH_INFORMATION
          : signals.map((signal) => `- ${signal.text}${signal.confirmed ? "" : " (unconfirmed)"}`).join("\n"),
      sourceIds: [
        ...new Set(
          signals.flatMap((signal) =>
            signal.sourceId !== null && sources.some((source) => source.id === signal.sourceId)
              ? [signal.sourceId]
              : [],
          ),
        ),
      ],
    },
    current_coverage_and_timing: {
      text:
        account.currentProvider === null && account.contractTiming === null && account.contractEndDate === null
          ? NOT_ENOUGH_INFORMATION
          : [
              typeof account.currentProvider === "string" ? `Current security: ${account.currentProvider}.` : "",
              typeof account.contractTiming === "string" ? `${account.contractTiming}.` : "",
              typeof account.contractEndDate === "string"
                ? `Contract end date on file: ${account.contractEndDate}.`
                : "",
            ]
              .filter(Boolean)
              .join(" "),
      sourceIds: [],
    },
    recommended_package: {
      text: `The default coverage for this kind of property fits what is known so far.`,
      sourceIds: [],
    },
    proof_point_internal: {
      text:
        data?.clientReference === null || data?.clientReference === undefined
          ? NOT_ENOUGH_INFORMATION
          : `${data.clientReference.labelNamed} (${data.clientReference.labelAnonymized}): ${Object.entries(
              data.clientReference.stats,
            )
              .map(([key, value]) => `${key} ${String(value)}`)
              .join(", ")}.`,
      sourceIds: [],
    },
    talking_points: {
      text:
        confirmed.length === 0
          ? NOT_ENOUGH_INFORMATION
          : confirmed
              .slice(0, 3)
              .map((signal) => `- Ask how they handle: ${signal.text}`)
              .join("\n"),
      sourceIds: [],
    },
    likely_objections: {
      text:
        typeof account.currentProvider === "string" && account.currentProvider !== "None"
          ? "- They may be satisfied with their current provider."
          : NOT_ENOUGH_INFORMATION,
      sourceIds: [],
    },
  };
  const defaultPackage: Package = data?.defaultPackage ?? {
    posts: 1,
    armed: false,
    coverage: "nights",
    supervisor: false,
    addons: [],
    termMonths: 12,
  };
  return {
    sections: BRIEF_SECTIONS.map((section) => ({ key: section.key, ...sectionText[section.key] })),
    recommendedPackage: defaultPackage,
  };
}

export function createFakeAiAdapter(
  options: { respond?: FakeResponder } = {},
): AiAdapter & { calls: AdapterRequest[] } {
  const calls: AdapterRequest[] = [];
  return {
    name: "fake",
    calls,
    converse(request) {
      calls.push(request);
      const attempt = request.messages.filter((message) => message.role === "assistant").length + 1;
      const scripted = options.respond?.(request, attempt);
      const toolInput =
        scripted !== undefined
          ? scripted
          : request.feature === "signal_extract"
            ? fakeSignals(request)
            : request.feature === "research_brief"
              ? fakeBrief(request)
              : {};
      return Promise.resolve({ toolInput, inputTokens: 0, outputTokens: 0 });
    },
  };
}
