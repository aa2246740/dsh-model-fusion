# Fusion vs Devin: SWE-rebench pilot (round devin-r1) — preregistration

Written before any model call of this round (2026-09-29). Do not change the tasks,
conditions, prompt, decision rules or plugin version after the first real attempt;
record deviations instead.

This is a directional pilot: 9 tasks × 1 repetition. It is not a leaderboard score
and not a claim of parity with Devin.

## Question

On the same nine SWE-rebench issues, does the DSH plugin's Fusion (enforced-v3, a
frontier Lead that briefs and reviews plus a cheap Sidekick that writes code) hold
its own against Devin's own Fusion on the **same model pair**, measured on:

1. resolved tasks (the maintainers' hidden tests),
2. API-equivalent cost at list prices,
3. harness efficiency — the two levers Devin's *More efficient Devin* post names:
   fewer/batched tool calls and prompt-cache hit share.

## Context: what the Devin post claims

<https://devin.ai/blog/more-efficient-devin>: Devin Fusion scores 68.8 on
FrontierCode 1.1 Extended at ~$0.60/task; Fusion and Normal are 30–40% cheaper.
It attributes the savings to (a) batching shell commands and parallel independent
tool calls so a turn does more work, and (b) keeping the prompt-cache prefix
stable (its example cuts processed-from-scratch tokens ~71%). We turn both into
measured quantities: requests/attempt, tool calls per turn, multi-command shell
calls, cache-read share, and wall time. Our round-5 weakness is the same axis:
Astra + Flash took 8.3 h vs 1.6 h for Astra alone (~80 Worker calls/task).

## Conditions

| id | driver | model selection | new calls |
| --- | --- | --- | --- |
| `D_F` | Devin local `devin -p` | `fusion-gpt-6-astra-high-sidekick-swe-2-medium` | 9 |
| `D_X` | Devin local `devin -p` | `gpt-6-astra-high` | 9 |
| `S_F` | DSH Studio Host (`run.py`) | Fusion `auto`; pair = Lead `pi-openai-codex/gpt-6-astra` high + Worker `devin-local/devin/swe-2` medium | 9 |
| `S_X` | reuse | round-4 `X_astra_only` rep-1 rows (`results-r4/results.jsonl`) | 0 |
| ref | reuse | round-5 `XF_fusion_flash` rep-1 rows | 0 |

`D_F` and `S_F` run the **same ordered model pair** (Astra high lead, SWE-2 medium
sidekick): that is the architecture comparison. `D_X` and `S_X` isolate the two
harnesses on the same Lead model. The reference column keeps our cheaper
GLM-Flash pairing in view but is not a decision input.

## Tasks

The nine round-1 instances (`benchmark/rebench/tasks.json`, split `2026_03`,
validated without a model): pypa__twine-1309, delgan__loguru-1451,
sqlfluff__sqlfluff-7615, pycqa__isort-2491, holoviz__param-1117,
ucfopen__canvasapi-716, pallets__click-3239, python-scim__scim2-models-139_interface,
pallets-eco__wtforms-892_interface. They are public and may be in the models'
training data; all conditions share that contamination, so the paired comparison
stays meaningful. A trajectory audit flags any attempt that fetched the upstream
fix and reports it separately.

## Protocol

- Fresh checkout per attempt at the base commit with `./.venv` (`harness.py
  prepare`). Hidden test patch and gold patch stay outside every workspace.
- Identical prompt for every condition (`run.py` `PROMPT` / `devin_attempts.py`
  `PROMPT`, byte-identical): issue text, workspace path, `./.venv` usage. No
  hints, no mention of Fusion or delegation.
- Grading is identical for all conditions: `harness.grade` restores the files the
  hidden test patch touches, applies it, runs the instance test command; resolved
  only if every FAIL_TO_PASS and PASS_TO_PASS test passes.
- Devin conditions are driven non-interactively by `devin -p` (the same local
  agent engine that Devin Desktop and `devin acp` wrap; the GUI is only a shell
  over it). `devin_attempts.py launch` runs each attempt: cwd = the prepared
  workspace, `--model` = the exact catalog id, `--permission-mode dangerous`
  (auto-approve, matching DSH's approve-for-me preset), `--respect-workspace-trust
  false`, and the prompt passed verbatim after `--`. No human or subagent edits
  the candidate, answers a model's question, or changes the plugin mid-round.
- Devin usage is read back from the local session forest `sessions.db`
  (read-only; `devin -p` writes to `cli/sessions.db`, Desktop to `cli-next`):
  per-role deduplicated requests, input / cache-read / output tokens, tool-call
  counts and per-turn parallelism (`devin_session.py`). Lead vs Sidekick are
  split by generation model; `compactor` is reported separately and counted in
  neither Lead nor Sidekick spend.
- DSH usage comes from the native session logs (`run.py`), extended to emit the
  same efficiency counters.
- Order rotates per task. DSH attempts run with concurrency ≤ 3 (a confound for
  wall time; reported). Devin attempts are serial (one Desktop session at a
  time). 6-hour limit per attempt.
- No model-outcome retries. Infrastructure/driver failures before the model
  produced anything are rerun once and listed. Nobody edits a candidate, answers
  a model's question or changes the plugin mid-round.
- Quota recorded before and after. If one attempt moves either quota > 10 points,
  pause and report before continuing.

## Versions recorded at freeze

- DSH plugin: `dsh-model-fusion` 0.2.0 installed under `~/.dsh` profiles; Host =
  DSH Studio (`deepseek-harness` 0.1.7-rc.2, driven from a local checkout of the same release).
- Devin: CLI `3000.11.3` (`devin -p`, writes `cli/sessions.db`); Desktop
  `devin-next 3000.10.1035` wraps the same engine into `cli-next/sessions.db`.
- Drivers: `run.py` (DSH), `devin_attempts.py launch` → `devin -p` (Devin).

## Decision rules (fixed in advance)

Let R(X) be resolved attempts of condition X (N = 9 per condition, rep 1).

- Quality: `R(S_F) ≥ R(D_F) − 1` reads as "DSH Fusion within one task of Devin
  Fusion on the same pair." Report the raw counts; with n = 1 per cell these are
  observations, not rates.
- Cost: median paired `S_F / D_F` API-equivalent cost. ≤ 0.8 cheaper;
  0.8–1.2 comparable; ≥ 1.2 more expensive.
- Harness efficiency (no threshold — descriptive): compare `D_F` vs `S_F` and
  `D_X` vs `S_X` on Lead request count, tokens sent, cache-read share, tool calls
  per turn, multi-command calls, and wall time. The gap points at the next
  optimization target (batching vs caching).
- Health: report delegations, Lead read-only refusals, any attempt where the
  Sidekick never ran, and any driver intervention.

If the pilot is clean (≤ 1 suspect attempt per condition), a second repetition is
proposed for separate approval before it runs.

## Cost accounting note

SWE-2 is listed `Free` in the Devin catalog; we still report its raw tokens and
count its API-equivalent cost as $0. Devin-side Lead tokens use the same list
price as the DSH side ($10 / $1 / $50 for gpt-6-astra). These are estimates at
list prices, not bills; Devin's actual ACU/quota draw is recorded separately from
the account UI before and after the round.

## Outcome and deviations (recorded after the round, 2026-09-29)

Full write-up: `benchmark/rebench/results-devin-r1/CONCLUSION.md`. Data: `merged.jsonl`. Tables: `REPORT.md`.

Deviations from the protocol above:

- **The "fresh checkout per attempt" rule was broken on the Devin side.**
  - The Devin daily quota ran out mid-round.
  - `devin_attempts.py launch` graded the quota-blocked attempts in place, which applies the hidden test patch
    inside the workspace.
  - After the quota reset it reran them in the same workspaces. All six reruns (click, scim2, wtforms × D_F and
    D_X) saw the hidden tests, and all six are contaminated.
  - `launch` now prepares a fresh checkout itself and takes a per-key lock. The resume had also overlapped two
    drivers on the same keys, which produced duplicate rows.
- **One DSH attempt fetched the upstream fix.** The S_F Sidekick on `pycqa__isort-2491` curled the upstream PR diff
  and downloaded newer package releases. It still failed.
- **The contamination audit was widened.** The original audit only looked at Devin network fetches. Every row now
  gets a network audit on both harnesses, plus a hidden-test exposure audit on Devin rows. Contaminated attempts are
  excluded from the headline, as the rule above requires.
- **The cost formula was corrected.** Devin reports uncached prompt tokens as `cacheCreation`. The formula now bills
  them at the input price; they had been omitted.
- **Contaminated attempts were not rerun**, because the Devin quota left was too small. The headline therefore uses
  the four tasks that are clean in every condition: loguru-1451, param-1117, sqlfluff-7615 and canvasapi-716.

Decision rules on those four tasks:

| Rule | Result | Verdict |
|---|---|---|
| Quality | R(S_F) = 4, R(D_F) = 3 | met |
| Cost | median paired S_F/D_F = 0.57 | "cheaper" (swe-2 at $0 on both sides) |
| Efficiency | S_F used 4.4× D_F's Sidekick calls and 3.4× its wall time; its fresh-input share was 5.1% vs 18.8% | descriptive only |

- The pilot was not clean: 7 contaminated attempts.
- No second repetition is proposed from this round.
