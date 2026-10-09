import {
  getModel,
  Message,
  ModelInfo,
  ReasoningEffort,
  stream,
  TextContent,
} from "@coding-harness/ai-providers";
import {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentState,
  AgentTool,
  streamFn,
  ThinkingLevel,
} from "./types.js";
import { agentLoop, retryAgentLoop } from "./agent-loop.js";

interface AgentOptions {
  initialState?: Partial<AgentState>;

  convertToLlm?: (message: AgentMessage[]) => Message[] | Promise<Message[]>;

  /** for actions like pruning, injecting external context etc */
  transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => Promise<AgentMessage[]>;

  /**
   * Steering mode: "all" = send all steering messages at once, "one-at-a-time" = one per turn
   */
  steeringMode?: "all" | "one-at-a-time";

  /**
   * Follow-up mode: "all" = send all follow-up messages at once, "one-at-a-time" = one per turn
   */
  followUpMode?: "all" | "one-at-a-time";

  /**
   * Custom stream function
   */
  streamFn?: streamFn;

  getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
}

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m) =>
      m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );
}

/**
 * Stateful wrapper around agent llop
 * doesnot interact will LLM, delegates to agent loop
 */
export class Agent {
  private _state: AgentState = {
    systemPrompt: "",
    model: getModel("openrouter", "openai/gpt-4o-mini"),
    thinkingLevel: "off",
    tools: [],
    messages: [],
    isStreaming: false,
    streamMessage: null,
    pendingToolCalls: new Set<string>(),
    error: undefined,
  };

  private listeners = new Set<(e: AgentEvent) => void>(); //callbacks for agent events
  private abortController?: AbortController;
  private convertToLlm: (
    messages: AgentMessage[],
  ) => Message[] | Promise<Message[]>;
  private transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => Promise<AgentMessage[]>;
  private steeringQueue: AgentMessage[] = [];
  private followUpQueue: AgentMessage[] = [];
  private steeringMode: "all" | "one-at-a-time";
  private followUpMode: "all" | "one-at-a-time";
  public streamFn: streamFn;
  public getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
  private runningPrompt?: Promise<void>;
  private resolveRunningPrompt?: () => void;

  constructor(agentOptions: AgentOptions) {
    this._state = { ...this._state, ...agentOptions.initialState };
    this.convertToLlm = agentOptions.convertToLlm || defaultConvertToLlm;
    this.transformContext = agentOptions.transformContext;
    this.steeringMode = agentOptions.steeringMode || "one-at-a-time";
    this.followUpMode = agentOptions.followUpMode || "one-at-a-time";
    this.streamFn = agentOptions.streamFn || stream;
    this.getApiKey = agentOptions.getApiKey;
  }

  get state(): AgentState {
    return this._state;
  }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setSystemPrompt(v: string) {
    this._state.systemPrompt = v;
  }

  setModel(m: ModelInfo) {
    this._state.model = m;
  }
  setThinkingLevel(tl: ThinkingLevel) {
    this._state.thinkingLevel = tl;
  }

  setSteeringMode(mode: "all" | "one-at-a-time") {
    this.steeringMode = mode;
  }

  getSteeringMode(): "all" | "one-at-a-time" {
    return this.steeringMode;
  }

  setFollowUpMode(mode: "all" | "one-at-a-time") {
    this.followUpMode = mode;
  }

  getFollowUpMode(): "all" | "one-at-a-time" {
    return this.followUpMode;
  }

  setTools(tools: AgentTool<any>[]) {
    this._state.tools = tools;
  }

  replaceMessages(messages: AgentMessage[]) {
    this._state.messages = messages.slice(); // to get the completly different ref
  }

  appendMessage(message: AgentMessage) {
    this._state.messages = [...this._state.messages, message];
  }

  /**
   * interupt the agent mid-run after the current tool execution
   * drops the remaining tools
   */
  steer(message: AgentMessage) {
    this.steeringQueue.push(message);
  }

  followUp(message: AgentMessage) {
    this.followUpQueue.push(message);
  }

  clearSteeringQueue() {
    this.steeringQueue = [];
  }

  clearFollowUpQueue() {
    this.followUpQueue = [];
  }

  clearAllQueues() {
    this.steeringQueue = [];
    this.followUpQueue = [];
  }

  clearMessages() {
    this._state.messages = [];
  }

  /**
   * retuns a promise which allows to wait for the agent to finish its current run
   * if the agent is not running, returns a resolved promise
   */
  waitForIdle(): Promise<void> {
    return this.runningPrompt ?? Promise.resolve();
  }

  /** abort the current run (LLM stream and running tool); no-op when idle */
  abort() {
    this.abortController?.abort();
  }

  reset() {
    this._state.messages = [];
    this._state.isStreaming = false;
    this._state.streamMessage = null;
    this._state.pendingToolCalls = new Set<string>();
    this._state.error = undefined;
    this.steeringQueue = [];
    this.followUpQueue = [];
  }

  private emit(e: AgentEvent) {
    for (const listener of this.listeners) {
      listener(e);
    }
  }

