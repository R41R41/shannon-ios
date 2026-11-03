from analyze4 import *
ALL = []
for key in TASKS:
    B, A, segs, C = all_segments(key)
    st = stretches(segs)
    for s in st:
        s['task'] = key; s['B'] = B
    ALL += st
nonhold = sorted([s for s in ALL if not s['hold']], key=lambda s: -(s['t1'] - s['t0']))
def cmds_in(B, t0, t1):
    out = []
    for a in B['acts']:
        if a['start'] and a['end'] and a['start'] < t1 and a['end'] > t0:
            out.append(a)
    return out
def comp_str(c):
    return ', '.join('%s %.1fs' % (k, v) for k, v in sorted(c.items(), key=lambda kv: -kv[1]))
for i, s in enumerate(nonhold[:14], 1):
    B = s['B']
    print('#%d %s %s -> %s  len %.1f s | %s' % (i, s['task'], jst(s['t0'], 1), jst(s['t1'], 1), s['t1'] - s['t0'], comp_str(s['comp'])))
    for a in cmds_in(B, s['t0'] - 0.5, s['t1'] + 0.5):
        hd = ','.join('%s%s' % (h.get('do'), ('(%ss)' % h['seconds']) if h.get('seconds') else '') for h in a['hands'])
        print('     cmd %s [%s..%s] %s | %s | %s %s | %s' % (a['item'], jst(a['start'], 1), jst(a['end'], 1), hd, (a['why'] or '')[:40], a['outcome'], a['code'], ''))
    # decisions overlapping
    for d in B['decs'].values():
        if d['t1'] > s['t0'] and d['t0'] < s['t1']:
            print('     dec %s [%s..%s] %s %.1fs' % (d['id'], jst(d['t0'], 1), jst(d['t1'], 1), d['cls'], d['ms'] or 0))
