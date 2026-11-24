import type { AiFeature } from "@soa/shared";

/* The one boundary to a model. Only apps/api/src/providers/ai/ may talk to Bedrock (CLAUDE.md rule 3). */

export interface AdapterMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AdapterRequest {
  modelId: string;
  feature: AiFeature;
  system: string;
  messages: AdapterMessage[];
  /** A single forced tool: the model must answer by calling it, and its input is the result. */
  tool: { name: string; description: string; inputSchema: Record<string, unknown> };
}

export interface AdapterResult {
  toolInput: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AiAdapter {
  readonly name: string;
  converse: (request: AdapterRequest, signal: AbortSignal) => Promise<AdapterResult>;
}
