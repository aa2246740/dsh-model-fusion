#!/usr/bin/env python3
"""Prepare and collect Devin-Desktop attempts for the SWE-rebench comparison.

`prepare` materializes per-attempt workspaces (fresh checkouts, same harness.py
prepare() the DSH side uses) and a prompt file, then writes a rotated manifest the
Codex Desktop driver walks one row at a time. `collect` runs after the driver
reports an attempt finished: it resolves the session, reads usage from the local
session forest, grades the workspace and appends a run.py-compatible row to
results.jsonl. Nothing here calls a model or drives the GUI itself.

    python3 devin_attempts.py prepare --plan plan-devin-r1.json --out work/devin-r1
    python3 devin_attempts.py collect --plan plan-devin-r1.json --out work/devin-r1 \
        --key <iid>|<cond>|<rep> --session <session_id> [--results results-devin-r1/results.jsonl]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import harness  # noqa: E402
import devin_session  # noqa: E402

# Same prompt body as run.py so the DSH and Devin conditions are identical.
PROMPT = """Resolve the following GitHub issue in the repository at {cwd} ({repo}).

Change the project's code so that the behaviour described in the issue is fixed or implemented. You may add or update tests. A Python virtual environment with the project's dependencies is already installed at ./.venv: use ./.venv/bin/python and ./.venv/bin/pytest to run code and tests. Do not commit with git. When you are done, summarise what you changed and how you verified it.

