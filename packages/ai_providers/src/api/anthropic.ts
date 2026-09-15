import {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  RefusalStopDetails,
} from "@anthropic-ai/sdk/resources";
import {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  ModelInfo,
  StopReason,
  StreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { Anthropic } from "@anthropic-ai/sdk";
import { transformMessages } from "../utils/tranform-messages";
import { sanitizeSurrogates } from "../utils/sanitize-unicodes";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ServerSentEvent } from "@anthropic-ai/sdk/core/streaming.mjs";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-helper";
import { calculateCost } from "../provider";

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
]);

const claudeCodeTools = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "EnterPlanMode",
  "ExitPlanMode",
  "Skill",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];

// Create a lookup map for case-insensitive tool name matching
const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));
// Helper functions to convert between Claude Code tool names and standard tool names
const toClaudeCodeName = (name: string) =>
  ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
  if (tools && tools.length > 0) {
    const lowerName = name.toLowerCase();
    const matchedTool = tools.find(
      (tool) => tool.name.toLowerCase() === lowerName,
    );
    if (matchedTool) return matchedTool.name;
  }
  return name;
};

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

export interface AnthropicOptions extends StreamOptions {
  thinkingEnabled?: boolean;
  //for older models
  thinkingBudgetToken?: number;

  /**
   * Effort level for adaptive thinking models.
   * Controls how much thinking Claude allocates:
   * - "max": Always thinks with no constraints (Opus 4.6 only)
   * - "xhigh": Highest reasoning level (Opus 4.7+, Fable 5)
   * - "high": Always thinks, deep reasoning
   * - "medium": Moderate thinking, may skip for simple queries
   * - "low": Minimal thinking, skips for simple tasks
   * Ignored for older models.
   */
  effort?: AnthropicEffort;
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

interface SseDecoderState {
  event: string | null;
  data: string[];
  raw: string[];
}

///////////// sse handling ///////////////

/**
 * sse handling flow
 * using create.onResponse will return http response
 *
 * response.body is sent to iterateSSE
 * it will be binary readable stream having .read() with lock
 * the value is read from the event using .read() and then decoded
 * while decoding the
 * it will will extract the line based on \n\n or \r\n delimiter
 *  if no line break it will add the next chunk to buffer and then send to extract line
 * the result will be something like {line: "data:...", rest: "..."}
 * line is passed to decodeSseLine and rest becomes the buffer and again send to extract line
 *
 * decodeSseLine will parse the line and extract the event type and data and return ServerSentEvent typed object.
 * the line will be text like "event: message_start"
 * "data: {"type":"message_start",...}"
 * ""
 * decodeSseLine will only return the ServerSentEvent object when the line break delimiter arrives. or when the event is done.
 *
 * event and data will get stored in the state object and when the line break delimiter arrives, it will flush the event.
 *
 * and then iterateSSE will yield the ServerSentEvent object.
 */

/**
 * Iterates over the SSE stream and yields ServerSentEvent objects.
 * @param body The readable stream to iterate over.
 * @param signal An optional abort signal to stop the iteration.
 * @yields ServerSentEvent objects.
 */
async function* iterateSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  //state will hold the events data
  // and when the line break delimiter arrives, it will flush the event.
  const state: SseDecoderState = { event: null, data: [], raw: [] };
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request aborted");
      }

      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let extractedLine = extractLine(buffer);

      while (extractedLine) {
        buffer = extractedLine.rest;
        const event = decodeSseLine(extractedLine.line, state);

        if (event) {
          yield event;
        }
        extractedLine = extractLine(buffer);
      }
    }

    // if any buffer left, decode it and extract lines especially for the last event
    // so that it doesnot get corrupted.
    buffer += decoder.decode();
    let extractedLine = extractLine(buffer);
    while (extractedLine) {
      buffer = extractedLine.rest;
      const event = decodeSseLine(extractedLine.line, state);
      if (event) {
        yield event;
      }
      extractedLine = extractLine(buffer);
    }

    //if extractedLine returns null due to no line break above,
    //it will stiff be in buffer to handle.
    if (buffer.length > 0) {
      const event = decodeSseLine(buffer, state);
      if (event) {
        yield event;
      }
    }

    //flush any remaining event
    const event = flushSseEvent(state);
    if (event) {
      yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
  if (!state.event && state.data.length === 0) {
    return null;
  }

  const event: ServerSentEvent = {
    event: state.event,
    data: state.data.join("\n"),
    raw: [...state.raw],
  };
  state.event = null;
  state.data = [];
  state.raw = [];
  return event;
}

