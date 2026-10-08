import {
  AssistantMessage,
  ImageContent,
  Message,
  ModelInfo,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from "../types.js";

const NON_VISION_USER_IMAGE_PLACEHOLDER =
  "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER =
  "(tool image omitted: model does not support images)";

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/**
 * This util function will normalize the content blocks
 * especially the toolCall ids according to the callback provided for each provider
 * eg anthropic support ids of 64char with specific regex and openai has 450+ chars
 */
export function transformMessages(
  messages: Message[],
  model: ModelInfo,
): Message[] {
  //map of original toolcall ids -> normalizeIds
  const toolCallIdMap = new Map<string, string>();

  //first pass -> normalizing ids and removing signature block if model changes
  const transformedMessages = messages.map((msg) => {
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
      return msg;
    }

    // assistant message
    if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantMessage;

      if (
        assistantMsg.model === model.id &&
        assistantMsg.provider === model.provider
      ) {
        return msg;
      }

      const transformedContent = assistantMsg.content.flatMap((block): (TextContent | ThinkingContent | ToolCall)[] => {
        if (block.type === "thinking") {
          if (!block.redacted && block.thinking?.trim() !== "") {
            return [{
              type: "text" as const,
              text: block.thinking,
            } as TextContent];
          }
          // drop redacted or empty thinking blocks
          return [];
        }

        // remove signatures for cross-model messages
        if (block.type === "text") {
          return [{
            type: "text" as const,
            text: block.text,
          } as TextContent];
        }

        if (block.type === "toolCall") {
          const toolCall = block as ToolCall;
          let normalizedToolCall: ToolCall = toolCall;

          if (toolCall.thoughtSignature) {
            normalizedToolCall = { ...toolCall };
            delete normalizedToolCall.thoughtSignature;
          }

          const normalizedId = normalizeToolCallId(toolCall.id);
          if (normalizedId !== toolCall.id) {
            toolCallIdMap.set(toolCall.id, normalizedId);
            normalizedToolCall = {
              ...normalizedToolCall,
              id: normalizedId,
            };
          }
          return [normalizedToolCall];
        }

        return [block];
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
        (b) => b.type === "toolCall",
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
