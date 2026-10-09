import { Message } from "@coding-harness/ai-providers";
import { AgentMessage } from "../types.js";

export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

/** Collect file paths from read/write/edit tool calls in an assistant message */
export function extractFileOpsFromMessage(
  message: AgentMessage,
  fileOps: FileOperations,
): void {
  if (message.role !== "assistant") return;

  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    const path = block.arguments?.path;
    if (typeof path !== "string") continue;

    if (block.name === "read") fileOps.read.add(path);
    else if (block.name === "write") fileOps.written.add(path);
    else if (block.name === "edit") fileOps.edited.add(path);
  }
}

/** readFiles = only read, modifiedFiles = written or edited */
export function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
  return { readFiles, modifiedFiles: [...modified].sort() };
}

export function formatFileOperations(
  readFiles: string[],
  modifiedFiles: string[],
): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(
      `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
    );
  }
  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

/**
 * Serialize messages to plain text for the summarizer.
 * As text (not as a message list) the model summarizes the conversation
 * instead of trying to continue it.
 */
export function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("");
      if (text) parts.push(`[User]: ${text}`);
    } else if (msg.role === "assistant") {
      const text: string[] = [];
      const thinking: string[] = [];
      const calls: string[] = [];

      for (const block of msg.content) {
        if (block.type === "text") text.push(block.text);
        else if (block.type === "thinking") thinking.push(block.thinking);
        else if (block.type === "toolCall") {
          const args = Object.entries(block.arguments)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ");
          calls.push(`${block.name}(${args})`);
        }
      }

      if (thinking.length > 0) {
        parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
      }
      if (text.length > 0) parts.push(`[Assistant]: ${text.join("\n")}`);
      if (calls.length > 0) {
        parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
      }
    } else if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (text) parts.push(`[Tool result]: ${text}`);
    }
  }

  return parts.join("\n\n");
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
