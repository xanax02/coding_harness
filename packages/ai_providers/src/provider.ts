import { modelRegistry } from "./models/index.js";
import {
  AssistantMessage,
  Context,
  ModelInfo,
  // Provider,
  ProviderId,
  // ProviderRegistry,
  StreamOptions,
  Usage,
} from "./types.js";
import { AssistantMessageEventStream } from "./utils/event-stream.js";

/**
 * Simple provider registry with current provider selection
 */
// export class ProviderManager implements ProviderRegistry {
//   private providers = new Map<ProviderId, Provider>();
//   private apiKeyOverrides = new Map<ProviderId, string>();

//   setProvider(provider: Provider): void {
//     this.providers.set(provider.id, provider);
//   }

//   deleteProvider(id: string): void {
//     this.providers.delete(id);
//     this.apiKeyOverrides.delete(id);
//   }

//   getProviders(): readonly Provider[] {
//     return Array.from(this.providers.values());
//   }

//   getProvider(id: string): Provider | undefined {
//     return this.providers.get(id);
//   }

//   getModels(providerId: string): readonly ModelInfo[] {
//     const provider = this.providers.get(providerId);
//     return provider?.getModels() || [];
//   }

//   getModel(providerId: string, modelId: string): ModelInfo | undefined {
//     const provider = this.providers.get(providerId);
//     return provider?.getModel(modelId);
//   }

//   setApiKey(providerId: string, apiKey: string): void {
//     this.apiKeyOverrides.set(providerId, apiKey);
//   }

//   hasApiKey(providerId: string): boolean {
//     return !!this.resolveApiKey(providerId);
//   }

//   requireProvider(id: ProviderId): Provider {
//     const provider = this.providers.get(id);
//     if (!provider) {
//       throw new Error(`Provider ${id} not found`);
//     }
//     return provider;
//   }

//   resolveApiKey(providerId: ProviderId): string | undefined {
//     const override = this.apiKeyOverrides.get(providerId);
//     if (override) return override;
//     const provider = this.providers.get(providerId);
//     if (!provider) return undefined;
//     return process.env[provider.auth.apiKeyEnvVar];
//   }

//   stream(
//     model: ModelInfo,
//     context: Context,
//     options?: StreamOptions,
//   ): AssistantMessageEventStream {
//     const provider = this.requireProvider(model.provider);
//     const apiKey = this.resolveApiKey(model.provider);

//     //if api key is not found, make a error stream event so that it can be consumed by the caller and displayed to the user
//     if (!apiKey) {
//       const stream = new AssistantMessageEventStream();
//       const errorEvent: AssistantMessage = {
//         role: "assistant",
//         content: [],
//         provider: model.provider,
//         model: model.id,
//         usage: {
//           input: 0,
//           output: 0,
//           cacheRead: 0,
//           cacheWrite: 0,
//           totalTokens: 0,
//           cost: { input: 0, output: 0, total: 0, cacheWrite: 0, cacheRead: 0 },
//         },
//         stopReason: "error",
//         errorMessage: `API key for provider ${model.provider} not found`,
//         timeStamp: Date.now(),
//       };
//       stream.push({ type: "error", error: errorEvent });
//       return stream;
//     }

//     return provider.stream(model, context, { ...options, apiKey });
//   }

//   complete(
//     model: ModelInfo,
//     context: Context,
//     options?: StreamOptions,
//   ): Promise<AssistantMessage> {
//     return this.stream(model, context, options).result();
//   }
// }

// export function createProviders() {
//   return new ProviderManager();
// }

// export function calculateCost(model: ModelInfo, usage: Usage): Usage["cost"] {
//   // TODO: implement cost calculation based on model pricing
//   // This is a placeholder implementation
//   return {
//     input: 0,
//     output: 0,
//     total: 0,
//     cacheWrite: 0,
//     cacheRead: 0,
//   };
// }

export function getModel(provider: ProviderId, modelId: string): ModelInfo {
  return modelRegistry.get(provider)?.get(modelId)!;
}

export function getProviders(): ProviderId[] {
  return Array.from(modelRegistry.keys());
}

export function getModels(provider: ProviderId): ModelInfo[] {
  const models = modelRegistry.get(provider);
  if (!models) {
    return [];
  }
  return Array.from(models.values());
}

export function calculateCost(model: ModelInfo, usage: Usage): Usage["cost"] {
  usage.cost.input = (model.cost.input / 1000000) * usage.input;
  usage.cost.output = (model.cost.output / 1000000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
  usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
  usage.cost.total =
    usage.cost.input +
    usage.cost.output +
    usage.cost.cacheRead +
    usage.cost.cacheWrite;
  return usage.cost;

  //TODO: calculate reasoning cost if possible
}
