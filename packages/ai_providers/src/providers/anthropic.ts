import { stream } from "../api/anthropic.js";
import { createAntropicStream } from "../api/anthropic.lazy.js";
import { Context, ModelInfo, Provider, StreamOptions } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

const ANTHROPIC_MODELS: readonly ModelInfo[] = [
  {
    id: "claude-fabel-5-1",
    name: "Claude Fabel 5.1",
    baseUrl: ANTHROPIC_BASE_URL,
    provider: "anthropic",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: {
      input: 10,
      output: 50,
      cacheRead: 0.25,
      cacheWrite: 12.5,
    },
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    baseUrl: ANTHROPIC_BASE_URL,
    provider: "anthropic",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    },
  },
  {
    id: "claude-sonnet-5",
    name: "Cluade Sonnet 5",
    baseUrl: ANTHROPIC_BASE_URL,
    provider: "anthropic",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: {
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    },
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    baseUrl: ANTHROPIC_BASE_URL,
    provider: "anthropic",
    input: ["text", "image"],
    /**
     * for now making this false as this doesnot support adaptive thinking and there is no
     * logic of checking compatiblity yet and settings its thinking type
     * in future compat field will be added to modelInfo which for anthropic have forceAdaptiveThinking
     * boolean field to handle thiking type
     * as of now only adaptive thiking is being used
     * and this model does not support it
     *
     * this is handled here as well as when passing the model
     * thikingEnable field will be false also, if it supports that
     */
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: {
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    },
  },
];

export function anthropicProvider(): Provider {
  const modelsIdMap = new Map(
    ANTHROPIC_MODELS.map((model) => [model.id, model]),
  );

  return {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: ANTHROPIC_BASE_URL,
    auth: { apiKeyEnvVar: "ANTHROPIC_API_KEY" },

    getModels(): readonly ModelInfo[] {
      return ANTHROPIC_MODELS;
    },

    getModel(modelId: string): ModelInfo | undefined {
      return modelsIdMap.get(modelId);
    },

    stream(model: ModelInfo, context: Context, options?: StreamOptions): AssistantMessageEventStream {
      return createAntropicStream().stream(model, context, options);
    },
  };
}
