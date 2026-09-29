#!/usr/bin/env python3
"""Per-attempt usage and efficiency metrics for one Devin CLI/Desktop session.

Reads the local cli-next session forest in `sessions.db` (read-only SQLite) and
emits the same shape of usage row that `run.py` writes for a DSH attempt, plus
the efficiency counters the Devin efficiency post highlights: model request
count, parallel tool calls per assistant turn, multi-command shell calls and
prompt-cache read share. Sidekick (subagent) chains are walked via
`subagent_heads`, so a Fusion attempt attributes Lead and Sidekick work
separately exactly like the DSH `usage()` does.

    python3 devin_session.py <session_id> [--db PATH]

Prints one JSON object. Message text, reasoning and tool outputs are never
emitted; only ids, models, timing, token counters and tool names.
"""
from __future__ import annotations

import argparse
import json
import re
import os
import sqlite3
from collections import Counter
from contextlib import closing

# `devin -p` / `devin acp` (the local agent we drive) persists to `cli`; the
# Desktop app's bundled agent persists to `cli-next`. Same schema either way.
DEFAULT_DB = os.path.expanduser(os.environ.get('DEVIN_DB', '~/.local/share/devin/cli/sessions.db'))
# Shell command separators used to heuristically flag a batched/multi-command
# exec call. Cheap markers only; never treated as proof of semantic batching.
SHELL_SEPARATORS = ('&&', '||', ';', '\n', '|')
# Tools considered "shell commands" when counting batched commands per call.
SHELL_TOOL_NAMES = {'exec', 'shell', 'run_command', 'bash', 'terminal'}
# Fusion delegation tool (Lead -> Sidekick).
DELEGATE_TOOL_NAMES = {'sidekick', 'delegate', 'fusion_delegate', 'spawn_agent'}


def parse_dt(value):
    """ISO-8601 'Z' timestamp -> epoch seconds (float) or None."""
    if not value or not isinstance(value, str):
        return None
    try:
        from datetime import datetime, timezone
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (ValueError, AttributeError):
        return None


