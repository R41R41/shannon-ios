from common import *
import bisect, csv

ops_all = load_ops()
hs, opl = load_oplog()

# ---- task spans and holds (from state.log, read by eye) ---------------------------------------------------------------------------------------------
def cancel_time(key):
    for t, r in load_state(key):
        if r.startswith('CANCEL'):
            return t
# the people's repairs (holds): tasks.json, key "holds" of each task: [start, end, why] (ISO times)
HOLDS = {k: [(ts(a), ts(b), why) for a, b, why in v] for k, v in HOLD_ROWS.items()}

class Span: pass

def build(key):
    T = TASKS[key]
    ev = load_events(key)
    st = load_state(key)
    t_start = st[0][0]
    t_end = cancel_time(key)
    holds = HOLDS[key]

    # --- decisions ---
    req = {}; resp = {}; applied = {}; calls = collections.defaultdict(list); discarded = {}; failed = {}
    sent = []; recv = {}; woke = []
    for v in ev:
        e = v['ev']
        if e == 'request': req[v['id']] = v
        elif e == 'response': resp[v['id']] = v
        elif e == 'applied': applied[v['id']] = v
        elif e == 'call': calls[v['decisionId']].append(v)
        elif e == 'discarded': discarded[v['id']] = v
        elif e == 'failed': failed[v['id']] = v
        elif e == 'sent': sent.append(v)
        elif e == 'received': recv[v['ids']['command']] = v
        elif e == 'woke': woke.append(v)
    decs = {}
    for did, r in req.items():
        if r['kind'] != 'decision': continue
        s = ts(r['at']); rp = resp.get(did)
        if rp: end = ts(rp['at'])
        elif did in failed: end = ts(failed[did]['at'])
        else: continue
        cl = 'other'
        cs = calls.get(did, [])
        names = [c['name'] for c in cs]
        if did in discarded: cl = 'discarded'
        elif did in failed: cl = 'aborted'
        elif 'mc.act' in names:
            ok = all(((c.get('result') or {}).get('ok') is not False) for c in cs if c['name'] == 'mc.act')
            cl = 'act' if ok else 'act_refused'
        elif any(n in ('mc.probe', 'mc.view') for n in names): cl = 'look'
        decs[did] = dict(id=did, t0=s, t1=end, ms=(rp['ms'] / 1000 if rp else None), cls=cl, step=r.get('stepIndex'), round=r.get('round'),
                         applied=ts(applied[did]['at']) if did in applied else None,
                         call_end=max([ts(c['at']) for c in cs]) if cs else None, names=names)
    plans = [(ts(r['at']), ts(resp[i]['at']), r['kind'], r['model']) for i, r in req.items() if r['kind'] != 'decision' and i in resp]
    # --- body commands (acts) ---
    acts = []
    for o in ops_all[T['id']]:
        if o['skill'] != 'act': continue
        bt = o.get('bodyTimes') or {}
        a = dict(cid=o['id'], item=(o['queue'] or {}).get('item'), after=(o['queue'] or {}).get('after'), created=ts(o['created_at']),
                 acc=ts(bt.get('acceptedAt')), start=ts(bt.get('startedAt')), first_motor=ts(bt.get('firstMotorAt')), end=ts(bt.get('endedAt') or bt.get('failedAt')),
                 outcome=o['outcome'], code=(o.get('unit') or {}).get('code'), ops=bt.get('motorOps'), why=o.get('why'), hands=o.get('hands') or [], lines=o.get('lines') or [],
                 ms=o.get('ms'))
        acts.append(a)
    acts.sort(key=lambda a: a['created'])
    # link sent events (decision id) to acts
    sent_by_cmd = {s['commandId']: s for s in sent}
    for a in acts:
        s = sent_by_cmd.get(a['cid'])
        a['sent_at'] = ts(s['at']) if s else a['created']
        a['decision'] = s.get('decisionId') if s else None
        r = recv.get(a['cid'])
        a['recv_at'] = ts(r['at']) if r else None
    looks = []   # (t0, t1) of look tool execution
    for did, d in decs.items():
        if d['cls'] == 'look' and d['applied'] and d['call_end']:
            looks.append((d['applied'], d['call_end'], did))
    return dict(key=key, T=T, ev=ev, t_start=t_start, t_end=t_end, holds=holds, decs=decs, plans=plans, acts=acts, looks=looks, woke=woke, sent=sent, recv=recv, calls=calls)

if __name__ == '__main__':
    for key in TASKS:
        B = build(key)
        wall = B['t_end'] - B['t_start']
        hold = sum(b - a for a, b, _ in B['holds'])
        print(key, 'wall %.1f hold %.1f active %.1f' % (wall, hold, wall - hold), 'decs', len(B['decs']), collections.Counter(d['cls'] for d in B['decs'].values()), 'acts', len(B['acts']))
