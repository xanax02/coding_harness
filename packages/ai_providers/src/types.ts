import { z } from "zod";

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
}

/**
 * Provider interface
 */
export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly auth: string; // this needs to be changed

  getModels(): readonly ModelInfo[];
  getModel(modelId: string): ModelInfo | undefined;

  //   stream(model: ModelInfo, context: Context)
}

export interface ProviderRegistry {
  setProvider(provider: Provider): void;
  deleteProvider(id: string): void;
  clearProviders(): void;

  getProviders(): readonly Provider[];
  getProvider(id: string): Provider | undefined;

  getModels(prividerId: string): readonly ModelInfo[];
  // setModel(providerId: string)
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
  thoughtSignature?: string;
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
    cahcheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type StopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted";

/////////// tools interfaces and types //////////////
export interface Tool<T extends z.ZodType = z.ZodObject<any>> {
  name: string;
  description: string;
  parameters: T;
}
