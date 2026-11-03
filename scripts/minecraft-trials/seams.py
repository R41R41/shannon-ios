#!/usr/bin/env python3
"""seams.py <trial.json> <rig log> — decisions between the milestones of a rig trial (the late-game run, section L; any section works).

For every interval between two milestone latches (and from the start to the first, and from the last to the end) it prints how many decisions the head
made, which tools it used, and the stretch of the interval it spent waiting (`fca_wait`). S3's seam question: how many decisions pass between one section
of the run and the next move (1-2 in his replays). When the trial stopped, the last decision's tools and the world at the end (dimension, position,
inventory counts) are printed: the current section, the real dimension and the pack for a stop of type 5.

Reads the exports of one trial only (results/<batch>/<trial>.json and rig-<trial>.log); no API, no database.
"""
import json
import re
import sys


def main(argv):
    if len(argv) != 3:
        print(__doc__); return 2
    with open(argv[1], encoding='utf-8') as handle: trial = json.load(handle)
    marks = sorted((float(sec), name) for name, sec in (trial.get('milestones') or {}).items())
    decisions = []
    with open(argv[2], encoding='utf-8', errors='replace') as handle:
        for line in handle:
            if '"event":"fca_decision_metrics"' not in line: continue
            try: row = json.loads(line[line.index('{'):])
            except ValueError: continue
            decisions.append(row)
    print(f'trial {trial.get("trial")}: {trial.get("reason")} at {trial.get("elapsed")} s, {len(decisions)} decisions, {len(marks)} milestones')
    bounds = [0.0] + [seconds for seconds, _ in marks] + [float(trial.get('elapsed') or 1e9)]
    labels = ['start'] + [name for _, name in marks] + ['end']
    for index in range(len(bounds) - 1):
        lo, hi = bounds[index], bounds[index + 1]
        inside = [d for d in decisions if lo < float(d.get('t', -1)) <= hi]
        tools = {}
        for d in inside:
            for tool in d.get('tools') or []:
                tools[tool] = tools.get(tool, 0) + 1
        waits = tools.get('fca_wait', 0)
        print(f'  {labels[index]} -> {labels[index + 1]}: {hi - lo:.0f} s, {len(inside)} decisions, waits {waits}, tools {json.dumps(tools, ensure_ascii=False)}')
    if not trial.get('ok'):
        final = trial.get('final') or {}
        print(f'  stopped: dimension {final.get("dimension")}, pos {final.get("pos")}, health {final.get("health")}, deaths {final.get("deaths")}')
        last = (trial.get('stall') or {}).get('last') or []
        for item in last[-4:]:
            print('   ', re.sub(r'\s+', ' ', json.dumps(item, ensure_ascii=False))[:240])
        print('  maxCounts (the pack):', json.dumps({k: v for k, v in (trial.get('maxCounts') or {}).items() if v}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
