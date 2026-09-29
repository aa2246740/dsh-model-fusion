# Evidence: does Fusion give frontier results at a discount?

Short answer, on the tasks measured: **yes for GPT-6 Astra + GLM-5.3-Flash** — more tasks resolved than GPT-6 Astra
alone, at 46% of its cost. The sample is small; read the limitations below.

## Result

Nine real SWE-rebench issues, two attempts each (18 per condition), graded by the maintainers' hidden tests.
Plugin 0.2.0-preview.11, DSH Studio 0.1.7-rc.2 on macOS. Costs are API-equivalent at list prices, not bills.

| Condition | Resolved | Total cost | Paired cost vs Astra alone (median / total) | Lead cost (cache hits) | Sidekick cost | Attempt time |
| --- | --- | --- | --- | --- | --- | --- |
| GPT-6 Astra alone (round 4) | 9/18 | $39.17 | — | — | — | 1.6 h |
| **Fusion: Astra + GLM-5.3-Flash** | **11/18** | **$18.07** | **0.51 / 0.46** | $13.70 (85%) | $4.37 | 8.3 h |
| Fusion: Astra + Grok 4.6 | 13/18 | $41.27 | 0.85 / 1.05 | $13.34 (86%) | $27.93 | 3.4 h |

- Astra + Flash met both preregistered rules: quality at least Astra alone − 2 (it resolved 2 more), and a median
  paired cost ratio ≤ 0.6.
- Astra + Grok 4.6 was the most accurate pair (13/18 in rounds 4 and 5) but not cheaper: the Grok Sidekick costs about
  what the Lead saves.
- The Lead never needed to take over the code: 0 takeovers in 72 Fusion attempts (rounds 4 and 5).
- Fusion is slower: about 5× the attempt time of Astra alone, mostly Sidekick generation (Flash makes ~80 calls per
  task).

Per task (Fusion from round 5, Astra alone from round 4; ✓ = resolved, two attempts each, cost of both):

| Task | Astra alone | Astra + Flash | Astra + Grok 4.6 |
| --- | --- | --- | --- |
| pypa__twine-1309 | ✗ ✗ $2.83 | ✗ ✗ $1.16 | ✓ ✓ $2.16 |
| delgan__loguru-1451 | ✓ ✓ $3.35 | ✓ ✓ $2.07 | ✓ ✓ $2.40 |
| sqlfluff__sqlfluff-7615 | ✗ ✗ $8.28 | ✓ ✗ $2.03 | ✓ ✓ $6.93 |
| pycqa__isort-2491 | ✗ ✗ $5.19 | ✗ ✗ $3.01 | ✗ ✗ $12.41 |
| holoviz__param-1117 | ✓ ✓ $4.57 | ✓ ✓ $2.52 | ✓ ✓ $4.40 |
| ucfopen__canvasapi-716 | ✓ ✗ $2.79 | ✓ ✓ $1.16 | ✓ ✓ $1.56 |
| pallets__click-3239 | ✓ ✓ $4.35 | ✓ ✓ $2.51 | ✓ ✓ $4.10 |
| python-scim__scim2-models-139_interface | ✓ ✓ $5.47 | ✓ ✓ $2.51 | ✗ ✓ $5.02 |
| pallets-eco__wtforms-892_interface | ✗ ✗ $2.34 | ✗ ✗ $1.12 | ✗ ✗ $2.30 |

## Against Devin's own Fusion (round devin-r1, 2026-09-29)

This round compared the plugin (0.2.0) with Fusion inside Devin, using the same pair: GPT-6 Astra (high) as Lead and
SWE-2 (medium) as Sidekick. Both got the same prompt, the same fresh checkouts and the same hidden-test grading. Each
single model ran alone as a baseline.

Seven attempts were excluded as contaminated:
- Six Devin reruns started in workspaces that still held the hidden tests from grading an earlier, quota-blocked
  attempt.
- One DSH Sidekick downloaded the upstream fix. It still failed.

The four tasks that were clean in every condition give this result:

| Condition | Resolved | Cost | Mean minutes |
| --- | --- | --- | --- |
| **DSH Fusion: Astra + SWE-2** | **4/4** | **$2.73** | 20.1 |
| Devin Fusion: Astra + SWE-2 | 3/4 | $4.81 | 6.0 |
| Devin, Astra alone | 3/4 | $8.13 | 5.1 |
| DSH, Astra alone (round 4) | 3/4 | $10.11 | 5.8 |

- Fusion was cheaper than the single model on both harnesses: 41% less on Devin and 73% less on DSH.
- The one task only DSH Fusion solved was sqlfluff-7615.
- Four tasks with one attempt each cannot rank the two systems. It is no claim of parity or superiority.
- SWE-2 is free in Devin's catalog and is priced at $0 on both sides, so these costs are the Lead's.
- The plugin's Sidekick used about 4× Devin's Sidekick calls, and the plugin took about 3.4× Devin's wall time.
- Freshly processed prompt input was 5% of all prompt tokens for the plugin and 19% for Devin Fusion.
- Protocol, deviations and root causes: [REBENCH_DEVIN.md](REBENCH_DEVIN.md) and
  `benchmark/rebench/results-devin-r1/`.

## Setup

