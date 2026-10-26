# DSH compatibility

Fusion supports **DeepSeek Harness 0.2.1-rc.2**. It is an ordinary external plugin: it uses only DSH's public
plugin APIs and never patches, replaces or rebuilds DSH itself. `scripts/build.mjs` refuses to build against another
Host version, `engines.dsh` declares the supported runtime, and the `peerDependencies` pin the same release.

## What Fusion depends on

Public services always used (`ctx.*`): `agents`, `subagents`, `sessions`, `sessionQuery`, `sessionController`
(`modelCatalog`, `selectModel`, `resolveAgent`), `llm` (`stream` hooks, `resolveModelInfo`, `registerAdapter`),
`tools` (`guard`, `execute`, per-agent catalog), `commands`, `webServer`, `agentDefaultModel`, `logger`.

Services Fusion looks up at runtime (`ctx.get`), with what happens when one is missing:

| Service | Used for | Without it |
| --- | --- | --- |
| `sandboxPolicy` | the Lead's read-only sandbox (enforced-v3) | every Lead shell command is refused; the Lead still reads with file and search tools |
| `jobs` | the Sidekick's background commands | background commands are refused |
| `tokenMeter` | measuring each request against the context window | Fusion requests stop with an error |
| `compaction`, `agentPresets` | compacting a long Fusion conversation | Fusion pauses when the context is full, keeping the full record |
| `approval` | routing Sidekick approvals through DSH's own approval policy | commands that need approval fail |
| `locale` (client) | Chinese / English UI | the UI follows the browser language |

Packages imported: `cordis`, `schemastery`, `dsh-agent`, `dsh-llm`, `dsh-session`, `dsh-session-query`,
`dsh-subagent`, `dsh-tools`, `dsh-jobs`, `dsh-commands`, `dsh-host-webserver`, `dsh-api-session-controller`,
`dsh-agent-default-model`, `dsh-agent-preset-registry`, `dsh-compaction`, `dsh-token-meter`, `dsh-user-approval` and the
client packages `dsh-client-ui-*` and `dsh-client-store`. Only package entry points and their documented `/client` and
`/types` subpaths are imported.

Fusion writes only public session events (messages, tool calls and results, and `sandbox/mode` for the Lead's read-only
sandbox) and stores its own records in its plugin directory.

## Changes from 0.2.0-rc.2 to 0.2.1-rc.2

The subagent seam was renamed and widened; the delegation composition knobs moved. Everything else Fusion imports
kept its shape — all 25 non-client `@deepseek-ai/*` symbols Fusion imports still exist with unchanged signatures.

| 0.2.0-rc.2 | 0.2.1-rc.2 | Fusion's handling |
| --- | --- | --- |
| `ctx.subagents.startContinuable(spec)` | `ctx.subagents.startActivation(spec)` | renamed in `src/host/native-worker.ts` |
| `ContinuableStartSpec`, `ContinuableStart` | `SubagentActivationSpec`, `SubagentActivation` | spec gained a required `delivery: 'parent' \| 'caller'`; the return gained `result`/`dispose()` and made `messageId` optional |
| `ctx.subagents.drainContinuableChildren(parent, childIds)` | `ctx.subagents.drainChildren(parent, childIds)` | renamed; `drainDescendants(parents)` is the broader form |
| `ctx.subagents.start(name, request)` | removed | the benchmark baseline uses `startActivation` with `delivery: 'caller'` |
| `SubagentRun.localAgent` | removed | the child Agent is read back with `ctx.agents.get(childId)` |
| `request.persona`, `request.toolFilter` | removed (DSH directs callers to an Agent Preset) | see below |
| `TerminalBlockLabels` (client) | gained a required `commandLine` | added in `src/client/ActivityRows.tsx` |

`delivery: 'parent'` preserves the 0.2.0 behaviour: the Worker's settlement reaches the Lead's inbox, which is what
the Lead reconciles from the session log.

**The persona and tool-ceiling knobs have no start-time replacement.** 0.2.1 rejects them outright
(`tool-subagent: persona is no longer supported; configure persona and tool plugins in an Agent Preset and select it
with agentPreset`) and `SubagentStartRequest` no longer declares them. The sanctioned replacement is an Agent Preset,
but Fusion computes the Worker's persona and its tool set per work order at runtime, so a preset cannot express them —
and requiring a user-configured preset would silently change Fusion's contract. Fusion therefore keeps both inside the
native role scope it already owns:

- the Worker's persona prompt was already redundant: `NativeFusionScopes` installs the `fusion-role` system-prompt
  section carrying `binding.prompts[role]` on the child's own context;
- the Worker's tool ceiling was **not** redundant. In `implement` mode `readOnlyTools` used to return `undefined` and
  the ceiling came from the start-time `toolFilter` alone. `readOnlyTools` now returns `workerTools` for every Worker
  mode, so `NativeFusionScopes` narrows the inherited tool set for the child. Its scope is installed at
  `agent/created`, before the child's first request, and the existing deny-only guard remains the second gate.

That leaves one deliberate behavioural difference to flag: `NativeFusionScopes` pairs a tool restriction with
`tools.presentAs('native')`, so an `implement`-mode Worker is now presented natively like the read-only modes already
were. The advertised tool list and the enforced ceiling are unchanged.

### Version declarations

The old version declarations were **not** what blocked 0.2.1, and it is worth being precise about why. DSH evaluates
plugin requirements with `includePrerelease: true`, and `0.2.1-rc.2` sorts *below* `0.2.1`, so the old
`>=0.2.0-rc.1 <0.2.1` peer range already satisfied the 0.2.1 gate. What broke was the code.

