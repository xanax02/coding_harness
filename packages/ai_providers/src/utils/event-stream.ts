import { AssistantMessage, AssistantMessageEvent } from "../types.js";

// export class AssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waitingQueue: ((value: IteratorResult<T>) => void)[] = [];
  private done: boolean = false;
  private finalResultPromise: Promise<R>; // promise which will get resolved when the stream is done

  //this will contain the resolve callback from above promise so that it can get resolved outside the promise elsewhere
  private resolveFinalResult!: (value: R) => void;

  //now this class is for generic events, it can't check event.type === "done" or "error" directly
  //need to pass callbacks in constructor to check for done and error events
  private isComplete: (event: T) => boolean;
  private extractResult: (event: T) => R;

  constructor(
    isComplete: (event: T) => boolean,
    extractResult: (event: T) => R,
  ) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: T): void {
    if (this.done) return;

    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }

    const watier = this.waitingQueue.shift();
    if (watier) {
      watier({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(result?: R): void {
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

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        // if producer has not generated any event yet and consumer is waiting,
        // add a awaited result promise to waiting queue
        // when the token/event is available to consume this promise will get resolve with event's value
        const result = await new Promise<IteratorResult<T>>((resolve) => {
          this.waitingQueue.push(resolve);
        });
        if (result.done) {
          return;
        }
        yield result.value;
      }
    }
  }

  //method to get final result as promise after event ends
  result(): Promise<R> {
    return this.finalResultPromise;
  }
}

export class AssistantMessageEventStream extends EventStream<
  AssistantMessageEvent,
  AssistantMessage
> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") {
          return event.message;
        } else if (event.type === "error") {
          return event.error;
        }
        throw new Error("Unexpected event type for final result");
      },
    );
  }
}
