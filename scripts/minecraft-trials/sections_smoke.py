#!/usr/bin/env python3
"""Smoke test of the S6-S11 definitions (sections.json) against a real server, with no model and no cost.

For one published world (pristine/<key>/{world,facts.json,sites.json}) it starts a lab server on a copy (normal difficulty, as shannon-home),
lets a bare client named I_am_Shannon stand in for the body, and for each section runs what trials.py runs before the request
(setup_body: give / wear / prep / tp, then preflight) and then asks the server the questions the poll loop asks. Then it grants, gives or
builds the thing the section is waiting for (the advancement, 6 blaze rods, 12 pearls, 32 gold gone, the 12 eyes in the frames ...) and checks
that the detector fires and the section ends. A start that cannot be reached, a command the server refuses, or a success the harness would
never see shows here and not in a paid batch.

  python3 -I sections_smoke.py --key c2 [--sections 6,7,8a,8b,9,10,11] [--slot 16]

Where: the PC's WSL lab with HOME=/home/azureuser (backend/scripts/lab/README.md), or the VM under lab-slot.sh. Needs node and the body's
node_modules for scripts/lab/join-bot.mjs (--node, --node-modules, --join-script; the defaults are the WSL lab's).
"""
import argparse
import importlib.util
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser('~')


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# what makes each section's end milestone true, by section id: commands the operator could not tell from the real thing
PROVE = {
    '6': ['advancement grant I_am_Shannon only minecraft:nether/find_fortress'],
    '7': ['give I_am_Shannon minecraft:blaze_rod 6'],
    '67': ['give I_am_Shannon minecraft:blaze_rod 7'],
    '8a': ['give I_am_Shannon minecraft:ender_pearl 12'],
    '8b': ['clear I_am_Shannon minecraft:gold_ingot 32'],
    '9': ['advancement grant I_am_Shannon only minecraft:story/follow_ender_eye'],
    '10': ['@frames-filled', '@tp-end'],
    '11': ['advancement grant I_am_Shannon only minecraft:end/kill_dragon'],
}


