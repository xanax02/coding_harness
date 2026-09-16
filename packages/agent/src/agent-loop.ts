import { AssistantMessageEventStream } from "@coding-harness/ai-providers";
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
  streamFunction: streamFn,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  return newMessages;
}
