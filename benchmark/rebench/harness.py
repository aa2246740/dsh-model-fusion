"""SWE-rebench local harness: fetch tasks, validate environments, prepare workspaces, grade. Never calls a model.

Gold and hidden-test patches live only in REBENCH_DATA (default ~/.rebench-data), never in this
repository or a model workspace. Workspaces live in REBENCH_WORK (default ~/rebench-work).

    python3 harness.py fetch                     # download task rows for tasks.json
    python3 harness.py validate [iid|all]        # base fails, gold passes (no model)
    python3 harness.py prepare <iid> <label>     # fresh checkout + .venv; prints the workspace path
    python3 harness.py grade <workspace> <iid>   # official-style grading of a candidate workspace
"""
import json, os, re, shutil, subprocess, sys, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.expanduser(os.environ.get('REBENCH_DATA', '~/.rebench-data'))
WORK = os.path.expanduser(os.environ.get('REBENCH_WORK', '~/rebench-work'))
PYTHON = os.environ.get('REBENCH_PYTHON', '3.13')
# REBENCH_TASKS selects another task file (e.g. a screening or gap list); rows are cached per file.
TASKS_PATH = os.path.abspath(os.environ.get('REBENCH_TASKS', os.path.join(HERE, 'tasks.json')))
TASKS = json.load(open(TASKS_PATH))
ROWS_PATH = os.path.join(DATA, 'rows-' + os.path.splitext(os.path.basename(TASKS_PATH))[0] + '.json')
SPLITS = TASKS['split'] if isinstance(TASKS['split'], list) else [TASKS['split']]
IDS = [iid for tier in TASKS['tiers'].values() for iid in tier]
TIER = {iid: tier for tier, ids in TASKS['tiers'].items() for iid in ids}


def rows():
    if not os.path.exists(ROWS_PATH): raise SystemExit('Run `harness.py fetch` first (same REBENCH_TASKS)')
    return {r['instance_id']: r for r in json.load(open(ROWS_PATH))}


def split_rows(split):
    offset, out = 0, []
    while True:
        query = urllib.parse.urlencode({'dataset': TASKS['dataset'], 'config': 'default', 'split': split, 'offset': offset, 'length': 100})
        page = json.load(urllib.request.urlopen('https://datasets-server.huggingface.co/rows?' + query, timeout=120))
        out += [dict(item['row'], _split=split) for item in page['rows']]
        offset += 100
        if offset >= page['num_rows_total']: return out


def fetch():
    os.makedirs(DATA, exist_ok=True)
    wanted, found = set(IDS), {}
    for split in SPLITS:
        for row in split_rows(split):
            if row['instance_id'] in wanted: found[row['instance_id']] = row
    missing = wanted - set(found)
    if missing: raise SystemExit(f'Missing instances: {sorted(missing)}')
    json.dump([found[i] for i in IDS], open(ROWS_PATH, 'w'))
    print(json.dumps({'fetched': len(found), 'rows': ROWS_PATH}))


def sh(cmd, cwd, env=None, timeout=1800, input=None):
    p = subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True, timeout=timeout, env=env, input=input)
    return p.returncode, p.stdout + p.stderr


def venv_env(repo):
    env = dict(os.environ)
    env['PATH'] = os.path.join(repo, '.venv/bin') + os.pathsep + env['PATH']
    env['VIRTUAL_ENV'] = os.path.join(repo, '.venv')
    env.pop('PYTHONPATH', None)
    return env


def prepare(iid, label):
    """Fresh shallow checkout at base_commit with dependencies in repo/.venv (excluded from git)."""
    r = rows()[iid]
    repo = os.path.join(WORK, iid, label)
    if os.path.exists(repo): shutil.rmtree(repo)
    os.makedirs(repo)
    for c in ['git init -q', f"git remote add origin https://github.com/{r['repo']}.git",
              f"git fetch -q --depth 1 origin {r['base_commit']}", 'git checkout -q FETCH_HEAD',
              "printf '.venv/\\n' >> .git/info/exclude", f'uv venv -q --seed --python {PYTHON} .venv']:
        code, out = sh(c, repo, timeout=900)
        if code: raise RuntimeError(f'{c}: {out[-800:]}')
    for step in (r['install_config'].get('pre_install') or []) + [r['install_config']['install']]:
        code, out = sh(step, repo, env=venv_env(repo), timeout=1800)
        if code: raise RuntimeError(f'install: {out[-1500:]}')
    return repo