function decodeSseLine(
  line: string,
  state: SseDecoderState,
): ServerSentEvent | null {
  if (line === "") {
    return flushSseEvent(state);
  }

  state.raw.push(line);
  // if line is a comment remove it
  if (line.startsWith(":")) {
    return null;
  }

  const delimiterIndex = line.indexOf(":");
  const fieldName =
    delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
  let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);

  if (fieldName === "event") {
    state.event = value;
  } else if (fieldName === "data") {
    state.data.push(value);
  }

  return null;
}

/**
 * Extracts a single line from the buffer and returns it along with the remaining buffer.
 * @param text The buffer to extract from.
 * @returns An object containing the extracted line and the remaining buffer, or null if no line is found.
 */
const extractLine = (text: string): { line: string; rest: string } | null => {
  const lineBreakIndex = nextLineBreakIndex(text);
  if (lineBreakIndex === -1) {
    return null;
  }

  let nextIndex = lineBreakIndex + 1;
  if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
    nextIndex += 1;
  }

  return {
    line: text.slice(0, lineBreakIndex),
    rest: text.slice(nextIndex),
  };
};

function nextLineBreakIndex(text: string): number {
  const carriageReturnIndex = text.indexOf("\r");
  const newlineIndex = text.indexOf("\n");
  if (carriageReturnIndex === -1) {
    return newlineIndex;
  }
  if (newlineIndex === -1) {
    return carriageReturnIndex;
  }
  return Math.min(carriageReturnIndex, newlineIndex);
}

