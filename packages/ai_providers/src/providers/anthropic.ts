// export function anthropicProvider(): Provider {
//   const modelsIdMap = new Map(
//     ANTHROPIC_MODELS.map((model) => [model.id, model]),
//   );

import { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources.js";
import {
  Context,
  ImageContent,
  ModelInfo,
  StreamOptions,
  TextContent,
} from "../types.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicodes.js";
import { transformMessages } from "../utils/tranform-messages.js";

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
        cache_control: {
          type: "ephemeral",
        },
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
