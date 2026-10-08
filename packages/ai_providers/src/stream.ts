import { AnthropicOptions, anthropicStream } from "./providers/anthropic.js";
import { Context, ModelInfo } from "./types.js";

export function stream(
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions,
) {
  return anthropicStream(model, context, options);
}

export function complete(
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions,
) {
  const s = stream(model, context, options);
  return s.result();
}
