import { z } from "zod";
import { AgentTool } from "../types.js";
import { resolveReadPath } from "../utils/pathUtils.js";
import { TextContent } from "@coding-harness/ai-providers";
import { access, constants, readFile, writeFile } from "fs/promises";

const editSchema = z.object({
  path: z.string().describe("Path to the file to edit, (relative or absolute"),
  oldText: z.string().describe("Exact text to replace"),
  newText: z.string().describe("New text to replace with"),
});

export interface EditToolDetails {
  /** Diff of the changes made */
  diff: string;
  /** Line number of the first change in the new file for editor navigation */
  firstChangedLine?: number;
}

export function createEditTool(cwd: string): AgentTool<typeof editSchema> {
  return {
    name: "edit",
    label: "edit",
    description: "Edit a file by replacing text",
    parameters: editSchema,
    execute: async (toolCallId, params, signal) => {
      const { path, oldText, newText } = params;
      const absolutePath = resolveReadPath(path, cwd);

      return new Promise<{
        content: TextContent[];
        details: EditToolDetails | undefined;
      }>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }

        let aborted = false;

        // Set up abort handler
        const onAbort = () => {
          aborted = true;
          reject(new Error("Operation aborted"));
        };

        if (signal) {
          signal.addEventListener("abort", onAbort, {
            once: true,
          });
        }

        (async () => {
          try {
            await access(absolutePath, constants.R_OK | constants.W_OK);

            if (aborted) {
              return;
            }

            const rawContent = await readFile(absolutePath, "utf-8");

            // Check if aborted after reading
            if (aborted) {
              return;
            }

            const { bom, text: content } = stripBom(rawContent);

            const originalEnding = detectLineEnding(content);
            const normalizedRawContent = normalizeToLF(content);
            const normalizedOldText = normalizeToLF(oldText);
            const normalizedNewText = normalizeToLF(newText);

            if (!normalizedRawContent.includes(normalizedOldText)) {
              if (signal) {
                signal.removeEventListener("abort", onAbort);
              }
              reject(new Error(`Could not find the exact text in ${path}. `));
              return;
            }

            // Count occurrences
            const occurrences =
              normalizedRawContent.split(normalizedOldText).length - 1;

            if (occurrences > 1) {
              if (signal) {
                signal.removeEventListener("abort", onAbort);
              }
              reject(
                new Error(
                  `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
                ),
              );
              return;
            }

            // Check if aborted before writing
            if (aborted) {
              return;
            }

            const index = normalizedRawContent.indexOf(normalizedOldText);
            const normalizedNewContent =
              normalizedRawContent.substring(0, index) +
              normalizedNewText +
              normalizedRawContent.substring(index + normalizedOldText.length);

            // Verify the replacement actually changed something
            if (normalizedRawContent === normalizedNewContent) {
              if (signal) {
                signal.removeEventListener("abort", onAbort);
              }
              reject(
                new Error(
                  `No changes made to ${path}. The replacement produced identical content.`,
                ),
              );
              return;
            }

            const finalContent =
              bom + restoreLineEndings(normalizedNewContent, originalEnding);
            await writeFile(absolutePath, finalContent, "utf-8");

            // Check if aborted after writing
            if (aborted) {
              return;
            }

            // Clean up abort handler
            if (signal) {
              signal.removeEventListener("abort", onAbort);
            }

            //TODO add diff details
            resolve({
              content: [
                {
                  type: "text",
                  text: `Successfully replaced text in ${path}.`,
                },
              ],
              details: undefined,
            });
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

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(
  text: string,
  ending: "\r\n" | "\n",
): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}
/**
 * It looks at where \r\n and \n first appear in the file,
 * and whichever comes first is declared the file's line ending style.
 */
export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export const editTool = createEditTool(process.cwd());
