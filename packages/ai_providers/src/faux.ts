// Fake provider for testing - replays scripted responses
import {
  AssistantMessage,
  Context,
  ModelInfo,
  Provider,
  StreamOptions,
  TextContent,
} from "./types.js";
import { AssistantMessageEventStream } from "./utils/event-stream.js";

export class FauxProvider implements Provider {
  readonly id = "faux";
  readonly name = "Faux Provider";
  readonly auth = { apiKeyEnvVar: "FAUX_API_KEY" };

  private scriptedResponse: string =
    "This is a test response from the faux provider.";

  constructor(response?: string) {
    if (response) {
      this.scriptedResponse = response;
    }
  }

  getModels(): readonly ModelInfo[] {
    return [this.getModel("faux-model")!];
  }

  getModel(modelId: string): ModelInfo | undefined {
    if (modelId === "faux-model") {
      return {
        id: "faux-model",
        name: "Faux Model",
        baseUrl: "https://faux.example.com",
        provider: "faux",
        input: ["text"],
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 1024,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      };
    }
    return undefined;
  }

  stream(
    model: ModelInfo,
    context: Context,
    options?: StreamOptions,
  ): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();

    // Simulate async streaming
    setTimeout(() => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: this.scriptedResponse,
          } as TextContent,
        ],
        provider: "faux",
        model: model.id,
        usage: {
          input: 10,
          output: this.scriptedResponse.length,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 10 + this.scriptedResponse.length,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        errorMessage: "",
        timeStamp: Date.now(),
      };

      stream.push({ type: "start", partial: output });
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: output,
      });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: this.scriptedResponse,
        partial: output,
      });
      stream.push({
        type: "text_end",
        contentIndex: 0,
        content: this.scriptedResponse,
        partial: output,
      });
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    }, 100);

    return stream;
  }
}
