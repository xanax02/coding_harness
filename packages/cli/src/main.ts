#!/usr/bin/env node
import {
  getModel,
  getModels,
  getProviders,
} from "@coding-harness/ai-providers";
import "dotenv/config";
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

Default model is openrouter/openai/gpt-4o-mini and needs OPENROUTER_API_KEY.
Other keys: OPENAI_API_KEY (openai), ANTHROPIC_API_KEY (anthropic).`;

const API_KEY_ENV: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

function findModel(spec: string) {
  for (const provider of getProviders()) {
    if (spec.startsWith(`${provider}/`)) {
      const model = getModel(provider, spec.slice(provider.length + 1));
      if (model) return model;
    }
  }
  for (const provider of ["openrouter", ...getProviders()]) {
    const model = getModel(provider, spec);
    if (model) return model;
  }
  return undefined;
}

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

  const getApiKey = (provider: string) =>
    process.env[API_KEY_ENV[provider] ?? ""];

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
    getApiKey,
  });

  if (args.model) {
    // accepts "<provider>/<id>" (e.g. anthropic/claude-haiku-4-5-20251001) or a bare id
    // (looked up under openrouter first, then the other providers)
    const model = findModel(args.model);
    if (!model) {
      const known = getProviders()
        .flatMap((p) => getModels(p).map((m) => `${p}/${m.id}`))
        .join(", ");
      throw new Error(`Unknown model "${args.model}". Known: ${known}`);
    }
    agent.setModel(model);
  }

  const model = agent.state.model;
  if (!getApiKey(model.provider)) {
    throw new Error(
      `${API_KEY_ENV[model.provider] ?? "API key"} is not set (needed for ${model.provider})`,
    );
  }

  const repl = new Repl({
    agent,
    getApiKey,
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
