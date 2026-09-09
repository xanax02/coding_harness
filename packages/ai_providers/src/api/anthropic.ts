import {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
} from "@anthropic-ai/sdk/resources";
import {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  ModelInfo,
  StreamOptions,
  TextContent,
  ToolResultMessage,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { Anthropic } from "@anthropic-ai/sdk";
import { transformMessages } from "../utils/tranform-messages";
import { sanitizeSurrogates } from "../utils/sanitize-unicodes";

export interface AnthropicOptions extends StreamOptions {
  thikingBudgetToken?: number;

  // TODO: Add more Anthropic-specific options (thinkingEnabled, efforts, etc.)
}

async function fetchStream(
  stream: AssistantMessageEventStream,
  options: AnthropicOptions,
  model: ModelInfo,
  context: Context,
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
    stopReason: "pending",
    timeStamp: Date.now(),
    errorMessage: "",
  };

  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: model.baseUrl,
  });

  try {
    const params = buildParams(model, context, options);
    const response = await client.messages.create(params);

    stream.push({ type: "start", partial: output });

    for await (const event of response) {
      console.log(event);
    }
  } catch (error) {
    console.error(error);
  }
}

export const stream = (
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();

  // fetchStream(stream);

  return stream;
};

export const buildParams = (
  model: ModelInfo,
  context: Context,
  options: AnthropicOptions,
): MessageCreateParamsStreaming => {
  const transformedMessages = transformMessages(
    context.messages,
    model,
    normalizeToolCallId,
  );

  //base params
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    max_tokens: options.maxTokens ?? model.maxTokens,
    stream: true,
    messages: [],
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

  //if tools are present in context, add them to params
  // if (context.tools && context.tools.length > 0) {
  //   params.tools = context.tools;
  // }

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
