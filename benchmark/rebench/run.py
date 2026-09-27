"""Run the SWE-rebench matrix against a running DSH web Host and grade every attempt.

    python3 run.py --plan plan.json --out results.jsonl [--dry-run] [--concurrency 3] [--timeout-min 60] [--budget-usd 40]

plan.json:
  {"conditions": {"A_lead_only": {"provider": "...", "model": "glm-5.3", "effort": "max"},
                  "B_fusion":    {"provider": "dsh-model-fusion", "model": "auto",
                                  "pair": {"lead": {...route...}, "worker": {...route...}}},
                  "C_worker_only": {"provider": "...", "model": "glm-5.3-flash", "effort": "high"}},
   "reps": 1,
   "prices": {"glm-5.3": [1.40, 0.26, 4.40], "glm-5.3-flash": [0.15, 0.03, 0.50]}}
prices are USD per 1M tokens: [uncached input, cache read, output], keyed by model id.

--dry-run applies the gold patch instead of calling a model: it proves preparation, grading and
bookkeeping without spending tokens. Results are appended and resumable (finished keys are skipped).
Environment: DSH_ROOT (Harness checkout running the Host), DSH_HOME (default ~/.dsh), REBENCH_DATA, REBENCH_WORK.
"""
import argparse, glob, json, os, re, shutil, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DSH_HOME = os.path.expanduser(os.environ.get('DSH_HOME', '~/.dsh'))
PROMPT = """Resolve the following GitHub issue in the repository at {cwd} ({repo}).

Change the project's code so that the behaviour described in the issue is fixed or implemented. You may add or update tests. A Python virtual environment with the project's dependencies is already installed at ./.venv: use ./.venv/bin/python and ./.venv/bin/pytest to run code and tests. Do not commit with git. When you are done, summarise what you changed and how you verified it.

<issue>
{issue}
</issue>
"""
lock = threading.Lock()
pair_lock = threading.Lock()
current_pair = {}


def dsh(*args):
    p = subprocess.run(['node', '--experimental-strip-types', '--no-warnings', os.path.join(HERE, 'dsh.mjs'), *args],
                       capture_output=True, text=True, timeout=300)
    if p.returncode: raise RuntimeError(f'dsh {args[0]}: {p.stderr[-800:]}')
    return json.loads(p.stdout.strip().splitlines()[-1])


def events(path):
    p = subprocess.run(['zstd', '-dc', path], capture_output=True)
    out = []
    for line in p.stdout.decode(errors='replace').splitlines():
        try: out.append(json.loads(line))
        except ValueError: pass
    return out


def first_usage(node):
    queue = [node]
    while queue:
        n = queue.pop(0)
        if isinstance(n, dict):
            u = n.get('usage')
            if isinstance(u, dict) and 'inputTokens' in u: return u
            queue.extend(n.values())
        elif isinstance(n, list): queue.extend(n)
    return None


def parent_of(path):
    head = subprocess.run(f'zstd -dc -- "{path}" | head -1', shell=True, capture_output=True, text=True).stdout
    try: return json.loads(head).get('parentSession')
    except ValueError: return None


def usage(session_id):
    """Per role and model: calls and tokens from the native session logs (Lead plus this run's Workers)."""
    # DSH 0.1.5 writes session.v3, 0.1.7 session.v4 (same event types).
    found = glob.glob(os.path.join(DSH_HOME, 'sessions', '*', session_id, 'session.v[34].jsonl.zstd'))
    if not found: return {'error': 'session log not found'}
    lead = found[0]
    # Only this run's Sidekicks: repeated rounds reuse the workspace path, so the same session folder can hold
    # Sidekicks of earlier runs (round 5 first summed round 4's Workers).
    workers = [path for path in glob.glob(os.path.join(os.path.dirname(os.path.dirname(lead)), 'fusion-worker-*', 'session.v[34].jsonl.zstd'))
               if parent_of(path) == session_id]
    by, tools, delegations, refused, turn_end, problems = {}, {}, 0, 0, [], []
    for path in [lead] + workers:
        role = 'lead' if path == lead else 'worker'
        names = {}
        for e in events(path):
            t, d = e.get('type'), e.get('data', {})
            if t == 'assistant/message':
                src = (d.get('message') or {}).get('source') or {}
                key = f"{role}:{src.get('model')}"
                row = by.setdefault(key, {'calls': 0, 'input': 0, 'cacheRead': 0, 'output': 0, 'unreported': 0})
                u = first_usage(d); row['calls'] += 1
                if not u: row['unreported'] += 1; continue
                row['input'] += u.get('inputTokens') or 0; row['cacheRead'] += u.get('cacheReadTokens') or 0; row['output'] += u.get('outputTokens') or 0
            elif t == 'tool/call':
                name = d.get('name'); tools[f'{role}:{name}'] = tools.get(f'{role}:{name}', 0) + 1; names[d.get('callId')] = name
                if role == 'lead' and name in ('fusion_delegate', 'fusion_delegate_text'): delegations += 1
            elif t == 'tool/result':
                if role == 'lead' and 'FUSION_LEAD_READ_ONLY' in json.dumps(d): refused += 1
                # Root causes of workflow stalls: refused or undecided Fusion tool results, verbatim (truncated).
                msg = d.get('message') or {}
                # DSH 0.1.7: the tool message itself carries toolCallId/isError; 0.1.5 nested tool-result parts.
                parts = [msg] if msg.get('role') == 'tool' else msg.get('content') or []
                for part in parts:
                    name = names.get(part.get('toolCallId'), '')
                    text = ''.join(c.get('text', '') for c in part.get('content') or [] if isinstance(c, dict))
                    if name.startswith('fusion_') and (part.get('isError') or 'needs-decision' in text or 'unavailable' in text) and len(problems) < 30:
                        problems.append({'role': role, 'tool': name, 'text': text[:300]})
            elif t == 'turn/end' and role == 'lead': turn_end.append((d.get('reason') or {}).get('kind'))
    return {'by': by, 'tools': tools, 'delegations': delegations, 'leadRefused': refused, 'leadTurnEnds': turn_end, 'fusionProblems': problems}


