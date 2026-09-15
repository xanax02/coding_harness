import {
  AssistantMessageEventStream,
  Context,
  ImageContent,
  ModelInfo,
  StreamOptions,
  TextContent,
  Tool,
} from "@coding-harness/ai-providers";
import { z } from "zod";

export type streamFn = (
  model: ModelInfo,
  content: Context,
  options?: StreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** Tool definition */
export interface AgentTool<
  TSchema extends z.ZodType = z.ZodObject<any>,
  TDetails = unknown,
> extends Tool<TSchema> {
  label: string;
  prepareArguments?: (args: unknown) => z.infer<TSchema>;
  execute: (
    toolCallId: string,
    params: z.infer<TSchema>,
    signal?: AbortSignal | undefined,
  ) => Promise<AgentToolResult<TDetails>>;
}

export interface AgentToolResult<TDetails = unknown> {
  content: (TextContent | ImageContent)[];
  details?: TDetails;

  // TODO add cpuUsage, terminate, etc.
}

/** Execution env used by harness */
export interface ExecutionEnv {
  /** current working directory */
  cwd: string;
  /** Read utf-8 textfiles */
  readTextFile: (path: string) => Promise<string>;
  /** Read binary files */
  readBinaryFile: (path: string) => Promise<Uint8Array>;
  /** create or overwrite file */
  writeFile: (path: string, content: string | Uint8Array) => Promise<void>;
  /** file info */
  fileInfo: (path: string) => Promise<FileInfo>;
}

export interface FileInfo {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  modTimeMs: number;
}
