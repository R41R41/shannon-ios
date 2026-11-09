#!/usr/bin/env python3
"""film_watch.py — a read-only watch of the filmed thru (11/10) or of a rig's thru trial: the milestones of section T, the deaths, the yen.

    python3 -I film_watch.py --task <task id> [--every 15] [--out ~/film1110-watch.jsonl]            (shannon-home and the production database)
    python3 -I film_watch.py --task <task id> --rig-dir ~/.cache/minebot-lab/rig/<n> --lab-dir <lab> (a rig's trial: its own database and lab server)

What it reads, and nothing else: over RCON the body's inventory counts (`clear <body> <item> 0` removes nothing), its dimension, position, health,
respawn, the advancements of the milestones and the death score `trial_deaths` (make it once before the request:
`scoreboard objectives add trial_deaths deathCount`; without it the deaths read 0 and the log count below is the one to trust);
from the database (read-only) the task's status and yen; from the server's logs/latest.log the death messages of the body.
It never cancels, gives, moves or writes anything: stopping the run stays the operator's `cancel`.
"""
import argparse
from datetime import datetime
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import trials  # noqa: E402

DEATH_WORDS = re.compile(r'\]: ' + re.escape(trials.BODY) + r' (was |drowned|died|starved|suffocated|froze|burned|blew up|fell|hit the ground|went up in flames|'
                         r'walked into|tried to swim|experienced kinetic|discovered the floor|left the confines|withered|didn.t want to live|'
                         r'was doomed)')


def lab_rcon(lab_dir):
    values = {}
    with open(os.path.join(lab_dir, 'server.properties'), encoding='utf-8') as handle:
        for line in handle:
            if '=' in line and not line.startswith('#'):
                key, value = line.rstrip('\n').split('=', 1)
                values[key.strip()] = value
    return ('127.0.0.1', int(values['rcon.port']), values.get('rcon.password', ''))


def log_deaths(server_dir):
    try:
        with open(os.path.join(server_dir, 'logs', 'latest.log'), encoding='utf-8', errors='replace') as handle:
            return [line.rstrip('\n')[-160:] for line in handle if DEATH_WORDS.search(line)]
    except OSError:
        return None


def main(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--task', required=True)
    p.add_argument('--every', type=float, default=15)
    p.add_argument('--out')
    p.add_argument('--rig-dir', help='a rig trial directory (its head/shannon.db is read instead of the production database)')
    p.add_argument('--lab-dir', help='the rig trial\'s lab server directory (its server.properties and logs instead of shannon-home\'s)')
    p.add_argument('--once', action='store_true')
    a = p.parse_args(argv)
    server_dir = trials.MC
    if a.rig_dir:
        trials.DB = os.path.join(a.rig_dir, 'head', 'shannon.db')
    if a.lab_dir:
        trials.RCON_TARGET = lab_rcon(a.lab_dir)
        server_dir = a.lab_dir
    section = {str(s['id']): s for s in trials.config()['sections']}['T']
    gate = section.get('deathFailsAfter')
    items = trials.tracked_items(section)
    latched, maxima = {}, {}
    t0 = None
    while True:
        row = trials.task_row(a.task) or {}
        if t0 is None and row.get('createdAt'):
            t0 = datetime.fromisoformat(row['createdAt'].replace('Z', '+00:00')).timestamp()
        elapsed = (time.time() - t0) if t0 else None
        try:
            r = trials.Rcon(timeout=20)
            counts = {i: trials.count_items(r, i) for i in items}
            state = trials.body_state(r)
            state['extra'] = trials.extra_probes(r, section, {}, latched)
            r.close()
        except (OSError, ConnectionError, trials.Stop) as error:
            print(f'{time.strftime("%H:%M:%S")} rcon: {error}', flush=True)
            if a.once: return 1
            time.sleep(a.every)
            continue
        for i, n in counts.items(): maxima[i] = max(maxima.get(i, 0), n)
        before = set(latched)
        trials.check_milestones(section, counts, state, latched, maxima, round(elapsed or 0, 1))
        deaths = log_deaths(server_dir)
        line = {'at': trials.now_iso(), 'elapsed': round(elapsed, 1) if elapsed else None, 'status': row.get('status'), 'exec': row.get('execState'),
                'yen': row.get('yen'), 'dimension': state.get('dimension'), 'pos': state.get('pos'), 'health': state.get('health'),
                'deathScore': state.get('deaths'), 'deathLog': len(deaths) if deaths is not None else None,
                'gate': gate in latched, 'new': sorted(set(latched) - before), 'milestones': latched}
        if a.out:
            with open(os.path.expanduser(a.out), 'a', encoding='utf-8') as handle: handle.write(json.dumps(line, ensure_ascii=False) + '\n')
        mins = f'{elapsed / 60:5.1f} 分' if elapsed else '  ?  分'
        last = max(latched, key=latched.get) if latched else '—'
        print(f'{time.strftime("%H:%M:%S")} {mins} {row.get("status")}/{row.get("execState")} ¥{row.get("yen")} {state.get("dimension")} {state.get("pos")} '
              f'体力 {state.get("health")} 死亡 {state.get("deaths")}（記録 {line["deathLog"]}）{" 鉄の後" if gate in latched else ""} '
              f'節目 {len(latched)}/{len(section["milestones"])}（最新 {last}）' + (f' 新: {"・".join(line["new"])}' if line['new'] else ''), flush=True)
        if a.once or row.get('status') in trials.FINISHED: return 0
        time.sleep(a.every)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
