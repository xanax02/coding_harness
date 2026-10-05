import { z } from "zod";
import { AgentTool } from "../types.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  TruncationResult,
} from "./truncate.js";
import { resolveReadPath, resolveToCwd } from "../utils/pathUtils.js";
import { TextContent } from "@coding-harness/ai-providers";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";

const readSchema = z.object({
  path: z.string().describe("Path to the file to read (relative or absolute)"),
  offset: z
    .number()
    .optional()
    .describe("Offset in bytes to start reading from"),
  limit: z.number().optional().describe("Number of bytes to read"),
});

export interface ReadToolDetails {
  truncation?: TruncationResult;
}

export function createReadTool(cwd: string): AgentTool<typeof readSchema> {
  return {
    name: "read",
    label: "read",
    description: `Read content from a file.  output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files`,
    parameters: readSchema,
    execute: async (toolCallId, params, signal) => {
      const { path, offset, limit } = params;

      const absolutePath = resolveReadPath(path, cwd);

      //it is returning promise as we want some machenism to cancel or reject the task on abort signal.
      return new Promise<{
        content: TextContent[];
        details: ReadToolDetails | undefined;
      }>((resolve, reject) => {
        // for now we are only handling text
        if (signal?.aborted) {
          reject(new Error("Read operation was aborted"));
          return;
        }

        let aborted = false;

        const onAbort = () => {
          aborted = true;
          reject(new Error("Read operation was aborted"));
        };

        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true });
        }

        (async () => {
          try {
            //check if file exist, using access so it will throw on non existent file
            await access(absolutePath, constants.F_OK);

            let content: TextContent[];
            let details: ReadToolDetails | undefined;

            const textContent = await readFile(absolutePath, "utf-8");
            const allLines = textContent.split("\n");
            const totalFileLines = allLines.length;

            // apply offeset
            const startLine = offset ? Math.max(0, offset - 1) : 0;
            const startLineDisplay = startLine + 1;

            if (startLine >= totalFileLines) {
              throw new Error(
                `Offset ${offset} is beyond end of file (${totalFileLines} lines total)`,
              );
            }

            let selectedContent: string;
            let userLimitedLines: number | undefined;
            if (limit !== undefined) {
              const endLine = Math.min(startLine + limit, allLines.length);
              selectedContent = allLines.slice(startLine, endLine).join("\n");
              userLimitedLines = endLine - startLine;
            } else {
              selectedContent = allLines.slice(startLine).join("\n");
            }

            const truncation = truncateHead(selectedContent);
            let outputText: string;

            if (truncation.firstLineExceedsLimit) {
              // First line at offset exceeds 30KB - tell model to use bash
              const firstLineSize = formatSize(
                Buffer.byteLength(allLines[startLine], "utf-8"),
              );
              outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
              details = { truncation };
            } else if (truncation.truncated) {
              // Truncation occurred - build actionable notice
              const endLineDisplay =
                startLineDisplay + truncation.outputLines - 1;
              const nextOffset = endLineDisplay + 1;

              outputText = truncation.content;

              if (truncation.truncatedBy === "lines") {
                outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
              } else {
                outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
              }
              details = { truncation };
            } else if (
              userLimitedLines !== undefined &&
              startLine + userLimitedLines < allLines.length
            ) {
              // User specified limit, there's more content, but no truncation
              const remaining =
                allLines.length - (startLine + userLimitedLines);
              const nextOffset = startLine + userLimitedLines + 1;

              outputText = truncation.content;
              outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
            } else {
              // No truncation, no user limit exceeded
              outputText = truncation.content;
            }

            content = [{ type: "text", text: outputText }];

            if (aborted) {
              return;
            }

            // Clean up abort handler
            if (signal) {
              signal.removeEventListener("abort", onAbort);
            }

            resolve({ content, details });
          } catch (error) {
            if (signal) {
              signal.removeEventListener("abort", onAbort);
            }

            if (!aborted) {
              reject(error);
            }
          }
        })();
      });
    },
  };
}

export const readTool = createReadTool(process.cwd());
