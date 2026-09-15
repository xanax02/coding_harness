import { AssistantMessage, AssistantMessageEvent } from "../types.js";

export class AssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
  private queue: AssistantMessageEvent[] = [];
  private waitingQueue: ((
    value: IteratorResult<AssistantMessageEvent>,
  ) => void)[] = [];
  private done: boolean = false;
  private finalResultPromise: Promise<AssistantMessage>; // promise which will get resolved when the stream is done

  //this will contain the resolve callback from above promise so that it can get resolved outside the promise elsewhere
  private resolveFinalResult!: (value: AssistantMessage) => void;

  constructor() {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.done) return;

    if (event.type === "done" || event.type === "error") {
      this.done = true;
      this.resolveFinalResult(
        event.type === "done" ? event.message : event.error,
      );
    }

    const watier = this.waitingQueue.shift();
    if (watier) {
      watier({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(result?: AssistantMessage): void {
    this.done = true;
    if (result !== undefined) {
      this.resolveFinalResult(result);
    }

    while (this.waitingQueue.length > 0) {
      const waiter = this.waitingQueue.shift();
      if (waiter) {
        waiter({ value: undefined, done: true });
      }
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        // if producer has not generated any event yet and consumer is waiting,
        // add a awaited result promise to waiting queue
        // when the token/event is available to consume this promise will get resolve with event's value
        const result = await new Promise<IteratorResult<AssistantMessageEvent>>(
          (resolve) => {
            this.waitingQueue.push(resolve);
          },
        );
        if (result.done) {
          return;
        }
        yield result.value;
      }
    }
  }

  //method to get final result as promise after event ends
  result(): Promise<AssistantMessage> {
    return this.finalResultPromise;
  }
}
