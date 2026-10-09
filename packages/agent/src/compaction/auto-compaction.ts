import { isContextOverflow } from "@coding-harness/ai-providers";
import { Agent } from "../agent.js";
import { AgentMessage } from "../types.js";
import {
  CompactionResult,
  CompactionSettings,
  DEFAULT_COMPACTION_SETTINGS,
  compact,
  getLastAssistantUsage,
  calculateContextTokens,
  prepareCompaction,
  shouldCompact,
} from "./compaction.js";

export interface AutoCompactionOptions {
  agent: Agent;
  /** how to get the API key for the summarization call */
  getApiKey: (provider: string) => string | undefined | Promise<string | undefined>;
  settings?: Partial<CompactionSettings>;
  /** called when compaction starts / ends, for the UI */
  onStart?: (reason: "threshold" | "overflow" | "manual") => void;
  onEnd?: (result: CompactionResult | undefined, error?: Error) => void;
}

/**
 * Keeps an Agent's history inside the context window.
 *
 * Call `afterRun()` each time `agent.prompt()` has finished:
 *  - normal end, context above window - reserveTokens: compact, done.
 *  - provider rejected the request as too long: drop the failed assistant
 *    message, compact, and `agent.continue()` once to retry.
 */
export class AutoCompaction {
  private agent: Agent;
  private settings: CompactionSettings;
  private getApiKey: AutoCompactionOptions["getApiKey"];
  private onStart: AutoCompactionOptions["onStart"];
  private onEnd: AutoCompactionOptions["onEnd"];
  private controller?: AbortController;

  constructor(options: AutoCompactionOptions) {
    this.agent = options.agent;
    this.settings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.settings };
    this.getApiKey = options.getApiKey;
    this.onStart = options.onStart;
    this.onEnd = options.onEnd;
  }

  /** Cancel a running compaction */
  abort() {
    this.controller?.abort();
  }

  /** Check the finished run and compact if needed */
  async afterRun(): Promise<void> {
    const messages = this.agent.state.messages;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;

    if (isContextOverflow(last)) {
      // the failed request carries no usable usage; remove it and retry after compacting
      this.agent.replaceMessages(messages.slice(0, -1));
      const result = await this.run("overflow");
      if (result) await this.agent.continue();
      return;
    }

    if (last.stopReason === "error" || last.stopReason === "aborted") return;

    const usage = getLastAssistantUsage(messages);
    if (!usage) return;
    const tokens = calculateContextTokens(usage);
    if (shouldCompact(tokens, this.agent.state.model.contextWindow, this.settings)) {
      await this.run("threshold");
    }
  }

  /** Compact now, regardless of usage. Returns undefined if there is nothing to compact. */
  async compactNow(customInstructions?: string): Promise<CompactionResult | undefined> {
    return this.run("manual", customInstructions);
  }

  private async run(
    reason: "threshold" | "overflow" | "manual",
    customInstructions?: string,
  ): Promise<CompactionResult | undefined> {
    const messages: AgentMessage[] = this.agent.state.messages;
    const preparation = prepareCompaction(messages, this.settings);
    if (!preparation) {
      this.onEnd?.(undefined);
      return undefined;
    }

    this.onStart?.(reason);
    this.controller = new AbortController();
    try {
      const model = this.agent.state.model;
      const apiKey = await this.getApiKey(model.provider);
      if (!apiKey) throw new Error(`No API key for provider ${model.provider}`);

      const result = await compact(preparation, {
        model,
        apiKey,
        signal: this.controller.signal,
        customInstructions,
        streamFn: this.agent.streamFn,
      });
      this.agent.replaceMessages(result.messages);
      this.onEnd?.(result);
      return result;
    } catch (error) {
      this.onEnd?.(
        undefined,
        error instanceof Error ? error : new Error(String(error)),
      );
      return undefined;
    } finally {
      this.controller = undefined;
    }
  }
}
