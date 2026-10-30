# dsh-model-fusion 0.2.9

Fusion now supports DeepSeek Harness 0.2.0-rc.2 and 0.2.1-rc.2 in one package.

## Changes

- Model menus use the Host's theme colors, so their labels remain readable in dark mode.
- Fusion accepts the input modalities supported by the configured Lead, including images when that Lead supports them.
- Missing or null usage counters remain unknown instead of aborting the turn with `USAGE_MERGE_CONFLICT`.
- Fusion restores its permitted tools after another plugin replaces the assembled tool table. A missing required Fusion tool stops the request with `FUSION_TOOL_TABLE_INCOMPLETE`.
- Workspace write leases apply only to agents owned by Fusion. Ordinary sessions in the same folder are no longer blocked by another Fusion task's lease.
- Read-only reports validate the files they cite. Unrelated file changes or unsupported file types no longer prevent an otherwise valid answer from finishing.
- A settled Sidekick without a report returns `WORKFLOW_INCOMPLETE`. Recovery controls explain when a model switch is refused, and the user's sandbox mode propagates to a resident Sidekick.
- The Sidekick's tool allowlist is enforced when a tool executes, including tools another plugin registers directly on the Sidekick.

These changes include PRs #16, #17 and #18, incorporating the contributions from PRs #2, #7 and #14.

## Validation

Release preparation passes type checking, all 326 unit tests, a fresh build and the DSHX static plugin checks. The rebuilt `lib/` matches the merged candidate byte for byte.

The merged candidate previously passed 256 native Host tests on each supported Host version, with one Windows-specific test skipped on macOS. Real-model implementation tasks completed on both versions, and a read-only question completed on 0.2.1-rc.2. This release preparation makes no new model calls and does not install or activate the plugin in the user's running Host.

## Open reports

- [#15](https://github.com/aa2246740/dsh-model-fusion/issues/15): incorrect quota display, awaiting reproduction details.
- [#19](https://github.com/aa2246740/dsh-model-fusion/issues/19): an investigation of an empty folder can remain blocked while waiting for feedback.
- [#20](https://github.com/aa2246740/dsh-model-fusion/issues/20): missing Fusion tools on the first turn, reported on 0.2.8 and not yet verified against this release.
- [#21](https://github.com/aa2246740/dsh-model-fusion/issues/21): cache keepalive after changing the model or reasoning effort; PR #22 remains under review.

## Install

Use `dsh-model-fusion@0.2.9`. See [English instructions](INSTALL.md) or [中文安装说明](INSTALL.zh.md).
