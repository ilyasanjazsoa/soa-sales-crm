import { BedrockRuntimeClient, ConverseCommand, type Message } from "@aws-sdk/client-bedrock-runtime";
import type { AiAdapter } from "./types";

/* Claude through Amazon Bedrock's Converse API, in the company's AWS account (ARCHITECTURE.md §7.1).
   Credentials come from the task role; in production the endpoint is reached through a VPC endpoint. */

export function createBedrockAdapter(options: { region: string }): AiAdapter {
  const client = new BedrockRuntimeClient({ region: options.region });
  return {
    name: "bedrock",
    async converse(request, signal) {
      const messages: Message[] = request.messages.map((message) => ({
        role: message.role,
        content: [{ text: message.text }],
      }));
      const output = await client.send(
        new ConverseCommand({
          modelId: request.modelId,
          system: [{ text: request.system }],
          messages,
          toolConfig: {
            tools: [
              {
                toolSpec: {
                  name: request.tool.name,
                  description: request.tool.description,
                  inputSchema: { json: request.tool.inputSchema as never },
                },
              },
            ],
            toolChoice: { tool: { name: request.tool.name } },
          },
          inferenceConfig: { maxTokens: 4096, temperature: 0.2 },
        }),
        { abortSignal: signal },
      );
      const block = output.output?.message?.content?.find((content) => content.toolUse !== undefined);
      return {
        toolInput: block?.toolUse.input,
        inputTokens: output.usage?.inputTokens ?? null,
        outputTokens: output.usage?.outputTokens ?? null,
      };
    },
  };
}
