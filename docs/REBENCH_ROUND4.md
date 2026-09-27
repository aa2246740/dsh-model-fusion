# Fusion round 4: choosing the Sidekick for a frontier-quality daily driver (preregistration)

Written before any model call of round 4 (2026-09-26).

**Goal (the user's definition).** A Fusion user wants the frontier model's results at a discount. The only
comparison that matters is Fusion against the frontier model alone; the Sidekick alone is not a baseline.

**Question.** With plugin 0.2.0-preview.10 (verbatim requirements with per-requirement review verdicts,
baseline-relative regression checks, Host-unlocked Lead takeover), which Sidekick gives GPT-6 Astra quality at
the lower cost: Grok 4.6 (high) or GLM-5.3-Flash (high)?

**Conditions** (nine round-1 tasks, two repetitions each, 54 attempts): XG = Fusion, Lead Astra high + Worker
grok-4.6 high; XF = Fusion, Lead Astra high + Worker glm-5.3-flash high; X = Astra alone, high. DSH Studio
0.1.7-rc.2 on the user's Mac, launched with its Dock environment; permission preset approve-for-me; 6-hour
limit; concurrency 3; condition order rotated per task. The runner sets each Fusion condition's pair right
before starting its session (a session freezes the pair at selection).

**Rules, per Fusion condition (N = 18 attempts).**
- Quality: R(Fusion) ≥ R(X) − 2.
- Cost: median paired Fusion/X API-equivalent cost ≤ 0.6.
- Both hold → the pair delivers frontier quality at a discount. If both pairs pass, the default Sidekick is the
  one with more resolved attempts (ties: lower cost).
- Also reported: Lead takeovers (count and reason; target at most 1 in 9 tasks), requirement-verdict and
  baseline refusals, wall time per condition.

**Protocol.** As before: fresh workspace per attempt, identical prompt, hidden tests and gold patches never in a
workspace, official-style grading, no model-outcome retries; infrastructure or provider stops rerun once and
listed. The runner restores the user's default model and Fusion pair afterwards. Prices (USD per 1M input /
cache read / output): gpt-6-astra 10 / 1 / 50, grok-4.6 2 / 0.3 / 6, glm-5.3-flash 0.15 / 0.03 / 0.50 —
estimates, not bills.
