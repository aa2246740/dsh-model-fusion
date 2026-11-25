# DSH compatibility

Fusion supports **DeepSeek Harness 0.2.2-rc.5** (`>=0.2.2-rc.5 <0.2.3-0`). It is an ordinary external plugin: it uses only DSH's public plugin APIs and never patches, replaces or rebuilds DSH itself. `scripts/build.mjs` builds standalone with local `tsdown` and `lightningcss` (and validates `DSHX_HARNESS` when set for host integration tests), `engines.dsh` declares the supported runtime, and every `@deepseek-ai/dsh-*` peer uses the same range.

## What Fusion depends on

Public services always used (`ctx.*`): `agents`, `subagents`, `sessions`, `sessionQuery`, `sessionController`
(`modelCatalog`, `selectModel`, `resolveAgent`), `llm` (`stream` hooks, `prepareCall`, `resolveModelInfo`, `providerRetryPolicy`, `registerAdapter`),
`tools` (`guard`, `restrict`, `register(..., { when })`, `ToolExecutionPipeline`), `commands`, `webServer`, `agentDefaultModel`, `logger`.

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
`dsh-subagent`, `dsh-tools` (including `@deepseek-ai/dsh-tools/pipeline`), `dsh-jobs`, `dsh-commands`,
`dsh-host-webserver`, `dsh-api-session-controller`, `dsh-agent-default-model`, `dsh-agent-preset-registry`,
`dsh-compaction`, `dsh-token-meter`, `dsh-user-approval`, `dsh-goal` (optional native Goal mode integration),
and the client packages `dsh-client-ui-*` and `dsh-client-store`.

