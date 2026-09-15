import { z } from "zod";
import { AssistantMessageEventStream } from "./utils/event-stream";

export type KnownProvider = "openai" | "anthropic" | "google";
export type ProviderId = KnownProvider | string;

/**
 * Model cost interface
 */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Model info interface
 */
export interface ModelInfo {
  id: string;
  name: string;
  baseUrl: string;
  provider: ProviderId;
  input: ("text" | "image")[];
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;

  /** TODO: add compatibilities like longCacheRetention, etc. */
}

/**
 * Provider interface
 */
export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly auth: ProviderAuth;

  getModels(): readonly ModelInfo[];
  getModel(modelId: string): ModelInfo | undefined;

  stream(
    model: ModelInfo,
    context: Context,
    options?: StreamOptions,
  ): AssistantMessageEventStream;
}

export interface ProviderAuth {
  apiKeyEnvVar: string;
}

export interface ProviderRegistry {
  setProvider(provider: Provider): void;
  deleteProvider(id: string): void;

  getProviders(): readonly Provider[];
  getProvider(id: string): Provider | undefined;

  getModels(providerId: string): readonly ModelInfo[];
  getModel(providerId: string, modelId: string): ModelInfo | undefined;

  /** Explicit override; takes precedence over the provider's env var */
  setApiKey(providerId: string, apiKey: string): void;
  hasApiKey(providerId: string): boolean;

  stream(
    model: ModelInfo,
    context: Context,
    options?: StreamOptions,
  ): AssistantMessageEventStream;
  complete(
    model: ModelInfo,
    context: Context,
    options?: StreamOptions,
  ): Promise<AssistantMessage>;
}

/**
 * Context interfaces for AI agent
 */
export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}

////////// messages interfaces and types //////////////////
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  responseModel?: string; // Concrete `chunk.model` when different from the requested `model` (e.g. OpenRouter `auto` -> `anthropic/...`)
  responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
  content: (TextContent | ThinkingContent | ToolCall)[];
  provider: ProviderId;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage: string;
  timeStamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
}

export interface TextContent {
  type: "text";
  text: string;
  /**
   * Opaque signature from the provider for the text block eg. for gemini's tool call
   */
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /**
   * Provider-opaque signature for the thinking block,
   * cryptographically signed by the provider to know that the
   * thinking content is not tempered with
   */
  thinkingSignature?: string;
  /**
   * When thinking content is redacted by provider due to safety reasons
   * The opaque encrypted payload is stored in thinkingSignature
   */
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  image: string; //base64
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string; //google specific can be removed for now
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/////////// tools interfaces and types //////////////
export interface Tool<T extends z.ZodType = z.ZodObject<any>> {
  name: string;
  description: string;
  parameters: T;
}

// this is the default settings
// to be updated later with provider-specific settings
// if now found then fallback to these settings
export interface StreamOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** Resolved by Provider manager before reaching Provider.stream(); now to be set manually */
  apiKey?: string;

  metaData?: Record<string, unknown>;

  // TODO: add cache rentention config for better model performance
  // and enabling caching for tokens optimization
}

/**
 * To be documented
 */
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "text_end";
      contentIndex: number;
      content: string;
      partial: AssistantMessage;
    }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: ToolCall;
      partial: AssistantMessage;
    }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "thinking_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "thinking_end";
      contentIndex: number;
      content: string;
      partial: AssistantMessage;
    }
  | {
      type: "done";
      reason?: Extract<StopReason, "stop" | "length" | "toolUse">;
      message: AssistantMessage;
    }
  | {
      type: "error";
      reason?: Extract<StopReason, "error" | "aborted">;
      error: AssistantMessage;
    };
