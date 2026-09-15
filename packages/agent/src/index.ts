import { ProviderManager, createProviders } from "@coding-harness/ai-providers";

export class Agent {
  private providerManager: ProviderManager;

  constructor(providerManager?: ProviderManager) {
    this.providerManager = providerManager ?? createProviders();
  }

  public getProviderManager(): ProviderManager {
    return this.providerManager;
  }
}
