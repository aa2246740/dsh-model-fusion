#!/usr/bin/env python3
"""Merge the devin-r1 round into one graded dataset and audit the Devin rows.

- Reads `results-devin-r1/results.jsonl` (D_F, D_X, S_F written by the two drivers).
- Appends the reused DSH baseline S_X = round-4 `X_astra_only` rep-1 rows (no new
  calls) and the round-5 `XF_fusion_flash` rep-1 rows as a reference column.
- Tags every row with a contamination audit: Devin rows with the upstream-fetch audit
  (`devin_session.audit_session`) and the hidden-test exposure audit
  (`devin_session.audit_workspace_exposure`); DSH rows with `run.audit_session`.
- Recomputes costUsd with the current price formula (uncached input includes cacheCreation).

    python3 merge_results.py --plan plan-devin-r1.json \
        --this results-devin-r1/results.jsonl --out results-devin-r1/merged.jsonl
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import devin_session  # noqa: E402
import harness  # noqa: E402
import run  # noqa: E402


def load(path):
    if not os.path.exists(path):
        return []
    return [json.loads(l) for l in open(path) if l.strip()]


def audit(r):
    """Network fetch of the upstream fix, and (Devin) hidden tests already in the workspace."""
    repo = harness.rows()[r['iid']]['repo']
    try:
        if r.get('harness') != 'devin':
            return run.audit_session(r['sessionId'], repo)
        network = devin_session.audit_session(devin_session.DEFAULT_DB, r['sessionId'], repo)
        touched, created = harness.hidden_test_paths(r['iid'])
        workspace = devin_session.audit_workspace_exposure(devin_session.DEFAULT_DB, r['sessionId'], touched, created)
        return {'network': network, 'workspace': workspace,
                'contaminated': bool(network.get('contaminated') or workspace.get('contaminated'))}
    except Exception as e:  # noqa: BLE001
        return {'error': str(e)[:200], 'contaminated': None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--plan', required=True)
    ap.add_argument('--this', required=True, help='this round results.jsonl')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    plan = json.load(open(args.plan))
    rows = load(args.this)
    out = []

    for r in rows:
        out.append(r)

    # Reuse S_X (DSH Astra-alone) from the round the plan points at.
    sx = plan['conditions'].get('S_X', {}).get('reuse')
    if sx:
        for r in load(os.path.join(HERE, sx['results'])):
            if r['condition'] == sx['condition'] and r['rep'] == sx['rep'] \
                    and r['iid'] not in (plan.get('exclude') or {}):
                nr = dict(r)
                nr['condition'] = 'S_X'
                nr['reusedFrom'] = f"{sx['results']}#{sx['condition']}#rep{sx['rep']}"
                out.append(nr)

    for r in out:
        if r.get('sessionId'):
            r['contamination'] = audit(r)
        if r.get('usage'):
            r['costUsd'], r['unpricedModels'] = run.cost(r['usage'], plan.get('prices', {}))

    with open(args.out, 'w') as f:
        for r in out:
            f.write(json.dumps(r) + '\n')
    # summary
    from collections import Counter
    res = Counter()
    for r in out:
        res[r['condition']] += 1
        res[r['condition'] + ':resolved'] += 1 if (r.get('grade') or {}).get('resolved') else 0
    print(json.dumps({'wrote': args.out, 'rows': len(out),
                      'per_condition': dict(res)}, indent=1))


if __name__ == '__main__':
    main()
