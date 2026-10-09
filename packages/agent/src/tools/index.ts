import { AgentTool } from "../types.js";
import { bashTool, createBashTool } from "./bash.js";
import { createEditTool, editTool } from "./edit.js";
import { createReadTool, readTool } from "./read.js";
import { createWriteTool, writeTool } from "./write.js";

export { createBashTool, createEditTool, createReadTool, createWriteTool };

/** The four tools a coding agent needs, bound to a working directory */
export function createCodingTools(cwd: string): AgentTool<any>[] {
  return [
    createReadTool(cwd),
    createBashTool(cwd),
    createEditTool(cwd),
    createWriteTool(cwd),
  ];
}

export const allTools = {
  read: readTool,
  write: writeTool,
  edit: editTool,
  bash: bashTool,
};
