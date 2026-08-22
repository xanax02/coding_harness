import { ModelInfo, Provider, ProviderId } from "./types";

/**
 * Simple provider registry with current provider selection
 */
class ProviderManager {
  private providers = new Map<ProviderId, Provider>();
}

export function createProviders() {
  return new ProviderManager();
}