def load_forest(db_path, session_id):
    """Return nodes {node_id: {parent, message}}, chains {name: set(node_id)}."""
    with closing(sqlite3.connect('file:' + db_path + '?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only = ON')
        session = db.execute(
            'SELECT id, model, main_chain_id, working_directory, created_at, last_activity_at, title '
            'FROM sessions WHERE id = ?', (session_id,)).fetchone()
        if session is None:
            raise SystemExit(f'session not found in devin db: {session_id}')
        nodes_rows = db.execute(
            'SELECT node_id, parent_node_id, chat_message FROM message_nodes '
            'WHERE session_id = ? ORDER BY node_id', (session_id,)).fetchall()
        heads = db.execute(
            'SELECT agent_id, chain_node_id FROM subagent_heads WHERE session_id = ?',
            (session_id,)).fetchall()
    nodes = {}
    for row in nodes_rows:
        try:
            message = json.loads(row['chat_message'])
        except (ValueError, TypeError):
            message = {}
        nodes[row['node_id']] = {'parent': row['parent_node_id'], 'message': message}

    def ancestry(head):
        seen, out = set(), []
        cur = head
        while cur is not None and cur in nodes and cur not in seen:
            seen.add(cur)
            out.append(cur)
            cur = nodes[cur]['parent']
        return out

    chains = {'main': set(ancestry(session['main_chain_id']))}
    for head in heads:
        chains['subagent/' + head['agent_id']] = set(ancestry(head['chain_node_id']))
    return dict(session), nodes, chains


def role_of_chain(name):
    if name == 'main':
        return 'lead'
    # Devin names the Fusion worker 'sidekick'; treat every subagent as worker.
    return 'worker'


# Compaction requests are their own role: not Lead turns, not Sidekick spend.
COMPACTOR_MODELS = {'compactor'}


def role_for_model(model, lead_models):
    """Attribute a request to lead vs worker by the generation model.

    Devin persists Sidekick work on a separate `subagent_heads` chain, but it can
    also leave off-history or main-linked nodes (aborted/continued branches), so
    chain membership alone mislabels them. For this pilot the Lead and Sidekick
    always run different models, so the generation model is the reliable split.
    The `compactor` role is kept separate so it neither inflates Lead cost nor
    counts as cheap-Worker output.
    """
    if model in COMPACTOR_MODELS:
        return 'compactor'
    if not lead_models:
        return 'lead'
    return 'lead' if model in lead_models else 'worker'


def is_multi_command(tool_call):
    """Heuristic: a shell/exec call that runs several commands in one call."""
    if (tool_call.get('name') or '') not in SHELL_TOOL_NAMES:
        return False
    args = tool_call.get('arguments')
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            args = {'command': args}
    if not isinstance(args, dict):
        return False
    # An explicit array of commands is the clearest batched form.
    for key in ('commands', 'command_list', 'cmds'):
        if isinstance(args.get(key), list) and len(args[key]) > 1:
            return True
    command = args.get('command') or args.get('cmd') or ''
    if not isinstance(command, str):
        return False
    return any(sep in command for sep in ('&&', '||', ';', '\n'))


def summarize_session(db_path, session_id, lead_models=None):
    session, nodes, chains = load_forest(db_path, session_id)
    # Lead models default to the part before "+sidekick" in a Fusion model id.
    # With non-Fusion sessions (a lone model) lead_models stays empty -> all lead.
    if lead_models is None:
        sel = session.get('model') or ''
        # A Fusion id is `fusion-<lead>-sidekick-<worker>`; the Lead's generation
        # model is the middle segment (strip the `fusion-` prefix too).
        if sel.startswith('fusion-') and '-sidekick-' in sel:
            lead_models = {sel.split('-sidekick-')[0][len('fusion-'):]}
        else:
            lead_models = set()

    by = {}            # "lead:model" / "worker:model" -> {calls,input,cacheRead,cacheCreation,output}
    tools = Counter()  # "role:toolname" -> count
    delegations = 0
    lead_turn_ends = []
    requests = []      # de-duplicated by request_id
    seen_requests = {}
    # efficiency: tool calls grouped per assistant request
    req_tool_calls = {}
    multi_cmd_calls = 0
    first_ts, last_ts = None, None

    for nid in sorted(nodes):
        node = nodes[nid]
        msg = node['message']
        md = msg.get('metadata') or {}
        role = role_for_model(md.get('generation_model'), lead_models)

        ts = parse_dt(md.get('started_generation_at')) or parse_dt(md.get('created_at'))
        if ts:
            first_ts = ts if first_ts is None else min(first_ts, ts)
            last_ts = ts if last_ts is None else max(last_ts, ts)

        request_id = md.get('request_id')
        if msg.get('role') == 'assistant' and request_id:
            model = md.get('generation_model') or 'unknown'
            metrics = md.get('metrics') or {}
            tcs = msg.get('tool_calls') or []
            if request_id not in seen_requests:
                seen_requests[request_id] = {
                    'role': role, 'model': model, 'started_at': ts,
                    'input': metrics.get('input_tokens') or 0,
                    'cacheRead': metrics.get('cache_read_tokens') or 0,
                    'cacheCreation': metrics.get('cache_creation_tokens') or 0,
                    'output': metrics.get('output_tokens') or 0,
                    'finish_reason': md.get('finish_reason'),
                }
                requests.append(request_id)
            # Tool calls counted once per request (copied nodes share request_id+call id).
            bucket = req_tool_calls.setdefault(request_id, set())
            for tc in tcs:
                cid = tc.get('id')
                if cid in bucket:
                    continue
                bucket.add(cid)
                tname = tc.get('name') or 'unknown'
                tools[f'{role}:{tname}'] += 1
                if role == 'lead' and tname in DELEGATE_TOOL_NAMES:
                    delegations += 1
                if is_multi_command(tc):
                    multi_cmd_calls += 1
        if msg.get('role') == 'assistant' and role == 'lead':
            lead_turn_ends.append(md.get('finish_reason'))

    for rid in requests:
        r = seen_requests[rid]
        key = f"{r['role']}:{r['model']}"
        row = by.setdefault(key, {'calls': 0, 'input': 0, 'cacheRead': 0,
                                  'cacheCreation': 0, 'output': 0, 'unreported': 0})
        row['calls'] += 1
        row['input'] += r['input']
        row['cacheRead'] += r['cacheRead']
        row['cacheCreation'] += r['cacheCreation']
        row['output'] += r['output']

    calls_per_turn = [len(ids) for ids in req_tool_calls.values()]
    parallel_turns = sum(1 for n in calls_per_turn if n > 1)
    total_tool_calls = sum(calls_per_turn)

    return {
        'sessionId': session_id,
        'selectedModel': session.get('model'),
        'title': session.get('title'),
        'cwd': session.get('working_directory'),
        'by': by,
        'tools': dict(tools),
        'delegations': delegations,
        'leadTurnEnds': lead_turn_ends,
        'uniqueRequests': len(requests),
        'efficiency': {
            'requestCount': len(requests),
            'totalToolCalls': total_tool_calls,
            'parallelTurns': parallel_turns,
            'multiCommandCalls': multi_cmd_calls,
            'meanToolCallsPerTurn': round(total_tool_calls / len(calls_per_turn), 3) if calls_per_turn else 0,
            'chains': {name: len(ids) for name, ids in chains.items()},
        },
        'timespanSeconds': round(last_ts - first_ts, 1) if (first_ts and last_ts) else None,
    }


def find_session(db_path, working_directory, created_after=None):
    """Locate the Devin session that ran in a workspace directory.

    Matches the exact `working_directory`; `created_after` (epoch seconds) breaks
    ties toward the newest session so a reused path picks this attempt's run.
    """
    with closing(sqlite3.connect('file:' + db_path + '?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute(
            'SELECT id, created_at, working_directory, model, title FROM sessions '
            'ORDER BY created_at DESC').fetchall()
    # macOS: Devin records /tmp as its realpath /private/tmp; match on realpath.
    want = os.path.realpath(working_directory)
    rows = [dict(r) for r in rows
            if os.path.realpath(r['working_directory'] or '') == want]
    if created_after is not None:
        newer = [r for r in rows if (r.get('created_at') or 0) >= created_after]
        if newer:
            rows = newer
    return rows[0]['id'] if rows else None


def audit_session(db_path, session_id, repo_slug):
    """Contamination audit: did the trajectory fetch the upstream fix?

    Scans every node's tool_call arguments and text content for URLs or git refs
    pointing at the upstream repository's fix surface (pull/, /commit/, /issues/,
    /blob/, /compare/, raw.githubusercontent). Returns counts + the matched path
    fragments (never full message text). A hit is a flag for manual review, not
    an automatic invalidation — a model may legitimately read the project's repo.
    """
    with closing(sqlite3.connect('file:' + db_path + '?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute('SELECT node_id, chat_message FROM message_nodes WHERE session_id = ?',
                          (session_id,)).fetchall()
    slug = repo_slug.lower()
    patterns = [f'github.com/{slug}/pull', f'github.com/{slug}/commit',
                f'github.com/{slug}/issues', f'github.com/{slug}/blob',
                f'github.com/{slug}/compare', f'raw.githubusercontent.com/{slug}',
                f'{slug}.git', 'git log', 'git fetch origin']
    hits = Counter()
    scanned_nodes = 0
    for row in rows:
        try:
            m = json.loads(row['chat_message'])
        except (ValueError, TypeError):
            continue
        # Only scan what the model DID: a fetch command it issued. A URL that
        # merely appears inside an edit's old_string or a sidekick hand-off
        # message is text, not a network fetch — exclude those tools entirely.
        NET_TOOLS = ('web', 'fetch', 'browser', 'curl', 'wget', 'request')
        tcs = m.get('tool_calls') or []
        for tc in tcs:
            name = (tc.get('name') or '').lower()
            args = tc.get('arguments')
            if isinstance(args, str):
                try: args = json.loads(args)
                except ValueError: args = {}
            args = args if isinstance(args, dict) else {}
            # A real fetch is a network tool, or a shell command that curls/wgets.
            shell_cmd = (args.get('command') or args.get('cmd') or '')
            is_net = any(n in name for n in NET_TOOLS) or \
                     ('curl ' in shell_cmd or 'wget ' in shell_cmd or 'python -c' in shell_cmd and 'request' in shell_cmd)
            if not is_net:
                continue
            scanned_nodes += 1
            hay = json.dumps(args, ensure_ascii=False).lower()
            for pat in patterns:
                if pat in hay:
                    hits[pat] += 1
    return {'session_id': session_id, 'repo': repo_slug,
            'nodesScanned': scanned_nodes, 'flagged': dict(hits),
            'contaminated': bool(hits)}


WRITE_TOOLS = {'edit', 'write', 'multi_edit', 'create', 'create_file', 'str_replace', 'apply_patch'}
WRITE_MARKERS = ('write_text', 'tee ', 'sed -i', 'Set-Content', 'Out-File', 'open(')


def _tool_text(message):
    content = message.get('content')
    if isinstance(content, list):
        content = ' '.join(part.get('text', '') if isinstance(part, dict) else str(part) for part in content)
    return content if isinstance(content, str) else ''


def _exposes(text, path, created):
    """A tool output shows the hidden file as present or changed (not merely named by the agent)."""
    status = re.compile(r'(?:^|\|)\s*(?:\?\?|[MADRCU]{1,2}|\s[MADRCU])\s+' + re.escape(path) + r'\s*$')
    for line in text.splitlines():
        if status.search(line) or f'diff --git a/{path} ' in line:
            return True
        # A file the hidden patch creates does not exist in a fresh checkout: any listing of it is exposure.
        bare = line.split('|', 1)[-1].strip()
        if created and (bare == path or bare == './' + path or bare.endswith('/' + path)):
            return True
    return False


def audit_workspace_exposure(db_path, session_id, hidden_paths, created_paths=()):
    """Local contamination audit: were the hidden tests already in the workspace?

    A workspace reused after grading still holds the hidden test patch
    (devin-r1: six reruns after quota-blocked attempts). Flags a hidden path
    when a tool output shows it as present or changed (git status line, diff
    header, or a listing of a file the patch creates) before the agent's own
    first write to it. Returns node ids only, never message text.
    """
    with closing(sqlite3.connect('file:' + db_path + '?mode=ro', uri=True)) as db:
        rows = db.execute('SELECT node_id, chat_message FROM message_nodes WHERE session_id = ? ORDER BY node_id',
                          (session_id,)).fetchall()
    written, exposed = set(), {}
    for node_id, raw in rows:
        try:
            message = json.loads(raw)
        except (ValueError, TypeError):
            continue
        if message.get('role') == 'tool':
            text = _tool_text(message)
            for path in hidden_paths:
                if path not in written and path in text and _exposes(text, path, path in created_paths):
                    exposed.setdefault(path, []).append(node_id)
        for call in message.get('tool_calls') or []:
            function = call.get('function', call)
            name = (function.get('name') or '').lower()
            args = function.get('arguments')
            args = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
            for path in hidden_paths:
                redirect = re.search(r'>>?\s*["\']?(?:\./)?' + re.escape(path), args)
                if path in args and (name in WRITE_TOOLS or redirect or any(marker in args for marker in WRITE_MARKERS)):
                    written.add(path)
    return {'session_id': session_id, 'exposed': {path: ids[:5] for path, ids in exposed.items()},
            'contaminated': bool(exposed)}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('session_id', nargs='?', help='session id; omit with --find-cwd')
    ap.add_argument('--db', default=DEFAULT_DB)
    ap.add_argument('--find-cwd', help='resolve a session id by its working directory')
    ap.add_argument('--created-after', type=float, help='prefer sessions created at/after epoch seconds')
    ap.add_argument('--lead-model', action='append',
                    help='generation_model id to count as the Lead (repeatable); default derives from the Fusion model id')
    ap.add_argument('--audit-repo', help='run the contamination audit against this upstream repo slug (org/name)')
    args = ap.parse_args()
    session_id = args.session_id
    if args.find_cwd:
        session_id = find_session(args.db, args.find_cwd, args.created_after)
        if not session_id:
            raise SystemExit(f'no devin session for cwd {args.find_cwd}')
    if not session_id:
        ap.error('provide session_id or --find-cwd')
    if args.audit_repo:
        print(json.dumps(audit_session(args.db, session_id, args.audit_repo), ensure_ascii=False, indent=2))
        return
    lead = set(args.lead_model) if args.lead_model else None
    print(json.dumps(summarize_session(args.db, session_id, lead), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
