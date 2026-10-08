// export function anthropicProvider(): Provider {
//   const modelsIdMap = new Map(
//     ANTHROPIC_MODELS.map((model) => [model.id, model]),
//   );

import {
  ContentBlockParam,
  MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources.js";
import {
  Context,
  ImageContent,
  Message,
  ModelInfo,
  StreamOptions,
  TextContent,
  ToolResultMessage,
} from "../types.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicodes.js";
import { transformMessages } from "../utils/tranform-messages.js";
import { MessageParam } from "@anthropic-ai/sdk/resources";

//   return {
//     id: "anthropic",
//     name: "Anthropic",
//     baseUrl: ANTHROPIC_BASE_URL,
//     auth: { apiKeyEnvVar: "ANTHROPIC_API_KEY" },

//     getModels(): readonly ModelInfo[] {
//       return ANTHROPIC_MODELS;
//     },

//     getModel(modelId: string): ModelInfo | undefined {
//       return modelsIdMap.get(modelId);
//     },

//     stream(model: ModelInfo, context: Context, options?: StreamOptions): AssistantMessageEventStream {
//       return createAntropicStream().stream(model, context, options);
//     },
//   };
// }

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

export const buildParams = (
  model: ModelInfo,
  context: Context,
  options?: AnthropicOptions,
): MessageCreateParamsStreaming => {
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
