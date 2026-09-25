import {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ToolCall,
  ToolResultMessage,
  validateToolArguments,
} from "@coding-harness/ai-providers";
import {
  AgentContext,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  FinalizedToolCallOutcome,
  ImmediateToolCallOutcome,
  PreparedToolCall,
  streamFn,
} from "./types.js";

export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  streamFunction: streamFn,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();

  return stream;
}

export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFunction: streamFn,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "iteration_start" });

  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(
    currentContext,
    newMessages,
    config,
    signal,
    emit,
    streamFunction,
  );
  return newMessages;
}

async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFunction: streamFn,
): Promise<void> {
  let firstTurn = true;

  let pendingMessages: AgentMessage[] =
    (await config?.getSteeringMessages?.()) || [];

  while (true) {
    let hasMoreToolCalls = true;

    // Inner loop -> process tool calls and steering messages
    while (hasMoreToolCalls && pendingMessages.length > 0) {
      if (!firstTurn) {
        emit({ type: "iteration_start" });
      } else {
        firstTurn = false;
      }

      //inject pending messages
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
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
        emit,
        streamFunction,
      );
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "iteration_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // Check for tool calls
      const toolCalls = message.content.filter((c) => c.type === "toolCall");

      const toolCallResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;

      if (toolCalls.length > 0) {
        const executedToolBatch =
          message.stopReason === "length"
            ? await failAllToolCalls(toolCalls, emit)
            : await executeToolCalls(
                currentContext,
                message,
                config,
                signal,
                emit,
              );
        toolCallResults.push(...executedToolBatch.messages);
        // hasMoreToolCalls = !executedToolBatch.terminate;

        for (const result of toolCallResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }
    }
  }
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFunction: streamFn,
): Promise<AssistantMessage> {
  //apply context transform if present
  //this includes pruning messages and stuff
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(context.messages);
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

  const response = await streamFunction(config.model, llmContext, {
    ...config,
    apiKey,
    signal,
  });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  return response.result;
}

//when the stop reason is length, all the tools calls should get failed
// as incomplete args can be there due to truncation
// json can be still valid but args can be incomplete and we have no way to know which tool call will have
// these incomplete args so failing all
async function failAllToolCalls(
  toolCalls: AgentToolCall[],
  emit: AgentEventSink,
) {
  const messages: ToolResultMessage[] = [];
  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const finalized: FinalizedToolCallOutcome = {
      toolCall,
      result: createErrorToolResult(
        `Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
      ),
      isError: true,
    };

    await emitToolExecutionEnd(finalized, emit);
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    messages.push(toolResultMessage);
  }
  return { messages, terminate: false };
}

function createErrorToolResult(message: string): AgentToolResult<any> {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}
async function emitToolExecutionEnd(
  finalized: FinalizedToolCallOutcome,
  emit: AgentEventSink,
): Promise<void> {
  await emit({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
  });
}

function createToolResultMessage(
  finalized: FinalizedToolCallOutcome,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    content: finalized.result.content ?? [],
    isError: finalized.isError,
    timestamp: Date.now(),
    usage: finalized.result.usage,
    details: finalized.result.details,
  };
}

async function emitToolResultMessage(
  toolResultMessage: ToolResultMessage,
  emit: AgentEventSink,
): Promise<void> {
  await emit({ type: "message_start", message: toolResultMessage });
  await emit({ type: "message_end", message: toolResultMessage });
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
  currentContext: AgentContext,
  message: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<{ messages: ToolResultMessage<any>[] }> {
  //filter toolCalls from all assitant messages
  const toolCalls = message.content.filter((msg) => msg.type === "toolCall");

  //TODO: in future add parallel execution support
  // this is exeucuting tools sequentially
  const toolCallResultsMessages: ToolResultMessage<any>[] = [];
  const finalizedCalls: FinalizedToolCallOutcome[] = [];

  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparedToolCall = await prepareToolCall(
      currentContext,
      message,
      toolCall,
      config,
      signal,
    );

    let finalized: FinalizedToolCallOutcome;
    if (preparedToolCall.kind === "immediate") {
      finalized = {
        toolCall,
        result: preparedToolCall.result,
        isError: preparedToolCall.isError,
      };
    } else {
      const executedToolCall = await executePreparedToolCall(
        preparedToolCall,
        signal,
        emit,
      );
      // TODO: for after execution hook handle it after tool execution
      // finalized = await finalizeExecutedToolCall(
      //   currentContext,
      //   message,
      //   preparedToolCall,
      //   executed,
      //   config,
      //   signal,
      // );
      finalized = executedToolCall;
    }

    await emitToolExecutionEnd(finalized, emit);
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    finalizedCalls.push(finalized);
    toolCallResultsMessages.push(toolResultMessage);

    if (signal?.aborted) {
      break;
    }
  }

  return {
    messages: toolCallResultsMessages,
  };
}

/**
 *
 * Prepares a tool call for execution
 * validate too call arguments
 * For now it only does this and based on the above
 * operation is successful or not, it returns either a PreparedToolCall
 * or an ImmediateToolCallOutcome
 *
 * @param currentContext
 * @param assistantMessage
 * @param toolCall
 * @param config
 * @param signal
 * @returns
 */
async function prepareToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  const tool = currentContext.tools?.find((t) => t.name === toolCall.name);

  if (!tool) {
    return {
      kind: "immediate",
      result: createErrorToolResult(`Tool ${toolCall.name} not found`),
      isError: true,
    };
  }

  try {
    const validatedArgs = validateToolArguments(tool, toolCall);

    //TODO: if beforeTool hook is added handle it here
    if (signal?.aborted) {
      return {
        kind: "immediate",
        result: createErrorToolResult("Operation aborted"),
        isError: true,
      };
    }
    return {
      kind: "prepared",
      toolCall,
      tool,
      args: validatedArgs,
    };
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(
        error instanceof Error ? error.message : String(error),
      ),
      isError: true,
    };
  }
}

async function executePreparedToolCall(
  preparedToolCall: PreparedToolCall,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<FinalizedToolCallOutcome> {
  const updateEvents: Promise<void>[] = [];
  let acceptingUpdates = true;

  try {
    const result = await preparedToolCall.tool.execute(
      preparedToolCall.toolCall.id,
      preparedToolCall.args as never,
      signal,
      (partialResult) => {
        if (!acceptingUpdates) return;
        updateEvents.push(
          Promise.resolve(
            emit({
              type: "tool_execution_update",
              toolCallId: preparedToolCall.toolCall.id,
              toolName: preparedToolCall.toolCall.name,
              args: preparedToolCall.toolCall.arguments,
              partialResult,
            }),
          ),
        );
      },
    );
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    return { toolCall: preparedToolCall.toolCall, result, isError: false };
  } catch (error) {
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    return {
      toolCall: preparedToolCall.toolCall,
      result: createErrorToolResult(
        error instanceof Error ? error.message : String(error),
      ),
      isError: true,
    };
  } finally {
    acceptingUpdates = false;
  }
}
