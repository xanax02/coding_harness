import {
  AssistantMessage,
  Context,
  EventStream,
  ToolResultMessage,
  validateToolArguments,
  stream as streamer,
} from "@coding-harness/ai-providers";
import {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  streamFn,
} from "./types.js";

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream<AgentEvent, AgentMessage[]>(
    (event: AgentEvent) => event.type === "agent_end",
    (event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
  );
}

/**
 * Starts agent loop for new prompt message
 * Prompt is added to context and events are emitted
 */
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal | undefined,
  streamFunction?: streamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();

  void backgroundRunLoop(
    prompts,
    context,
    config,
    stream,
    signal,
    streamFunction,
  ).then((messages) => stream.end(messages));

  return stream;
}

/**
 * agent loop for handling retries
 */
export function retryAgentLoop(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: streamFn,
) {
  if (context.messages.length === 0) {
    throw new Error("Cannot retry, no messages in context");
  }

  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot retry from assistant message");
  }

  const stream = createAgentStream();
  const prompts: AgentMessage[] = [];

  void backgroundRunLoop(
    prompts,
    context,
    config,
    stream,
    signal,
    streamFn,
  ).then((msg) => stream.end(msg));

  return stream;
}

export async function backgroundRunLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  signal: AbortSignal | undefined,
  streamFunction?: streamFn,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  stream.push({ type: "agent_start" });
  stream.push({ type: "iteration_start" });

  for (const prompt of prompts) {
    stream.push({ type: "message_start", message: prompt });
    stream.push({ type: "message_end", message: prompt });
  }

  await runLoop(
    currentContext,
    newMessages,
    config,
    signal,
    stream,
    streamFunction,
  );
  return newMessages;
}

//TODO: handle retries

async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  streamFunction?: streamFn,
): Promise<void> {
  let firstTurn = true;

  let pendingMessages: AgentMessage[] =
    (await config?.getSteeringMessages?.()) || [];

  // outerloop is handling any queued follow up messages given by user
  // still its there for future use
  while (true) {
    let hasMoreToolCalls = true;
    let steeringAfterTools: AgentMessage[] | null = null;

    // Inner loop -> process tool calls and steering messages
    while (hasMoreToolCalls && pendingMessages.length > 0) {
      if (!firstTurn) {
        stream.push({ type: "iteration_start" });
      } else {
        firstTurn = false;
      }

      //inject pending messages
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          stream.push({ type: "message_start", message });
          stream.push({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      // stream response
      const message = await streamAssistantResponse(
        currentContext,
        config,
        signal,
        stream,
        streamFunction,
      );
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "iteration_end", message, toolResults: [] });
        stream.push({ type: "agent_end", messages: newMessages });
        return;
      }

      //tool calls
      const toolCalls = message.content.filter((c) => c.type === "toolCall");
      hasMoreToolCalls = toolCalls.length > 0;

      const toolCallResults: ToolResultMessage[] = [];

      if (hasMoreToolCalls) {
        const executedToolCall = await executeToolCalls(
          currentContext.tools,
          message,
          signal,
          stream,
          config.getSteeringMessages,
        );
        toolCallResults.push(...executedToolCall.toolsResults);
        steeringAfterTools = executedToolCall.steeringMessages ?? null;

        for (const result of toolCallResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      stream.push({
        type: "iteration_end",
        message,
        toolResults: toolCallResults,
      });

      if (steeringAfterTools && steeringAfterTools.length > 0) {
        pendingMessages = steeringAfterTools;
        steeringAfterTools = null;
      } else {
        pendingMessages = (await config.getSteeringMessages?.()) || [];
      }
    }
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    // No more messages, exit
    break;
  }

  stream.push({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  streamFn?: streamFn,
): Promise<AssistantMessage> {
  //apply context transform if present
  //this includes pruning messages and stuff
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  //llm-compatible messages
  const llmMessages = await config.convertMessagesToLlm(messages);

  //llm context
  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  //resolve api
  const apiKey = config?.getApiKey
    ? await config.getApiKey(config.model.provider)
    : undefined;

  const streamFunction = streamFn || streamer;

  const response = await streamFunction(config.model, llmContext, {
    ...config,
    apiKey,
    signal,
  });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        stream.push({ type: "message_start", message: { ...partialMessage } });
        break;

      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          stream.push({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...partialMessage },
          });
        }
        break;
      case "done":
      case "error": {
        const finalMessage = await response.result();
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
        }
        if (!addedPartial) {
          stream.push({ type: "message_start", message: { ...finalMessage } });
        }
        stream.push({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
    }
  }

  const finalMessage = await response.result();
  if (addedPartial) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    stream.push({ type: "message_start", message: { ...finalMessage } });
  }
  stream.push({ type: "message_end", message: finalMessage });
  return finalMessage;
}

/**
 * Executes toolCalls from an assistant message
 * Filters out toolCalls from message params
 *
 *
 * @param currentContext
 * @param message
 * @param config
 * @param signal
 * @param emit
 * @returns
 */
async function executeToolCalls(
  tools: AgentTool[] | undefined,
  message: AssistantMessage,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  getSteeringMessages?: AgentLoopConfig["getSteeringMessages"],
): Promise<{
  toolsResults: ToolResultMessage[];
  steeringMessages?: AgentMessage[];
}> {
  const toolCalls = message.content.filter((c) => c.type === "toolCall");
  const results: ToolResultMessage[] = [];
  let steeringMessages: AgentMessage[] | undefined;

  for (let i = 0; i < toolCalls.length; i++) {
    const toolCall = toolCalls[i];
    const tool = tools?.find((t) => t.name === toolCall.name);

    stream.push({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    let result: AgentToolResult<any>;
    let isError = false;

    try {
      if (!tool) throw new Error(`Tool ${toolCall.name} not found`);

      const validatedArgs = validateToolArguments(tool, toolCall);
      result = await tool.execute(
        toolCall.id,
        validatedArgs,
        signal,
        (partialResult) => {
          stream.push({
            type: "tool_execution_update",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.arguments,
            partialResult,
          });
        },
      );
    } catch (error) {
      isError = true;
      result = {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        details: {},
      };
    }

    stream.push({
      type: "tool_execution_end",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result,
      isError,
    });

    const toolResultMessage: ToolResultMessage = {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: result.content,
      details: result.details,
      isError,
      timestamp: Date.now(),
    };

    results.push(toolResultMessage);
    stream.push({ type: "message_start", message: toolResultMessage });
    stream.push({ type: "message_end", message: toolResultMessage });

    //if steering messages are there, skip  remaining tool calsl
    if (getSteeringMessages) {
      const steeringMsgs = await getSteeringMessages();
      if (steeringMsgs.length > 0) {
        const remainingToolCalls = toolCalls.slice(i + 1);
        for (const skipCall of remainingToolCalls) {
          results.push(skipToolCall(skipCall, stream));
        }
      }
    }
  }

  return { toolsResults: results, steeringMessages };
}

function skipToolCall(
  toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
  stream: EventStream<AgentEvent, AgentMessage[]>,
): ToolResultMessage {
  const result: AgentToolResult<any> = {
    content: [{ type: "text", text: "Skipped due to queued user message." }],
    details: {},
  };

  stream.push({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
  });
  stream.push({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    isError: true,
  });

  const toolResultMessage: ToolResultMessage = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: {},
    isError: true,
    timestamp: Date.now(),
  };

  stream.push({ type: "message_start", message: toolResultMessage });
  stream.push({ type: "message_end", message: toolResultMessage });

  return toolResultMessage;
}
