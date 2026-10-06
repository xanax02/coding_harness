import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";

export const allTools = {
  read: readTool,
  write: writeTool,
  edit: editTool,
  bash: bashTool,
};
