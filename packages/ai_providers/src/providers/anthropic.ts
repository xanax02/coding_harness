import {
  ContentBlockParam,
  MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources";
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
import { sanitizeSurrogates } from "../utils/sanitize-unicodes.js";
import { transformMessages } from "../utils/tranform-messages.js";
import { MessageParam } from "@anthropic-ai/sdk/resources";
import { zodToJsonSchema } from "zod-to-json-schema";
import Anthropic from "@anthropic-ai/sdk";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { calculateCost } from "../provider.js";
import { parseStreamingJson } from "../utils/json-helper.js";

/**
 * Convert content blocks to Anthropic API format
 * for now only handling text blocks
 */
function convertContentBlocks(
  content: (TextContent | ImageContent)[],
): string | Array<{ type: "text"; text: string }> {
  // If only text blocks, return as concatenated string for simplicity
  const hasImages = content.some((c) => c.type === "image");
  if (!hasImages) {
    return sanitizeSurrogates(
      content.map((c) => (c as TextContent).text).join("\n"),
    );
  }

  // handling only text block
  const blocks = content.map((block) => {
    if (block.type === "text") {
      return {
        type: "text" as const,
        text: sanitizeSurrogates(block.text),
      };
    }
  });

  return blocks.filter((b) => b !== undefined);
}

export type AnthropicThinkingDisplay = "summarized" | "omitted";
export interface AnthropicOptions extends StreamOptions {
  thinkingEnabled?: boolean;
  //for older models
  thinkingBudgetToken?: number;
  /**
   * Controls how thinking content is returned in API responses.
   * - "summarized": Thinking blocks contain summarized thinking text.
   * - "omitted": Thinking blocks return an empty thinking field; the encrypted
   *   signature still travels back for multi-turn continuity. Use for faster
   *   time-to-first-text-token when your UI does not surface thinking.
   */
  thinkingDisplay?: AnthropicThinkingDisplay;
  /**
   * Anthropic tool choice behavior. String values map to Anthropic's built-in
   * choices; `{ type: "tool", name }` forces a specific tool.
   * Default: omitted (Anthropic default behavior, currently equivalent to auto).
   */
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
}

function getEnvApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY;
}

export const anthropicStream: StreamFunction = (
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();

  void fetchStream(stream, model, context, options);

  return stream;
};

