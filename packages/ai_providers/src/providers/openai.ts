import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { z } from "zod";
import { calculateCost } from "../provider.js";
import {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  ModelInfo,
  StopReason,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-helper.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicodes.js";
import { transformMessages } from "../utils/tranform-messages.js";

/**
 * Chat Completions provider. Works with OpenAI and any OpenAI-compatible endpoint
 * (OpenRouter, ...): the endpoint comes from `model.baseUrl`, the key from `options.apiKey`.
 */
export interface OpenAIOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "required" | { type: "function"; name: string };
}

const isOpenRouter = (model: ModelInfo) => model.baseUrl.includes("openrouter.ai");

export const openaiStream: StreamFunction = (
  model: ModelInfo,
  context: Context,
  options?: OpenAIOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();

  void fetchStream(stream, model, context, options);

  return stream;
};

type Block = TextContent | ThinkingContent | (ToolCall & { partialJson: string });

async function fetchStream(
  stream: AssistantMessageEventStream,
  model: ModelInfo,
  context: Context,
  options?: OpenAIOptions,
) {
  const output: AssistantMessage = {
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
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timeStamp: Date.now(),
    errorMessage: "",
  };

  try {
    const client = new OpenAI({
      apiKey: options?.apiKey,
      baseURL: model.baseUrl,
    });

    const params = buildOpenAIParams(model, context, options);
    const openaiStream = await client.chat.completions.create(params, {
      signal: options?.signal,
    });

    stream.push({ type: "start", partial: output });

    const blocks = output.content as Block[];
    // the one text/thinking block currently receiving deltas, and tool call blocks by stream index
    let current: TextContent | ThinkingContent | undefined;
    const toolBlocks = new Map<number, Block & { type: "toolCall" }>();

    const finishCurrent = () => {
      if (!current) return;
      const contentIndex = blocks.indexOf(current);
      if (current.type === "text") {
        stream.push({ type: "text_end", contentIndex, content: current.text, partial: output });
      } else {
        stream.push({
          type: "thinking_end",
          contentIndex,
          content: current.thinking,
          partial: output,
        });
      }
      current = undefined;
    };

    for await (const chunk of openaiStream) {
      if (chunk.usage) {
        applyUsage(output, chunk.usage, model);
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        const result = stopReasonMapper(choice.finish_reason);
        output.stopReason = result.stopReason;
        if (result.errorMessage) output.errorMessage = result.errorMessage;
      }

      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) {
        if (current?.type !== "text") {
          finishCurrent();
          current = { type: "text", text: "" };
          output.content.push(current);
          stream.push({
            type: "text_start",
            contentIndex: output.content.length - 1,
            partial: output,
          });
        }
        current.text += delta.content;
        stream.push({
          type: "text_delta",
          contentIndex: blocks.indexOf(current),
          delta: delta.content,
          partial: output,
        });
      }

      // reasoning text is not part of the OpenAI spec: OpenRouter sends `reasoning`,
      // DeepSeek-style endpoints send `reasoning_content`
      const d = delta as { reasoning?: string; reasoning_content?: string };
      const reasoning = d.reasoning || d.reasoning_content;
      if (reasoning) {
        if (current?.type !== "thinking") {
          finishCurrent();
          current = { type: "thinking", thinking: "" };
          output.content.push(current);
          stream.push({
            type: "thinking_start",
            contentIndex: output.content.length - 1,
            partial: output,
          });
        }
        current.thinking += reasoning;
        stream.push({
          type: "thinking_delta",
          contentIndex: blocks.indexOf(current),
          delta: reasoning,
          partial: output,
        });
      }

      for (const tc of delta.tool_calls ?? []) {
        let block = toolBlocks.get(tc.index);
        if (!block) {
          finishCurrent();
          block = {
            type: "toolCall",
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
            arguments: {},
            partialJson: "",
          };
          toolBlocks.set(tc.index, block);
          output.content.push(block);
          stream.push({
            type: "toolcall_start",
            contentIndex: output.content.length - 1,
            partial: output,
          });
        }
        if (tc.id) block.id = tc.id;
        if (tc.function?.name) block.name = tc.function.name;
        const argsDelta = tc.function?.arguments ?? "";
        block.partialJson += argsDelta;
        block.arguments = parseStreamingJson(block.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: blocks.indexOf(block),
          delta: argsDelta,
          partial: output,
        });
      }
    }

    finishCurrent();
    for (const block of toolBlocks.values()) {
      block.arguments = parseStreamingJson(block.partialJson);
      delete (block as { partialJson?: string }).partialJson;
      stream.push({
        type: "toolcall_end",
        contentIndex: blocks.indexOf(block),
        toolCall: block,
        partial: output,
      });
    }

    if (options?.signal?.aborted) {
      throw new Error("Request was aborted");
    }

    if (output.stopReason === "aborted" || output.stopReason === "error") {
      throw new Error(output.errorMessage || "An unknown error occurred");
    }

    stream.push({ type: "done", reason: output.stopReason, message: output });
    stream.end();
  } catch (error) {
    for (const block of output.content) {
      delete (block as { partialJson?: string }).partialJson;
    }
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage =
      error instanceof Error ? error.message : JSON.stringify(error);
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end();
  }
}

