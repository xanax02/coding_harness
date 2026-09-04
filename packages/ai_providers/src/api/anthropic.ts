import { Context, ModelInfo, StreamOptions } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";

export interface AnthropicOptions extends StreamOptions {
  thikingBudgetToken?: number;
}

export const stream = (
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions,
): AssistantMessageEventStream => {
  // TODO: Implement Anthropic streaming
  throw new Error("Anthropic streaming not implemented yet");
};