async function fetchStream(
  stream: AssistantMessageEventStream,
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions,
) {
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    provider: "anthropic",
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timeStamp: Date.now(),
    errorMessage: "",
  };

  try {
    const client = new Anthropic({
      apiKey: options?.apiKey,
      baseURL: model.baseUrl,
    });

    const params = buildParams(model, context, options);
    const anthropicStream = client.messages.stream(
      { ...params, stream: true },
      { signal: options?.signal },
    );

    stream.push({ type: "start", partial: output });

    type Block = (
      | ThinkingContent
      | TextContent
      | (ToolCall & { partialJson: string })
    ) & { index: number };
    const blocks = output.content as Block[];

    for await (const event of anthropicStream) {
      // Capture initial token usage from message_start event
      // This ensures we have input token counts even if the stream is aborted early
      if (event.type === "message_start") {
        output.usage.input = event.message.usage.input_tokens || 0;
        output.usage.output = event.message.usage.output_tokens || 0;
        output.usage.cacheRead =
          event.message.usage.cache_read_input_tokens || 0;
        output.usage.cacheWrite =
          event.message.usage.cache_creation_input_tokens || 0;
        output.usage.totalTokens =
          output.usage.input +
          output.usage.output +
          output.usage.cacheRead +
          output.usage.cacheWrite;
        calculateCost(model, output.usage);
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "text") {
          const block: Block = {
            type: "text",
            text: "",
            index: event.index,
          };
          output.content.push(block);
          stream.push({
            type: "text_start",
            contentIndex: output.content.length - 1,
            partial: output,
          });
        } else if (event.content_block.type === "thinking") {
          const block: Block = {
            type: "thinking",
            thinking: "",
            thinkingSignature: "",
            index: event.index,
          };
          output.content.push(block);
          stream.push({
            type: "thinking_start",
            contentIndex: output.content.length - 1,
            partial: output,
          });
        } else if (event.content_block.type === "redacted_thinking") {
          const block: Block = {
            type: "thinking",
            thinking: "[Reasoning redacted]",
            thinkingSignature: event.content_block.data,
            redacted: true,
            index: event.index,
          };
          output.content.push(block);
          stream.push({
            type: "thinking_start",
            contentIndex: output.content.length - 1,
            partial: output,
          });
        } else if (event.content_block.type === "tool_use") {
          const block: Block = {
            type: "toolCall",
            id: event.content_block.id,
            name: event.content_block.name,
            arguments: (event.content_block.input as Record<string, any>) ?? {},
            partialJson: "",
            index: event.index,
          };
          output.content.push(block);
          stream.push({
            type: "toolcall_start",
            contentIndex: output.content.length - 1,
            partial: output,
          });
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          const index = blocks.findIndex((blk) => blk.index === event.index);
          const block = blocks[index];
          if (block && block.type === "text") {
            block.text += event.delta.text;
            stream.push({
              type: "text_delta",
              contentIndex: index,
              delta: event.delta.text,
              partial: output,
            });
          }
        } else if (event.delta.type === "thinking_delta") {
          const index = blocks.findIndex((b) => b.index === event.index);
          const block = blocks[index];
          if (block && block.type === "thinking") {
            block.thinking += event.delta.thinking;
            stream.push({
              type: "thinking_delta",
              contentIndex: index,
              delta: event.delta.thinking,
              partial: output,
            });
          }
        } else if (event.delta.type === "input_json_delta") {
          const index = blocks.findIndex((b) => b.index === event.index);
          const block = blocks[index];
          if (block && block.type === "toolCall") {
            block.partialJson += event.delta.partial_json;
            block.arguments = parseStreamingJson(block.partialJson);
            stream.push({
              type: "toolcall_delta",
              contentIndex: index,
              delta: event.delta.partial_json,
              partial: output,
            });
          }
        } else if (event.delta.type === "signature_delta") {
          const index = blocks.findIndex((b) => b.index === event.index);
          const block = blocks[index];
          if (block && block.type === "thinking") {
            block.thinkingSignature = block.thinkingSignature || "";
            block.thinkingSignature += event.delta.signature;
          }
        }
      } else if (event.type === "content_block_stop") {
        const index = blocks.findIndex((blk) => blk.index === event.index);
        const block = blocks[index];
        if (block) {
          delete (block as any).index;
          if (block.type === "text") {
            stream.push({
              type: "text_end",
              contentIndex: index,
              content: block.text,
              partial: output,
            });
          } else if (block.type === "thinking") {
            stream.push({
              type: "thinking_end",
              contentIndex: index,
              content: block.thinking,
              partial: output,
            });
          } else if (block.type === "toolCall") {
            block.arguments = parseStreamingJson(block.partialJson);
            delete (block as any).partialJson;
            stream.push({
              type: "toolcall_end",
              contentIndex: index,
              toolCall: block,
              partial: output,
            });
          }
        }
      } else if (event.type === "message_delta") {
        if (event.delta.stop_reason) {
          const stopReasonResult = stopReasonMapper(
            event.delta.stop_reason,
            event.delta.stop_details,
          );
          output.stopReason = stopReasonResult.stopReason;
          if (stopReasonResult.errorMessage) {
            output.errorMessage = stopReasonResult.errorMessage;
          }
        }
        if (event.usage) {
          if (event.usage.input_tokens != null) {
            output.usage.input = event.usage.input_tokens;
          }
          if (event.usage.output_tokens != null) {
            output.usage.output = event.usage.output_tokens;
          }
          if (event.usage.cache_read_input_tokens != null) {
            output.usage.cacheRead = event.usage.cache_read_input_tokens;
          }
          if (event.usage.cache_creation_input_tokens != null) {
            output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
          }
          const thinkingTokens = (
            event.usage as {
              output_tokens_details?: { thinking_tokens?: number };
            }
          ).output_tokens_details?.thinking_tokens;
          if (thinkingTokens != null) {
            output.usage.reasoning = thinkingTokens;
          }
        }
        output.usage.totalTokens =
          output.usage.input +
          output.usage.output +
          output.usage.cacheRead +
          output.usage.cacheWrite +
          (output.usage.reasoning ?? 0);
        calculateCost(model, output.usage);
      }
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
      delete (block as { index?: number }).index;
      delete (block as { partialJson?: string }).partialJson;
    }
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage =
      error instanceof Error ? error.message : JSON.stringify(error);
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end();
  }
}

export const buildParams = (
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions,
): MessageCreateParamsStreaming => {
  //TODO: handle OAuth

  const transformedMessages = transformMessages(context.messages, model);

  const anthropicCompatMessages = convertMessages(transformedMessages);

  //base params
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    max_tokens: options?.maxTokens ?? model.maxTokens,
    stream: true,
    messages: anthropicCompatMessages,
  };

  //if systemPrompt is present in context, add it to params
  if (context.systemPrompt) {
    params.system = [
      {
        type: "text",
        text: context.systemPrompt,
        cache_control: {
          type: "ephemeral",
        },
      },
    ];
  }

  // if tools are present in context, add them to params
  // if (context.tools && context.tools.length > 0) {
  //   params.tools = convertTools(context.tools);
  // }

  // Temperature is incompatible with extended thinking and unsupported on Claude Opus 4.7+.
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }

  //configure thiking mode
  // TODO: add logic to handle models compat for adaptive and extended thinking
  // currently this only supports adaptive type.
  if (model.reasoning) {
    if (options?.thinkingEnabled) {
      // Default to "summarized"
      const display: AnthropicThinkingDisplay =
        options.thinkingDisplay ?? "summarized";
      // Adaptive thinking: Claude decides when and how much to think.
      params.thinking = { type: "adaptive", display };
    } else if (options?.thinkingEnabled === false) {
      params.thinking = { type: "disabled" };
    }
  }

  if (options?.metaData) {
    const userId = options.metaData.user_id;
    if (typeof userId === "string") {
      params.metadata = { user_id: userId };
    }
  }

  if (options?.toolChoice) {
    if (typeof options.toolChoice === "string") {
      params.tool_choice = { type: options.toolChoice };
    } else {
      params.tool_choice = options.toolChoice;
    }
  }

  return params;
};

