import {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  ModelInfo,
  StreamOptions,
  TextContent,
  Tool,
  ToolResultMessage,
  Usage,
} from "@coding-harness/ai-providers";
import { z } from "zod";

export type streamFn = (
  model: ModelInfo,
  content: Context,
  options?: StreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** Tool definition */
export interface AgentTool<
  TSchema extends z.ZodType = z.ZodObject<any>,
  TDetails = unknown,
> extends Tool<TSchema> {
  label: string;
  prepareArguments?: (args: unknown) => z.infer<TSchema>;
  execute: (
    toolCallId: string,
    params: z.infer<TSchema>,
    signal?: AbortSignal | undefined,
    // onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}

export interface AgentToolResult<TDetails = unknown> {
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  usage?: Usage;
}

export type AgentMessage = Message;

export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool<any>[];
}

export interface AgentLoopConfig extends StreamOptions {
  model: ModelInfo;
  /**
   * * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
   *
   * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
   * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
   * status messages) should be filtered out.
   */
  convertMessagesToLlm: (
    messages: AgentMessage[],
  ) => Message[] | Promise<Message[]>;
  /**
   * Optional transform applied to the context before `convertToLlm`.
   *
   * Use this for operations that work at the AgentMessage level:
   * - Context window management (pruning old messages)
   * - Injecting context from external sources
   */
  transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;

  /**
   * resolve api key
   */
  getApiKey?: (
    provider: string,
  ) => string | undefined | Promise<string | undefined>;

  // TODO: added optional methods to handle model, provider changes to update context accordingly
  // TODO: add optional method to handle steering messages

  /**
   * Tool execution mode.
   * - "sequential": execute tool calls one by one
   * - "parallel": preflight tool calls sequentially, then execute allowed tools concurrently;
   *   emit `tool_execution_end` in tool completion order after each tool is finalized,
   *   then emit tool-result message artifacts later in assistant source order
   *
   * Default: "parallel"
   */
  toolExecution?: "sequential" | "parallel";
  /**
   * Returns steering messages to inject into the conversation mid-run.
   *
   * Called after the current assistant turn finishes executing its tool calls
   * If messages are returned, they are added to the context before the next LLM call.
   * Tool calls from the current assistant message are not skipped.
   *
   * Use case: "Steering" the agent while it's working, e.g., injecting user feedback
   * or corrections without waiting for the agent to finish its current task.
   */
  getSteeringMessages?: () => Promise<AgentMessage[]>;
}

export type AgentEvent =
  // Agent begin processing prompt
  | { type: "agent_start" }
  // Emitted when agent finishes; includes final message
  | { type: "agent_end"; messages: AgentMessage[] }
  //Turn lifecycle -> one assistant response + tool calls/results
  | { type: "iteration_start" }
  | {
      type: "iteration_end";
      message: AgentMessage;
      toolResults: ToolResultMessage[];
    }
  // Message lifecycle - emitted for user, assistant, and toolResult messages
  | { type: "message_start"; message: AgentMessage }
  // Only emitted for assistant messages during streaming
  | {
      type: "message_update";
      message: AgentMessage;
      assistantMessageEvent: AssistantMessageEvent;
    }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution lifecycle
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: any;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: any;
      partialResult: any;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: any;
      isError: boolean;
    };

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;
