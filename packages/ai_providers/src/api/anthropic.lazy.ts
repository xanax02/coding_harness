import { lazyLoadModule } from "../utils/lazy";

/**
 * Creates an Anthropic stream using dynamic import for lazy loading
 * @returns A promise that resolves to the Anthropic stream function
 */
export const createAntropicStream = () => {
  return lazyLoadModule(() => import("./anthropic"));
};
