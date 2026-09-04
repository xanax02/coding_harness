import { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources";
import { AssistantMessage, Context, ModelInfo, StreamOptions } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { Anthropic } from "@anthropic-ai/sdk";

export interface AnthropicOptions extends StreamOptions {
  thikingBudgetToken?: number;

  // TODO: Add more Anthropic-specific options (thinkingEnabled, efforts, etc.)
}

async function fetchStream(
  stream: AssistantMessageEventStream,
  options: AnthropicOptions,
  model: ModelInfo,
  context: Context,
) {
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    provider: "anthropic",
    model: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "pending",
    timeStamp: Date.now(),
    errorMessage: "",
  };

  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: model.baseUrl,
  });

  try {
    const params = buildParams(model, context, options);
    const response = await client.messages.create(params);

    stream.push({ type: "start", partial: output });

    for await (const event of response) {
      console.log(event);
    }
  } catch (error) {
    console.error(error);
  }
}

export const stream = (
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();

  // fetchStream(stream);

  return stream;
};

export const buildParams = (
  model: ModelInfo,
  context: Context,
  options: AnthropicOptions,
): MessageCreateParamsStreaming => {
  return {} as unknown as MessageCreateParamsStreaming;
};

// const client = new Anthropic();

// const streamTest = await client.messages.create({
//   max_tokens: 1024,
//   messages: [{ role: "user", content: "Hello, Claude" }],
//   model: "claude-opus-5",
//   stream: true,
// });
// for await (const messageStreamEvent of streamTest) {
//   console.log(messageStreamEvent);
// }
