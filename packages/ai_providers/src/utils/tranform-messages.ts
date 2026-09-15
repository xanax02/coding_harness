import {
  AssistantMessage,
  ImageContent,
  Message,
  ModelInfo,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from "../types.js";

const NON_VISION_USER_IMAGE_PLACEHOLDER =
  "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER =
  "(tool image omitted: model does not support images)";

/**
 * This util function will normalize the content blocks
 * especially the toolCall ids according to the callback provided for each provider
 * eg anthropic support ids of 64char with specific regex and openai has 450+ chars
 */
export function transformMessages(
  messages: Message[],
  model: ModelInfo,
  normalizeToolCallIdsCallback?: (
    id: string,
    model: ModelInfo,
    source: AssistantMessage,
  ) => string,
): Message[] {
  //map of original toolcall ids -> normalizeIds
  const toolCallIdMap = new Map<string, string>();

  //normalizing null, undefined content blocks
  const normalizedMessages = messages.map((msg) =>
    msg.content === null ? { ...msg, content: [] } : msg,
  );

  //removing images if not supported in model.input
  const imageAwareMessages = filterUnsupportedImages(normalizedMessages, model);

  //transform messages (unsupported image downgrade, thinking blocks handling, tool call id normalization)
  const transformedMessages = imageAwareMessages.map((msg) => {
    // user message unchanged
    if (msg.role === "user") {
      return msg;
    }

    // tool result message - normalize toolCallid
    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      if (normalizedId && normalizedId !== msg.toolCallId) {
        return {
          ...msg,
          toolCallId: normalizedId,
        };
      }
    }

    // assistant message
    if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantMessage;
      //for cross-model messages certain signatures needs to be removed
      const isSameModel =
        assistantMsg.model === model.id &&
        assistantMsg.provider === model.provider;

      const transformedContent = assistantMsg.content.flatMap((block: AssistantMessage["content"][number]) => {
        if (block.type === "thinking") {
          // Drop redacted for cross-model messages
          if (block.redacted) {
            return isSameModel ? block : [];
          }
          // For same model: keep thinking blocks with signatures (needed for replay)
          // even if the thinking text is empty (OpenAI encrypted reasoning)
          if (isSameModel && block.thinkingSignature) return block;
          // Skip empty thinking blocks, convert others to plain text
          if (!block.thinking || block.thinking.trim() === "") return [];
          if (isSameModel) return block;
          return {
            type: "text" as const,
            text: block.thinking,
          };
        }

        if (block.type === "text") {
          if (isSameModel) return block;
          return {
            type: "text" as const,
            text: block.text,
          };
        }

        if (block.type === "toolCall") {
          const toolCall = block as ToolCall;
          let normalizedToolCall: ToolCall = toolCall;

          if (!isSameModel && toolCall.thoughtSignature) {
            normalizedToolCall = { ...toolCall };
            delete (normalizedToolCall as { thoughtSignature?: string })
              .thoughtSignature;
          }

          if (!isSameModel && normalizeToolCallIdsCallback) {
            const normalizedId = normalizeToolCallIdsCallback(
              toolCall.id,
              model,
              assistantMsg,
            );
            if (normalizedId !== toolCall.id) {
              toolCallIdMap.set(toolCall.id, normalizedId);
              normalizedToolCall = {
                ...normalizedToolCall,
                id: normalizedId,
              };
            }
          }

          return normalizedToolCall;
        }

        return block;
      });

      return {
        ...assistantMsg,
        content: transformedContent,
      };
    }
    return msg;
  });

  //second pass - handling orphaned tool calls
  // it will add synthetic tool results for tool calls that don't have a corresponding tool result
  const result: Message[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();
  const insertSyntheticToolResults = () => {
    if (pendingToolCalls.length > 0) {
      for (const tc of pendingToolCalls) {
        if (!existingToolResultIds.has(tc.id)) {
          result.push({
            role: "toolResult",
            toolCallId: tc.id,
            toolName: tc.name,
            content: [{ type: "text", text: "No result provided" }],
            isError: true,
            timestamp: Date.now(),
          } as ToolResultMessage);
        }
      }
      pendingToolCalls = [];
      existingToolResultIds = new Set();
    }
  };

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];

    if (msg.role === "assistant") {
      // If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
      insertSyntheticToolResults();

      // Skip errored/aborted assistant messages entirely.
      const assistantMsg = msg as AssistantMessage;
      if (
        assistantMsg.stopReason === "error" ||
        assistantMsg.stopReason === "aborted"
      ) {
        continue;
      }

      // Track tool calls from this assistant message
      const toolCalls = assistantMsg.content.filter(
        (b: AssistantMessage["content"][number]) => b.type === "toolCall",
      ) as ToolCall[];
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }

      result.push(msg);
    } else if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
    } else if (msg.role === "user") {
      // User message interrupts tool flow - insert synthetic results for orphaned calls
      insertSyntheticToolResults();
      result.push(msg);
    } else {
      result.push(msg);
    }
  }

  // If the conversation ends with unresolved tool calls, synthesize results now.
  insertSyntheticToolResults();

  return result;
}

export function filterUnsupportedImages(messages: Message[], model: ModelInfo) {
  if (model.input.includes("image")) {
    return messages;
  }

  return messages.map((msg) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: replaceImagesWithPlaceholder(
          msg.content,
          NON_VISION_USER_IMAGE_PLACEHOLDER,
        ),
      };
    }

    if (msg.role === "toolResult") {
      return {
        ...msg,
        content: replaceImagesWithPlaceholder(
          msg.content,
          NON_VISION_TOOL_IMAGE_PLACEHOLDER,
        ),
      };
    }

    return msg;
  });
}

function replaceImagesWithPlaceholder(
  content: (TextContent | ImageContent)[],
  placeholder: string,
): TextContent[] {
  const result: TextContent[] = [];
  let previousWasPlaceholder = false;

  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder) {
        result.push({ type: "text", text: placeholder });
      }
      previousWasPlaceholder = true;
      continue;
    }

    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
  }

  return result;
}
