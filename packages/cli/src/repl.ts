import { createInterface, Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  Agent,
  AgentEvent,
  AutoCompaction,
  CompactionSettings,
} from "@coding-harness/agent";

export interface ReplOptions {
  agent: Agent;
  getApiKey: (provider: string) => string | undefined;
  compaction?: Partial<CompactionSettings>;
  input?: Readable;
  output?: Writable;
}

const MAX_ARG_CHARS = 80;
const MAX_RESULT_LINES = 3;
const MAX_RESULT_LINE_CHARS = 160;

function short(text: string, max: number): string {
  const flat = text.replace(/\r?\n/g, "\\n");
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function formatArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  return Object.entries(args)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${short(text ?? "", MAX_ARG_CHARS)}`;
    })
    .join(" ");
}

function resultText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] })
    ?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

/**
 * Line-based terminal frontend for an Agent.
 *
 * - a line typed while idle is a prompt (or a /command)
 * - a line typed while the agent runs steers it: remaining tool calls are skipped
 *   and the line is delivered as the next user message
 * - Ctrl+C aborts the current run; Ctrl+C again exits
 */
export class Repl {
  private agent: Agent;
  private compaction: AutoCompaction;
  private input: Readable;
  private output: Writable;
  private color: boolean;

  private rl?: Interface;
  private current?: Promise<void>;
  private running = false;
  private abortRequested = false;
  private forcedExit = false;
  private closed = false;
  private atLineStart = true;
  private compactionFailed = false;
  /** per tool call: bash output already printed, so partial updates only add the new tail */
  private streamedOutput = new Map<string, string>();
  /** lines typed while running but not streaming (e.g. during compaction) */
  private queued: string[] = [];

  constructor(options: ReplOptions) {
    this.agent = options.agent;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.color = Boolean((this.output as { isTTY?: boolean }).isTTY);

    this.compaction = new AutoCompaction({
      agent: this.agent,
      getApiKey: options.getApiKey,
      settings: options.compaction,
      onStart: (reason) =>
        this.writeLine(this.dim(`[compacting context (${reason})...]`)),
      onEnd: (result, error) => {
        if (error) {
          this.compactionFailed = true;
          this.writeLine(this.red(`Compaction failed: ${error.message}`));
        } else if (result) {
          this.writeLine(
            this.dim(
              `[compacted ~${result.tokensBefore} tokens, kept ${result.messages.length - 1} recent messages]`,
            ),
          );
        }
      },
    });

    this.agent.subscribe((event) => this.render(event));
  }

  // ---- output helpers ----------------------------------------------------

  private write(text: string) {
    if (text.length === 0) return;
    this.output.write(text);
    this.atLineStart = text.endsWith("\n");
  }

  private writeLine(text: string) {
    this.ensureNewline();
    this.write(`${text}\n`);
  }

  private ensureNewline() {
    if (!this.atLineStart) this.write("\n");
  }

  private dim(text: string): string {
    return this.color ? `\x1b[2m${text}\x1b[22m` : text;
  }

  private red(text: string): string {
    return this.color ? `\x1b[31m${text}\x1b[39m` : text;
  }

  // ---- agent events ------------------------------------------------------

  private render(event: AgentEvent) {
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") this.write(e.delta);
        else if (e.type === "thinking_delta") this.write(this.dim(e.delta));
        else if (e.type === "thinking_end") this.ensureNewline();
        break;
      }

      case "message_end":
        if (event.message.role === "assistant") this.ensureNewline();
        break;

      case "tool_execution_start":
        this.writeLine(
          this.dim(`> ${event.toolName} ${formatArgs(event.args)}`),
        );
        break;

      case "tool_execution_update": {
        if (event.toolName !== "bash") break;
        // partialResult holds the whole rolling output; print only what is new
        const text = resultText(event.partialResult);
        const printed = this.streamedOutput.get(event.toolCallId) ?? "";
        if (text.length > printed.length && text.startsWith(printed)) {
          this.write(text.slice(printed.length));
          this.streamedOutput.set(event.toolCallId, text);
        }
        break;
      }

      case "tool_execution_end": {
        const alreadyStreamed = this.streamedOutput.has(event.toolCallId);
        this.streamedOutput.delete(event.toolCallId);
        this.ensureNewline();
        if (alreadyStreamed) {
          if (event.isError) this.writeLine(this.red("  [tool failed]"));
          break;
        }
        const lines = resultText(event.result).split("\n").filter(Boolean);
        const shown = lines
          .slice(0, MAX_RESULT_LINES)
          .map((l) => `  ${short(l, MAX_RESULT_LINE_CHARS)}`);
        if (lines.length > MAX_RESULT_LINES) {
          shown.push(`  ... (+${lines.length - MAX_RESULT_LINES} more lines)`);
        }
        const body = shown.join("\n");
        if (body) this.writeLine(event.isError ? this.red(body) : this.dim(body));
        break;
      }
    }
  }

  // ---- running prompts ---------------------------------------------------

  /** Run one prompt to completion (plus compaction). Returns false if it ended in error or abort. */
  async runPrompt(text: string): Promise<boolean> {
    this.running = true;
    try {
      await this.agent.prompt(text);
      await this.compaction.afterRun();
      return this.reportOutcome();
    } finally {
      this.running = false;
      this.abortRequested = false;
    }
  }

  private reportOutcome(): boolean {
    const messages = this.agent.state.messages;
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant") return true;
    if (last.stopReason === "error") {
      this.writeLine(this.red(`Error: ${last.errorMessage || "unknown error"}`));
      return false;
    }
    if (last.stopReason === "aborted") {
      this.writeLine(this.dim("[aborted]"));
      return false;
    }
    return true;
  }

  private async handleLine(line: string): Promise<void> {
    if (line === "/exit" || line === "/quit") {
      this.rl?.close();
      return;
    }
    if (line === "/reset") {
      this.agent.reset();
      this.writeLine(this.dim("[conversation cleared]"));
      return;
    }
    if (line === "/compact" || line.startsWith("/compact ")) {
      this.compactionFailed = false;
      const result = await this.compaction.compactNow(
        line.slice("/compact".length).trim() || undefined,
      );
      if (!result && !this.compactionFailed) {
        this.writeLine(this.dim("[nothing to compact yet]"));
      }
      return;
    }
    await this.runPrompt(line);
  }

  /** Handle a line, then any lines that were typed meanwhile */
  private async drain(first: string): Promise<void> {
    let next: string | undefined = first;
    while (next !== undefined) {
      this.running = true;
      try {
        await this.handleLine(next);
      } catch (error) {
        this.writeLine(
          this.red(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      } finally {
        this.running = false;
        this.abortRequested = false;
      }
      next = this.queued.shift();
    }
    if (!this.closed) this.rl?.prompt();
  }

  private interrupt() {
    if (this.running && !this.abortRequested) {
      this.abortRequested = true;
      this.agent.abort();
      this.compaction.abort();
      this.writeLine(this.dim("[aborting, press Ctrl+C again to exit]"));
      return;
    }
    this.forcedExit = true;
    this.agent.abort();
    this.rl?.close();
  }

  /** Read lines until /exit, Ctrl+C Ctrl+C, or end of input */
  start(): Promise<void> {
    const rl = createInterface({
      input: this.input,
      output: this.output,
      prompt: "> ",
    });
    this.rl = rl;

    return new Promise<void>((resolve) => {
      rl.on("line", (raw) => {
        const line = raw.trim();
        if (!line) {
          if (!this.running) rl.prompt();
          return;
        }
        if (this.running) {
          if (this.agent.state.isStreaming) {
            this.agent.steer({
              role: "user",
              content: [{ type: "text", text: line }],
              timestamp: Date.now(),
            });
          } else {
            this.queued.push(line);
          }
          return;
        }
        this.current = this.drain(line);
      });

      rl.on("SIGINT", () => this.interrupt());

      rl.on("close", () => {
        this.closed = true;
        if (this.forcedExit) return resolve();
        // input ended (or /exit): let the current run finish first
        void (this.current ?? Promise.resolve()).then(() => resolve());
      });

      rl.prompt();
    });
  }
}
