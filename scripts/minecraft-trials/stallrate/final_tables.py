from analyze4 import *

CAT = {
    'model_act': 'モデルの待ち', 'model_refused': 'モデルの待ち',
    'wait_f': 'wait の手', 'wait_o': 'wait の手',
    'redecide': '決め直し・Opus',
    'model_look': '確かめ・look', 'look_exec': '確かめ・look',
    'path': '経路探索の止まり',
    'dispatch': 'そのほか', 'head_other': 'そのほか', 'head_other_opus_bg': 'そのほか', 'startup': 'そのほか',
}
ORDER = ['保留', 'モデルの待ち', 'wait の手', '経路探索の止まり', '確かめ・look', '決め直し・Opus', 'そのほか', '(動いていた)']
res = {}
for key in TASKS:
    B, A, segs, C = all_segments(key)
    wall = B['t_end'] - B['t_start']; hold = sum(b - a for a, b, _ in B['holds']); active = wall - hold
    c = collections.Counter(); sub = collections.Counter()
    for a, b, lab in segs:
        d = b - a
        if lab.startswith('hold:'): c['保留'] += d; continue
        if lab == 'move': c['(動いていた)'] += d; continue
        c[CAT[lab]] += d; sub[lab] += d
    res[key] = dict(wall=wall, hold=hold, active=active, c=c, sub=sub)
tot = dict(wall=sum(r['wall'] for r in res.values()), hold=sum(r['hold'] for r in res.values()), active=sum(r['active'] for r in res.values()), c=collections.Counter(), sub=collections.Counter())
for r in res.values():
    tot['c'].update(r['c']); tot['sub'].update(r['sub'])
res['ALL'] = tot
print('| 原因 | ' + ' | '.join('%s 秒 (壁/稼働%%)' % k for k in res) + ' |')
for cat in ORDER:
    line = '| %s |' % cat
    for k, r in res.items():
        v = r['c'].get(cat, 0.0)
        line += ' %.1f (%.1f%% / %s) |' % (v, 100 * v / r['wall'], ('%.1f%%' % (100 * v / r['active'])) if cat != '保留' else '—')
    print(line)
for k, r in res.items():
    print(k, 'wall %.1f hold %.1f active %.1f  not-moving(non-hold) %.1f = %.1f%% of active; moving %.1f = %.1f%% of active, %.1f%% of wall' % (
        r['wall'], r['hold'], r['active'], r['active'] - r['c'].get('(動いていた)', 0), 100 * (r['active'] - r['c'].get('(動いていた)', 0)) / r['active'], r['c'].get('(動いていた)', 0), 100 * r['c'].get('(動いていた)', 0) / r['active'], 100 * r['c'].get('(動いていた)', 0) / r['wall']))
print('sub (ALL):', {k: round(v, 1) for k, v in tot['sub'].items()})
# distribution of stops incl. holds
ALL = []
for key in TASKS:
    B, A, segs, C = all_segments(key)
    for s in stretches(segs):
        s['task'] = key; ALL.append(s)
nh = [s['t1'] - s['t0'] for s in ALL if not s['hold']]
wh = [s['t1'] - s['t0'] for s in ALL]
print('non-hold stops n=%d median %.2f p90 %.2f p95 %.2f max %.2f' % (len(nh), statistics.median(nh), pct(nh, .9), pct(nh, .95), max(nh)))
print('with holds     n=%d median %.2f p90 %.2f max %.2f' % (len(wh), statistics.median(wh), pct(wh, .9), max(wh)))
# dominant cause of stops
dom = collections.defaultdict(list)
for s in ALL:
    if s['hold']: continue
    comp = collections.Counter()
    for k, v in s['comp'].items():
        if k == 'move_blip': continue
        comp[CAT[k]] += v
    d = comp.most_common(1)[0][0]
    dom[d].append(s['t1'] - s['t0'])
print('stops by dominant cause (non-hold):')
for k, v in sorted(dom.items(), key=lambda kv: -sum(kv[1])):
    print('  %-14s n=%3d sum=%7.1f median=%5.1f p90=%5.1f max=%5.1f' % (k, len(v), sum(v), statistics.median(v), pct(v, .9), max(v)))
big = [s for s in ALL if not s['hold'] and (s['t1'] - s['t0']) >= 10]
domb = collections.Counter()
for s in big:
    comp = collections.Counter()
    for k, v in s['comp'].items():
        if k == 'move_blip': continue
        comp[CAT[k]] += v
    domb[comp.most_common(1)[0][0]] += 1
print('stops >=10 s:', len(big), dict(domb))