function applyUsage(
  output: AssistantMessage,
  usage: NonNullable<ChatCompletionChunk["usage"]>,
  model: ModelInfo,
) {
  // prompt_tokens already includes cached tokens; keep `input` as the uncached part
  const details = usage.prompt_tokens_details as
    | { cached_tokens?: number; cache_write_tokens?: number }
    | undefined;
  const cacheRead = details?.cached_tokens ?? 0;
  const cacheWrite = details?.cache_write_tokens ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;

  output.usage.cacheRead = cacheRead;
  output.usage.cacheWrite = cacheWrite;
  output.usage.input = Math.max(0, (usage.prompt_tokens ?? 0) - cacheRead - cacheWrite);
  output.usage.output = usage.completion_tokens ?? 0;
  if (reasoning != null) output.usage.reasoning = reasoning;
  // completion_tokens already counts reasoning tokens, so they are not added again
  output.usage.totalTokens =
    output.usage.input +
    output.usage.output +
    output.usage.cacheRead +
    output.usage.cacheWrite;
  calculateCost(model, output.usage);
}

export const buildOpenAIParams = (
  model: ModelInfo,
  context: Context,
  options?: OpenAIOptions,
): ChatCompletionCreateParamsStreaming => {
  const transformedMessages = transformMessages(context.messages, model);

  const params: ChatCompletionCreateParamsStreaming = {
    model: model.id,
    messages: convertMessages(model, context.systemPrompt, transformedMessages),
    stream: true,
    stream_options: { include_usage: true },
  };

  // OpenAI's newer models reject max_tokens; OpenAI-compatible servers mostly only know max_tokens
  const maxTokens = options?.maxTokens ?? model.maxTokens;
  if (model.baseUrl.includes("api.openai.com")) {
    params.max_completion_tokens = maxTokens;
  } else {
    params.max_tokens = maxTokens;
  }

  if (context.tools && context.tools.length > 0) {
    params.tools = convertTools(context.tools);
  }

  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }

  if (model.reasoning && options?.resoning) {
    if (isOpenRouter(model)) {
      (params as unknown as Record<string, unknown>).reasoning = {
        effort: options.resoning,
      };
    } else {
      params.reasoning_effort = options.resoning;
    }
  }

  if (options?.toolChoice) {
    params.tool_choice =
      typeof options.toolChoice === "string"
        ? options.toolChoice
        : { type: "function", function: { name: options.toolChoice.name } };
  }

  const userId = options?.metaData?.user_id;
  if (typeof userId === "string") {
    params.user = userId;
  }

  return params;
};

function convertUserContent(
  model: ModelInfo,
  content: (TextContent | ImageContent)[],
): ChatCompletionContentPart[] {
  const parts: ChatCompletionContentPart[] = [];
  for (const item of content) {
    if (item.type === "text") {
      if (item.text.trim().length === 0) continue;
      parts.push({ type: "text", text: sanitizeSurrogates(item.text) });
    } else if (model.input.includes("image")) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${item.mimeType};base64,${item.image}` },
      });
    }
  }
  return parts;
}

function convertMessages(
  model: ModelInfo,
  systemPrompt: string | undefined,
  transformedMessages: Message[],
): ChatCompletionMessageParam[] {
  const params: ChatCompletionMessageParam[] = [];

  if (systemPrompt) {
    // reasoning models take "developer", everything else (and compat servers) "system"
    const useDeveloper = model.reasoning && model.baseUrl.includes("api.openai.com");
    params.push({
      role: useDeveloper ? "developer" : "system",
      content: sanitizeSurrogates(systemPrompt),
    });
  }

  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          params.push({ role: "user", content: sanitizeSurrogates(msg.content) });
        }
      } else {
        const parts = convertUserContent(model, msg.content);
        if (parts.length === 0) continue;
        params.push({ role: "user", content: parts });
      }
    } else if (msg.role === "assistant") {
      const text = msg.content
        .flatMap((b) => (b.type === "text" && b.text.trim().length > 0 ? [b.text] : []))
        .join("");
      const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
      // thinking blocks are not sent back: Chat Completions has no field for them
      if (text.length === 0 && toolCalls.length === 0) continue;

      const assistant: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: text.length > 0 ? sanitizeSurrogates(text) : null,
      };
      if (toolCalls.length > 0) {
        assistant.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        }));
      }
      params.push(assistant);
    } else if (msg.role === "toolResult") {
      const result = msg as ToolResultMessage;
      const text = result.content
        .map((c) => (c.type === "text" ? c.text : "(image omitted)"))
        .join("\n");
      params.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: sanitizeSurrogates(text.length > 0 ? text : "(no output)"),
      });
    }
  }

  return params;
}

function convertTools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.parameters, { target: "draft-7" }) as Record<
        string,
        unknown
      >,
    },
  }));
}

function stopReasonMapper(reason: string): {
  stopReason: StopReason;
  errorMessage?: string;
} {
  switch (reason) {
    case "stop":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "tool_calls":
    case "function_call":
      return { stopReason: "toolUse" };
    case "content_filter":
      return {
        stopReason: "error",
        errorMessage: "The response was blocked by the provider's content filter",
      };
    case "error":
      return { stopReason: "error", errorMessage: "The provider reported an error" };
    default:
      return { stopReason: "stop" };
  }
}
