import { lazyLoadModule } from "../utils/lazy.js";
/**
 * Creates an Anthropic stream using dynamic import for lazy loading
 * @returns A promise that resolves to the Anthropic stream function
 */
export const createAntropicStream = () => {
    return lazyLoadModule(() => import("./anthropic.js"));
};
//# sourceMappingURL=anthropic.lazy.js.map