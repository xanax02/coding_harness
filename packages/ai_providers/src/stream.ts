import { AnthropicOptions, anthropicStream } from "./providers/anthropic.js";
import { OpenAIOptions, openaiStream } from "./providers/openai.js";
import { Context, ModelInfo } from "./types.js";

export function stream(
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions | OpenAIOptions,
) {
  // "openrouter" (and any other OpenAI-compatible provider id) goes through Chat Completions
  if (model.provider === "anthropic") {
    return anthropicStream(model, context, options as AnthropicOptions);
  }
  return openaiStream(model, context, options as OpenAIOptions);
}

export function complete(
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions | OpenAIOptions,
) {
  const s = stream(model, context, options);
  return s.result();
}
