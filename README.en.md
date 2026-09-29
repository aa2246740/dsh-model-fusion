# Fusion · a DSH plugin

[中文](README.md) · [Install](INSTALL.md) · [安装](INSTALL.zh.md)

In DeepSeek Harness (DSH), Fusion is one entry in the model menu: **Fusion · auto**. Behind it are two models you choose:

- **Lead**: a strong frontier model. It reads the request and the code, briefs the work and reviews the result.
- **Sidekick**: a much cheaper model. It edits code, runs commands and runs tests.

One goal: **frontier-model results at a discount.**

Inspired by Fusion in Cognition's Devin. This is an independent implementation, not affiliated with Cognition.

## Measured

Nine real open-source issues (SWE-rebench, Python), two runs each, graded by hidden tests. Lead GPT-6 Astra (high), Sidekick GLM-5.3-Flash (high):

| | Solved | Total cost (API list prices) |
|---|---|---|
| GPT-6 Astra alone | 9/18 | $39.17 |
| **Fusion: GPT-6 Astra + GLM-5.3-Flash** | **11/18** | **$18.07 (54% less)** |
| Fusion: GPT-6 Astra + Grok 4.6 | 13/18 | $41.27 (no saving) |

- Costs are estimates at each provider's public API prices, not bills.
- Limits: small sample (9 tasks × 2), Python only, and public issues may be in training data.
- Method, raw data and per-round conclusions: [docs/EVIDENCE.md](docs/EVIDENCE.md).

**Against Devin's own Fusion:** both used the same pair, GPT-6 Astra (high) as Lead and SWE-2 as Sidekick, on the same
tasks, workspaces and hidden tests.

After contaminated attempts were excluded, four tasks were clean in every condition:

| | Solved | Cost |
|---|---|---|
| **This plugin: Astra + SWE-2** | **4/4** | **$2.73** |
| Devin Fusion: Astra + SWE-2 | 3/4 | $4.81 |
| Devin, Astra alone | 3/4 | $8.13 |