def run_tests(repo, iid):
    r = rows()[iid]
    code, out = sh(r['install_config']['test_cmd'], repo, env=venv_env(repo), timeout=1800)
    status = {}
    for line in out.splitlines():
        m = re.match(r'^(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\s+(\S.*?)(?:\s+-\s.*)?$', line)
        if m: status[m.group(2)] = m.group(1)

    def state(test):
        # Dataset test ids can be truncated at a space; match by prefix.
        hits = [v for k, v in status.items() if k == test or k.startswith(test)]
        return 'PASSED' if hits and all(h == 'PASSED' for h in hits) else (hits[0] if hits else 'MISSING')
    return {t: state(t) for t in r['FAIL_TO_PASS']}, {t: state(t) for t in r['PASS_TO_PASS']}, out


def apply(repo, patch):
    code, out = sh('git apply --whitespace=nowarn -', repo, input=patch)
    if code: raise RuntimeError('apply: ' + out[-600:])


def reset_test_files(repo, patch):
    """Like the official harness: files the hidden test patch touches return to the base version first."""
    for f in sorted(set(re.findall(r'^diff --git a/(\S+)', patch, re.M))):
        if sh(f'git ls-files --error-unmatch -- "{f}"', repo)[0] == 0: sh(f'git checkout HEAD -- "{f}"', repo)
        elif os.path.exists(os.path.join(repo, f)): os.remove(os.path.join(repo, f))


def grade(repo, iid):
    r = rows()[iid]
    reset_test_files(repo, r['test_patch'])
    apply(repo, r['test_patch'])
    f2p, p2p, _ = run_tests(repo, iid)
    ok = all(v == 'PASSED' for v in f2p.values()) and all(v == 'PASSED' for v in p2p.values())
    return {'resolved': ok, 'f2p': [sum(v == 'PASSED' for v in f2p.values()), len(f2p)],
            'p2p': [sum(v == 'PASSED' for v in p2p.values()), len(p2p)],
            'f2p_failing': {k: v for k, v in f2p.items() if v != 'PASSED'}, 'p2p_broken': [k for k, v in p2p.items() if v != 'PASSED'][:20]}


def validate(iid):
    t = time.time(); r = rows()[iid]; repo = prepare(iid, 'validate')
    try:
        apply(repo, r['test_patch']); f2p0, _, _ = run_tests(repo, iid)
        apply(repo, r['patch']); f2p1, p2p1, _ = run_tests(repo, iid)
    finally:
        size = subprocess.run(['du', '-sh', repo], capture_output=True, text=True).stdout.split()[0]
        shutil.rmtree(repo)
    res = {'iid': iid, 'tier': TIER[iid], 'seconds': round(time.time() - t), 'disk': size,
           'base_f2p_failing': sum(v != 'PASSED' for v in f2p0.values()), 'f2p_total': len(f2p0),
           'gold_f2p_pass': sum(v == 'PASSED' for v in f2p1.values()), 'gold_p2p_pass': sum(v == 'PASSED' for v in p2p1.values()),
           'p2p_total': len(p2p1), 'gold_p2p_failing': [k for k, v in p2p1.items() if v != 'PASSED'][:8]}
    res['valid'] = res['base_f2p_failing'] == res['f2p_total'] and res['gold_f2p_pass'] == res['f2p_total'] and res['gold_p2p_pass'] == res['p2p_total']
    return res


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'fetch': fetch()
    elif cmd == 'validate':
        for iid in (IDS if len(sys.argv) < 3 or sys.argv[2] == 'all' else [sys.argv[2]]):
            try: print(json.dumps(validate(iid)), flush=True)
            except Exception as e: print(json.dumps({'iid': iid, 'valid': False, 'error': str(e)[-1500:]}), flush=True)
    elif cmd == 'prepare': print(prepare(sys.argv[2], sys.argv[3]))
    elif cmd == 'grade': print(json.dumps(grade(sys.argv[2], sys.argv[3])))
    else: print(__doc__)
