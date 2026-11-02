from analyze import *

def merge(iv):
    iv = sorted([x for x in iv if x[1] > x[0]])
    out = []
    for a, b in iv:
        if out and a <= out[-1][1] + 1e-9:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out
def subtract(base, cut):
    """base, cut: lists of [a,b] merged & sorted; return base minus cut"""
    out = []
    ci = 0
    for a, b in base:
        cur = a
        for c0, c1 in cut:
            if c1 <= cur: continue
            if c0 >= b: break
            if c0 > cur: out.append([cur, c0])
            cur = max(cur, c1)
            if cur >= b: break
        if cur < b: out.append([cur, b])
    return out
def intersect(a_list, b_list):
    out = []
    for a0, a1 in a_list:
        for b0, b1 in b_list:
            lo = max(a0, b0); hi = min(a1, b1)
            if hi > lo: out.append([lo, hi])
    return merge(out)

def active_spans(B):
    spans = [[B['t_start'], B['t_end']]]
    return subtract(spans, merge([[a, b] for a, b, _ in B['holds']]))

def busy_intervals(B, A):
    iv = []
    for a in B['acts']:
        if a['start'] and a['end'] and a['end'] > a['start']:
            iv.append([a['start'], a['end']])
    return intersect(merge(iv), A)

def probe_rows(B):
    out = []
    for o in ops_all[B['T']['id']]:
        if o['skill'] in ('probe', 'view'):
            bt = o.get('bodyTimes') or {}
            c = ts(o['created_at']); e = ts(bt.get('endedAt')) if bt.get('endedAt') else ts(o.get('observedAt'))
            if e and e > c: out.append((c, e, o['skill'], o['args']))
    return out

def attribute_gap(B, g0, g1, dec_iv, look_iv, disp_iv, plan_iv, first_req):
    """Split [g0,g1] into labelled slices. Returns list of (t0,t1,label)."""
    cuts = {g0, g1}
    for lst in (dec_iv, look_iv, disp_iv, plan_iv):
        for x in lst:
            for t in (x[0], x[1]):
                if g0 < t < g1: cuts.add(t)
    cuts = sorted(cuts)
    out = []
    for a, b in zip(cuts, cuts[1:]):
        m = (a + b) / 2
        lab = None
        for x in dec_iv:
            if x[0] <= m < x[1]:
                lab = {'act': 'model_act', 'act_refused': 'model_refused', 'look': 'model_look', 'discarded': 'redecide', 'aborted': 'model_act', 'other': 'model_act'}[x[2]]
                break
        if lab is None:
            for x in look_iv:
                if x[0] <= m < x[1]: lab = 'look_exec'; break
        if lab is None:
            for x in disp_iv:
                if x[0] <= m < x[1]: lab = 'dispatch'; break
        if lab is None:
            if m < first_req: lab = 'startup'
            else:
                lab = 'head_other'
                for x in plan_iv:
                    if x[0] <= m < x[1]: lab = 'head_other_opus_bg'; break
        out.append([a, b, lab])
    # merge adjacent same labels
    res = []
    for s in out:
        if res and res[-1][2] == s[2] and abs(res[-1][1] - s[0]) < 1e-9: res[-1][1] = s[1]
        else: res.append(s)
    return res

def analyze_task(key):
    B = build(key)
    A = active_spans(B)
    busy = busy_intervals(B, A)
    idle = subtract(A, busy)
    decs = B['decs']
    dec_iv = [(d['t0'], d['t1'], d['cls']) for d in decs.values()]
    look_iv = [(c, e) for c, e, sk, args in probe_rows(B)]
    # model-ordered looks: from applied to call end (already in probe rows for the command run; add them too)
    look_iv += [(a, b) for a, b, _ in B['looks']]
    look_iv = merge([[a, b] for a, b in look_iv])
    disp_iv = []
    for a in B['acts']:
        if a['acc'] and a['decision'] and a['decision'] in decs:
            disp_iv.append((decs[a['decision']]['t1'], a['acc']))
    plan_iv = [(p[0], p[1]) for p in B['plans'] if p[2] == 'plan']
    first_req = min(d['t0'] for d in decs.values())
    segs = []
    for g0, g1 in idle:
        segs += [(a, b, lab) for a, b, lab in attribute_gap(B, g0, g1, dec_iv, look_iv, disp_iv, plan_iv, first_req)]
    return B, A, busy, idle, segs

if __name__ == '__main__':
    tot = collections.Counter(); wall = 0; hold = 0; active = 0; busy_t = 0
    for key in TASKS:
        B, A, busy, idle, segs = analyze_task(key)
        c = collections.Counter()
        for a, b, lab in segs: c[lab] += b - a
        aw = sum(b - a for a, b in A); bw = sum(b - a for a, b in busy); iw = sum(b - a for a, b in idle)
        print(key, 'active %.1f busy %.1f idle %.1f (%.1f%%)' % (aw, bw, iw, 100 * iw / aw), {k: round(v, 1) for k, v in c.most_common()})
        tot.update(c); active += aw; busy_t += bw
    print('TOTAL active %.1f busy %.1f idle %.1f' % (active, busy_t, sum(tot.values())), {k: round(v, 1) for k, v in tot.most_common()})
