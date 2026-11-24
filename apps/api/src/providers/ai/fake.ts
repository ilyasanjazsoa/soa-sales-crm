import { BRIEF_SECTIONS, NOT_ENOUGH_INFORMATION, type Package } from "@soa/shared";
import {
  readCrmData,
  readSources,
  type BriefPromptData,
  type OutreachPromptData,
  type PrepPromptData,
  type AskPlanData,
  type AskResultData,
} from "./prompts";
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

function fakeDraft(request: AdapterRequest): unknown {
  const data = readCrmData(request.messages.map((message) => message.text).join("\n")) as
    OutreachPromptData | undefined;
  if (data === undefined) return { subject: null, body: "Hello." };
  const signal = data.signals.find((entry) => entry.confirmed) ?? data.signals[0];
  const hook =
    signal === undefined
      ? ""
      : ` I saw a note that ${signal.text.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}.`;
  const proof = data.reference === null ? "" : ` A comparable site we look after: ${data.reference.label}.`;
  const first = data.contact.firstName;
  if (data.channel === "linkedin") {
    return {
      subject: null,
      body: `Hi ${first}, I work with properties like ${data.account.name} on security coverage. Would you be open to connecting?`.slice(
        0,
        280,
      ),
    };
  }
  if (data.channel === "voicemail") {
    return {
      subject: null,
      body: `Hi ${first}, this is ${data.rep.name} with Security Of America.${hook} I'd like to offer a short site walk at ${data.account.name}. You can reach me at ${data.rep.phone ?? "my office line"}. Thanks.`,
    };
  }
  if (data.channel === "call") {
    return {
      subject: null,
      body: `Opener: Hi ${first}, this is ${data.rep.name} with Security Of America.${hook}\nQuestion: How is coverage handled at ${data.account.name} today?\nQuestion: What would you change about it?\nAsk: Could we walk the site for 30 minutes next week?`,
    };
  }
  return {
    subject: `Security at ${data.account.name}`,
    body: `Hi ${first},\n\nI lead security coverage for ${data.account.propertyType.toLowerCase()} properties${data.account.city === null ? "" : ` around ${data.account.city}`}.${hook}${proof}\n\nWould you be open to a 30-minute site walk next week? I can share what we would recommend for ${data.account.name}.`,
  };
}

function fakeClaims(request: AdapterRequest): unknown {
  const [draft] = readSources(request.messages.map((message) => message.text).join("\n"));
  const text = draft?.text ?? "";
  const absoluteClaims = [...text.matchAll(/[^.!?\n]*\b(guarantee[sd]?|100%|never fail)[^.!?\n]*/gi)].map((match) =>
    match[0].trim(),
  );
  const disparagement = [...text.matchAll(/[^.!?\n]*\b(unreliable|terrible|worse than|incompetent)[^.!?\n]*/gi)].map(
    (match) => match[0].trim(),
  );
  return { absoluteClaims: absoluteClaims.slice(0, 5), disparagement: disparagement.slice(0, 5) };
}

function fakeClassify(request: AdapterRequest): unknown {
  const [reply] = readSources(request.messages.map((message) => message.text).join("\n"));
  const text = reply?.text ?? "";
  const classification = /unsubscribe|remove me|stop (emailing|sending)/i.test(text)
    ? "unsubscribe"
    : /out of (the )?office|away until|automatic reply/i.test(text)
      ? "out_of_office"
      : /not interested|no thanks|no, thank/i.test(text)
        ? "not_interested"
        : /next (year|quarter)|not right now|maybe later|circle back/i.test(text)
          ? "not_now"
          : /interested|let'?s (talk|meet)|sounds good|call me|happy to|set up a time/i.test(text)
            ? "interested"
            : "other";
  const summaries: Record<string, string> = {
    unsubscribe: "Asks to stop receiving email.",
    out_of_office: "Automatic away message.",
    not_interested: "Says they are not interested.",
    not_now: "Not now; open to talking later.",
    interested: "Interested and open to a conversation.",
    other: "A reply that needs a look.",
  };
  return { classification, summary: summaries[classification] };
}

