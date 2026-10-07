# dsh-model-fusion 0.2.7

Supports DeepSeek Harness **0.2.0-rc.2**.

Sidekick workspace paths, baseline-ready test parsers and command program probes:

- The leased project root and every Sidekick path are matched by filesystem identity, not string spelling: macOS `/tmp/x` for `/private/tmp/x`, symlinked checkouts, and directories *below* the project root are accepted; paths outside the root stay refused. Relative `workdir` resolves inside the workspace, and absolute `file_path` values for write/edit normalize to workspace-relative before the lease checks them.
- `baseline: "no-new-failures"` now works with unittest, vitest, jest, tap, go (verbose) and cargo besides pytest. A baseline is still rejected whenever the output cannot name every failure its summary counts: a failure without a name, or two under one name, would let a candidate trade a frozen failure for a new one. Mocha stays unsupported (its default report cannot name failures); the error names the concrete fix (run with the TAP reporter, or drop baseline). pytest 9 `SUBFAILED` subtests count and list correctly.
- Command program probes no longer look up a quoted word in command position: `"$PY" -m unittest`, `FOO="a b" pytest`. Quoted text is replaced by NUL, which no program name contains; assignments, wrappers, heredocs and PATH-overriding commands behave as before.

Install in Desktop Settings → Plugins → Add plugin:

```text
dsh-model-fusion@0.2.7
```

Validation was on macOS arm64 with DSH 0.2.0-rc.2: 265 unit tests and 239 Host tests pass, 1 Windows-only test skipped; a real-model acceptance ran a unittest baseline freeze, a `/tmp`-alias and relative-subdirectory workdir, and an absolute-path edit. No new Windows or Linux runtime acceptance is claimed.
