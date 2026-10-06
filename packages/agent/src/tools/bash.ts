import { z } from "zod";
import { AgentTool } from "../types.js";
import {
  DEFAULT_MAX_BYTES,
  truncateTail,
  TruncationResult,
} from "./truncate.js";
import { getShellConfig, killProcessTree } from "../utils/shellUtils.js";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bashSchema = z.object({
  command: z.string().describe("The bash command to execute"),
  timeout: z.number().optional().describe("Timeout in milliseconds"),
});

interface bashToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

export function createBashTool(cwd: string): AgentTool<typeof bashSchema> {
  return {
    name: "bash",
    label: "bash",
    description: "Execute a bash command",
    parameters: bashSchema,
    execute: async (toolCallId, params, signal?, onUpdate?) => {
      const { command, timeout } = params;

      return new Promise((resolve, reject) => {
        // Handle abort signal - kill entire process tree
        const onAbort = () => {
          if (child.pid) {
            killProcessTree(child.pid);
          }
        };

        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        const { shell, args } = getShellConfig();
        const child = spawn(shell, [...args, command], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let tempFilePath: string | undefined;
        let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
        let totalBytes = 0;

        // Keep a rolling buffer of the last chunk for tail truncation
        const chunks: Buffer[] = [];
        let chunksBytes = 0;
        // Keep more than we need so we have enough for truncation
        const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

        let timedOut = false;

        // Set timeout if provided
        let timeoutHandle: NodeJS.Timeout | undefined;
        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            onAbort();
          }, timeout * 1000);
        }

        const handleData = (data: Buffer) => {
          totalBytes += data.length;

          // Start writing to temp file once we exceed the threshold
          if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
            tempFilePath = getTempFilePath();
            tempFileStream = createWriteStream(tempFilePath);
            // Write all buffered chunks to the file
            for (const chunk of chunks) {
              tempFileStream.write(chunk);
            }
          }

          // Write to temp file if we have one
          if (tempFileStream) {
            tempFileStream.write(data);
          }

          // Keep rolling buffer of recent data
          chunks.push(data);
          chunksBytes += data.length;

          // Trim old chunks if buffer is too large
          while (chunksBytes > maxChunksBytes && chunks.length > 1) {
            const removed = chunks.shift()!;
            chunksBytes -= removed.length;
          }

          // Stream partial output to callback (truncated rolling buffer)
          if (onUpdate) {
            const fullBuffer = Buffer.concat(chunks);
            const fullText = fullBuffer.toString("utf-8");
            const truncation = truncateTail(fullText);
            onUpdate({
              content: [{ type: "text", text: truncation.content || "" }],
              details: {
                truncation: truncation.truncated ? truncation : undefined,
                fullOutputPath: tempFilePath,
              },
            });
          }
        };

        // Collect stdout and stderr together
        if (child.stdout) {
          child.stdout.on("data", handleData);
        }
        if (child.stderr) {
          child.stderr.on("data", handleData);
        }
      });
    },
  };
}

function getTempFilePath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `coding-harness-bash-${id}.log`);
}
