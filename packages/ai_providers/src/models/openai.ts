import { ModelInfo } from "../types.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// TODO: verify ids and prices against the providers' current model lists
export const OPENAI_MODELS: ModelInfo[] = [
  {
    id: "gpt-4o",
    name: "GPT-4o",
    baseUrl: OPENAI_BASE_URL,
    provider: "openai",
    input: ["text", "image"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o mini",
    baseUrl: OPENAI_BASE_URL,
    provider: "openai",
    input: ["text", "image"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  },
];

// OpenRouter model ids are "<vendor>/<model>"
export const OPENROUTER_MODELS: ModelInfo[] = [
  {
    id: "openai/gpt-4o",
    name: "GPT-4o (OpenRouter)",
    baseUrl: OPENROUTER_BASE_URL,
    provider: "openrouter",
    input: ["text", "image"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o mini (OpenRouter)",
    baseUrl: OPENROUTER_BASE_URL,
    provider: "openrouter",
    input: ["text", "image"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  },
];