  async prompt(input: string | AgentMessage | AgentMessage[]) {
    if (this._state.isStreaming) {
      throw new Error("Agent is already running");
    }

    const model = this._state.model;
    if (!model) throw new Error("No model provided");

    let msgs: AgentMessage[];

    if (Array.isArray(input)) {
      msgs = input;
    } else if (typeof input === "string") {
      const content: Array<TextContent> = [{ type: "text", text: input }];
      msgs = [
        {
          role: "user",
          content,
          timestamp: Date.now(),
        },
      ];
    } else {
      msgs = [input];
    }

    await this._runLoop(msgs);
  }

  /** Continue from current context (for retry after overflow) */
  async continue() {
    if (this._state.isStreaming) {
      throw new Error(
        "Agent is already processing. Wait for completion before continuing.",
      );
    }

    const messages = this._state.messages;
    if (messages.length === 0) {
      throw new Error("No messages to continue from");
    }
    if (messages[messages.length - 1].role === "assistant") {
      throw new Error("Cannot continue from message role: assistant");
    }

    await this._runLoop(undefined);
  }

  /**
   * runs agent loop
   */
  private async _runLoop(messages?: AgentMessage[]) {
    const model = this._state.model;
    if (!model) throw new Error("No model configured");

    this.runningPrompt = new Promise<void>((resolve) => {
      this.resolveRunningPrompt = resolve;
    });

    this.abortController = new AbortController();
    this._state.isStreaming = true;
    this._state.streamMessage = null;
    this._state.error = undefined;

    const reasoning: ReasoningEffort | undefined = this._state
      .thinkingLevel as ReasoningEffort;

    const context: AgentContext = {
      systemPrompt: this._state.systemPrompt,
      messages: this._state.messages.slice(), // to give a fresh copy to the stream function
      tools: this._state.tools,
    };

    const config: AgentLoopConfig = {
      model: model,
      resoning: reasoning,
      convertMessagesToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      getApiKey: this.getApiKey,
      getSteeringMessages: async () => {
        if (this.steeringMode === "one-at-a-time") {
          if (this.steeringQueue.length > 0) {
            const first = this.steeringQueue[0];
            this.steeringQueue = this.steeringQueue.slice(1);
            return [first];
          }
          return [];
        } else {
          const steering = this.steeringQueue.slice();
          this.steeringQueue = [];
          return steering;
        }
      },
      getFollowUpMessages: async () => {
        if (this.followUpMode === "one-at-a-time") {
          if (this.followUpQueue.length > 0) {
            const first = this.followUpQueue[0];
            this.followUpQueue = this.followUpQueue.slice(1);
            return [first];
          }
          return [];
        } else {
          const followUp = this.followUpQueue.slice();
          this.followUpQueue = [];
          return followUp;
        }
      },
    };

    let partial: AgentMessage | null = null;

    try {
      const stream = messages
        ? agentLoop(
            messages,
            context,
            config,
            this.abortController.signal,
            this.streamFn,
          )
        : retryAgentLoop(
            context,
            config,
            this.abortController.signal,
            this.streamFn,
          );

      // handling only those events which changes agent state
      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            partial = event.message;
            this._state.streamMessage = event.message;
            break;

          case "message_update":
            partial = event.message;
            this._state.streamMessage = event.message;
            break;

          case "message_end":
            partial = null;
            this._state.streamMessage = null;
            this.appendMessage(event.message);
            break;

          case "tool_execution_start": {
            const s = new Set(this._state.pendingToolCalls);
            s.add(event.toolCallId);
            this._state.pendingToolCalls = s;
            break;
          }

          case "tool_execution_end": {
            const s = new Set(this._state.pendingToolCalls);
            s.delete(event.toolCallId);
            this._state.pendingToolCalls = s;
            break;
          }
          case "iteration_end":
            if (
              event.message.role === "assistant" &&
              (event.message as any).errorMessage
            ) {
              this._state.error = (event.message as any).errorMessage;
            }
            break;

          case "agent_end":
            this._state.isStreaming = false;
            this._state.streamMessage = null;
            break;
        }

        this.emit(event);
      }

      //handling remaining partial message
      if (
        partial &&
        partial.role === "assistant" &&
        partial.content.length > 0
      ) {
        const onlyEmpty = !partial.content.some(
          (c) =>
            (c.type === "thinking" && c.thinking.trim().length > 0) ||
            (c.type === "text" && c.text.trim().length > 0) ||
            (c.type === "toolCall" && c.name.trim().length > 0),
        );
        if (!onlyEmpty) {
          this.appendMessage(partial);
        } else {
          if (this.abortController?.signal.aborted) {
            throw new Error("Request was aborted");
          }
        }
      }
    } catch (error: any) {
      const agentErrorMsg: AgentMessage = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: this.abortController?.signal.aborted ? "aborted" : "error",
        errorMessage: error?.message || String(error),
        timeStamp: Date.now(),
      } as AgentMessage;

      this.appendMessage(agentErrorMsg);
      this._state.error = error?.message || String(error);
      this.emit({ type: "agent_end", messages: [agentErrorMsg] });
    } finally {
      this._state.isStreaming = false;
      this._state.streamMessage = null;
      this._state.pendingToolCalls = new Set<string>();
      this.abortController = undefined;
      this.resolveRunningPrompt?.();
      this.runningPrompt = undefined;
      this.resolveRunningPrompt = undefined;
    }
  }
}
