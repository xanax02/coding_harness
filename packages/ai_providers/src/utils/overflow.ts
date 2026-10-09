import { AssistantMessage } from "../types.js";

/**
 * Patterns for provider errors that mean "the prompt does not fit in the context window".
 * Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * Anthropic 413: "request_too_large"
 */
const OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /exceeds the context window/i,
  /context length exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
];

/**
 * True if the assistant message is a context-overflow error.
 * Used as a fallback trigger for compaction when the usage-based check did not fire in time.
 */
export function isContextOverflow(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage));
}
