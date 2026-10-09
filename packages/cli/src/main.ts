#!/usr/bin/env node
import { getModel, getModels } from "@coding-harness/ai-providers";
import {
  Agent,
  buildSystemPrompt,
  createCodingTools,
  loadProjectContext,
} from "@coding-harness/agent";
import { Repl } from "./repl.js";

const HELP = `coding-harness [options] [prompt]

  prompt             first message; the session continues interactively afterwards
  -p, --print        run the prompt, print the answer, exit
  -m, --model <id>   model id (default: agent default)
  --no-compact       disable automatic context compaction
  -h, --help         show this help

In the session:
  <text>             send a message; while the agent runs it steers the agent instead
  /compact [focus]   compact the context now
  /reset             clear the conversation
  /exit              quit
  Ctrl+C             abort the current run; press again to exit

Needs ANTHROPIC_API_KEY.`;

interface Args {
  prompt?: string;
  model?: string;
  print: boolean;
  compact: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { print: false, compact: true, help: false };
  const words: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "-p" || arg === "--print") args.print = true;
    else if (arg === "--no-compact") args.compact = false;
    else if (arg === "-m" || arg === "--model") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a model id`);
      args.model = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else words.push(arg);
  }

  if (words.length > 0) args.prompt = words.join(" ");
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.print && !args.prompt) {
    throw new Error("--print needs a prompt");
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const cwd = process.cwd();
  const tools = createCodingTools(cwd);

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt({
        cwd,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        projectContext: loadProjectContext(cwd),
      }),
      tools,
    },
    getApiKey: () => apiKey,
  });

  if (args.model) {
    const model = getModel("anthropic", args.model);
    if (!model) {
      const known = getModels("anthropic").map((m) => m.id).join(", ");
      throw new Error(`Unknown model "${args.model}". Known: ${known}`);
    }
    agent.setModel(model);
  }

  const repl = new Repl({
    agent,
    getApiKey: () => apiKey,
    compaction: { enabled: args.compact },
  });

  if (args.print) {
    return (await repl.runPrompt(args.prompt!)) ? 0 : 1;
  }

  if (args.prompt) {
    // run the first message, then hand over to the interactive loop
    await repl.runPrompt(args.prompt);
  }
  await repl.start();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
