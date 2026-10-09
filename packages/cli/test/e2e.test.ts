/**
 * End-to-end checks with a scripted fake provider (no network, no API key).
 * Run: npm test --workspace @coding-harness/cli   (needs `npm run build` first)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { z } from "zod";
import {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  getModel,
  StreamOptions,
  ToolCall,
} from "@coding-harness/ai-providers";
import {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentTool,
  AutoCompaction,
  buildSystemPrompt,
  createCodingTools,
  findCutPoint,
  getSummaryText,
  SUMMARIZATION_SYSTEM_PROMPT,
  streamFn,
} from "@coding-harness/agent";
import { Repl } from "../src/repl.js";

// ---- fake provider ---------------------------------------------------------

type Block = { text: string } | ToolCall;

function assistantMessage(
  blocks: Block[],
  opts: { totalTokens?: number; stopReason?: AssistantMessage["stopReason"]; errorMessage?: string } = {},
): AssistantMessage {
  const hasTool = blocks.some((b) => "name" in b);
  return {
    role: "assistant",
    content: blocks.map((b) => ("name" in b ? b : { type: "text" as const, text: b.text })),
    provider: "anthropic",
    model: "fake",
    usage: {
      input: opts.totalTokens ?? 10,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: opts.totalTokens ?? 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: opts.stopReason ?? (hasTool ? "toolUse" : "stop"),
    errorMessage: opts.errorMessage ?? "",
    timeStamp: Date.now(),
  };
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

type Script = (ctx: Context, options: StreamOptions | undefined) => AssistantMessage | Promise<AssistantMessage>;

function fakeStream(script: Script, seen: Context[] = []): streamFn {
  return (_model, context, options) => {
    seen.push(structuredClone({ ...context, tools: undefined }));
    const stream = new AssistantMessageEventStream();
    void (async () => {
      const aborted = new Promise<never>((_, reject) =>
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
      try {
        const msg = await Promise.race([Promise.resolve(script(context, options)), aborted]);
        stream.push({ type: "start", partial: { ...msg, content: [] } });
        msg.content.forEach((block, i) => {
          if (block.type === "text") {
            stream.push({ type: "text_start", contentIndex: i, partial: msg });
            stream.push({ type: "text_delta", contentIndex: i, delta: block.text, partial: msg });
            stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: msg });
          } else if (block.type === "toolCall") {
            stream.push({ type: "toolcall_start", contentIndex: i, partial: msg });
            stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: msg });
          }
        });
        if (msg.stopReason === "error") stream.push({ type: "error", reason: "error", error: msg });
        else stream.push({ type: "done", reason: msg.stopReason as "stop" | "toolUse" | "length", message: msg });
      } catch {
        const msg = assistantMessage([], { stopReason: "aborted", errorMessage: "aborted" });
        stream.push({ type: "error", reason: "aborted", error: msg });
      }
      stream.end();
    })();
    return stream;
  };
}

const smallModel = { ...getModel("anthropic", "claude-haiku-4-5-20251001"), contextWindow: 1000 };

function lastUserText(ctx: Context): string {
  const m = [...ctx.messages].reverse().find((x) => x.role === "user");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

function newAgent(script: Script, tools: AgentTool<any>[], seen: Context[] = []): Agent {
  return new Agent({
    initialState: { model: smallModel, systemPrompt: "sys", tools },
    streamFn: fakeStream(script, seen),
    getApiKey: () => "test-key",
  });
}

// ---- tiny runner -----------------------------------------------------------

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

// ---- tests -----------------------------------------------------------------

test("loop: write tool call, then final answer, in the right event order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ch-"));
  try {
    let turn = 0;
    const agent = newAgent(
      () =>
        turn++ === 0
          ? assistantMessage([call("c1", "write", { path: "out/a.txt", content: "hello" })])
          : assistantMessage([{ text: "done" }]),
      createCodingTools(dir),
    );
    const events: string[] = [];
    agent.subscribe((e: AgentEvent) => events.push(e.type));

    await agent.prompt("make a file");

    assert.equal(readFileSync(join(dir, "out", "a.txt"), "utf-8"), "hello");
    assert.deepEqual(agent.state.messages.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
    const order = events.filter((e) => ["agent_start", "tool_execution_start", "tool_execution_end", "agent_end"].includes(e));
    assert.deepEqual(order, ["agent_start", "tool_execution_start", "tool_execution_end", "agent_end"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loop: unknown tool and bad arguments become isError results, run continues", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ch-"));
  try {
    let turn = 0;
    const agent = newAgent(
      () =>
        turn++ === 0
          ? assistantMessage([call("c1", "nope", {}), call("c2", "write", { path: 5 })])
          : assistantMessage([{ text: "ok" }]),
      createCodingTools(dir),
    );
    await agent.prompt("go");
    const results = agent.state.messages.filter((m) => m.role === "toolResult");
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.role === "toolResult" && r.isError));
    assert.equal(agent.state.messages.at(-1)?.role, "assistant");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("steering: queued message skips remaining tool calls and lands on the next turn", async () => {
  const ran: string[] = [];
  let agent!: Agent;
  const mk = (name: string): AgentTool<any> => ({
    name,
    label: name,
    description: name,
    parameters: z.object({}),
    execute: async () => {
      ran.push(name);
      if (name === "first") agent.steer({ role: "user", content: [{ type: "text", text: "change of plan" }], timestamp: Date.now() });
      return { content: [{ type: "text", text: name }] };
    },
  });
  const seen: Context[] = [];
  let turn = 0;
  agent = newAgent(
    (ctx) =>
      turn++ === 0
        ? assistantMessage([call("c1", "first", {}), call("c2", "second", {})])
        : assistantMessage([{ text: `saw: ${lastUserText(ctx)}` }]),
    [mk("first"), mk("second")],
    seen,
  );
  await agent.prompt("start");

  assert.deepEqual(ran, ["first"]);
  const results = agent.state.messages.filter((m) => m.role === "toolResult");
  assert.equal(results.length, 2);
  assert.ok(results[1].role === "toolResult" && results[1].isError);
  const final = agent.state.messages.at(-1);
  assert.ok(final?.role === "assistant" && final.content[0].type === "text" && final.content[0].text === "saw: change of plan");
});

test("abort: agent.abort() stops a hanging request and leaves valid history", async () => {
  const agent = newAgent(() => new Promise<AssistantMessage>(() => {}), []);
  const run = agent.prompt("hang");
  setTimeout(() => agent.abort(), 20);
  await run;
  assert.equal(agent.state.isStreaming, false);
  const last = agent.state.messages.at(-1);
  assert.ok(last?.role === "assistant" && last.stopReason === "aborted");
  // the agent can be used again
  await assert.doesNotReject(agent.continue().catch((e) => { if (!/assistant/.test(String(e))) throw e; }));
});

test("compaction: threshold trigger replaces old history with a summary + recent messages", async () => {
  let turn = 0;
  const agent = newAgent((ctx) => {
    if (ctx.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT) return assistantMessage([{ text: "## Goal\nbuild thing" }]);
    turn++;
    // usage reports 950 of 1000 tokens used: above window - reserve(100)
    return assistantMessage([{ text: `answer ${turn} ${"x".repeat(200)}` }], { totalTokens: 950 });
  }, []);
  const ac = new AutoCompaction({ agent, getApiKey: () => "k", settings: { reserveTokens: 100, keepRecentTokens: 60 } });

  for (const q of ["one", "two", "three"]) {
    await agent.prompt(`${q} ${"y".repeat(200)}`);
  }
  const before = agent.state.messages.length;
  await ac.afterRun();

  const msgs = agent.state.messages;
  assert.ok(msgs.length < before, `history should shrink (${before} -> ${msgs.length})`);
  assert.match(getSummaryText(msgs[0]) ?? "", /build thing/);
  assert.equal(msgs[0].role, "user");
  // never starts a kept part with a toolResult, and ends where it did
  assert.notEqual(msgs[1].role, "toolResult");
});

test("compaction: second compaction updates the previous summary and keeps file lists", async () => {
  const prompts: string[] = [];
  const agent = newAgent((ctx) => {
    if (ctx.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT) {
      prompts.push(lastUserText(ctx));
      return assistantMessage([{ text: "## Goal\nsummary" }]);
    }
    return assistantMessage([{ text: "z".repeat(300) }], { totalTokens: 950 });
  }, []);
  const readCall = assistantMessage([call("r1", "read", { path: "src/a.ts" })]);
  agent.replaceMessages([
    { role: "user", content: [{ type: "text", text: "q1 " + "y".repeat(300) }], timestamp: 1 },
    readCall,
    { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: 2 },
    assistantMessage([{ text: "a1 " + "z".repeat(300) }]),
    { role: "user", content: [{ type: "text", text: "q2 " + "y".repeat(300) }], timestamp: 3 },
    assistantMessage([{ text: "a2 " + "z".repeat(300) }]),
  ]);
  const ac = new AutoCompaction({ agent, getApiKey: () => "k", settings: { keepRecentTokens: 50 } });

  assert.ok(await ac.compactNow());
  const first = getSummaryText(agent.state.messages[0]);
  assert.match(first ?? "", /<read-files>\nsrc\/a\.ts\n<\/read-files>/);

  agent.appendMessage({ role: "user", content: [{ type: "text", text: "q3 " + "y".repeat(300) }], timestamp: 4 });
  agent.appendMessage(assistantMessage([{ text: "a3 " + "z".repeat(300) }]));
  assert.ok(await ac.compactNow());

  // a mid-turn cut runs two summarizer calls in parallel (history + turn prefix),
  // so check all calls made by the second compaction, not just the last to finish
  const second = prompts.slice(1);
  assert.ok(second.length >= 1, "second compaction called the summarizer");
  assert.ok(
    second.some((p) => /<previous-summary>/.test(p) && /## Goal\nsummary/.test(p)),
    "history call carries the previous summary",
  );
  assert.match(getSummaryText(agent.state.messages[0]) ?? "", /src\/a\.ts/, "file list survives a second compaction");
  assert.equal(agent.state.messages.filter((m) => getSummaryText(m) !== undefined).length, 1);
});

test("compaction: overflow error is compacted away and the request is retried", async () => {
  let overflowOnce = true;
  const agent = newAgent((ctx) => {
    if (ctx.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT) return assistantMessage([{ text: "## Goal\nsmall" }]);
    if (overflowOnce) {
      overflowOnce = false;
      return assistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: 213462 tokens > 200000 maximum" });
    }
    return assistantMessage([{ text: "recovered" }], { totalTokens: 100 });
  }, []);
  agent.replaceMessages([
    { role: "user", content: [{ type: "text", text: "old " + "y".repeat(400) }], timestamp: 1 },
    assistantMessage([{ text: "old answer " + "z".repeat(400) }]),
    { role: "user", content: [{ type: "text", text: "old2 " + "y".repeat(400) }], timestamp: 2 },
    assistantMessage([{ text: "old answer2 " + "z".repeat(400) }]),
  ]);
  const ac = new AutoCompaction({ agent, getApiKey: () => "k", settings: { keepRecentTokens: 120 } });

  await agent.prompt("one more " + "q".repeat(100));
  assert.equal(agent.state.messages.at(-1)?.role === "assistant" && (agent.state.messages.at(-1) as AssistantMessage).stopReason, "error");
  await ac.afterRun();

  const last = agent.state.messages.at(-1) as AssistantMessage;
  assert.equal(last.stopReason, "stop");
  assert.equal(last.content[0].type === "text" && last.content[0].text, "recovered");
  assert.ok(getSummaryText(agent.state.messages[0]) !== undefined);
});

test("cut point never starts the kept part at a toolResult", () => {
  const u = (t: string): AgentMessage => ({ role: "user", content: [{ type: "text", text: t }], timestamp: 0 });
  const tr = (id: string, t: string): AgentMessage => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: t }], isError: false, timestamp: 0 });
  const msgs: AgentMessage[] = [
    u("a".repeat(400)),
    assistantMessage([call("1", "read", { path: "x" })]),
    tr("1", "r".repeat(4000)),
    assistantMessage([{ text: "b".repeat(40) }]),
  ];
  for (const keep of [1, 20, 200, 900, 5000]) {
    const cut = findCutPoint(msgs, 0, keep);
    assert.ok(cut, `keep=${keep}`);
    assert.notEqual(msgs[cut.firstKeptIndex].role, "toolResult", `keep=${keep}`);
  }
});

test("system prompt: placeholders are filled, project context is inserted verbatim", () => {
  const p = buildSystemPrompt({
    cwd: "C:\\proj",
    tools: [{ name: "read", description: "Read a file" }],
    projectContext: "rules with $& and $1",
  });
  assert.doesNotMatch(p, /\{\{/);
  assert.match(p, /- read: Read a file/);
  assert.match(p, /READ-ONLY mode/);
  assert.match(p, /rules with \$& and \$1/);
  assert.match(p, /C:\\proj/);
});

test("repl: prompt runs, tool call and answer are rendered, /exit ends the loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ch-"));
  try {
    let turn = 0;
    const agent = newAgent(
      () =>
        turn++ === 0
          ? assistantMessage([call("c1", "write", { path: "r.txt", content: "hi" })])
          : assistantMessage([{ text: "all done" }]),
      createCodingTools(dir),
    );
    const input = new PassThrough();
    const output = new PassThrough();
    let out = "";
    output.on("data", (d) => (out += d.toString()));

    const repl = new Repl({ agent, getApiKey: () => "k", input, output });
    const finished = repl.start();
    input.write("please write r.txt\n");
    await new Promise((r) => setTimeout(r, 300));
    input.write("/exit\n");
    await finished;

    assert.equal(readFileSync(join(dir, "r.txt"), "utf-8"), "hi");
    assert.match(out, /> write path=r\.txt content=hi/);
    assert.match(out, /Successfully wrote/);
    assert.match(out, /all done/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repl: a line typed while the agent runs steers it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const seen: Context[] = [];
  let turn = 0;
  const slow: AgentTool<any> = {
    name: "slow",
    label: "slow",
    description: "slow",
    parameters: z.object({}),
    execute: async () => {
      await gate;
      return { content: [{ type: "text", text: "slow done" }] };
    },
  };
  const agent = newAgent(
    (ctx) =>
      turn++ === 0
        ? assistantMessage([call("c1", "slow", {}), call("c2", "slow", {})])
        : assistantMessage([{ text: `reply to: ${lastUserText(ctx)}` }]),
    [slow],
    seen,
  );
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (d) => (out += d.toString()));

  const repl = new Repl({ agent, getApiKey: () => "k", input, output });
  const finished = repl.start();
  input.write("start\n");
  await new Promise((r) => setTimeout(r, 100));
  input.write("actually do this\n");
  await new Promise((r) => setTimeout(r, 50));
  release();
  await new Promise((r) => setTimeout(r, 200));
  input.write("/exit\n");
  await finished;

  assert.match(out, /reply to: actually do this/);
});

// ---- run -------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 6).join("\n     ") : error}`);
  }
}
console.log(failed === 0 ? `\nall ${tests.length} passed` : `\n${failed} of ${tests.length} failed`);
process.exit(failed === 0 ? 0 : 1);
