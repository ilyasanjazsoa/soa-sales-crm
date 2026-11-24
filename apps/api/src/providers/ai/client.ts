import type { Database } from "@soa/db";
import { DAILY_AI_CALL_LIMIT, type AiFeature, type Env } from "@soa/shared";
import { z, type ZodType } from "zod";
import type { Clock } from "../../clock";
import { HttpError } from "../../errors";
import { aiCallsRepo } from "../../repos/research";
import { systemScope } from "../../repos/scope";
import type { AdapterMessage, AiAdapter } from "./types";

/* The AI client (ARCHITECTURE.md §7.1): the only way the application calls a model (CLAUDE.md rule 3).
   - One forced tool whose input schema comes from the Zod schema; the tool input is the result.
   - Output is validated with Zod (and an optional semantic check); on failure it retries once with the problem
     appended, then fails with a typed error.
   - Every attempt writes an ai_calls row. 200 calls a day per user; 60 s (writer) and 20 s (fast) timeouts.
   - The model is never given tools that change data (rule 5). */

export type AiTier = "writer" | "fast";

export interface GenerateRequest<T> {
  feature: AiFeature;
  tier: AiTier;
  system: string;
  messages: AdapterMessage[];
  schema: ZodType<T>;
  userId: string | null;
  /** Problems beyond the schema (e.g. unknown source ids). An empty list means the output is acceptable. */
  check?: (data: T) => string[];
}

export class AiOutputError extends Error {
  constructor(
    readonly feature: AiFeature,
    readonly problems: string[],
  ) {
    super(`The AI's answer for ${feature} could not be used.`);
    this.name = "AiOutputError";
  }
}

export const aiLimitReached = () =>
  new HttpError(
    429,
    "ai_limit",
    `You've reached today's limit of ${String(DAILY_AI_CALL_LIMIT)} AI requests. It resets within 24 hours.`,
  );

const TIMEOUT_MS: Record<AiTier, number> = { writer: 60_000, fast: 20_000 };
const DAY_MS = 24 * 60 * 60 * 1000;

const errorKind = (error: unknown) => (error instanceof Error ? error.name : "unknown");

export interface AiClient {
  generate: <T>(request: GenerateRequest<T>) => Promise<{ data: T; aiCallId: string }>;
  /** Throws 429 when the user has no AI calls left today (checked again on every call). */
  assertWithinLimit: (userId: string) => Promise<void>;
}

export function createAiClient(deps: {
  db: Database;
  adapter: AiAdapter;
  config: Pick<Env, "AI_MODEL_WRITER" | "AI_MODEL_FAST">;
  clock: Clock;
}): AiClient {
  const { db, adapter, config, clock } = deps;
  const system = systemScope("ai client");

  const assertWithinLimit = async (userId: string) => {
    const used = await aiCallsRepo(db).countSince(system, userId, new Date(clock().getTime() - DAY_MS));
    if (used >= DAILY_AI_CALL_LIMIT) throw aiLimitReached();
  };

  return {
    assertWithinLimit,

    async generate<T>(request: GenerateRequest<T>) {
      if (request.userId !== null) await assertWithinLimit(request.userId);
      const modelId = request.tier === "writer" ? config.AI_MODEL_WRITER : config.AI_MODEL_FAST;
      const tool = {
        name: `submit_${request.feature}`,
        description: `Submit the ${request.feature.replace("_", " ")} result. Always answer by calling this tool.`,
        inputSchema: z.toJSONSchema(request.schema, { target: "draft-7", io: "input" }) as Record<string, unknown>,
      };
      const messages = [...request.messages];
      let problems: string[] = [];

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (attempt === 2 && request.userId !== null) await assertWithinLimit(request.userId);
        const started = clock().getTime();
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, TIMEOUT_MS[request.tier]);
        let toolInput: unknown;
        let usage: { inputTokens: number | null; outputTokens: number | null } = {
          inputTokens: null,
          outputTokens: null,
        };
        let failure: string | null = null;
        try {
          const result = await adapter.converse(
            { modelId, feature: request.feature, system: request.system, messages, tool },
            controller.signal,
          );
          toolInput = result.toolInput;
          usage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens };
        } catch (error) {
          failure = controller.signal.aborted ? "timeout" : errorKind(error);
        } finally {
          clearTimeout(timer);
        }

        let data: T | undefined;
        if (failure === null) {
          const parsed = request.schema.safeParse(toolInput);
          if (!parsed.success) {
            problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
          } else {
            problems = request.check?.(parsed.data) ?? [];
            if (problems.length === 0) data = parsed.data;
          }
        }

        const aiCallId = await aiCallsRepo(db).insert(system, {
          userId: request.userId,
          feature: request.feature,
          model: modelId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          latencyMs: clock().getTime() - started,
          ok: data !== undefined,
          error: failure ?? (problems.length > 0 ? "invalid_output" : null),
          request: { system: request.system, messages, tool: tool.name, attempt },
          response: toolInput === undefined ? null : toolInput,
        });

        if (data !== undefined) return { data, aiCallId };
        if (failure !== null) problems = [`The request failed (${failure}).`];
        if (attempt === 1 && failure === null) {
          // Retry once with the problem appended (§7.1).
          messages.push(
            { role: "assistant", text: JSON.stringify(toolInput ?? null).slice(0, 20_000) },
            {
              role: "user",
              text: `That answer was rejected:\n- ${problems.join("\n- ")}\nCorrect it and call the tool again.`,
            },
          );
        } else if (failure !== null) {
          break;
        }
      }
      throw new AiOutputError(request.feature, problems);
    },
  };
}
