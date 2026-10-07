# dsh-model-fusion 0.2.8

Supports DeepSeek Harness **0.2.0-rc.2**.

Built on top of v0.2.7 (workspace path identity, baseline parsers, program probe); this release adds the
fix for the `INVALID_TOKEN_COUNT` turn abort on gateways that zero-fill usage aliases with `null`.

## What broke

On some `claude-opus-5.5` routes the gateway returns no `completion_tokens_details`.
The adapter's `mapUsage()` reads `usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens`,
which evaluates to `null`, and `null !== undefined` so the field is emitted as `reasoningTokens: null`:

```json
{"inputTokens": 4, "outputTokens": 1617, "cacheWriteTokens": 149462, "reasoningTokens": null}
```

`billFromNativeUsage()` only treated `undefined` as "unknown", so `null` was passed to `known(null)` →
`safeTokens(null)` → `Number.isSafeInteger(null) === false` → `FusionError(USAGE_MERGE_CONFLICT, 'INVALID_TOKEN_COUNT')`.
The error is thrown inside the `llm/stream` hook, so the whole turn aborts and the UI reports `本轮运行失败`
with the error code flattened to `UNKNOWN`.

Measured in the session logs: 3 turns aborted this way (2 in one session, 1 in another), all on claude-opus-5.5.
The `hy4-preview-ioa` route was never affected because it reports a real integer.

## Fix

`src/host/native-usage.ts` — a counter is "known" only when the provider reported a real finite number;
`null` and `NaN` now degrade to `unknown`, and `cacheWriteTokens` gets the same treatment. The guard is
unchanged, so genuinely invalid counters (for example a negative one) still fail loudly.

## Validation

- The three logged claude-opus-5.5 payloads now bill without throwing; `reasoning` becomes
  `{ kind: 'unknown', tokens: { state: 'unknown' } }` instead of aborting the turn.
- `hy4-preview-ioa` and the existing `native-usage` expectations are unchanged.
- Two regression tests added in `tests/native-usage.spec.ts` covering `null` reasoning and `null`/`NaN` cache write.

Install in Desktop Settings → Plugins → Add plugin:

```text
dsh-model-fusion@0.2.8
```