**Tasks.** Nine instances from `nebius/SWE-rebench-leaderboard` (split 2026_03): real GitHub issues with the
maintainers' fix. Each was validated without a model: its FAIL_TO_PASS tests fail at the base commit, and every
FAIL_TO_PASS and PASS_TO_PASS test passes with the maintainers' patch.

| Tier | Instance | Maintainers' patch | FAIL_TO_PASS / PASS_TO_PASS |
| --- | --- | --- | --- |
| easy | pypa__twine-1309 | 1 file, 15 lines | 1 / 3 |
| easy | delgan__loguru-1451 | 1 file, 16 lines | 2 / 22 |
| easy | sqlfluff__sqlfluff-7615 | 2 files, 12 lines | 1 / 24 |
| medium | pycqa__isort-2491 | 1 file, 50 lines | 1 / 73 |
| medium | holoviz__param-1117 | 1 file, 47 lines | 2 / 94 |
| medium | ucfopen__canvasapi-716 | 1 file, 43 lines | 2 / 60 |
| hard | pallets__click-3239 | 3 files, 131 lines | 4 / 694 |
| hard | python-scim__scim2-models-139_interface | 5 files, 279 lines | 9 / 0 |
| hard | pallets-eco__wtforms-892_interface | 8 files, 107 lines | 10 / 0 |

**Protocol.**
- Each attempt starts from a fresh checkout at the base commit with dependencies in `./.venv`.
- The hidden tests and the maintainers' patch never enter a workspace.
- Every condition gets the same prompt: the issue text and how to use `./.venv`, with no hints and no mention of
  Fusion or delegation.
- Grading follows the official harness: restore the files the hidden test patch touches, apply it, run the tests.
  An attempt is resolved only if every FAIL_TO_PASS and PASS_TO_PASS test passes.
- No model outcome is retried. Infrastructure or provider failures are rerun once and listed.
- Nobody edits a candidate, answers a model's question or changes the plugin during a round.
- Conditions rotate per task; concurrency 3; 6-hour limit per attempt (never reached).
- Models: GPT-6 Astra through the ChatGPT subscription route, GLM-5.3-Flash and Grok 4.6 through their own routes, all
  at reasoning effort `high`, permission preset "approve for me".

**Cost.** Tokens come from DSH's own session logs for the Lead and every Sidekick session it started, converted with
list prices (USD per 1M tokens, uncached input / cache read / output): gpt-6-astra 10 / 1 / 50, grok-4.6 2 / 0.3 / 6,
glm-5.3-flash 0.15 / 0.03 / 0.50. The ratio that the rules use is the median over the 18 paired attempts (same task,
same repetition) of Fusion cost ÷ Astra-alone cost.

## How the result was reached

Each round was preregistered (question, conditions and decision rules written before the first model call).

| Round | Question | Outcome |
| --- | --- | --- |
| 1–2 | Fusion with a GLM-5.3 (max) Lead | Found plugin defects (Lead blocking delegation, attempts where the Sidekick never ran). A GLM Lead is too close in price to the Sidekick to show a saving. Not included here. |
| 3 | Astra + Flash, one attempt per task ([preregistration](REBENCH_ROUND3.md), [conclusion](../benchmark/rebench/results-r3/CONCLUSION.md)) | 6/9 vs Astra 5/9; cost ratio 0.67. Showed that exact wording in requirements could get lost between brief and implementation → verbatim requirements with per-requirement verdicts. |
| 4 | Which Sidekick: Grok 4.6 or Flash ([preregistration](REBENCH_ROUND4.md), [conclusion](../benchmark/rebench/results-r4/CONCLUSION.md)) | Both beat Astra on quality; neither reached the 0.6 cost rule. Cause: the Lead's prompt cache (69% hits) — its tool list changed with the task phase, and keepalive was off. |
| 5 | Same after the cache fixes ([conclusion](../benchmark/rebench/results-r5/CONCLUSION.md)) | Lead cache hits 85%, Lead cost −37%; Astra + Flash meets both rules. |

Round 5 also corrected a measurement error: Sidekick sessions are attributed by their `parentSession`, since repeated
rounds reuse workspace paths. `results.raw.jsonl` keeps the uncorrected rows.

## Limitations

- Small sample: nine tasks, two attempts each. A difference of one or two tasks is within noise.
- Python only, and all from one benchmark split. The issues are public and may be in the models' training data.
- One machine, one user's subscriptions; Astra alone comes from round 4 (a day earlier), not from round 5.
- Costs are list-price estimates. Subscription plans bill differently.
- The Lead takeover path never triggered in a real run; only automated tests cover it.

## Reproduce

Requires DSH 0.1.7-rc.2 running with Fusion installed and the models signed in, a checkout of the same Harness release
(`DSH_ROOT`, used to talk to the running Host), Node 22, Python 3 and `uv` (task environments use Python 3.13).

```sh
export DSH_ROOT=/path/to/deepseek-harness-0.1.7-rc.2
cd benchmark/rebench
python3 harness.py fetch && python3 harness.py validate          # download and validate the nine tasks (no model calls)
python3 run.py --plan plan-r5.json --out results.jsonl --dry-run # grade the maintainers' patches: proves the setup
python3 run.py --plan plan-r5.json --out results.jsonl --cleanup # the real run
python3 report.py results.jsonl
```

`plan-r5.json` names the providers used here; change them to your own routes. Raw rows for every round are in
`benchmark/rebench/results-r*/`.
