import { AssistantMessageEvent } from "../types";

export class AssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
  async *[Symbol.asyncIterator]() {
    // TODO: Implement the async iterator
  }
}
