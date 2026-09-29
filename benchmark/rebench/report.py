"""Summarise results.jsonl by condition and difficulty tier (markdown).

    python3 report.py results.jsonl [--baseline A_lead_only]
"""
import json, statistics, sys

path = sys.argv[1]
baseline = sys.argv[sys.argv.index('--baseline') + 1] if '--baseline' in sys.argv else 'A_lead_only'
rows = [json.loads(l) for l in open(path) if l.strip()]
# A flagged audit (upstream fix fetched, hidden tests visible) removes the row from every headline number.
flagged = [r for r in rows if not r.get('error') and (r.get('contamination') or {}).get('contaminated')]
valid = [r for r in rows if not r.get('error') and r not in flagged]
errors = [r for r in rows if r.get('error')]
conds = sorted({r['condition'] for r in valid})
order = ['easy', 'medium', 'hard']
tiers = sorted({r['tier'] for r in valid}, key=lambda t: (order.index(t) if t in order else len(order), t))


def resolved(r): return bool((r.get('grade') or {}).get('resolved'))


print(f'# SWE-rebench results ({len(valid)} graded attempts, {len(errors)} infrastructure errors, {len(flagged)} contaminated and excluded)\n')
print('| condition | ' + ' | '.join(f'{t} resolved' for t in tiers) + ' | total resolved | total $ | median $/attempt | median minutes | timeouts |')
print('|' + '---|' * (6 + len(tiers)))
for c in conds:
    rs = [r for r in valid if r['condition'] == c]
    cells = []
    for t in tiers:
        tr = [r for r in rs if r['tier'] == t]
        cells.append(f'{sum(map(resolved, tr))}/{len(tr)}')
    costs = [r.get('costUsd') or 0 for r in rs]
    print(f"| {c} | {' | '.join(cells)} | {sum(map(resolved, rs))}/{len(rs)} | {sum(costs):.2f} | "
          f"{statistics.median(costs) if costs else 0:.3f} | {statistics.median([r['wallSeconds'] / 60 for r in rs]) if rs else 0:.1f} | "
          f"{sum(1 for r in rs if r.get('timedOut'))} |")

print(f'\n## Paired cost ratio vs {baseline} (same task and repetition)\n')
print('| condition | tier | median cost ratio | pairs |')
print('|---|---|---|---|')
base = {(r['iid'], r['rep']): r for r in valid if r['condition'] == baseline}
for c in conds:
    if c == baseline: continue
    for t in tiers + ['all']:
        ratios = [r['costUsd'] / base[(r['iid'], r['rep'])]['costUsd'] for r in valid
                  if r['condition'] == c and (t == 'all' or r['tier'] == t) and (r['iid'], r['rep']) in base
                  and base[(r['iid'], r['rep'])].get('costUsd') and r.get('costUsd') is not None]
        if ratios: print(f'| {c} | {t} | {statistics.median(ratios):.2f} | {len(ratios)} |')

print('\n## Per attempt\n')
print('| task | tier | condition | rep | resolved | F2P | P2P | $ | min | lead calls | worker calls | cache% | tools/turn | multiCmd | delegations | lead refused |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for r in sorted(valid, key=lambda r: (tiers.index(r['tier']), r['iid'], r['condition'], r['rep'])):
    by = (r.get('usage') or {}).get('by') or {}
    calls = lambda role: sum(v['calls'] for k, v in by.items() if k.startswith(role + ':'))
    g = r.get('grade') or {}
    eff = r.get('efficiency') or (r.get('usage') or {}).get('efficiency') or {}
    # prompt-cache read share across all roles (input / (input + cacheRead)).
    inp = sum(v.get('input', 0) for v in by.values()); cr = sum(v.get('cacheRead', 0) for v in by.values())
    cache_pct = f'{100 * cr / (inp + cr):.0f}' if (inp + cr) else ''
    print(f"| {r['iid']} | {r['tier']} | {r['condition']} | {r['rep']} | {'yes' if resolved(r) else 'no'} | "
          f"{'/'.join(map(str, g.get('f2p', [])))} | {'/'.join(map(str, g.get('p2p', [])))} | {r.get('costUsd') or 0:.3f} | "
          f"{(r.get('wallSeconds') or 0) / 60:.1f} | {calls('lead')} | {calls('worker')} | {cache_pct} | "
          f"{eff.get('meanToolCallsPerTurn', '')} | {eff.get('multiCommandCalls', '')} | "
          f"{(r.get('usage') or {}).get('delegations', '')} | {(r.get('usage') or {}).get('leadRefused', '')} |")
suspects = [r for r in valid if r.get('suspect')]
if suspects:
    print('\n## Suspect attempts (inspect: quota/provider stop, timeout, abnormal turn end)\n')
    for r in suspects: print(f"- {r['key']}: timedOut={r.get('timedOut', False)} leadTurnEnds={(r.get('usage') or {}).get('leadTurnEnds')}")
if errors:
    print('\n## Infrastructure errors (not graded; rerun these once)\n')
    for r in errors: print(f"- {r['key']}: {r['error'][:300]}")

if flagged:
    print('\n## Contaminated attempts (excluded above)\n')
    for r in flagged:
        c = r['contamination']
        why = [k for k in ('network', 'workspace') if (c.get(k) or {}).get('contaminated')] or ['fetch']
        print(f"- {r['key']}: {', '.join(why)}; resolved={resolved(r)}")
    # Paired view: only tasks where no condition was contaminated, so every condition faces the same tasks.
    dirty = {r['iid'] for r in flagged}
    clean = [r for r in valid if r['iid'] not in dirty]
    tasks = sorted({r['iid'] for r in clean})
    print(f'\n## Tasks clean in every condition ({len(tasks)}): {", ".join(tasks)}\n')
    print('| condition | resolved | total $ | mean minutes |')
    print('|---|---|---|---|')
    for c in conds:
        rs = [r for r in clean if r['condition'] == c]
        if rs: print(f"| {c} | {sum(map(resolved, rs))}/{len(rs)} | {sum(r.get('costUsd') or 0 for r in rs):.2f} | {statistics.mean(r['wallSeconds'] / 60 for r in rs):.1f} |")
