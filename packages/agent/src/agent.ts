import { AgentState } from "./types.js";

export class Agent {
  private _state: AgentState = {
    systemPrompt: "",
    model: {
      id: "",
      name: "",
      baseUrl: "",
      provider: "openai",
      input: [],
      reasoning: false,
      contextWindow: 0,
      maxTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    },
  };
}