async function* iterateAnthropicEvents(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
  if (!response.body) {
    throw new Error(
      "Attempted to iterate over an Anthropic response with no body",
    );
  }

  //this is for the check if the stream is completed or not due to some error.
  let sawMessageStart = false;
  let sawMessageEnd = false;

  for await (const sse of iterateSSE(response.body, signal)) {
    if (sse.event === "error") {
      throw new Error(sse.data);
    }

    if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
      continue;
    }

    try {
      const event = parseJsonWithRepair(sse.data);
      if (event.type === "message_start") {
        sawMessageStart = true;
      } else if (event.type === "message_stop") {
        sawMessageEnd = true;
      }
      yield event;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
      );
    }
  }

  if (sawMessageStart && !sawMessageEnd) {
    throw new Error("Anthropic stream ended before message_stop");
  }
}

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
    model: "",
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

  const client = new Anthropic({
    apiKey: options?.apiKey,
    baseURL: model.baseUrl,
  });

  try {
    const params = buildParams(model, context, options);
    const requestOptions = {
      ...(options?.signal ? { signal: options.signal } : {}),
    };
    const response = await client.messages
      .create({ ...params, stream: true }, requestOptions)
      .asResponse();

    stream.push({ type: "start", partial: output });

    type Block = (
      | ThinkingContent
      | TextContent
      | (ToolCall & { partialJson: string })
    ) & { index: number };
    const blocks = output.content as Block[];

    for await (const event of iterateAnthropicEvents(
      response,
      options?.signal,
    )) {
      if (event.type === "message_start") {
        //on message_start set responseId and initial usage
        output.responseId = event.message.id;
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
        // event.type can be of multiple types -> text, thinking, redacted_thinking, tool_use
        //for text just create block and push in output content array with index also push this block to stream
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
          output.usage.cacheWrite;
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

export const stream = (
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();

  fetchStream(stream, model, context, options);

  return stream;
};

export const buildParams = (
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions,
): MessageCreateParamsStreaming => {
  const transformedMessages = transformMessages(
    context.messages,
    model,
    normalizeToolCallId,
  );

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
      },
    ];
  }

  // if tools are present in context, add them to params
  if (context.tools && context.tools.length > 0) {
    params.tools = convertTools(context.tools);
  }

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
      if (options.effort) {
        // The Anthropic SDK types can lag newly supported effort values such as "xhigh".
        params.output_config =
          options.effort === "xhigh"
            ? ({ effort: options.effort } as unknown as NonNullable<
                MessageCreateParamsStreaming["output_config"]
              >)
            : { effort: options.effort };
      }
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

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertMessages(
  transformedMessages: Message[],
  allowEmptySignature = false,
): MessageParam[] {
  const params: MessageParam[] = [];
  const loadedToolsNames = new Set<string>();

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
        const blocks: ContentBlockParam[] = msg.content.map((item) => {
          if (item.type === "text") {
            return {
              type: "text",
              text: sanitizeSurrogates(item.text),
            };
          } else {
            return {
              type: "image",
              source: {
                type: "base64",
                media_type: item.mimeType as
                  | "image/jpeg"
                  | "image/png"
                  | "image/gif"
                  | "image/webp",
                data: item.image,
              },
            };
          }
        });
        const filteredBlocks = blocks.filter((b) => {
          if (b.type === "text") {
            return b.text.trim().length > 0;
          }
          return true;
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
            !!thinkingSignature && thinkingSignature.trim().length > 0;
          if (block.thinking.trim().length === 0 && !hasThinkingSignature)
            continue;
          // If thinking signature is missing/empty (e.g., from aborted stream),
          // convert to plain text for Anthropic. Some compatible providers emit
          // and accept empty signatures, so let marked models preserve the block.
          if (!hasThinkingSignature) {
            blocks.push(
              allowEmptySignature
                ? {
                    type: "thinking",
                    thinking: sanitizeSurrogates(block.thinking),
                    signature: "",
                  }
                : {
                    type: "text",
                    text: sanitizeSurrogates(block.thinking),
                  },
            );
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
        const converted = convertToolResult(
          transformedMessages[j] as ToolResultMessage,
        );
        toolResults.push(...converted);
        j++;
      }

      i = j - 1;

      params.push({
        role: "user",
        content: toolResults,
      });
    }
  }

  //TODO: // add cache_control for last message if supported in future

  return params;
}

const convertToolResult = (msg: ToolResultMessage): ContentBlockParam[] => {
  const convertedContent = convertContentBlocks(msg.content);

  return [
    {
      type: "tool_result",
      tool_use_id: msg.toolCallId,
      content: convertedContent,
      is_error: msg.isError,
    },
  ];
};

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          source: {
            type: "base64";
            media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
            data: string;
          };
        }
    > {
  // If only text blocks, return as concatenated string for simplicity
  const hasImages = content.some((c) => c.type === "image");
  if (!hasImages) {
    return sanitizeSurrogates(
      content.map((c) => (c as TextContent).text).join("\n"),
    );
  }

  // If we have images, convert to content block array
  const blocks = content.map((block) => {
    if (block.type === "text") {
      return {
        type: "text" as const,
        text: sanitizeSurrogates(block.text),
      };
    }
    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: block.mimeType as
          | "image/jpeg"
          | "image/png"
          | "image/gif"
          | "image/webp",
        data: block.image,
      },
    };
  });

  // If only images (no text), add placeholder text block
  const hasText = blocks.some((b) => b.type === "text");
  if (!hasText) {
    blocks.unshift({
      type: "text" as const,
      text: "(see attached image)",
    });
  }

  return blocks;
}

function convertTools(tools: Tool[]): Anthropic.Messages.Tool[] {
  if (!tools) return [];

  return tools.map((tool, index) => {
    const schema = zodToJsonSchema(tool.parameters as any);

    return {
      name: toClaudeCodeName(tool.name),
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
  reason: Anthropic.Messages.StopReason | string,
  stopDetails?: RefusalStopDetails | null,
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

// const client = new Anthropic();

// const streamTest = await client.messages.create({
//   max_tokens: 1024,
//   messages: [{ role: "user", content: "Hello, Claude" }],
//   model: "claude-opus-5",
//   stream: true,
// });
// for await (const messageStreamEvent of streamTest) {
//   console.log(messageStreamEvent);
// }
