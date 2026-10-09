# coding_harness

A coding agent (read / write / edit / bash tools + LLM loop) built by following pi v0.35.0
(`c:\development\harnesses\pi_harness`, branch `v035-base`) as a reference. Read for structure,
do not copy wholesale. Roadmap: `pi_harness/coding_harness-TODO.md`.

## Layout

```
packages/
  ai_providers/  @coding-harness/ai-providers   LLM layer (Anthropic only)
  agent/         @coding-harness/agent          loop, Agent class, tools, prompt, compaction
  cli/           @coding-harness/cli            readline frontend (binary: coding-harness)
```

Dependency direction: `cli -> agent -> ai_providers`. Packages import each other by package name;
they resolve through each package's `dist/`, so run `npm run build` after changing a lower package.

### ai_providers/src
- `types.ts` Message / AssistantMessage / ToolCall / Usage / ModelInfo / stream event types
- `providers/anthropic.ts` `anthropicStream`, `buildParams`, message + tool conversion
- `stream.ts` `stream()` / `complete()` (always Anthropic for now)
- `provider.ts` `getModel`, `getModels`, `calculateCost`; `models/` model table
- `utils/event-stream.ts` `EventStream`, `AssistantMessageEventStream`
- `utils/validate.ts` zod validation of tool-call arguments
- `utils/overflow.ts` `isContextOverflow` (provider "prompt too long" detection)
- `faux.ts` fully commented out; tests use a scripted stream function instead

### agent/src
- `agent-loop.ts` `agentLoop` / `retryAgentLoop`: stream reply, run tool calls sequentially,
  steering + follow-up queues. Events: `agent_start/end`, `iteration_start/end` (pi calls it turn),
  `message_*`, `tool_execution_start/update/end`
- `agent.ts` `Agent`: state, `prompt` / `continue` / `abort` / `reset`, `steer` / `followUp`, `subscribe`
- `types.ts` `AgentTool`, `AgentEvent`, `AgentLoopConfig`, `AgentState`
- `tools/` `createReadTool/WriteTool/EditTool/BashTool(cwd)`, `createCodingTools(cwd)`, `truncate.ts`
- `systemPrompt.ts` `buildSystemPrompt({cwd, tools, projectContext})`, `loadProjectContext(cwd)`
- `compaction/compaction.ts` pure logic: `prepareCompaction`, `findCutPoint`, `compact`, summary message
- `compaction/auto-compaction.ts` `AutoCompaction`: wraps an Agent, call `afterRun()` after each prompt
- `compaction/utils.ts` file-op tracking, `serializeConversation`
- `utils/shellUtils.ts` Git Bash lookup on Windows, `killProcessTree`; `utils/pathUtils.ts`

### cli/src
- `repl.ts` `Repl`: readline loop, event rendering, steering, Ctrl+C, `/compact` `/reset` `/exit`.
  Takes injectable `input` / `output` streams (used by the tests)
- `main.ts` argument parsing and wiring. Needs `ANTHROPIC_API_KEY`
- `test/e2e.test.ts` scripted-provider tests

## Commands
- `npm run check` typecheck everything (run after code changes)
- `npm run build` build all packages (needed before `npm test` and before running the binary)
- `npm test --workspace @coding-harness/cli` end-to-end tests, no network, no API key
- `node packages/cli/dist/main.js [prompt]`

## Conventions
- Tool schemas are **zod 4**. `zod-to-json-schema` only understands zod 3; the Anthropic provider
  uses `z.toJSONSchema` instead (the `zod-to-json-schema` dependency is now unused)
- Tools are factories bound to a cwd and **throw** on error; the loop turns a throw into an
  `isError` tool result
- Event names differ from pi: `iteration_*` here, `turn_*` in pi
- Message types are exactly `user | assistant | toolResult` (no custom message kinds)

## Status
Done: provider layer, loop, tools (read/write/edit/bash), `Agent`, system prompt, CLI (Step 11),
compaction (Step 12).

**Deliberately skipped: session persistence (TODO Step 10).** The conversation lives only in
`agent.state.messages`; quitting loses it, and there is no `--continue`. Consequences:
- compaction rewrites the in-memory history (`agent.replaceMessages`) and stores the summary as a
  marked user message (see `createSummaryMessage` / `getSummaryText`), not as a session entry
- when sessions are added: append on `message_end`, load at startup into `agent.replaceMessages`,
  and persist the compaction (summary + kept messages) so a reload reproduces it.
  Reference: `pi_harness/pi-SESSION.md`

## Known gaps
- Not verified against the real Anthropic API (no key was available when written): everything
  was tested with a scripted provider. First real run should be treated as the real test
- No guard for `stopReason === "length"` (truncated tool-call JSON): tool calls from a truncated
  reply are still executed (TODO Step 7)
- Compaction token counts come from the last assistant message's usage; right after a compaction
  the next count is stale until the next reply
- Thinking is never enabled: `Agent` sets `resoning` but the Anthropic provider reads `thinkingEnabled`
- `Agent` default model is `claude-haiku-4-5-20251001`; the model table also has `claude-fabel-5-1`,
  `claude-opus-5`, `claude-sonnet-5` ids that should be checked against real model ids
- Stale compiled `.js` files are committed under `ai_providers/src` (`api/`, `index.js`, ...);
  `api/anthropic.ts` is a leftover duplicate of `providers/anthropic.ts`
- `bash` tool: the `timeout` param is documented as milliseconds but multiplied by 1000 (so it acts
  as seconds), and the schema description says "bash" while Windows runs Git Bash

## Rules for working here
- Read a file in full before editing it; match the surrounding style (2-space indent, double quotes)
- No `any` unless necessary; top-level imports only
- Do not commit unless asked