Fusion writes only public session events (messages, tool calls and results, `model/selection`, and `sandbox/mode` for the Lead's read-only sandbox) and stores its own records in its plugin directory.

## Changes for 0.2.2-rc.5

DSH `0.2.2-rc.5` locked several runtime seams and removed legacy 0.2.0/0.2.1 compatibility paths. Fusion targets `0.2.2-rc.5` directly:

| Area | DSH 0.2.2-rc.5 change | Fusion's handling |
| --- | --- | --- |
| Build tooling | `tools/dshx` removed from Harness checkouts | Vendored standalone build recipe in `tools/client-build.js` using local `tsdown` and `lightningcss`; `pnpm build` works without a Harness checkout |
| Lead model routing | `agent/request` freezes `provider`, `model`, and `reasoningEffort` from `agent.model.current()` | `FusionCatalogAdapter` implements `prepareCall`, `resolveModel` (exposing physical context/limits/update modes while omitting `reasoning`), and `stream` forwarding to the physical Lead adapter via `ctx.llm.prepareCall` with persisted per-message `replayState` route provenance and `agent/request-error` retry-policy forwarding |
| Worker model routing | Same locked `agent/request` seam | Worker runs directly on its physical route via `agentOptions` on activation and `agent.model.select()` on route switches |
| Tool visibility | `scope.tools.presentAs`, `tools.mode`, and `assembled.tools` removed; tool declarations are provider-owned | `scope.tools.restrict({ allow })` narrows inherited global and preset tools on both Lead and Worker; Fusion tools use `{ when: () => isAllowed(name) }` step-time conditions; `scope.tools.guard` remains the monotonic execution boundary (third-party tools registered directly on an agent's own `agent.ctx` remain visible in tool schemas by DSH's `ToolsService` contract, but unauthorized calls are still denied by `scope.tools.guard`) |
| Check execution | `ctx.tools.execute` takes `ToolBatchInput`; `@deepseek-ai/dsh-tools/types` removed | `src/host/native-checks.ts` uses `ToolExecutionPipeline` from `@deepseek-ai/dsh-tools/pipeline` with a fallback lookup for the global native shell tool |
| Subagent lifecycle | `startActivation` takes flattened fields (`prompt`, `agentOptions`, `maxDepth`, `signal`); `drainChildren` removed | `NativeWorkerTransport` uses flattened `startActivation` and tracks live `SubagentActivation` handles, releasing via `activation.dispose()` (or interrupt + idle + inbox clear for cold-resumed children) without calling `drainDescendants` on a live parent |
| Model selection helper | `installModelSelection(agent.ctx)` takes 1 argument; `agent.model.select()` is authoritative | `installNativeFusionSelection` and `FusionCoordinator` use `agent.model.current()` / `agent.model.select()` |
| Custom LLM failures | `new LlmError(msg, code)` requires a built-in failure code | Custom Fusion budget/context codes use `LlmError.fromFailure(...)` |
| Native Goal mode | `@deepseek-ai/dsh-goal-round-driver` emits `user/message` with `source: { kind: 'goal', round }` | `isInstructionSource()` accepts both native `user` and positive-round `goal` sources for delegation, task titling, and direct-turn completeness, while keeping Goal tools (`get_goal`, `create_goal`, `update_goal`) permitted on the Lead only |

### Pass 1 vs. Pass 2 `llm/stream` deduplication

Because Lead steps run on `dsh-model-fusion/auto` (Pass 1) and `FusionCatalogAdapter` forwards to the physical Lead provider via `ctx.llm.prepareCall` (Pass 2), every Lead step triggers `llm/stream` twice. `FusionCatalogAdapter` marks each forwarded `GenerateOptions` object in a private `WeakSet` (`isForwardedFusionRequest`). Fusion's own context guard, usage observer, and cache keepalive hooks skip forwarded Pass 2 calls and resolve the physical Lead route on Pass 1, avoiding double counting, double budget reservation, and duplicate keepalive rows.

### Version declarations

`engines.dsh` and every `@deepseek-ai/dsh-*` peer dependency declare:

```text
>=0.2.2-rc.5 <0.2.3-0
```

`devDependencies` pin `@deepseek-ai/dsh-*` to `0.2.2-rc.5`, `@deepseek-ai/cordis` to `^4.1.0`, and `@deepseek-ai/schemastery` to `^3.19.0`.

## Adapting to a future DSH release

1. Check out the new Harness release and point `DSHX_HARNESS` at it.
2. Update `engines.dsh`, the `@deepseek-ai/*` `peerDependencies`/`devDependencies`, `src/host/subagent-seam.ts`, and the version check in `scripts/build.mjs`; relink if needed with `node scripts/link-host.mjs <harness>`.
3. Sync `tools/client-build.js` with `packages/client/tsdown.client.ts` if client externals or inline-safe rules changed.
4. Run `pnpm typecheck`, `pnpm build`, `pnpm test`, and `DSHX_HARNESS=<harness> pnpm test:host`.
5. Cold-boot the plugin in a temporary `DSH_HOME` and verify `/api/model-fusion?view=catalog`, `/api/model-fusion?view=settings`, `/api/model-fusion?view=cache`, and `/plugins/dsh-model-fusion/client.js`.
6. Install into a real DSH and run a short task with a Fusion pair; check the Lead read-only probe from the README.
7. Update the supported version in `README.md`, `README.en.md`, `INSTALL*.md` and this file.

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
  `recovering` to be clear, and the route is not written if that check fails. Use `/fusion recover <inspection note>`,
  then continue or switch the Sidekick from the recovery panel. Saving a new pair in Settings changes the default for new
  conversations only.
- **Natural Worker disposal.** DSH disposes a continuable child after settlement, flushes the child log, and closes the
  persistence handle. `fusion_wait` reads the persisted task when that handle is already gone and asks for recovery only
  when a native effect is still pending or the outcome is unknown. An ended Worker with no report is `WORKFLOW_INCOMPLETE`,
  not a quota or provider outage. A later `stop` that sees `SessionHandleClosedError` treats that log as already durable,
  kills any recorded job, and releases the writer. Host unload while `runtime.background` is set records `recovery/needed`
  before that settlement can clear the flag.
