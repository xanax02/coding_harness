/**
 * Context compaction for long conversations.
 *
 * Works on the in-memory AgentMessage[] (no session file yet). After compaction
 * the history is [summary message, ...recent messages]. The summary is a user
 * message with a fixed prefix, so a later compaction can recognize it and update
 * it instead of summarizing a summary.
 */

import {
  AssistantMessage,
  ModelInfo,
  stream as defaultStream,
  TextContent,
  Usage,
} from "@coding-harness/ai-providers";
import { AgentMessage, streamFn } from "../types.js";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  FileOperations,
  formatFileOperations,
  serializeConversation,
  SUMMARIZATION_SYSTEM_PROMPT,
} from "./utils.js";

export interface CompactionSettings {
  enabled: boolean;
  /** tokens kept free for the next response; compact when context passes window - reserve */
  reserveTokens: number;
  /** roughly how many tokens of recent messages survive compaction verbatim */
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface CompactionResult {
  summary: string;
  /** new history: [summary message, ...kept messages] */
  messages: AgentMessage[];
  tokensBefore: number;
  details: CompactionDetails;
}

// ---------------------------------------------------------------------------
// Summary message
// ---------------------------------------------------------------------------

const SUMMARY_PREFIX =
  "The conversation so far was compacted into the following summary. Continue the work from it.\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

export function createSummaryMessage(summary: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}` }],
    timestamp: Date.now(),
  };
}

/** Returns the summary text if the message is a compaction summary, else undefined */
export function getSummaryText(message: AgentMessage): string | undefined {
  if (message.role !== "user") return undefined;
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("");
  if (!text.startsWith(SUMMARY_PREFIX)) return undefined;
  const body = text.slice(SUMMARY_PREFIX.length);
  return body.endsWith(SUMMARY_SUFFIX)
    ? body.slice(0, -SUMMARY_SUFFIX.length)
    : body;
}

const READ_FILES_RE = /<read-files>\n([\s\S]*?)\n<\/read-files>/;
const MODIFIED_FILES_RE = /<modified-files>\n([\s\S]*?)\n<\/modified-files>/;

/** Splits a previous summary into its text and the file lists appended to it */
function splitFileLists(summary: string): {
  text: string;
  readFiles: string[];
  modifiedFiles: string[];
} {
  const lines = (re: RegExp) =>
    (summary.match(re)?.[1] ?? "").split("\n").filter(Boolean);
  return {
    text: summary.replace(READ_FILES_RE, "").replace(MODIFIED_FILES_RE, "").trim(),
    readFiles: lines(READ_FILES_RE),
    modifiedFiles: lines(MODIFIED_FILES_RE),
  };
}

// ---------------------------------------------------------------------------
// Token accounting
// ---------------------------------------------------------------------------

export function calculateContextTokens(usage: Usage): number {
  return (
    usage.totalTokens ||
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  );
}

/** Usage of the newest assistant message that has valid usage (not aborted / errored) */
export function getLastAssistantUsage(
  messages: AgentMessage[],
): Usage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.role === "assistant" &&
      msg.stopReason !== "aborted" &&
      msg.stopReason !== "error" &&
      msg.usage
    ) {
      return msg.usage;
    }
  }
  return undefined;
}

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

/** chars / 4: rough, and errs on the high side */
export function estimateTokens(message: AgentMessage): number {
  let chars = 0;

  if (message.role === "user") {
    if (typeof message.content === "string") {
      chars = message.content.length;
    } else {
      for (const block of message.content) {
        if (block.type === "text") chars += block.text.length;
        else chars += 4800; // image
      }
    }
  } else if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "thinking") chars += block.thinking.length;
      else chars += block.name.length + JSON.stringify(block.arguments).length;
    }
  } else {
    for (const block of message.content) {
      if (block.type === "text") chars += block.text.length;
      else chars += 4800; // image
    }
  }

  return Math.ceil(chars / 4);
}

function estimateContextTokens(messages: AgentMessage[]): number {
  const usage = getLastAssistantUsage(messages);
  return usage
    ? calculateContextTokens(usage)
    : messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

// ---------------------------------------------------------------------------
// Cut point
// ---------------------------------------------------------------------------

export interface CutPoint {
  /** index of the first message that is kept verbatim */
  firstKeptIndex: number;
  /** when the cut lands mid-turn: index of the user message that started that turn */
  turnStartIndex: number;
  /** true if the cut is not at a user message, so the turn is split in two */
  isSplitTurn: boolean;
}

/**
 * Walk backwards from the newest message, adding up estimated tokens until
 * keepRecentTokens is reached, then cut at the nearest user/assistant message.
 * Never cut at a toolResult: it must stay next to the assistant message that
 * made the tool call. Only looks at messages from startIndex on.
 */
export function findCutPoint(
  messages: AgentMessage[],
  startIndex: number,
  keepRecentTokens: number,
): CutPoint | undefined {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    if (messages[i].role !== "toolResult") cutPoints.push(i);
  }
  if (cutPoints.length === 0) return undefined;

  // default: budget never reached, keep everything (nothing to summarize)
  let cutIndex = cutPoints[0];
  let accumulated = 0;

  for (let i = messages.length - 1; i >= startIndex; i--) {
    accumulated += estimateTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      cutIndex =
        cutPoints.find((c) => c >= i) ?? cutPoints[cutPoints.length - 1];
      break;
    }
  }

  if (messages[cutIndex].role === "user") {
    return { firstKeptIndex: cutIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let turnStartIndex = -1;
  for (let i = cutIndex; i >= startIndex; i--) {
    if (messages[i].role === "user") {
      turnStartIndex = i;
      break;
    }
  }
  return {
    firstKeptIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: turnStartIndex !== -1,
  };
}

// ---------------------------------------------------------------------------
// Summarization prompts
// ---------------------------------------------------------------------------

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

// ---------------------------------------------------------------------------
// Preparation and compaction
// ---------------------------------------------------------------------------

export interface CompactionPreparation {
  messagesToSummarize: AgentMessage[];
  /** first part of a split turn; summarized separately from the history */
  turnPrefixMessages: AgentMessage[];
  /** messages that survive verbatim */
  keptMessages: AgentMessage[];
  tokensBefore: number;
  /** text of the summary from an earlier compaction, for an incremental update */
  previousSummary?: string;
  fileOps: FileOperations;
  settings: CompactionSettings;
}

/**
 * Decide what to summarize and what to keep. Returns undefined when there is
 * nothing worth compacting yet.
 */
export function prepareCompaction(
  messages: AgentMessage[],
  settings: CompactionSettings,
): CompactionPreparation | undefined {
  const previous = messages[0] ? getSummaryText(messages[0]) : undefined;
  const boundaryStart = previous !== undefined ? 1 : 0;

  const cut = findCutPoint(messages, boundaryStart, settings.keepRecentTokens);
  if (!cut) return undefined;

  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptIndex;
  const messagesToSummarize = messages.slice(boundaryStart, historyEnd);
  const turnPrefixMessages = cut.isSplitTurn
    ? messages.slice(cut.turnStartIndex, cut.firstKeptIndex)
    : [];
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
    return undefined;
  }

  const fileOps = createFileOps();
  let previousSummary: string | undefined;
  if (previous !== undefined) {
    const split = splitFileLists(previous);
    previousSummary = split.text;
    for (const f of split.readFiles) fileOps.read.add(f);
    for (const f of split.modifiedFiles) fileOps.edited.add(f);
  }
  for (const msg of [...messagesToSummarize, ...turnPrefixMessages]) {
    extractFileOpsFromMessage(msg, fileOps);
  }

  return {
    messagesToSummarize,
    turnPrefixMessages,
    keptMessages: messages.slice(cut.firstKeptIndex),
    tokensBefore: estimateContextTokens(messages),
    previousSummary,
    fileOps,
    settings,
  };
}

export interface CompactOptions {
  model: ModelInfo;
  apiKey: string;
  signal?: AbortSignal;
  /** extra focus for the summary, e.g. from "/compact focus on the auth bug" */
  customInstructions?: string;
  /** defaults to the Anthropic stream; override for tests */
  streamFn?: streamFn;
}

async function runSummarization(
  systemPrompt: string | undefined,
  promptText: string,
  maxTokens: number,
  options: CompactOptions,
): Promise<string> {
  const fn: streamFn = options.streamFn ?? defaultStream;
  const eventStream = await fn(
    options.model,
    {
      systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: promptText }],
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens, signal: options.signal, apiKey: options.apiKey },
  );
  const response: AssistantMessage = await eventStream.result();

  if (response.stopReason === "aborted") {
    throw new Error("Compaction aborted");
  }
  if (response.stopReason === "error") {
    throw new Error(
      `Summarization failed: ${response.errorMessage || "unknown error"}`,
    );
  }

  const text = response.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Summarization returned no text");
  return text;
}

async function generateSummary(
  messages: AgentMessage[],
  reserveTokens: number,
  options: CompactOptions,
  previousSummary?: string,
): Promise<string> {
  let prompt = previousSummary
    ? UPDATE_SUMMARIZATION_PROMPT
    : SUMMARIZATION_PROMPT;
  if (options.customInstructions) {
    prompt += `\n\nAdditional focus: ${options.customInstructions}`;
  }

  // serialized to text so the model summarizes the conversation instead of continuing it
  let promptText = `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += prompt;