- Four tasks with one run each cannot rank the two systems. This is not a parity claim.
- SWE-2 is priced at $0 on both sides, so the costs are the Lead's.
- The plugin took about 3.4× Devin's wall time.
- For the excluded attempts and why they were excluded, see
  [docs/EVIDENCE.md](docs/EVIDENCE.md#against-devins-own-fusion-round-devin-r1-2026-09-29).

## Use

1. Install the plugin ([INSTALL.md](INSTALL.md)).
2. Open **Settings → Fusion** and choose a Lead and a Sidekick. Any model you are signed in to in DSH works.
3. Select **Fusion · auto** in the model menu and work as usual.

**Pairing:** Fusion saves money because the Sidekick costs far less than the Lead. Pick a strong frontier Lead and a Sidekick that is much cheaper (ideally 5× or more). The closer their prices, the smaller the saving.

## How it works

- **Conversation:** the Lead answers directly, like any model.
- **Changes:** the Lead hands the work to the Sidekick. The brief carries the user's own words and the acceptance commands.
- **Acceptance:**
  - When the Sidekick reports, DSH runs the acceptance commands in the real workspace.
  - The Lead reviews the change and must give a verdict with evidence for each of the user's hard requirements. A missing verdict blocks acceptance.
  - Tests that were already failing (for example, missing optional dependencies) can be marked "no new failures".
  - If the Sidekick rewrote an existing test, it is flagged, and the Lead must confirm it before accepting.
- **Rework:** a rejected change goes back to the same Sidekick with the concrete problem.
  - When the allowed files turn out too narrow (for example another test file still encodes the old behaviour), the Lead can add them during rework. Paths are only added, never removed, and each change is recorded.
- **The Lead does not write code.** The program enforces this, not the prompt:
  - the Lead has no file-writing tools;
  - its shell commands run in DSH's read-only sandbox.
- **The only exception is a takeover the Host unlocks when the Sidekick demonstrably cannot finish.** For example: checks still failing after 2 rework rounds, or the Sidekick hit its step limit or kept stalling. During a takeover:
  - the Lead may only change the files the task allows;
  - its work must pass the same acceptance;
  - it returns to read-only afterwards.
- **Quota or provider errors:** handled per role. Switch a model or schedule a continuation; progress is kept.

## Cache keepalive

While the Lead waits for the Sidekick, often for several minutes, the model's prompt cache can expire. The next request then re-reads the whole conversation at full price. Keepalive sends a 1-token request at intervals so the cache stays warm.

- **Defaults:** taken from each provider's documentation, covering the vendors of the Artificial Analysis top 20.
  - Matched by model name: gpt-*, claude-*, gemini-*, glm-*, grok-*, kimi-*, deepseek-*, …
  - Plus the billing of the [dsh-oauth-login](https://github.com/aa2246740/dsh-oauth-login) routes: plans billed per request default to off, since every ping counts as a request.
- **Auto:** starts only after the model has actually reported cache hits, so a model without caching never pays for pings.
- **Every model is adjustable on the settings page:** on/off, interval, reset to default. The page also shows the observed effect for each model:
  - whether the cache survived each wait;
  - how many pings were sent and how many tokens they read;
  - how many tokens were kept from being resent at full price.
- **Automatic adjustment:** if pings keep missing, the interval is shortened automatically. It is never lengthened automatically; when a longer interval looks safe, the page suggests it and you decide.

## Support

- **DSH version:** **0.1.7-rc.2** only, desktop app or Web. Other versions are not guaranteed; new releases will be adapted separately.
- **Models:** DSH's built-in providers, plus the subscription routes of [dsh-oauth-login](https://github.com/aa2246740/dsh-oauth-login) and dsh-antigravity-oauth. Other third-party model plugins are untested.
- **Operating systems:**
  - **macOS:** verified (Seatbelt sandbox).
  - **Windows:** `v0.2.1` supports native `pwsh` and has been verified on Windows Server 2022 with PowerShell 7.6.6. Make sure `pwsh` is on the PATH used to launch DSH. Windows 10/11 remain unverified. Windows ACL enforcement is partial: it can restrict ordinary file writes, but does not restrict reads or networking.
  - **Linux:** not verified. Check it yourself first:
  1. In a test folder, select Fusion and say: "This is a read-only sandbox test; a refusal is expected. Call the bash tool yourself with `echo test > fusion-probe.txt` (don't delegate, don't rewrite it) and paste the tool's raw output."
  2. Expected: the tool output says the sandbox denied it (for example `Operation not permitted` / `read-only`), and no `fusion-probe.txt` appears.
     - If the Lead only declines in words without calling the tool, the check doesn't count; ask it again to actually call the tool.
  3. If the file is created, the Lead's read-only limit does not work on your system. Don't use Fusion there, and please report it.
  - Where DSH has no sandbox at all, every Lead shell command is refused (it fails safe). The Lead still reads code with its file and search tools.

### Windows validation in v0.2.1

On Windows Server 2022 with Node 22.23.3, PowerShell 7.6.6 and DSH 0.1.7-rc.2, all **253 unit tests and 236 Host tests** passed, as did type checking. The repair candidate passed plugin installation, a cold start, the Fusion settings page and both settings/cache APIs. The v0.2.1 server and client bundles are byte-for-byte identical to that candidate. v0.2.2 only adds a way for the Lead to widen the allowed files during rework (platform-independent); it was re-tested on macOS, not on Windows.

The real PowerShell ACL test denied the Lead's `Set-Content probe.txt test` command and left no file; the Sidekick could write the same file within its granted workspace. This is partial ACL enforcement, with the limits above. These checks used no model credentials or real model requests. macOS regression: 253 unit tests and 235 Host tests passed; the Windows-only ACL test was skipped.

## Data

- **Fusion's own records:** briefs, check results, usage, cache statistics and settings live in `$DSH_HOME/plugins/dsh-model-fusion/state.sqlite`. `DSH_HOME` defaults to `~/.dsh`.
- **The conversations themselves:** stored by DSH. Fusion uploads nothing else.
- **To clear Fusion's records:** quit DSH and delete that file. Settings go with it; choose the pair again next time.

## Known limits

- **Slower than the frontier model alone:** GPT-6 + Flash took about 5× the time of GPT-6 alone, mostly spent in the Sidekick. A faster Sidekick helps.
- **Lead takeover:** never triggered in 72 measured runs; only automated tests cover it.
- **PATH in the macOS desktop app:** DSH Studio opened from the Dock gets only the system PATH, so `node`, `npm`, `cargo` and other tools installed by Homebrew (`/opt/homebrew/bin`), nvm and similar are not found by the shell. This is DSH's environment and affects every model. Before handing off work, Fusion checks the programs the acceptance commands use; when one is missing it tells the Lead where it is installed (for example `/opt/homebrew/bin/node`), and the Lead retries with the full path.
- **Windows 10/11 and Linux not verified:** see Operating systems above.

## Development

```sh
corepack pnpm@9.15.9 install --frozen-lockfile
node scripts/link-host.mjs /path/to/deepseek-harness-0.1.7-rc.2   # link DSH sources for development
DSHX_HARNESS=/path/to/deepseek-harness-0.1.7-rc.2 pnpm build
pnpm test && DSHX_HARNESS=/path/to/deepseek-harness-0.1.7-rc.2 pnpm test:host
```

For Windows development, put PowerShell 7 (`pwsh`), Node and Python on the test process PATH. Native tests use `DSHX_HARNESS` to read the built, pinned Host checkout; no Host source changes are required.

The plugin uses only DSH's public plugin APIs and never modifies DSH itself. How to adapt it to a new DSH release: [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## License

Apache-2.0
