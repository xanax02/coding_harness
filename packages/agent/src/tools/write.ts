import { AgentTool } from "../types.js";
import { z } from "zod";
import { resolveToCwd } from "../utils/pathUtils.js";
import { dirname } from "path";
import { mkdir, writeFile } from "fs/promises";

const writeZodSchema = z.object({
  path: z.string().describe("Path to the file to write (relative or absolute)"),
  content: z.string().describe("Content to write to the file"),
});

// const writeSchema = zodToJsonSchema(writeZodSchema) as unknown as z.ZodType;

export function createWriteTool(cwd: string): AgentTool<typeof writeZodSchema> {
  return {
    name: "write",
    label: "write",
    description: "Write content to a file",
    parameters: writeZodSchema,
    execute: async (toolCallId, params, signal) => {
      const { path, content } = params;
      const absolutePath = resolveToCwd(path, cwd);
      const dir = dirname(absolutePath);

      return new Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: undefined;
      }>((resolve, reject) => {
        // Check if already aborted
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
          signal.addEventListener("abort", onAbort, { once: true });
        }

        // Perform the write operation
        (async () => {
          try {
            // Create parent directories if needed
            await mkdir(dir, { recursive: true });

            // Check if aborted before writing
            if (aborted) {
              return;
            }

            // Write the file
            await writeFile(absolutePath, content, "utf-8");

            // Check if aborted after writing
            if (aborted) {
              return;
            }

            // Clean up abort handler
            if (signal) {
              signal.removeEventListener("abort", onAbort);
            }

            resolve({
              content: [
                {
                  type: "text",
                  text: `Successfully wrote ${content.length} bytes to ${path}`,
                },
              ],
              details: undefined,
            });
          } catch (error: any) {
            // Clean up abort handler
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

export const writeTool = createWriteTool(process.cwd());