`engines.dsh: ">=0.2.1-rc.2 <0.3.0-0"` is added anyway, for two reasons: after this port the code genuinely requires
0.2.1 and would fail on 0.2.0-rc.2, and `engines.dsh` decides alone, so it states that requirement in the one place
DSH consults first. The peer ranges are widened to the same span because `scripts/link-host.mjs` checks them with
**plain** semver, where `>=0.2.0-rc.1 <0.2.1` rejects `0.2.1-rc.2`.

| Runtime | Old declarations | New declarations |
| --- | --- | --- |
| DSH `0.2.0-rc.2` | accepted | rejected |
| DSH `0.2.1-rc.2` | accepted (but the code fails) | accepted |

## Changes from 0.1.5 to 0.1.7 (an example of what an upgrade touches)

- Plugin message sources became `{ kind: 'plugin:<id>' }` (was `{ kind: 'plugin', plugin: '<id>' }`); Fusion declares its
  kind in `src/message-source.ts`.
- Jobs: `JobSnapshot`/`onJobDone` became `JobView`/`events.subscribe`, and job calls take the calling agent's id.
- `dsh-agent-presets` became `dsh-agent-preset-registry`.
- Tool results became `role: 'tool'` messages that carry `toolCallId` and `isError` themselves.
- Session logs are `session.v4.jsonl.zstd` (benchmark tooling reads v3 and v4).
- Plugins declare a bundle patch (`dsh.bundle.patch` → `cordis.patch.yml`).

## Adapting to a new DSH release (for example 0.1.8)

1. Check out the new Harness release and point `DSHX_HARNESS` at it.
2. Update the version check in `scripts/build.mjs`, `engines.dsh` and the `@deepseek-ai/*` `peerDependencies`; relink
   with `node scripts/link-host.mjs <harness>`. Pick the range carefully: DSH's gate uses `includePrerelease`, where a
   prerelease sorts below its own release, so a stale upper bound like `<0.2.1` still admits `0.2.1-rc.2` and silently
   passes — while `scripts/link-host.mjs` uses plain semver and rejects it. Declare the span you actually support
   (`>=0.2.1-rc.2 <0.3.0-0`) and verify both consumers.
3. Read the release notes and run `dshx check` for compatibility rules; fix type errors (`pnpm typecheck`). Renames in
   the subagent seam are not caught by type checking when the old name is simply gone — grep `ctx.subagents` calls by
   hand, and check the client packages too (`TerminalBlockLabels` gained a required field this time).
4. Run `pnpm test` and `pnpm test:host` against the new Harness; the Host suite exercises the real Agent, session,
   tool, job, sandbox and subagent services.
5. Cold-boot the plugin alone in a temporary home: `dshx verify-boot <plugin dir>`.
6. Install into a real DSH and run a short task with a Fusion pair; check the Lead read-only probe from the README.
7. Update the supported version in `README.md`, `README.en.md`, `INSTALL*.md` and this file.

## Other plugins that rewrite the tool table

Fusion registers `fusion_*` tools on the agent and then filters `system-prompt/assemble` down to the role allowlist.
That filter only removes tools. A plugin that **replaces** `assembled.tools` inside the same hook — `dsh-tool-search` does
this, keeping an eager set such as `bash`, `glob`, `grep`, `read` and moving everything else, including `fusion_*` and
often `job_output`, out of the request — used to leave the Lead with no delegation tool. The task could then end
`COMPLETED` without any Fusion work.

Fusion now rebuilds the request table as **allowlist ∪ its own registry** after `next()` returns. Names the role is
allowed to see are copied back from `tools.schemas(agent)` when another plugin dropped them. If a required `fusion_*`
tool is not in that registry either, assembly throws `FUSION_TOOL_TABLE_INCOMPLETE` instead of sending the request.
Putting those names in `dsh-tool-search`'s `core` list is unnecessary once this build is installed; it remains harmless.

## Host behaviour Fusion does not own

These show up next to Fusion's own gates. Fusion does not patch the host to remove them.

- **Sandbox read-only denial.** `[sandbox: file access denied under read-only mode]` is the DSH sandbox backend.
  enforced-v3 keeps the Lead's session read-only on purpose. The Sidekick is given the mode the user chose for the
  conversation. Fusion applies that mode when the user appends `sandbox/mode`, including onto a resident Sidekick, and
  again on the Sidekick's next model request. It never widens the Lead, and it cannot grant a mode the user did not set.
  A Sidekick that has already been disposed has no session left to update; the next delegation seeds a new one.
- **Reload recovery after a quota stop.** A Worker that stops on provider quota often leaves its `native-worker` outbox
  row `accepted` because no report was acknowledged. The next host start treats that row like any other unacknowledged
  dispatch and sets `recovering`. Continue and role switch both run only after `settled()`, which requires
  `recovering` to be clear, and the route is not written if that check fails. That inspection stays: Fusion cannot see
  host file or process effects that were not in its own journal. Use `/fusion recover <inspection note>`, then continue
  or switch the Sidekick from the recovery panel. Saving a new pair in Settings changes the default for new
  conversations only.
- **Natural Worker disposal.** DSH `0.2.0-rc.2` disposes a continuable child in `finishDisposal` and only then sends
  `subagent-settled`. `fusion_wait` reads the persisted task when that handle is already gone. It asks for recovery
  only when a native effect is still pending or the outcome is unknown. An ended Worker with no report is
  `WORKFLOW_INCOMPLETE`, not a quota or provider outage.