  return runSummarization(
    SUMMARIZATION_SYSTEM_PROMPT,
    promptText,
    Math.floor(0.8 * reserveTokens),
    options,
  );
}

async function generateTurnPrefixSummary(
  messages: AgentMessage[],
  reserveTokens: number,
  options: CompactOptions,
): Promise<string> {
  const promptText = `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  return runSummarization(
    SUMMARIZATION_SYSTEM_PROMPT,
    promptText,
    Math.floor(0.5 * reserveTokens),
    options,
  );
}

/** Ask the model for the summary and build the new, shorter history */
export async function compact(
  preparation: CompactionPreparation,
  options: CompactOptions,
): Promise<CompactionResult> {
  const {
    messagesToSummarize,
    turnPrefixMessages,
    keptMessages,
    tokensBefore,
    previousSummary,
    fileOps,
    settings,
  } = preparation;

  let summary: string;
  if (turnPrefixMessages.length > 0) {
    const [history, prefix] = await Promise.all([
      messagesToSummarize.length > 0
        ? generateSummary(
            messagesToSummarize,
            settings.reserveTokens,
            options,
            previousSummary,
          )
        : Promise.resolve(previousSummary ?? "No prior history."),
      generateTurnPrefixSummary(
        turnPrefixMessages,
        settings.reserveTokens,
        options,
      ),
    ]);
    summary = `${history}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix}`;
  } else {
    summary = await generateSummary(
      messagesToSummarize,
      settings.reserveTokens,
      options,
      previousSummary,
    );
  }

  const details = computeFileLists(fileOps);
  summary += formatFileOperations(details.readFiles, details.modifiedFiles);

  return {
    summary,
    messages: [createSummaryMessage(summary), ...keptMessages],
    tokensBefore,
    details,
  };
}
