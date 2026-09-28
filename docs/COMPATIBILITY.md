# DSH compatibility

Fusion supports official **DeepSeek Harness 0.2.0-rc.1** (`dsh-v0.2.0-rc.1`, SHA
`4878cdabd87d4041bdaff61d04c966883b9fd07a`, npm `@deepseek-ai/dsh@0.2.0-rc.1`). It is an ordinary external plugin: it
uses only DSH's public plugin APIs and never patches, replaces or rebuilds DSH itself. `scripts/build.mjs` refuses to
build unless the Host checkout's `@deepseek-ai/dsh-agent` is exactly `0.2.0-rc.1`. The `@deepseek-ai/dsh-*`
`peerDependencies` and `devDependencies` use `>=0.2.0-rc.1 <0.2.1`: that range accepts `0.2.0-rc.1` and stable `0.2.0`,
rejects `0.2.0` alphas, and rejects `0.1.7-rc.2`. Cordis stays `^4.0.4`, schemastery stays `^3.18.4`, and React stays
`^18.2.0` / `^18.3.1`.

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

## Changes from 0.1.5 to 0.1.7 (an example of what an upgrade touches)

- Plugin message sources became `{ kind: 'plugin:<id>' }` (was `{ kind: 'plugin', plugin: '<id>' }`); Fusion declares its
  kind in `src/message-source.ts`.
- Jobs: `JobSnapshot`/`onJobDone` became `JobView`/`events.subscribe`, and job calls take the calling agent's id.
- `dsh-agent-presets` became `dsh-agent-preset-registry`.
- Tool results became `role: 'tool'` messages that carry `toolCallId` and `isError` themselves.
- Session logs are `session.v4.jsonl.zstd` (benchmark tooling reads v3 and v4).
- Plugins declare a bundle patch (`dsh.bundle.patch` → `cordis.patch.yml`).

## Adapting to a new DSH release (for example 0.2.1)

1. Check out the new Harness release and point `DSHX_HARNESS` at it.
2. Update the version check in `scripts/build.mjs` and the `@deepseek-ai/dsh-*` `peerDependencies`; relink with
   `node scripts/link-host.mjs <harness>`.
3. Read the release notes and run `dshx check` for compatibility rules; fix type errors (`pnpm typecheck`).
4. Run `pnpm test` and `pnpm test:host` against the new Harness; the Host suite exercises the real Agent, session,
   tool, job, sandbox and subagent services.
5. Cold-boot the plugin alone in a temporary home: `dshx verify-boot <plugin dir>`.
6. Install into a real DSH and run a short task with a Fusion pair; check the Lead read-only probe from the README.
7. Update the supported version in `README.md`, `README.en.md`, `INSTALL*.md` and this file.
