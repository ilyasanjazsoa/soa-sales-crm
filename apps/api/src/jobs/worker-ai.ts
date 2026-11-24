import type { Database } from "@soa/db";
import type { Env } from "@soa/shared";
import type { Clock } from "../clock";
import { createBedrockAdapter } from "../providers/ai/bedrock";
import { createAiClient, type AiClient } from "../providers/ai/client";
import { createFakeAiAdapter } from "../providers/ai/fake";

/** The worker's AI client. Only the client is handed out (never an adapter), so every call is recorded and limited. */
export function createWorkerAi(db: Database, config: Env, clock: Clock): AiClient {
  return createAiClient({
    db,
    adapter: config.FAKE_PROVIDERS ? createFakeAiAdapter() : createBedrockAdapter({ region: config.AWS_REGION }),
    config,
    clock,
  });
}
