# Fusion round 3: frontier Lead on the round-1 tasks (preregistration)

Written before any model call of round 3 (2026-09-26).

**Question.** With a frontier Lead (GPT-6 Astra, `high`) and the cheap Worker (GLM-5.3-Flash, `high`), does
Fusion reach the frontier model's quality at a fraction of its cost — Cognition's claim for Fusion?

**Why these tasks.** The nine round-1 tasks (`benchmark/rebench/tasks.json`) have history: GLM-5.3 max alone
18/18, Flash alone 17/18, Fusion (GLM max + Flash, plugin 0.2.0-preview.5) 11/18 in round 2 part 1, with
three zero-worker attempts and explore-first dead ends. Those defects and four more found since
(preview.6–preview.9: stalled exploration, large-workspace snapshot, check preflight, skipped-test parser) are
fixed. Round 3 re-measures Fusion after the fixes with the largest Lead/Worker price gap available.

**Conditions** (one attempt each per task, 27 attempts): XF = Fusion enforced-v3, Lead Astra high + Worker Flash
high; X = Astra alone, high; F = Flash alone, high. Plugin 0.2.0-preview.9, DSH Studio 0.1.7-rc.2 on the
user's Mac (Astra uses the user's ChatGPT login and never leaves the machine), permission preset
approve-for-me, timeout 6 hours, concurrency 3, condition order rotated per task.

**Rules.**
- Quality near the frontier model: R(XF) ≥ R(X) − 1 (of 9).
- Cost: median paired XF/X API-equivalent cost ≤ 0.6 → saves; 0.6–1.0 → saves less than claimed; ≥ 1.0 → no saving.
- Fusion matches the claim only if both hold. R(F) is reported as the cheap-model baseline.
- Workflow health: no attempt where the Lead delegated and the Worker made no call.

**Protocol.** As rounds 1–2 (fresh workspace, identical prompt, hidden tests and gold patches never in a
workspace, official-style grading, no model-outcome retries; infrastructure or provider stops rerun once and
listed). No quota stop line (the user's instruction). Prices (USD per 1M input / cache read / output):
gpt-6-astra 10 / 1 / 50, glm-5.3-flash 0.15 / 0.03 / 0.50 — estimates, not bills.
