#!/usr/bin/env python3
"""stallrate.py — the stall-rate tool v1 (continuous-motion design R3-7; reads exports only: no API, no database write).

    python3 stallrate.py --data DIR [--json OUT] [--selftest]

DIR holds the exports of a run (see README.md): tasks.json, events-<task id>.jsonl, ops-all.jsonl, oplog-*.jsonl, state-<key>.log.
Prints, for every task and for all of them:
  * wall clock, holds (the people's repairs), active time (wall minus holds), time the body moved, time it did not;
  * stall rate A = not-moving time / active time (the holds are left out: the measure the forecasts use; run59: 43.3 %),
    stall rate B = (wall - moving) / wall (the holds count: run59: 81 %);
  * the stalls by cause (the model's wait, wait hands, path search, looks, redeciding, other), one stall at a time: median / p90 / max, and how many
    are 5, 10 and 30 seconds or longer per 10 minutes of active time; the longest ten with their causes.
--selftest checks run59's three finished tasks (A = 43.3 +- 1 points, B = 81 +- 1) and exits 1 when they are not reproduced.
"""
import argparse, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
parser.add_argument('--data', required=True, help='directory of the exports (tasks.json ...)')
parser.add_argument('--json', help='also write the numbers to this file')
parser.add_argument('--selftest', action='store_true', help='run59 must give A = 43.3 +- 1 and B = 81 +- 1')
args = parser.parse_args()
os.environ['STALLRATE_DATA'] = os.path.abspath(args.data)      # common.py goes to this directory when it is imported

from analyze4 import *       # noqa: E402,F401  (TASKS, all_segments, stretches, pct, jst, collections, statistics)

CAT = {
    'model_act': 'モデルの待ち', 'model_refused': 'モデルの待ち', 'model_other': 'モデルの待ち',
    'wait_f': 'wait の手', 'wait_o': 'wait の手', 'redecide': '決め直し・Opus', 'model_look': '確かめ・look', 'look_exec': '確かめ・look',
    'path': '経路探索の止まり', 'dispatch': 'そのほか', 'head_other': 'そのほか', 'head_other_opus_bg': 'そのほか', 'startup': 'そのほか',
}
ORDER = ['モデルの待ち', 'wait の手', '経路探索の止まり', '確かめ・look', '決め直し・Opus', 'そのほか']


def measure(key):
    B, A, segs, C = all_segments(key)
    wall = B['t_end'] - B['t_start']
    hold = sum(b - a for a, b, _ in B['holds'])
    active = wall - hold
    causes, moving = collections.Counter(), 0.0
    for a, b, lab in segs:
        if lab.startswith('hold:'): continue
        if lab == 'move': moving += b - a
        else: causes[CAT[lab]] += b - a
    stops = [s for s in stretches(segs) if not s['hold']]
    return dict(key=key, B=B, wall=wall, hold=hold, active=active, moving=moving, notmoving=active - moving, causes=causes, stops=stops)


def combine(rows):
    total = dict(key='ALL', wall=sum(r['wall'] for r in rows), hold=sum(r['hold'] for r in rows), active=sum(r['active'] for r in rows),
                 moving=sum(r['moving'] for r in rows), causes=collections.Counter(), stops=[])
    total['notmoving'] = total['active'] - total['moving']
    for r in rows:
        total['causes'].update(r['causes']); total['stops'] += [dict(s, task=r['key'], B=r['B']) for s in r['stops']]
    return total


def rates(r):
    return dict(A=100 * r['notmoving'] / r['active'] if r['active'] else float('nan'), B=100 * (r['wall'] - r['moving']) / r['wall'] if r['wall'] else float('nan'))


def dominant(stop):
    comp = collections.Counter()
    for k, v in stop['comp'].items():
        if k != 'move_blip': comp[CAT[k]] += v
    return comp.most_common(1)[0][0] if comp else 'そのほか'


def report(r):
    ab = rates(r)
    print('%-4s 壁 %7.1f 秒 | 保留 %7.1f | 稼働 %7.1f | 動いた %7.1f | 止まり %7.1f | 止まり率 A %5.1f%%  B %5.1f%%' % (r['key'], r['wall'], r['hold'], r['active'], r['moving'], r['notmoving'], ab['A'], ab['B']))
    return ab


def main():
    rows = [measure(key) for key in TASKS]
    total = combine(rows)
    print('=== 止まり率（A：保留を除いた稼働比、B：壁時計比） ===')
    for r in rows + [total]: report(r)
    print('\n=== 原因ごとの止まり（稼働 %.1f 秒に対して） ===' % total['active'])
    for cat in ORDER:
        v = total['causes'].get(cat, 0.0)
        print('  %-14s %7.1f 秒  %5.1f%%' % (cat, v, 100 * v / total['active'] if total['active'] else 0))
    durations = [s['t1'] - s['t0'] for s in total['stops']]
    if durations:
        per10 = lambda n: n * 600.0 / total['active']
        print('\n=== 1 回の止まり（合体した止まり、保留を除く）：%d 件 ===' % len(durations))
        print('  中央 %.2f 秒 / 90%% %.2f / 95%% %.2f / 最大 %.2f' % (statistics.median(durations), pct(durations, .9), pct(durations, .95), max(durations)))
        for threshold in (5, 10, 30):
            n = sum(1 for d in durations if d >= threshold)
            print('  %2d 秒以上：%3d 件（10 分あたり %.1f 回）' % (threshold, n, per10(n)))
        print('\n=== いちばん長い止まり 10 件 ===')
        for i, s in enumerate(sorted(total['stops'], key=lambda s: -(s['t1'] - s['t0']))[:10], 1):
            print('  #%d %s %s 〜 %s  %.1f 秒  主な原因：%s' % (i, s['task'], jst(s['t0'], 0), jst(s['t1'], 0), s['t1'] - s['t0'], dominant(s)))
    ab = rates(total)
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as handle:
            json.dump(dict(rates=ab, wall=total['wall'], hold=total['hold'], active=total['active'], moving=total['moving'], causes=dict(total['causes']),
                           tasks={r['key']: dict(wall=r['wall'], hold=r['hold'], active=r['active'], moving=r['moving'], **rates(r)) for r in rows}), handle, ensure_ascii=False, indent=2)
    if args.selftest:
        ok = abs(ab['A'] - 43.3) <= 1.0 and abs(ab['B'] - 81.0) <= 1.0
        print('\nselftest：A %.1f%%（43.3 ±1）・B %.1f%%（81 ±1）→ %s' % (ab['A'], ab['B'], 'PASS' if ok else 'FAIL'))
        sys.exit(0 if ok else 1)


main()
