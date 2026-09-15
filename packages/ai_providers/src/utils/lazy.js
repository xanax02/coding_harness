import { AssistantMessageEventStream } from "./event-stream.js";
//piping lazyAsync stream to target stream that is actually used by caller
export const forwardStream = async (source, target) => {
    for await (const chunk of source) {
        target.push(chunk);
    }
    target.end();
};
// this is for the returning imidiate synchromous stream object(for now),
// setup have the async functioning that it will do in background
// THIS IS DONE SO IF WHEN CALLING PROVIDER.STREAM, which will be async function
// return Promise<AssistantMessageEventStream> and for that
// await ProviderManager.stream needs to be done which will block the stream till the whole result is present
export const defferedAsyncStream = (model, setup) => {
    const outerStream = new AssistantMessageEventStream();
    //setup is the async stream function from provider(anthropic, google, openai, etc.)
    //it will have its own stream that is the inner stream which it will get resolved to
    // that inner and this.outerStream are passed in forwardStream for piping
    setup()
        .then((innerStream) => {
        forwardStream(innerStream, outerStream);
    })
        .catch((error) => {
        forwardStream(makeErrorStream(model, error), outerStream);
    });
    return outerStream;
};
export const lazyLoadModule = (load) => {
    return {
        stream: (model, context, options) => {
            return defferedAsyncStream(model, async () => (await load()).stream(model, context, options));
        },
    };
};
//error Stream event
function makeErrorStream(model, error) {
    const stream = new AssistantMessageEventStream();
    const msg = {
        role: "assistant",
        content: [],
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timeStamp: Date.now(),
    };
    stream.push({ type: "error", error: msg });
    stream.end(msg);
    return stream;
}
//# sourceMappingURL=lazy.js.map