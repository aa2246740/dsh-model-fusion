# Round 5 conclusion: after the Lead cache fixes (2026-09-27)

Plugin 0.2.0-preview.11 (fixed enforced-v3 Lead tool catalog; automatic Lead cache keepalive). Both Fusion arms,
nine round-1 tasks, two repetitions (36 attempts); Astra alone from round 4 (it does not use the plugin). No
infrastructure errors or suspect attempts; default model and pair restored.

**Measurement correction.** `run.py` summed every Sidekick session in the task's session folder, and repeated
rounds reuse the workspace path, so round 5 first counted round 4's Workers too. Workers are now attributed by
their `parentSession`; rounds 4 and 5 were recomputed from the session logs (`results.raw.jsonl` keeps the
uncorrected rows). Round 4 did not change (fresh folders); all round-5 rows did.

| 9 tasks × 2 | resolved | total cost | vs Astra alone (median / total) | Lead cost (cache hits) | Worker cost | wall |
| --- | --- | --- | --- | --- | --- | --- |
| Astra alone (r4) | 9/18 | $39.17 | — | — | — | 1.6 h |
| Astra + Grok 4.6, r4 | 13/18 | $39.86 | 0.96 / 1.02 | $20.20 (65%) | $19.66 | 2.9 h |
| Astra + Grok 4.6, r5 | 13/18 | $41.27 | 0.85 / 1.05 | $13.34 (86%) | $27.93 | 3.4 h |
| Astra + Flash, r4 | 12/18 | $25.59 | 0.69 / 0.65 | $21.79 (69%) | $3.79 | 7.2 h |
| **Astra + Flash, r5** | **11/18** | **$18.07** | **0.51 / 0.46** | **$13.70 (85%)** | $4.37 | 8.3 h |

- The cache fixes worked: Lead cache hits 69% → 85%, Lead cost −37%.
- **Astra + Flash meets both preregistered rules**: quality 11 ≥ 9 − 2 (and above Astra alone), median paired cost
  0.51 ≤ 0.6; total 54% cheaper than Astra alone — the top of Cognition's reported 39–54%.
- Astra + Grok 4.6 is the most accurate (13/18 in both rounds) but not cheaper than Astra alone: the Grok Worker
  costs as much as the Lead saves.
- Takeover: 0 in 36 attempts (0 in 72 across rounds 4–5).
- Remaining weakness: time. Astra + Flash took 8.3 h of attempt time against 1.6 h for Astra alone (the Flash
  Worker makes ~80 calls per task).

**Recommendation.** Default Sidekick for a frontier Lead: GLM-5.3-Flash (high). Offer Grok 4.6 as a
"highest accuracy" option that is not a discount.