def snapshot(t, r, section, sites, latched, maxima):
    items = t.tracked_items(section)
    counts = {i: t.count_items(r, i) for i in items}
    state = t.body_state(r)
    state['extra'] = t.extra_probes(r, section, sites, latched)
    for i, n in counts.items(): maxima[i] = max(maxima.get(i, 0), n)
    done = t.check_milestones(section, counts, state, latched, maxima, 0)
    return counts, state, done


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--key', required=True)
    parser.add_argument('--pristine', help='directory holding <key>/ (default: the seedscan out directory)')
    parser.add_argument('--sections', default='6,7,8a,8b,9,10,11')
    parser.add_argument('--slot', type=int, default=16)
    parser.add_argument('--node', default=os.path.join(HOME, '.nvm', 'versions', 'node', 'v22.21.1', 'bin', 'node'))
    parser.add_argument('--node-modules', default=os.path.join(HOME, 'Shannon-dev', 'node_modules'))
    parser.add_argument('--join-script', default=os.path.join(HOME, 'Shannon-dev', 'backend', 'scripts', 'lab', 'join-bot.mjs'))
    parser.add_argument('--keep', action='store_true', help='keep the lab directory')
    args = parser.parse_args(argv)
    s, t = load('seedscan'), load('trials')
    base = args.pristine or os.path.join(s.OUT, 'pristine')
    facts = t.load_json(os.path.join(base, args.key, 'facts.json'))
    sites = t.load_json(os.path.join(base, args.key, 'sites.json'))
    cfg = t.load_json(os.path.join(HERE, 'sections.json'))
    problems = t.validate_sections(cfg)
    if problems: raise SystemExit('sections.json: ' + '; '.join(problems))
    by_id = {str(x['id']): x for x in cfg['sections']}
    rows = []
    lab = s.Lab(f'smoke-{args.key}', facts['seed'], args.slot, heap='2G', cores=3, world_from=os.path.join(base, args.key, 'world'), difficulty='normal', monsters=True)
    bot = None
    try:
        lab.start()
        r = lab.wait_ready()
        bot = subprocess.Popen([args.node, args.join_script, str(lab.port), t.BODY, '900'], env={'HOME': HOME, 'PATH': '/usr/bin:/bin', 'BODY_NODE_MODULES': args.node_modules},
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for _ in range(60):
            if t.BODY in r.cmd('list'): break
            time.sleep(1)
        else:
            raise SystemExit('the stand-in client did not join: ' + (bot.stdout.readline() if bot.poll() is not None else ''))
        r.cmd('scoreboard objectives add trial_deaths deathCount')
        for sid in args.sections.split(','):
            section = by_id[sid]
            row = {'section': sid, 'name': section['name'], 'supply': t.supply_kinds(section)}
            t0 = time.monotonic()
            try:
                missing = sorted(k for k in t.site_refs(section) if k not in sites)
                if missing: raise t.Stop('no_sites:' + ','.join(missing))
                t.setup_body(r, section, None, sites)
                r.cmd(f'effect give {t.BODY} minecraft:resistance 900 4 true')
                r.cmd(f'effect give {t.BODY} minecraft:fire_resistance 900 0 true')
                time.sleep(3)
                row['start'] = {k: v for k, v in t.body_state(r).items() if k in ('dimension', 'pos', 'health')}
                row['preflight'] = t.preflight(r, section, sites) or 'ok'
                latched, maxima = {}, {}
                counts, state, done = snapshot(t, r, section, sites, latched, maxima)
                row['atStart'] = {'ended': done, 'latched': sorted(latched), 'kit': {k.replace('minecraft:', ''): v for k, v in counts.items() if v}}
                for step in PROVE[sid]:
                    if step == '@frames-filled':
                        for f in sites['strongholdFrames']:
                            r.cmd(f'execute in minecraft:overworld run setblock {f["x"]} {f["y"]} {f["z"]} minecraft:end_portal_frame[facing={f["facing"]},eye=true] replace')
                        counts, state, done = snapshot(t, r, section, sites, latched, maxima)
                        row['framesFilled'] = state['extra'].get('frames')
                    elif step == '@tp-end':
                        r.cmd(f'execute in minecraft:the_end run forceload add 96 -4 104 4')
                        time.sleep(3)
                        r.cmd(f'execute in minecraft:the_end run tp {t.BODY} 100 49 0')
                        time.sleep(4)
                    else:
                        r.cmd(step)
                        time.sleep(1)
                counts, state, done = snapshot(t, r, section, sites, latched, maxima)
                row['afterProof'] = {'ended': done, 'latched': sorted(latched), 'dimension': state.get('dimension')}
                if sid == '8b': row['goldLeft'] = counts.get('minecraft:gold_ingot')
            except t.Stop as error:
                row['stop'] = str(error)
            except Exception as error:      # noqa: BLE001 - a broken section must not hide the others
                row['error'] = f'{type(error).__name__}: {error}'[:300]
            row['secs'] = round(time.monotonic() - t0, 1)
            row['ok'] = row.get('preflight') == 'ok' and not row['atStart']['ended'] if 'atStart' in row else False
            row['ok'] = bool(row['ok'] and row.get('afterProof', {}).get('ended'))
            rows.append(row)
            s.log(f'S{sid}: ok={row["ok"]} preflight={row.get("preflight")} start={row.get("start")} proof={row.get("afterProof")} {row.get("stop", "")}{row.get("error", "")}')
        r.close()
    finally:
        if bot and bot.poll() is None: bot.terminate()
        lab.stop(remove=not args.keep)
    os.makedirs(s.OUT, exist_ok=True)
    out = os.path.join(s.OUT, f'sections-smoke-{args.key}.json')
    with open(out, 'w', encoding='utf-8') as handle: json.dump(rows, handle, ensure_ascii=False, indent=1)
    print(f'\n{sum(1 for x in rows if x["ok"])}/{len(rows)} sections start where they should, do not end by themselves, and end when their success is made true -> {out}')
    return 0 if all(x['ok'] for x in rows) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
