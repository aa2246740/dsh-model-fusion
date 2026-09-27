# Round 3 conclusion: GPT-6 Astra Lead + GLM-5.3-Flash on the round-1 tasks (2026-09-26)

Preregistration: `docs/REBENCH_ROUND3.md`. 27 attempts, plugin 0.2.0-preview.9, DSH Studio 0.1.7-rc.2 on the
user's Mac, permission preset approve-for-me, 6-hour limit (never reached), concurrency 3. No infrastructure
errors, no suspect attempts. Costs are API-equivalent at list prices, not bills.

| task | F = Flash alone | X = Astra alone | XF = Fusion (Astra Lead + Flash) |
| --- | --- | --- | --- |
| pypa__twine-1309 | ✓ $0.02 | ✗ $1.59 | ✗ $0.87 |
| delgan__loguru-1451 | ✓ $0.06 | ✓ $2.19 | ✗ $1.17 |
| sqlfluff__sqlfluff-7615 | ✓ $0.12 | ✗ $4.95 | ✓ $1.70 |
| pycqa__isort-2491 | ✗ $0.09 | ✗ $2.88 | ✓ $1.49 |
| holoviz__param-1117 | ✓ $0.18 | ✓ $1.89 | ✓ $1.39 |
| ucfopen__canvasapi-716 | ✓ $0.04 | ✓ $1.23 | ✓ $0.95 |
| pallets__click-3239 | ✓ $0.06 | ✓ $1.77 | ✓ $2.40 |
| python-scim__scim2-models-139_interface | ✓ $0.10 | ✓ $3.06 | ✓ $2.04 |
| pallets-eco__wtforms-892_interface | ✓ $0.07 | ✗ $1.22 | ✗ $1.12 |
| **resolved / total cost** | **8/9, $0.75** | **5/9, $20.78** | **6/9, $13.13** |

## Preregistered rules

- **Quality near the frontier model: holds.** R(XF) = 6 ≥ R(X) − 1 = 4. Fusion resolved one more task than
  Astra alone.
- **Cost: saves, less than claimed.** Median paired XF/X cost ratio 0.67 (0.34–1.35; one task, click, cost
  more under Fusion after four rework rounds). Total $13.13 vs $20.78 = 37% lower. The preregistered ≤ 0.6 band
  was not reached; Cognition reports 39–54% savings.
- **Workflow health: holds.** All nine Fusion attempts delegated once and the Worker made 39–129 calls; no
  zero-worker attempt, no dead end. The Lead made 8–20 calls and wrote 1.2k–2.7k output tokens per task, against
  19–42 calls and 2.7k–10.5k output tokens for Astra alone. Seven of nine attempts used review-driven rework.
- Against round 2 part 1 (Fusion with a GLM-5.3 max Lead, preview.5: 11/18 with three zero-worker attempts),
  the workflow defects are gone.

## What else the data says

1. **The cheap model alone was best here: 8/9 at $0.75**, 17× cheaper than Fusion. On these nine tasks
   GLM-5.3-Flash outperformed GPT-6 Astra (5/9). Astra's misses were exact-behaviour mismatches with the hidden
   tests (twine: status 599 wording; wtforms: a button default; sqlfluff and isort: target test still failing),
   not crashes. This task set does not reward the frontier model, so it cannot show Fusion recovering frontier
   quality on hard work — only that Fusion keeps frontier-level results at lower cost.
2. **Fusion inherits the Lead's reading of the task.** Where Astra alone mis-read the expected behaviour
   (twine, wtforms), Fusion failed the same test. Fusion also fixed two tasks Astra alone missed (sqlfluff,
   isort) — Flash's implementation plus the Lead's review beat Astra's own implementation there.
3. **A Fusion-specific loss (loguru).** Both single models passed; Fusion failed because the Worker personalised
   a required literal message (`logger.bind(key=value)`, `extra[key]` → the actual key name) and the Lead's review
   did not check the wording against the stated criteria. Exact-wording acceptance criteria can get lost between
   the Lead's brief and the Worker's implementation.
4. **Time.** Fusion took 229 min in total against 50 min for Astra alone and 99 min for Flash alone.

## Quota

The ChatGPT weekly counter read 78% on 2026-09-26 12:12 and 88% at 16:40 (includes the user's own Codex use).

## Limitations

One attempt per cell, nine tasks, single day; list-price estimates; the round-1 tasks may be in training data
(Flash's 8/9 and 17/18 in round 1 suggest these tasks are easy for it); round 1 ran on DSH 0.1.5-rc.2, round 3
on 0.1.7-rc.2.
