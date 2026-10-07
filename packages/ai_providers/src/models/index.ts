import { ModelInfo } from "../types.js";
import { ANTHROPIC_MODELS } from "./anthropic.js";

export const MODELS = {
  anthropic: ANTHROPIC_MODELS,
};

export const modelRegistry: Map<string, Map<string, ModelInfo>> = new Map();

for (const [provider, models] of Object.entries(MODELS)) {
  const providerModels = new Map<string, ModelInfo>();
  for (const model of models) {
    providerModels.set(model.id, model);
  }
  modelRegistry.set(provider, providerModels);
}