<issue>
{issue}
</issue>
"""


def prepare(plan, out_dir, only=None, conds_filter=None):
    """Create a fresh workspace + prompt file per (iid, cond, rep); emit a manifest.

    Devin conditions are those whose plan entry sets `"harness": "devin"`.
    `only`/`conds_filter` narrow the matrix (e.g. a single-task smoke run).
    """
    os.makedirs(out_dir, exist_ok=True)
    prompt_dir = os.path.join(out_dir, 'prompts')
    os.makedirs(prompt_dir, exist_ok=True)
    conds = [c for c in plan['conditions'] if plan['conditions'][c].get('harness') == 'devin']
    if conds_filter:
        conds = [c for c in conds if c in conds_filter]
    ids = harness.IDS
    excluded = set((plan.get('exclude') or {}).keys())
    ids = [i for i in ids if i not in excluded]
    if only:
        ids = [i for i in ids if i in only]
    reps = plan.get('reps', 1)
    manifest = []
    for rep in range(1, reps + 1):
        for i, iid in enumerate(ids):
            # Rotate the condition order per task, same formula as run.py.
            for j in range(len(conds)):
                cond = conds[(i + j) % len(conds)]
                key = f'{iid}|{cond}|{rep}'
                label = f'{cond}-r{rep}'
                repo = harness.prepare(iid, 'devin-' + label)
                r = harness.rows()[iid]
                prompt_path = os.path.join(prompt_dir, key.replace('|', '__') + '.txt')
                with open(prompt_path, 'w') as f:
                    f.write(PROMPT.format(cwd=repo, repo=r['repo'], issue=r['problem_statement']))
                manifest.append({
                    'key': key, 'iid': iid, 'tier': harness.TIER[iid],
                    'condition': cond, 'rep': rep,
                    'workspace': repo, 'promptFile': prompt_path,
                    'model': plan['conditions'][cond].get('devinModel'),
                    'preparedAt': round(time.time(), 3),
                })
                print(json.dumps({'prepared': key, 'workspace': repo}), flush=True)
    mpath = os.path.join(out_dir, 'manifest.json')
    with open(mpath, 'w') as f:
        json.dump({'createdAt': time.time(), 'conditions': conds, 'attempts': manifest}, f, indent=2)
    print(json.dumps({'manifest': mpath, 'attempts': len(manifest)}))
    return mpath


def _load_jsonl(path):
    if not os.path.exists(path):
        return []
    return [json.loads(l) for l in open(path) if l.strip()]


def launch(plan, out_dir, key, results_path, devin_bin, timeout_min):
    """Run one Devin attempt with `devin -p` and collect it.

    Non-interactive: cwd = the prepared workspace, model = the condition's
    devinModel, permission mode `dangerous` (auto-approve, matching DSH's
    approve-for-me preset), prompt passed verbatim after `--`. The session is
    found afterwards by working_directory in the local session DB, then graded
    and appended to results.jsonl. No GUI, no model edits, no answers.
    """
    iid, cond, rep = key.split('|')
    cond_cfg = plan['conditions'][cond]
    model = cond_cfg['devinModel']
    label = 'devin-' + f'{cond}-r{rep}'
    prompt_path = os.path.join(out_dir, 'prompts', key.replace('|', '__') + '.txt')
    prompt = open(prompt_path).read()
    # One process per key: devin-r1's resume overlapped two drivers on the same keys.
    lock_path = os.path.join(out_dir, 'locks', key.replace('|', '__') + '.lock')
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    try:
        os.close(os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except FileExistsError:
        raise SystemExit(f'{key} is already running (lock {lock_path}); remove the lock only if no devin -p owns it')
    try:
        # Always start from a fresh checkout. grade() applies the hidden tests in
        # place, so a workspace that was ever graded (devin-r1: quota-blocked
        # attempts) holds the answers. Six devin-r1 reruns saw them this way.
        repo = harness.prepare(iid, label)
        return _launch_prepared(plan, out_dir, key, results_path, devin_bin, timeout_min, repo, model, prompt)
    finally:
        os.remove(lock_path)


def _launch_prepared(plan, out_dir, key, results_path, devin_bin, timeout_min, repo, model, prompt):
    iid, cond, rep = key.split('|')
    started = time.time()
    env = dict(os.environ)
    argv = [devin_bin, '-p', '--model', model, '--permission-mode', 'dangerous',
            '--respect-workspace-trust', 'false', '--', prompt]
    result = {'key': key, 'iid': iid, 'tier': harness.TIER[iid], 'condition': cond,
              'rep': int(rep), 'harness': 'devin', 'workspace': repo, 'dryRun': False}
    proc_out = ''
    try:
        p = subprocess.run(argv, cwd=repo, capture_output=True, text=True,
                           timeout=timeout_min * 60, env=env)
        proc_out = (p.stdout or '') + (p.stderr or '')
        result['devinRc'] = p.returncode
    except subprocess.TimeoutExpired:
        result['timedOut'] = True
        result['devinRc'] = -1
    result['wallSeconds'] = round(time.time() - started)
    # Resolve the session this attempt created (same cwd, newest at/after start).
    session_id = devin_session.find_session(devin_session.DEFAULT_DB, repo, started)
    result['sessionId'] = session_id
    log_path = os.path.join(out_dir, 'logs', key.replace('|', '__') + '.log')
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    # The prompt and model output are not benchmark evidence we publish; keep a
    # byte count + tail marker only, to prove the run without leaking content.
    with open(log_path, 'w') as f:
        f.write(f'# devin -p log {key} bytes={len(proc_out)}\n')
    if not session_id:
        result['error'] = 'no devin session recorded for workspace'
    else:
        built = _build_result(plan, out_dir, key, session_id)
        built.update({k: v for k, v in result.items() if k in ('timedOut', 'devinRc', 'wallSeconds')})
        result = built
    with open(results_path, 'a') as f:
        f.write(json.dumps(result) + '\n')
    print(json.dumps({'key': key, 'resolved': (result.get('grade') or {}).get('resolved'),
                      'costUsd': result.get('costUsd'), 'session': session_id,
                      'error': result.get('error')}))
    return result


def _build_result(plan, out_dir, key, session_id):
    """Grade one finished Devin attempt and return its row (does not append)."""
    iid, cond, rep = key.split('|')
    rep = int(rep)
    r = harness.rows()[iid]
    label = 'devin-' + f'{cond}-r{rep}'
    repo = os.path.join(harness.WORK, iid, label)
    result = {'key': key, 'iid': iid, 'tier': harness.TIER[iid], 'condition': cond,
              'rep': rep, 'harness': 'devin', 'workspace': repo,
              'sessionId': session_id, 'dryRun': False}
    try:
        usage = devin_session.summarize_session(devin_session.DEFAULT_DB, session_id)
        result['usage'] = {
            'by': usage['by'], 'tools': usage['tools'],
            'delegations': usage['delegations'], 'leadTurnEnds': usage['leadTurnEnds'],
            'uniqueRequests': usage['uniqueRequests'],
        }
        result['efficiency'] = usage['efficiency']
        if usage.get('timespanSeconds'):
            result['wallSeconds'] = usage['timespanSeconds']
        result['grade'] = harness.grade(repo, iid)
        result['costUsd'], result['unpricedModels'] = _cost(result.get('usage') or {}, plan.get('prices', {}))
        u = result.get('usage') or {}
        result['suspect'] = bool(not u.get('leadTurnEnds')
                                 or not any(v['calls'] for v in (u.get('by') or {}).values()))
    except Exception as error:  # noqa: BLE001
        result['error'] = str(error)[-1500:]
    return result


def collect(plan, out_dir, key, session_id, results_path):
    """Grade one finished Devin attempt and append its row to results.jsonl."""
    result = _build_result(plan, out_dir, key, session_id)
    with open(results_path, 'a') as f:
        f.write(json.dumps(result) + '\n')
    print(json.dumps({'key': key, 'resolved': (result.get('grade') or {}).get('resolved'),
                      'costUsd': result.get('costUsd'), 'error': result.get('error')}))
    return result


def _cost(usage, prices):
    total, unknown = 0.0, []
    for key, row in (usage.get('by') or {}).items():
        model = key.split(':', 1)[1]
        if model not in prices:
            unknown.append(model)
            continue
        i, c, o = prices[model]
        # Devin reports uncached prompt tokens as cacheCreation (input is near 0);
        # they are billed as input. devin-r1 first omitted them (~40% of Devin cost).
        total += ((row['input'] + row.get('cacheCreation', 0)) * i + row['cacheRead'] * c + row['output'] * o) / 1e6
    return round(total, 4), unknown


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--plan', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--only', help='comma-separated instance ids')
    p.add_argument('--conditions', help='comma-separated condition names')
    c = sub.add_parser('collect')
    c.add_argument('--plan', required=True)
    c.add_argument('--out', required=True)
    c.add_argument('--key', required=True)
    c.add_argument('--session', required=True)
    c.add_argument('--results', required=True)
    l = sub.add_parser('launch',
                       help='run one Devin attempt non-interactively via `devin -p` and collect it')
    l.add_argument('--plan', required=True)
    l.add_argument('--out', required=True)
    l.add_argument('--key', required=True)
    l.add_argument('--results', required=True)
    l.add_argument('--devin', default=os.path.expanduser('~/.local/bin/devin'))
    l.add_argument('--timeout-min', type=float, default=360)
    args = ap.parse_args()
    plan = json.load(open(args.plan))
    if args.cmd == 'prepare':
        prepare(plan, args.out,
                only=set(args.only.split(',')) if args.only else None,
                conds_filter=set(args.conditions.split(',')) if args.conditions else None)
    elif args.cmd == 'launch':
        launch(plan, args.out, args.key, args.results, args.devin, args.timeout_min)
    else:
        collect(plan, args.out, args.key, args.session, args.results)


if __name__ == '__main__':
    main()