def cost(u, prices):
    total, unknown = 0.0, []
    for key, row in (u.get('by') or {}).items():
        model = key.split(':', 1)[1]
        if model not in prices: unknown.append(model); continue
        i, c, o = prices[model]
        total += (row['input'] * i + row['cacheRead'] * c + row['output'] * o) / 1e6
    return round(total, 4), unknown


def watch(session_id, deadline, result):
    """Wait until the session is idle twice in a row, or cancel it at the deadline. A failed status
    query (Host discovery glitch, busy Host) is retried; only 20 consecutive failures give up."""
    idle, failures = 0, 0
    time.sleep(20)
    while True:
        try:
            if time.time() > deadline:
                dsh('cancel', session_id); result['timedOut'] = True; time.sleep(20); return
            idle = idle + 1 if not dsh('running', session_id)['running'] else 0
            failures = 0
        except Exception as error:
            failures += 1; result['statusErrors'] = result.get('statusErrors', 0) + 1
            if failures >= 20: raise RuntimeError(f'session status unavailable: {error}')
        if idle >= 2: return
        time.sleep(15)


def attempt(job, plan, args):
    iid, cond, rep = job
    key = f'{iid}|{cond}|{rep}'
    route = plan['conditions'][cond]
    r = harness.rows()[iid]
    started = time.time()
    result = {'key': key, 'iid': iid, 'tier': harness.TIER[iid], 'condition': cond, 'rep': rep, 'dryRun': args.dry_run}
    try:
        attach = dict(a.split('=', 1) for a in (args.attach or []))
        if key in attach:
            # Resume a session whose runner stopped: keep its workspace and original start time.
            repo = os.path.join(harness.WORK, iid, f'{cond}-r{rep}')
            started = float(attach[key].split('@')[1]); session_id = attach[key].split('@')[0]
            result.update(workspace=repo, sessionId=session_id, attached=True)
            watch(session_id, started + args.timeout_min * 60, result)
            result['usage'] = usage(session_id)
        else:
            repo = harness.prepare(iid, f'{cond}-r{rep}')
            result['workspace'] = repo
        if key in attach: pass
        elif args.dry_run:
            harness.apply(repo, r['patch']); result['usage'] = {'by': {}}
        else:
            prompt_dir = os.path.join(harness.DATA, 'prompts'); os.makedirs(prompt_dir, exist_ok=True)
            prompt = os.path.join(prompt_dir, key.replace('|', '__') + '.txt')
            open(prompt, 'w').write(PROMPT.format(cwd=repo, repo=r['repo'], issue=r['problem_statement']))
            with pair_lock:
                # Each Fusion session freezes the pair configured when it is selected, so conditions with
                # different pairs can interleave: set this condition's pair right before its start.
                if route.get('pair') and current_pair.get('value') != route['pair']:
                    dsh('pair', json.dumps(route['pair']['lead']), json.dumps(route['pair']['worker']))
                    current_pair['value'] = route['pair']
                launch = dsh('start', repo, route['provider'], route['model'], *([route['effort']] if route.get('effort') else []), prompt)
            result['sessionId'] = launch['sessionId']; result['selected'] = launch['selected']
            watch(launch['sessionId'], started + args.timeout_min * 60, result)
            result['usage'] = usage(launch['sessionId'])
        result['wallSeconds'] = round(time.time() - started)
        result['grade'] = harness.grade(repo, iid)
        if args.cleanup:
            # Free disk as soon as the attempt is graded; the result row keeps the evidence.
            result['diffStat'] = subprocess.run(['git', 'diff', '--stat', 'HEAD'], cwd=repo, capture_output=True, text=True).stdout[-1500:]
            shutil.rmtree(repo, ignore_errors=True); result['cleanedUp'] = True
        result['costUsd'], result['unpricedModels'] = cost(result.get('usage') or {}, plan.get('prices', {}))
        u = result.get('usage') or {}
        # Not a model verdict until inspected: quota/provider stops, timeouts, abnormal turn ends, no model output.
        result['suspect'] = not args.dry_run and bool(result.get('timedOut') or any(k != 'completed' for k in u.get('leadTurnEnds', []))
                                                      or not u.get('leadTurnEnds') or not any(v['calls'] for v in (u.get('by') or {}).values()))
    except Exception as error:
        result['error'] = str(error)[-1500:]
        result['wallSeconds'] = round(time.time() - started)
    with lock:
        with open(args.out, 'a') as f: f.write(json.dumps(result) + '\n')
    print(json.dumps({k: result.get(k) for k in ('key', 'wallSeconds', 'costUsd', 'error')} | {'resolved': (result.get('grade') or {}).get('resolved')}), flush=True)
    return result


