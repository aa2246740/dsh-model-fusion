# Round 4 conclusion: which Sidekick (2026-09-26/27)

Preregistration: `docs/REBENCH_ROUND4.md`. 54 attempts, plugin 0.2.0-preview.10, DSH Studio 0.1.7-rc.2 (Dock
environment), preset approve-for-me, 6-hour limit. No infrastructure errors; one suspect attempt
(click, XG rep 1: Lead turn ended `aborted`, candidate resolved). The runner restored the user's default model
and Fusion pair. Costs are API-equivalent at list prices, not bills.

| task | X = Astra alone | XG = Astra + Grok 4.6 | XF = Astra + Flash |
| --- | --- | --- | --- |
| twine-1309 | ✗ ✗ | ✓ ✗ | ✓ ✓ |
| loguru-1451 | ✓ ✓ | ✓ ✓ | ✓ ✓ |
| sqlfluff-7615 | ✗ ✗ | ✓ ✓ | ✗ ✗ |
| isort-2491 | ✗ ✗ | ✗ ✗ | ✗ ✗ |
| param-1117 | ✓ ✓ | ✓ ✓ | ✓ ✓ |
| canvasapi-716 | ✓ ✗ | ✓ ✓ | ✗ ✓ |
| click-3239 | ✓ ✓ | ✓ ✓ | ✓ ✓ |
| scim2-models-139 | ✓ ✓ | ✓ ✓ | ✓ ✓ |
| wtforms-892 | ✗ ✗ | ✗ ✗ | ✓ ✗ |
| **resolved / cost / wall** | **9/18, $39.17, 1.6 h** | **13/18, $39.86, 2.9 h** | **12/18, $25.59, 7.2 h** |

## Rules
- Quality (R ≥ R(X) − 2 = 7): **XG holds (13), XF holds (12)** — both beat Astra alone.
- Cost (median paired ratio ≤ 0.6): **XG 0.96, fails** (Grok 4.6 worker $19.66 of $39.86; its cached-input price
  and long sessions erase the saving); **XF 0.69, fails narrowly** (0.6–1.0 band; total −35%).
- Takeover: 0 in 36 Fusion attempts. Requirement verdicts and baseline checks worked in every attempt; the Leads
  applied `baseline: no-new-failures` to full suites on their own.

## Why XF saved only ~31%: the Lead's prompt cache
In XF the Astra Lead is 85% of the cost ($21.79 of $25.59). Its cache hit rate was 69% against 94% for Astra
alone, and it paid more uncached input ($16.2) than Astra alone ($13.3) with 60% fewer calls. Two causes, both
plugin defects:
1. **The enforced-v3 Lead tool catalog changed with the task phase** (`fusion_review_result` only while
   reviewing, `fusion_wait` only while a Worker runs, …): 12 catalog changes in one click task. Tools are part of
   the prompt prefix, so each change resent the whole conversation uncached (e.g. 23k, 42k tokens 3–5 s apart).
2. **The Lead cache keepalive was off**: `cacheKeepalive` is set only when a pair explicitly enables it, and a
   pair saved from settings does not. Waits of 12–36 minutes for the Worker expired the cache.
Estimated effect of fixing both: Lead uncached input from ~$16 to ~$4–5, XF ≈ 35% of Astra alone.

## Other observations
- XF canvasapi rep 1: the Worker edited an existing test to fit its change; grading restores the maintainers'
  test, which then fails. A Host signal for modified existing test files would let the review catch this.
- The Leads quoted generic prompt instructions ("Do not commit with git") as requirements alongside the issue's
  own; harmless, but the requirement list could be more selective.
