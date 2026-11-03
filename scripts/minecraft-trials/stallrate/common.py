import json, glob, collections, datetime, statistics, math, sys
JST = datetime.timezone(datetime.timedelta(hours=9))
def ts(s):
    if s is None: return None
    return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
def jst(t, frac=1):
    d = datetime.datetime.fromtimestamp(t, JST)
    return d.strftime('%H:%M:%S') + ('.%0*d' % (frac, int(d.microsecond / 10**(6 - frac))) if frac else '')
import os
# The exports of a run live in STALLRATE_DATA (default: the current directory): events-<task id>.jsonl, ops-all.jsonl, oplog-*.jsonl (STALLRATE_OPLOGS, comma separated) and
# state-<key>.log; tasks.json says which tasks (id, name, state log) and which holds (the people's repairs: start, end, why) there are. See README.md.
DATA = os.environ.get('STALLRATE_DATA', '.')
os.chdir(DATA)
with open('tasks.json', encoding='utf-8') as _handle:
    _config = json.load(_handle)
TASKS = {key: dict(id=value['id'], name=value['name'], state=value['state']) for key, value in _config['tasks'].items()}
HOLD_ROWS = {key: value.get('holds', []) for key, value in _config['tasks'].items()}
OPLOGS = [name for name in os.environ.get('STALLRATE_OPLOGS', ','.join(_config.get('oplogs', []))).split(',') if name]
def load_events(key):
    out = []
    for raw in open('events-%s.jsonl' % TASKS[key]['id'], encoding='utf-8'):
        out.append(json.loads(raw))
    return out
def load_ops():
    ops = collections.defaultdict(list)
    for l in open('ops-all.jsonl', encoding='utf-8'):
        v = json.loads(l)
        ops[v['task']].append(v)
    return ops
def load_oplog():
    """hand_starts[command] = [(hand, at_ts, pos)], opsby[command] = [(at_ts, hand, op, detail)]"""
    hs = collections.defaultdict(list); op = collections.defaultdict(list)
    for p in OPLOGS:
        for raw in open(p, encoding='utf-8'):
            v = json.loads(raw)
            if v['kind'] == 'hand_start':
                c = v['ids']['command']
                hs[c].append((v['ids']['hand'], ts(v['at']), v.get('pos')))
            elif v['kind'] == 'op':
                op[v.get('command')].append((ts(v['at']), v.get('hand'), v.get('op'), v.get('detail')))
    return hs, op
def load_state(key):
    rows = []
    for l in open(TASKS[key]['state'], encoding='utf-8'):
        l = l.rstrip('\n')
        if not l: continue
        t = ts(l.split(' ', 1)[0])
        rest = l.split(' ', 1)[1]
        rows.append((t, rest))
    return rows
def pct(xs, q):
    xs = sorted(xs)
    if not xs: return float('nan')
    k = (len(xs) - 1) * q
    f = math.floor(k); c = math.ceil(k)
    return xs[f] if f == c else xs[f] + (xs[c] - xs[f]) * (k - f)