function convertMessages(transformedMessages: Message[]): MessageParam[] {
  const params: MessageParam[] = [];

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          params.push({
            role: "user",
            content: sanitizeSurrogates(msg.content),
          });
        }
      } else {
        const blocks: ContentBlockParam[] = msg.content.flatMap(
          //only handling text for first iteration
          (item: TextContent | ImageContent) => {
            if (item.type === "text") {
              return {
                type: "text",
                text: sanitizeSurrogates(item.text),
              };
            } else {
              return [];
            }
          },
        );
        const filteredBlocks = blocks.filter((b) => {
          b.type === "text" && b.text.trim().length > 0;
        });
        if (filteredBlocks.length === 0) continue;
        params.push({
          role: "user",
          content: filteredBlocks,
        });
      }
    } else if (msg.role === "assistant") {
      const blocks: ContentBlockParam[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) continue;
          blocks.push({
            type: "text",
            text: sanitizeSurrogates(block.text),
          });
        } else if (block.type === "thinking") {
          // Redacted thinking: pass the opaque payload back as redacted_thinking
          if (block.redacted) {
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature!,
            });
            continue;
          }
          const thinkingSignature = block.thinkingSignature;
          const hasThinkingSignature =
            thinkingSignature && thinkingSignature.trim().length > 0;
          if (block.thinking.trim().length === 0 && !hasThinkingSignature)
            continue;
          // If thinking signature is missing/empty (e.g., from aborted stream),
          // convert to plain text for Anthropic. Some compatible providers emit
          // and accept empty signatures, so let marked models preserve the block.
          if (!hasThinkingSignature) {
            blocks.push({
              type: "text",
              text: sanitizeSurrogates(block.thinking),
            });
          } else {
            blocks.push({
              type: "thinking",
              thinking: sanitizeSurrogates(block.thinking),
              signature: thinkingSignature,
            });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments ?? {},
          });
        }
      }
      if (blocks.length === 0) continue;
      params.push({
        role: "assistant",
        content: blocks,
      });
    } else if (msg.role === "toolResult") {
      const toolResults: ContentBlockParam[] = [];

      let j = i;
      while (
        j < transformedMessages.length &&
        transformedMessages[j].role === "toolResult"
      ) {
        const toolResultMessage = transformedMessages[j] as ToolResultMessage;
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolResultMessage.toolCallId,
          content: convertContentBlocks(toolResultMessage.content),
          is_error: toolResultMessage.isError,
        });
        j++;
      }

      i = j - 1;

      params.push({
        role: "user",
        content: toolResults,
      });
    }
  }

  //cache_control
  if (params.length > 0) {
    const lastMessage = params[params.length - 1];
    if (lastMessage.role === "user") {
      // Add cache control to the last content block
      if (Array.isArray(lastMessage.content)) {
        const lastBlock = lastMessage.content[lastMessage.content.length - 1];
        if (
          lastBlock &&
          (lastBlock.type === "text" ||
            lastBlock.type === "image" ||
            lastBlock.type === "tool_result")
        ) {
          lastBlock.cache_control = { type: "ephemeral" };
        }
      }
    }
  }

  return params;
}

function convertTools(tools: Tool[]): Anthropic.Messages.Tool[] {
  if (!tools) return [];

  return tools.map((tool) => {
    const schema = zodToJsonSchema(tool.parameters as any);

    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: (schema as any).properties ?? {},
        required: (schema as any).required ?? [],
      },
    };
  });
}

function stopReasonMapper(
  reason: string,
  stopDetails?: { explanation?: string | null } | null,
): { stopReason: StopReason; errorMessage?: string } {
  switch (reason) {
    case "end_turn":
      return { stopReason: "stop" };
    case "max_tokens":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "refusal":
      return {
        stopReason: "error",
        errorMessage:
          stopDetails?.explanation ||
          `The model refused to complete the request`,
      };
    case "pause_turn":
      return { stopReason: "stop" };
    case "stop_sequence":
      return { stopReason: "stop" };
    default:
      throw new Error(`Unhandled stop reason: ${reason}`);
  }
}