def spent(out):
    if not os.path.exists(out): return 0.0, set()
    rows = [json.loads(l) for l in open(out) if l.strip()]
    return sum(r.get('costUsd') or 0 for r in rows), {r['key'] for r in rows if not r.get('error')}


def default_model():
    """The profile's saved default model. DSH saves every session's model selection as the default, so a run
    must put the user's own choice back afterwards."""
    path = os.path.join(DSH_HOME, 'profiles', os.environ.get('DSH_PROFILE', 'desktop'), 'cordis.patch.yml')
    try: text = open(path).read()
    except OSError: return None
    block = re.search(r'- id: agent-default-model\n(?:[ \t].*\n)*', text)
    if not block: return None
    fields = dict(re.findall(r'^\s+(provider|model|reasoningEffort): *"?([^"\n]+?)"?\s*$', block.group(0), re.M))
    return [fields[k] for k in ('provider', 'model', 'reasoningEffort') if k in fields] if 'provider' in fields and 'model' in fields else None


def restore_default(saved):
    if not saved: return
    scratch = os.path.join(harness.WORK, '_default-restore'); os.makedirs(scratch, exist_ok=True)
    try: print('default model restored:', json.dumps(dsh('select', scratch, *saved)['selected']), flush=True)
    except Exception as error: print('WARNING: could not restore the default model', saved, error, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--plan', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--concurrency', type=int, default=3)
    ap.add_argument('--timeout-min', type=float, default=60); ap.add_argument('--budget-usd', type=float, default=40)
    ap.add_argument('--only', help='comma-separated instance ids'); ap.add_argument('--conditions', help='comma-separated condition names')
    ap.add_argument('--max-rep', type=int, help='run repetitions up to this number only (phase 1 = 1)')
    ap.add_argument('--attach', action='append', help='key=sessionId@startEpoch: resume watching a running session instead of starting one')
    ap.add_argument('--cleanup', action='store_true', help='delete each workspace after grading (keeps a diff stat in the row)')
    args = ap.parse_args()
    plan = json.load(open(args.plan))
    conds = args.conditions.split(',') if args.conditions else list(plan['conditions'])
    ids = args.only.split(',') if args.only else harness.IDS
    saved_pair = None
    if not args.dry_run and any(plan['conditions'][name].get('pair') for name in conds):
        saved_pair = dsh('settings').get('pair')
    if not args.dry_run:
        for name in conds:
            if plan['conditions'][name].get('pair'):
                pair = plan['conditions'][name]['pair']
                print(f'fusion pair for {name}:', json.dumps(pair), flush=True)
    # Rotate the condition order per task so no condition always runs first.
    last_rep = min(plan.get('reps', 1), args.max_rep or plan.get('reps', 1))
    jobs = [(iid, conds[(i + j) % len(conds)], rep) for rep in range(1, last_rep + 1)
            for i, iid in enumerate(ids) for j in range(len(conds))]
    total, done = spent(args.out)
    jobs = [j for j in jobs if f'{j[0]}|{j[1]}|{j[2]}' not in done]
    print(json.dumps({'pending': len(jobs), 'alreadySpentUsd': round(total, 3)}), flush=True)
    stop = threading.Event()

    def guarded(job):
        if stop.is_set(): return None
        if spent(args.out)[0] >= args.budget_usd: stop.set(); print('BUDGET REACHED; no new attempts', flush=True); return None
        return attempt(job, plan, args)
    saved = None if args.dry_run else default_model()
    try:
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            list(pool.map(guarded, jobs))
    finally:
        restore_default(saved)
        if saved_pair:
            try: print('fusion pair restored:', json.dumps(dsh('pair', json.dumps(saved_pair['lead']), json.dumps(saved_pair['worker']))['pair']), flush=True)
            except Exception as error: print('WARNING: could not restore the Fusion pair', error, flush=True)


if __name__ == '__main__':
    main()
