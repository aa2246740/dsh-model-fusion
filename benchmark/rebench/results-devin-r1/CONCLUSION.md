# Devin vs DSH Fusion — round devin-r1 (pilot), verified

Preregistered protocol: `docs/REBENCH_DEVIN.md`. Data: `merged.jsonl` (32 rows). Tables: `REPORT.md`.
One rep per cell. `pypa__twine-1309` was excluded before any model call: its gold patch fails its own
PASS_TO_PASS under current dependency versions.

**Corrected 2026-09-29.** The first write-up of this round reported Devin Fusion 6/8 vs DSH Fusion 4/8.
That comparison was invalid, for two reasons:

1. **Contamination.** Seven attempts saw the answers, so they are excluded under the preregistered rule.
   - The six Devin reruns saw the hidden tests. Grading applies the hidden test patch inside the workspace.
     The Devin attempts that had hit the daily quota were graded and then rerun in the same workspace, so every
     rerun (click, scim2, wtforms × D_F and D_X) started with the hidden tests present.
     - The click reruns opened with `git diff` of the patched test files.
     - scim2 D_F's first command was `cat tests/test_annotated.py`.
   - One DSH attempt fetched the upstream fix. The S_F Sidekick on `pycqa__isort-2491` downloaded the upstream
     PR diff and newer releases (it still failed).
   - The first audit only looked for network fetches and missed the workspace leak.
2. **Pricing.** Devin logs uncached prompt tokens as `cacheCreation`, with `input` near zero. The cost formula
   ignored that field, so Devin costs were understated by about 40%. They are now billed at the input price.

The harness now prepares a fresh checkout for every Devin launch and runs one process per key. Every row is
audited for both kinds of contamination (`merge_results.py`, `devin_session.audit_workspace_exposure`,
`run.audit_session`). The contaminated attempts were not rerun: the Devin quota left was too small.

## Conditions

| cond | driver | Lead | Worker |
|---|---|---|---|
| `S_F` | DSH Fusion plugin (`run.py`) | gpt-6-astra (high) | swe-2 (medium) |
| `D_F` | Devin's own Fusion (`devin -p`) | gpt-6-astra (high) | swe-2 (medium) |
| `D_X` | Devin, single model | gpt-6-astra (high) | — |
| `S_X` | DSH, single model (round-4 rows reused) | gpt-6-astra (high) | — |

The prompt, workspace preparation and hidden-test grading are identical on both sides.

## Result: tasks clean in every condition

Four tasks have no contaminated attempt in any condition: loguru-1451, param-1117, sqlfluff-7615 and
canvasapi-716.

| condition | resolved | cost | mean minutes |
|---|---|---|---|
| **S_F — DSH Fusion** | **4/4** | **$2.73** | 20.1 |
| D_F — Devin Fusion | 3/4 | $4.81 | 6.0 |
| D_X — Devin, Astra alone | 3/4 | $8.13 | 5.1 |
| S_X — DSH, Astra alone | 3/4 | $10.11 | 5.8 |

| task | S_F | D_F | D_X | S_X |
|---|---|---|---|---|
| delgan__loguru-1451 | ✓ $0.71 | ✓ $1.12 | ✓ $1.68 | ✓ $1.71 |
| holoviz__param-1117 | ✓ $0.75 | ✓ $1.13 | ✓ $1.82 | ✓ $3.02 |
| sqlfluff__sqlfluff-7615 | ✓ $0.84 | ✗ $1.71 | ✗ $3.52 | ✗ $4.04 |
| ucfopen__canvasapi-716 | ✓ $0.43 | ✓ $0.84 | ✓ $1.11 | ✓ $1.34 |

- **Fusion is cheaper than the same harness's single model on both sides:** −41% on Devin and −73% on DSH.
- **DSH Fusion vs Devin Fusion:** one more task resolved (sqlfluff, which no other condition solved) at 43% lower
  cost. With four tasks and one attempt each, this cannot rank the two systems; it only finds no sign that DSH
  Fusion is worse.
- **Costs are API-equivalent at list prices.** swe-2 is priced at $0 on both sides (Devin lists the SWE-2 Sidekick
  as free), so the costs are the Lead's.
  - The DSH Sidekick used far more tokens than Devin's: 258 vs 58 calls, 134.5k vs 19.2k output tokens, and 11.1M vs
    0.96M cache reads.
  - At GLM-5.3-Flash prices, those extra tokens would cost $0.38. DSH Fusion therefore stays cheaper unless swe-2
    costs more than about 5.5× GLM-5.3-Flash.
- **Speed:** DSH Fusion took about 3.4× Devin Fusion's wall time, mostly in Sidekick work.
- **Prompt cache:** freshly processed (uncached) input was 5.1% of all prompt tokens for S_F and 18.8% for D_F.
  The DSH plugin's delegation keeps prompt prefixes cacheable.

Excluded tasks, for completeness:
- **isort-2491:** unresolved in every condition, including the contaminated S_F attempt.
- **click, scim2, wtforms:** the clean DSH attempts had these results:

  | task | S_F | S_X |
  |---|---|---|
  | click | ✗ | ✓ |
  | scim2 | ✗ | ✓ |
  | wtforms | ✗ | ✗ |

  The Devin attempts on these three tasks are invalid.

## Why S_F missed click and scim2 (clean attempts)

- **click-3239:** the Worker's fix also changed behaviour for string-typed options.
  - It guarded with `isinstance(flag_value, bool)` where `is_bool_flag` was needed.
  - It then edited a pre-existing test expectation to match.
  - The Lead reviewed that edit and called it intended, so the hidden PASS_TO_PASS test failed.
  - Separately, the Lead could not widen the frozen `allowedPaths` to update a prompt test outside them, so the task
    ended unfinished. Plugin 0.2.2 adds `fusion_rework addAllowedPaths` for this.
- **scim2-models-139:** the Lead's brief fixed a literal reading of the interface text: serialize with
  `model_dump_json`, so the serializer returns a JSON string. The hidden tests expect `dump_python` to return a
  dict. Three rework rounds refined schema details and never revisited the return type.
- In earlier rounds, Fusion with other Workers resolved click 9/9 and scim2 8/9. Both misses look like
  run-to-run variance rather than a systematic gap.

## Caveats

- n is tiny: four clean tasks, one attempt each. No parity or superiority claim follows from it.
- `S_X` reuses round-4 rows (same tasks, grader and model) from a different calendar day.
- `resolved` is SWE-rebench hidden-test grading, not Devin's product score.
- The Sidekick and the Fusion compactor are priced at $0, so Fusion totals are a lower bound.
