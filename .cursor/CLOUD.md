# Cloud agent rules

These rules are mandatory for every Cloud Agent turn in this repository. Soft wording elsewhere does not override them.

## Model

- Only use Grok 4.6 (`cursor-grok-4.6-*`). Work as this Cloud Agent under Grok 4.6.
- Prefer Grok or Composer only. Composer is the only fallback if Grok is unavailable.
- Never Claude, Sonnet, Opus, GPT, or Gemini — including via Task, subagents, or "just this one helper".
- Never select Claude/GPT/Gemini; stay on the parent Grok model only.
- Never launch subagents (Task / explore / browser / computerUse / video) with other models. Only use grok 4.6.
- If a subagent is required, do not pass a model argument; inherit the parent model (`model: inherit`).

## Task / computer use / browser

- Do not spawn Task / computerUse / browser subagents unless the user explicitly asks.
- Do not spawn Claude/Sonnet/Opus/computerUse/browser subagents.
- Default to local tools: Read, Grep, Glob, Shell, and in-repo tests.
- Do not use browser automation to work around a missing Host, skin, or MCP server.

## Scope

- One repo: `dsh-model-fusion` only.
- Do not merge. Do not npm publish. Do not touch other machines or other plugins.

## Hooks

`.cursor/hooks.json` + `.cursor/hooks/block-other-models.sh` deny Claude/Sonnet/Opus/computerUse/browser at `subagentStart`. Do not weaken or bypass those hooks.

`.cursor/agents/worker.md` is the default implementation worker. Use it instead of generic Task.
