import {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
} from "@coding-harness/ai-providers";
import {
  AgentContext,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
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
    let hasMoreTooCalls = true;

    // Inner loop -> process tool calls and steering messages
    while (hasMoreTooCalls && pendingMessages.length > 0) {
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
