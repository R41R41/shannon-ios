from analyze2 import *
import re

FURNACE_RE = re.compile(r'かまど|燻製|焼|精錬|製錬|smelt|furnace')
STALL_CODES = {'unreachable', 'dead_end', 'stuck', 'not_arrived', 'not_visible', 'no_path', 'search_timeout'}

def command_intervals(B):
    """in-command 'not moving' intervals: wait hands, path-search stalls. Returns list of (t0,t1,label,item,cid,detail)."""
    out = []
    for a in B['acts']:
        if not (a['start'] and a['end'] and a['end'] > a['start']): continue
        cid = a['cid']; hands = a['hands']; lines = {ln['i']: ln for ln in a['lines']}
        seen = {}
        for h, t, pos in sorted(hs.get(cid, []), key=lambda x: (x[1], x[0])):
            if h not in seen: seen[h] = t
        order = sorted(seen.items(), key=lambda kv: kv[1])
        furnace_cmd = any(h.get('do') in ('smelt', 'furnace') for h in hands) or bool(FURNACE_RE.search(a.get('why') or ''))
        if not order:
            # no hand_start (rare): whole command if only waits
            if hands and all(h.get('do') == 'wait' for h in hands):
                out.append((a['start'], a['end'], 'wait_furnace' if furnace_cmd else 'wait_other', a['item'], cid, 'no hand_start'))
            continue
        for idx, (h, t) in enumerate(order):
            end_h = order[idx + 1][1] if idx + 1 < len(order) else a['end']
            t0 = max(t, a['start']); t1 = min(end_h, a['end'])
            if t1 <= t0: continue
            do = hands[h - 1]['do'] if 0 < h <= len(hands) else '?'
            myops = sorted([x for x in opl.get(cid, []) if x[1] == h], key=lambda x: x[0])
            if do == 'wait':
                out.append((t0, t1, 'wait_furnace' if furnace_cmd else 'wait_other', a['item'], cid, 'wait %ss' % hands[h - 1].get('seconds')))
                continue
            # think-timeout gaps
            seq = [('hand_start', t)] + [(x[2], x[0]) for x in myops]
            for (pa, ta), (pb, tb) in zip(seq, seq[1:]):
                if pa in ('setMovements', 'hand_start') and 4.5 <= tb - ta <= 5.6 and ta >= a['start'] - 0.01:
                    out.append((ta, min(tb, a['end']), 'path_search', a['item'], cid, '%s: setMovements->%s %.2fs' % (do, pb, tb - ta)))
            # tail: last op -> end of hand when a 5 s search runs to the hand end
            if seq and (t1 - seq[-1][1]) >= 4.5 and (t1 - seq[-1][1]) <= 5.6 and seq[-1][0] in ('setMovements', 'hand_start'):
                out.append((seq[-1][1], t1, 'path_search', a['item'], cid, '%s: tail %.2fs' % (do, t1 - seq[-1][1])))
            # zero-progress failed hands
            ln = lines.get(h) or {}
            pr = ln.get('progress') or {}
            if ln.get('status') in ('stopped', 'failed') and ln.get('code') in STALL_CODES:
                done = pr.get('done')
                if do in ('go', 'walk') and done == 0:
                    out.append((t0, t1, 'path_fail', a['item'], cid, '%s %s done=%s (project idleGo)' % (do, ln.get('code'), done)))
                elif len(myops) == 0 and (t1 - t0) >= 0.5:
                    out.append((t0, t1, 'path_fail', a['item'], cid, '%s %s zero-op' % (do, ln.get('code'))))
    return out

def classify_busy(B, A, busy):
    ci = command_intervals(B)
    byl = collections.defaultdict(list)
    for t0, t1, lab, item, cid, det in ci:
        byl[lab].append([t0, t1])
    wait_f = intersect(merge(byl['wait_furnace']), busy)
    wait_o = intersect(merge(byl['wait_other']), busy)
    path = intersect(merge(byl['path_search'] + byl['path_fail']), busy)
    path = subtract(path, merge(wait_f + wait_o))
    notmove = merge(wait_f + wait_o + path)
    move = subtract(busy, notmove)
    return dict(wait_f=wait_f, wait_o=wait_o, path=path, move=move, ci=ci)

if __name__ == '__main__':
    G = collections.Counter(); active = 0
    for key in TASKS:
        B, A, busy, idle, segs = analyze_task(key)
        C = classify_busy(B, A, busy)
        aw = sum(b - a for a, b in A)
        L = lambda x: sum(b - a for a, b in x)
        print(key, 'active %.1f | busy %.1f = move %.1f + wait_furnace %.1f + wait_other %.1f + path %.1f | idle %.1f' % (aw, L(busy), L(C['move']), L(C['wait_f']), L(C['wait_o']), L(C['path']), L(idle)))
        G['move'] += L(C['move']); G['wait_f'] += L(C['wait_f']); G['wait_o'] += L(C['wait_o']); G['path'] += L(C['path']); active += aw
        for a, b, lab in segs: G['gap:' + lab] += b - a
    print('TOTAL', {k: round(v, 1) for k, v in G.items()}, 'active', round(active, 1))
    for k, v in sorted(G.items(), key=lambda kv: -kv[1]): print('  %-22s %8.1f s  %5.1f%% of active' % (k, v, 100 * v / active))
