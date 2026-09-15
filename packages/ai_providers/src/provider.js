import { AssistantMessageEventStream } from "./utils/event-stream.js";
/**
 * Simple provider registry with current provider selection
 */
export class ProviderManager {
    providers = new Map();
    apiKeyOverrides = new Map();
    setProvider(provider) {
        this.providers.set(provider.id, provider);
    }
    deleteProvider(id) {
        this.providers.delete(id);
        this.apiKeyOverrides.delete(id);
    }
    getProviders() {
        return Array.from(this.providers.values());
    }
    getProvider(id) {
        return this.providers.get(id);
    }
    getModels(providerId) {
        const provider = this.providers.get(providerId);
        return provider?.getModels() || [];
    }
    getModel(providerId, modelId) {
        const provider = this.providers.get(providerId);
        return provider?.getModel(modelId);
    }
    setApiKey(providerId, apiKey) {
        this.apiKeyOverrides.set(providerId, apiKey);
    }
    hasApiKey(providerId) {
        return !!this.resolveApiKey(providerId);
    }
    requireProvider(id) {
        const provider = this.providers.get(id);
        if (!provider) {
            throw new Error(`Provider ${id} not found`);
        }
        return provider;
    }
    resolveApiKey(providerId) {
        const override = this.apiKeyOverrides.get(providerId);
        if (override)
            return override;
        const provider = this.providers.get(providerId);
        if (!provider)
            return undefined;
        return process.env[provider.auth.apiKeyEnvVar];
    }
    stream(model, context, options) {
        const provider = this.requireProvider(model.provider);
        const apiKey = this.resolveApiKey(model.provider);
        //if api key is not found, make a error stream event so that it can be consumed by the caller and displayed to the user
        if (!apiKey) {
            const stream = new AssistantMessageEventStream();
            const errorEvent = {
                role: "assistant",
                content: [],
                provider: model.provider,
                model: model.id,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, total: 0, cacheWrite: 0, cacheRead: 0 },
                },
                stopReason: "error",
                errorMessage: `API key for provider ${model.provider} not found`,
                timeStamp: Date.now(),
            };
            stream.push({ type: "error", error: errorEvent });
            return stream;
        }
        return provider.stream(model, context, { ...options, apiKey });
    }
    complete(model, context, options) {
        return this.stream(model, context, options).result();
    }
}
export function createProviders() {
    return new ProviderManager();
}
export function calculateCost(model, usage) {
    // TODO: implement cost calculation based on model pricing
    // This is a placeholder implementation
    return {
        input: 0,
        output: 0,
        total: 0,
        cacheWrite: 0,
        cacheRead: 0,
    };
}
//# sourceMappingURL=provider.js.map