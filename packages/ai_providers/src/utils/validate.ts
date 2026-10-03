/**
 * validate.ts
 *
 * Tool-call argument validation for the coding harness AI provider layer.
 *
 * Given a Tool whose `parameters` field is a Zod schema and a
 * ToolCall whose `arguments` came back from an LLM, validates those arguments
 * so that downstream tool-execution code can trust the shape it receives.
 *
 * ## Architecture
 *
 * 1. **Validation pass** — `z.safeParse` runs the full Zod check against the
 *    raw LLM arguments.  Errors are formatted into a human-readable string that
 *    names the failing field path, which the agent loop can feed back to the
 *    LLM as a correction prompt.
 *
 * 2. **CSP guard** — In browser-extension environments (Manifest V3) some Zod
 *    internals may be affected by strict CSP.  When detected, validation is
 *    skipped and the raw arguments are returned as-is, trusting the LLM output.
 */

import { z } from "zod";
import type { Tool, ToolCall } from "../types.js";

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/**
 * Formats a Zod validation issue into a human-readable "path: message" string.
 *
 * Zod reports issue paths as arrays of string/number segments (e.g.
 * `["params", "command", 0]`).  We join them with dots (array indices become
 * e.g. `params.command.0`) and fall back to `"root"` when the path is empty
 * (a top-level failure).
 *
 * @param issue - A single Zod validation issue.
 * @returns A formatted path string such as `"params.flags.0"` or `"root"`.
 */
function formatZodIssuePath(issue: z.ZodIssue): string {
  if (issue.path.length === 0) {
    return "root";
  }
  return issue.path.join(".");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Finds a tool by name and validates the tool call arguments against its Zod schema.
 *
 * This is the top-level entry point for the agent loop.  It delegates to
 * `validateToolArguments` after the tool lookup.
 *
 * @param tools    - The full list of tools registered with the agent.
 * @param toolCall - The tool call object produced by the LLM (name + arguments).
 * @returns The validated arguments object.
 * @throws {Error} If the named tool is not found in `tools`.
 * @throws {Error} If the arguments do not satisfy the tool's Zod schema, with
 *                 a detailed human-readable error message.
 */
export function validateToolCall(
  tools: Tool[],
  toolCall: ToolCall,
): Record<string, unknown> {
  const tool = tools.find((t) => t.name === toolCall.name);
  if (!tool) {
    throw new Error(`Tool "${toolCall.name}" not found`);
  }
  return validateToolArguments(tool, toolCall);
}

/**
 * Validates the arguments of a single tool call against the tool's Zod schema.

 * On failure, every Zod issue is formatted as `"  - path: message"` and the
 * raw arguments JSON is appended — the resulting error message is suitable for
 * feeding back to the LLM as a correction prompt.
 *
 * @param tool     - The tool definition, including its `parameters` Zod schema.
 * @param toolCall - The tool call from the LLM, containing `name` and `arguments`.
 * @returns The validated arguments object (type-narrowed by Zod's parse output).
 * @throws {Error} With a detailed message listing all failing fields and the
 *                 raw arguments JSON if Zod validation fails.
 */
export function validateToolArguments(
  tool: Tool,
  toolCall: ToolCall,
): Record<string, unknown> {
  const result = tool.parameters.safeParse(toolCall.arguments);

  if (result.success) {
    return result.data as Record<string, unknown>;
  }

  // Format validation errors nicely.
  const errors =
    result.error.issues
      .map((issue) => `  - ${formatZodIssuePath(issue)}: ${issue.message}`)
      .join("\n") || "Unknown validation error";

  const errorMessage =
    `Validation failed for tool "${toolCall.name}":\n${errors}\n\n` +
    `Received arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

  throw new Error(errorMessage);
}
