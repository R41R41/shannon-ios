from analyze3 import *

TOL = 1.0   # 'move' blips shorter than this do not break a stop

LABEL_GROUP = {
    'model_act': 'モデルの待ち', 'model_refused': 'モデルの待ち', 'model_other': 'モデルの待ち',
    'model_look': '確かめ・look', 'look_exec': '確かめ・look',
    'redecide': '決め直し・Opus',
    'wait_f': 'wait の手（精錬待ち）', 'wait_o': 'wait の手（つなぎ・結果待ち）',
    'path': '経路探索の止まり',
    'dispatch': 'そのほか（送り・体の受け取り）', 'head_other': 'そのほか（頭の処理）', 'head_other_opus_bg': 'そのほか（頭の処理）', 'startup': 'そのほか（頭の処理）',
    'hold': '保留',
}

def all_segments(key):
    B, A, busy, idle, segs = analyze_task(key)
    C = classify_busy(B, A, busy)
    out = []
    for a, b, lab in segs: out.append((a, b, lab))
    for lab in ('wait_f', 'wait_o', 'path', 'move'):
        for a, b in C[lab]: out.append((a, b, lab))
    for a, b, why in B['holds']: out.append((a, b, 'hold:' + why))
    out.sort()
    return B, A, out, C

def stretches(segs):
    """merge consecutive non-move segments (holds are separate). returns list of dict(t0,t1,comp)"""
    res = []
    cur = None
    pend_move = None
    for a, b, lab in segs:
        if lab.startswith('hold:'):
            if cur: res.append(cur); cur = None
            res.append(dict(t0=a, t1=b, comp=collections.Counter({lab: b - a}), hold=True)); continue
        if lab == 'move':
            if cur is not None:
                if b - a < TOL and a - cur['t1'] < 1e-6:
                    cur['pending'] = (cur.get('pending') or 0) + (b - a)
                    cur['t1_pending'] = b
                    continue
                else:
                    cur.pop('pending', None); cur.pop('t1_pending', None)
                    res.append(cur); cur = None
            continue
        # non-move
        if cur is not None and (a - (cur.get('t1_pending') or cur['t1'])) < 1e-6 + 0:
            if cur.get('pending'):
                cur['comp']['move_blip'] += cur['pending']
            cur.pop('pending', None); cur['t1'] = b; cur.pop('t1_pending', None)
            cur['comp'][lab] += b - a
        else:
            if cur is not None:
                cur.pop('pending', None); cur.pop('t1_pending', None); res.append(cur)
            cur = dict(t0=a, t1=b, comp=collections.Counter({lab: b - a}), hold=False)
    if cur is not None:
        cur.pop('pending', None); cur.pop('t1_pending', None); res.append(cur)
    return res

if __name__ == '__main__':
    ALL = []
    for key in TASKS:
        B, A, segs, C = all_segments(key)
        st = stretches(segs)
        for s in st:
            s['task'] = key; s['B'] = B
        ALL += st
        nonhold = [s for s in st if not s['hold']]
        L = [s['t1'] - s['t0'] for s in nonhold]
        print(key, 'stretches', len(nonhold), 'sum %.1f' % sum(L), 'median %.2f p90 %.2f max %.2f' % (statistics.median(L), pct(L, .9), max(L)))
    nonhold = [s for s in ALL if not s['hold']]
    L = [s['t1'] - s['t0'] for s in nonhold]
    print('ALL non-hold stretches', len(L), 'sum %.1f' % sum(L), 'mean %.2f median %.2f p75 %.2f p90 %.2f p95 %.2f p99 %.2f max %.2f' % (statistics.mean(L), statistics.median(L), pct(L, .75), pct(L, .9), pct(L, .95), pct(L, .99), max(L)))
    for thr in (2, 5, 10, 20, 30):
        sel = [x for x in L if x >= thr]
        print('  stops >= %2d s: n=%3d sum=%7.1f s' % (thr, len(sel), sum(sel)))