function fakePrep(request: AdapterRequest): unknown {
  const data = readCrmData(request.messages.map((message) => message.text).join("\n")) as PrepPromptData | undefined;
  const name = data?.account.name ?? "the property";
  const people = data?.attendees ?? [];
  const confirmed = (data?.signals ?? []).filter((signal) => signal.confirmed).slice(0, 3);
  return {
    sections: [
      { key: "goal", text: `Agree on the security gaps at ${name} and a next step toward a proposal.` },
      {
        key: "who_you_are_meeting",
        text:
          people.length === 0
            ? NOT_ENOUGH_INFORMATION
            : people.map((person) => `- ${person.name}${person.title === null ? "" : `, ${person.title}`}`).join("\n"),
      },
      {
        key: "agenda",
        text: "- Introductions and what prompted the meeting\n- Walk the site and its entry points\n- Current coverage and what isn't working\n- Next steps",
      },
      {
        key: "questions_to_ask",
        text: [
          ...confirmed.map((signal) => `- How are you handling this today: ${signal.text}`),
          "- Who else is involved in choosing a security provider?",
          "- When does the current arrangement end?",
          "- What would a great first 90 days look like?",
        ].join("\n"),
      },
      {
        key: "bring",
        text:
          data?.reference === null || data?.reference === undefined
            ? "- Business cards and a notebook for the site walk"
            : `- Results from ${data.reference.label}\n- Business cards and a notebook for the site walk`,
      },
    ],
  };
}

function fakeAsk(request: AdapterRequest): unknown {
  const text = request.messages.map((message) => message.text).join("\n");
  const question = (readSources(text)[0]?.text ?? "").toLowerCase();
  const data = readCrmData(text) as (AskPlanData & Partial<AskResultData>) | undefined;
  if (data?.results === undefined) {
    // The planner: keywords to functions.
    const calls: unknown[] = [];
    if (/stall|stuck|quiet|no activity/.test(question)) calls.push({ fn: "stalledDeals", days: 7 });
    if (question.includes("meet")) calls.push({ fn: "meetingsBetween", from: data?.weekStart, to: data?.weekEnd });
    if (/forecast|pipeline worth|weighted/.test(question)) calls.push({ fn: "forecast" });
    if (question.includes("repl")) calls.push({ fn: "recentReplies", days: 7 });
    if (/fit|best accounts|top accounts/.test(question)) calls.push({ fn: "topAccountsByFit", n: 5 });
    if (/my deals|open deals|my pipeline/.test(question)) calls.push({ fn: "myOpenDeals" });
    const named = /(?:about|for|on|with)\s+([a-z0-9][a-z0-9 &'-]{2,60}?)(?:[?.!]|$| deal| account)/.exec(question)?.[1];
    if (calls.length === 0 && named !== undefined) calls.push({ fn: "accountByName", text: named.trim() });
    return { calls: calls.slice(0, 4) };
  }
  const items = data.results.flatMap((result) => result.items).slice(0, 10);
  const answer =
    items.length === 0
      ? "Nothing in the CRM matched that."
      : data.draftRequested === true
        ? "Open the account's outreach screen and use Write with AI there."
        : data.results.map((result) => result.summary).join(" ");
  return { answer, items };
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
              : request.feature === "outreach_draft"
                ? fakeDraft(request)
                : request.feature === "claim_check"
                  ? fakeClaims(request)
                  : request.feature === "reply_classify"
                    ? fakeClassify(request)
                    : request.feature === "prep_brief"
                      ? fakePrep(request)
                      : fakeAsk(request);
      return Promise.resolve({ toolInput, inputTokens: 0, outputTokens: 0 });
    },
  };
}
