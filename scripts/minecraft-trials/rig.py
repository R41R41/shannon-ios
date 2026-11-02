#!/usr/bin/env python3
"""Section trials in an isolated head + body rig: the same trial as trials.py (start state, milestones, caps, report), but the head, the body and the world are the
rig's own, so a real run can go on beside it (VM with 4 vCPU; the lab-slot rules apply: take the slot first, `--allow-run` is the coordinator's decision).

What is shared with production: nothing that it could break. The rig is one process (services/api/scripts/minecraft-rig.ts): the head's own code (operator socket,
task runtime, FCA steps, LLM-centric step parts, control, budget) with its own database file, and the real body (NativeCommonFcaBody over a mineflayer bot, run by
CommonFcaControlLoop with its poll going to the control in-process) on a lab server of its own (a copy of the pristine world, the production's difficulty and distances).
shannon-home, the production body account, the services and their database are not opened. The model keys are read by the rig process from the env file given.

  python3 -I rig.py run --head-pin ~/s4-pins/head-<sha> --body-pin ~/s4-pins/body-<sha> --sections 6,7,9 --seeds c1 --max-section-yen 500 --batch-cap-yen 3000 \\
        --owner-ok-supply "<who, when>" [--model real|script] [--smoke 60]
  python3 -I rig.py report [--batch B]          (the same report as trials.py)

The head pin is `git archive` of the head tree under test with node_modules linked in (the rig script itself is copied into it); the body pin is the body tree under
test (src, scripts, package files), with ~/Shannon-dev's node_modules linked in. The body's side of the rig is bundled once per pin (esbuild, the body's own tsconfig).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)        # `python3 -I` leaves the script's own directory out of the path
import trials  # noqa: E402
import seedscan  # noqa: E402

HOME = os.path.expanduser('~')
RIG_ROOT = os.path.join(HOME, '.cache', 'minebot-lab', 'rig')
BODY_BUNDLE_SOURCE = """// The body parts S4's isolated head + body rig loads (rig.py writes this file into the body pin; the same text is backend/scripts/lab/rig-body.ts).
export { CommonFcaControlLoop } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
export { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
export { createProbeBot, closeProbeBot } from '../../src/services/minebot/testing/MinecraftProbeBot.js';
"""
PRODUCTION_ENV = os.path.join(HOME, '.config', 'shannon-ios', 'api.env')


def ensure_bundle(body_pin, body_node, dev=os.path.join(HOME, 'Shannon-dev')):
    """backend/lab-bundle/rig-body.mjs of the body pin, made once (and again when the source changed). Returns its path."""
    scripts = os.path.join(body_pin, 'backend', 'scripts', 'lab')
    source = os.path.join(scripts, 'rig-body.ts')
    out = os.path.join(body_pin, 'backend', 'lab-bundle', 'rig-body.mjs')
    os.makedirs(scripts, exist_ok=True)
    if not os.path.exists(source) or open(source, encoding='utf-8').read() != BODY_BUNDLE_SOURCE:
        with open(source, 'w', encoding='utf-8') as handle: handle.write(BODY_BUNDLE_SOURCE)
    if os.path.exists(out) and os.path.getmtime(out) > os.path.getmtime(source): return out
    for name in ('node_modules', os.path.join('backend', 'node_modules')):
        link, original = os.path.join(body_pin, name), os.path.join(dev, name)
        if not os.path.exists(link) and os.path.isdir(original):
            subprocess.run(['cp', '-al', original, link], check=True)
    esbuild = os.path.join(body_pin, 'node_modules', 'esbuild', 'bin', 'esbuild')
    if not os.path.exists(esbuild): raise trials.Stop(f'no esbuild in {body_pin}/node_modules (link ~/Shannon-dev/node_modules into the body pin)')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    done = subprocess.run([body_node, esbuild, source, '--bundle', '--platform=node', '--format=esm', '--packages=external',
                           f'--tsconfig={os.path.join(body_pin, "backend", "tsconfig.json")}', f'--outfile={out}', '--log-level=warning'],
                          cwd=body_pin, capture_output=True, text=True, timeout=300)
    if done.returncode != 0 or not os.path.exists(out): raise trials.Stop(f'the body bundle did not build: {(done.stdout + done.stderr)[-400:]}')
    return out


class Rig:
    """One trial's lab server and rig process. start() points trials.py at them (RCON, database, operator CLI); stop() puts everything back."""

    def __init__(self, args, section, seed_key, batch, world, facts):
        self.args, self.section, self.seed_key, self.batch = args, section, seed_key, batch
        self.label = f'{batch}-s{section["id"]}-{seed_key}'.replace('/', '_')[:60]
        self.dir = os.path.join(RIG_ROOT, self.label)
        self.world, self.facts = world, facts
        self.lab, self.proc, self.reader, self.ready, self.lines = None, None, None, None, []
        self.saved = {}

    def start(self):
        a = self.args
        os.makedirs(self.dir, exist_ok=True)
        slot = (int(os.environ.get('LAB_PORT_FROM', seedscan.GAME_PORT_BASE)) - seedscan.GAME_PORT_BASE) + int(os.environ.get('LAB_SLOT', '0')) + a.slot_offset
        self.lab = seedscan.Lab(f'rig-{self.label}', self.facts.get('seed', '0'), slot, heap=a.heap, cores=a.cores, world_from=self.world, difficulty='normal', monsters=True,
                                view=10, simulation=8, max_players=3)
        self.lab.start()
        seedscan.log(f'rig: lab server {self.lab.dir} on port {self.lab.port}')
        self.lab.wait_ready().close()
        bundle = ensure_bundle(a.body_pin, a.body_node)
        db = os.path.join(self.dir, 'head', 'shannon.db')
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': HOME, 'RIG_DIR': self.dir, 'RIG_PORT': str(self.lab.port), 'RIG_BODY_BUNDLE': bundle,
               'RIG_BODY_NAME': trials.BODY, 'RIG_MODEL': a.model, 'NODE_ENV': 'production'}
        if a.model == 'real': env['RIG_ENV_FILE'] = a.env_file
        cwd = os.path.join(a.head_pin, 'services', 'api')
        self.proc = subprocess.Popen([a.node, '--import', 'tsx', 'scripts/minecraft-rig.ts'], cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True, bufsize=1)
        self.reader = threading.Thread(target=self._drain, daemon=True)
        self.reader.start()
        deadline = time.monotonic() + a.ready_seconds
        while time.monotonic() < deadline and self.ready is None:
            if self.proc.poll() is not None: break
            time.sleep(0.5)
        if self.ready is None:
            raise trials.Stop(f'the rig did not come up (exit {self.proc.poll()}): ' + ' | '.join(self.lines[-6:])[-700:])
        self.saved = {'DB': trials.DB, 'IOS': trials.IOS, 'NODE': trials.NODE, 'RCON_TARGET': trials.RCON_TARGET}
        trials.DB, trials.IOS, trials.NODE = self.ready['db'], a.head_pin, a.node
        trials.RCON_TARGET = ('127.0.0.1', self.lab.rcon_port, self.lab.password)
        return self

    def _drain(self):
        log_path = os.path.join(self.dir, 'rig.log')
        with open(log_path, 'a', encoding='utf-8') as handle:
            for line in self.proc.stdout:
                line = line.rstrip('\n')
                handle.write(line + '\n'); handle.flush()
                self.lines.append(line)
                if line.startswith('RIG_READY '):
                    try: self.ready = json.loads(line[len('RIG_READY '):])
                    except ValueError: pass
                elif line.startswith('RIG_USAGE '):
                    try: self.usage = json.loads(line[len('RIG_USAGE '):])
                    except ValueError: pass

    def usage_usd(self):
        return getattr(self, 'usage', {}).get('totalUsd')

    def stop(self):
        if self.saved:
            trials.DB, trials.IOS, trials.NODE, trials.RCON_TARGET = (self.saved[k] for k in ('DB', 'IOS', 'NODE', 'RCON_TARGET'))
            self.saved = {}
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try: self.proc.wait(timeout=25)
            except subprocess.TimeoutExpired:
                self.proc.kill(); self.proc.wait()
        if self.lab: self.lab.stop(remove=True)
        if not self.args.keep and os.path.isdir(self.dir) and os.path.abspath(self.dir).startswith(os.path.abspath(RIG_ROOT) + os.sep):
            keep = os.path.join(trials.RESULTS, self.batch, f'rig-{self.label}.log')
            os.makedirs(os.path.dirname(keep), exist_ok=True)
            if os.path.exists(os.path.join(self.dir, 'rig.log')): shutil.copy2(os.path.join(self.dir, 'rig.log'), keep)
            shutil.rmtree(self.dir, ignore_errors=True)


class LoadWatch:
    """The coordinator's rule for a rig beside a real run: when the machine's 1-minute load stays above the limit (default 3.5 on the 4-vCPU VM) for `minutes`,
    the rig gives way: it makes the stop file, which ends the running trial at its next poll and keeps the next one from starting (trials.stop_requested)."""

    def __init__(self, limit, minutes, every=30):
        self.limit, self.every, self.need = limit, every, max(1, int(minutes * 60 / every))
        self.over, self.stop, self.tripped = 0, threading.Event(), None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self.stop.wait(self.every):
            load = os.getloadavg()[0]
            self.over = self.over + 1 if load > self.limit else 0
            if self.over >= self.need and not os.path.exists(trials.STOP_FILE):
                self.tripped = f'load {load:.1f} above {self.limit} for {self.over * self.every} s'
                os.makedirs(os.path.dirname(trials.STOP_FILE), exist_ok=True)
                with open(trials.STOP_FILE, 'w', encoding='utf-8') as handle: handle.write(f'rig.py: {self.tripped} at {trials.now_iso()}\n')
                trials.log(f'load watch: {self.tripped}: the stop file is made (remove {trials.STOP_FILE} when the machine is free again)')

    def __enter__(self):
        if self.limit > 0: self.thread.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        return False


def cmd_run(args):
    cfg = trials.config()
    problems = trials.validate_sections(cfg)
    if problems: raise trials.Stop('sections.json: ' + '; '.join(problems))
    sections = {str(s['id']): s for s in cfg['sections']}
    if trials.stop_requested(): raise trials.Stop(f'{trials.STOP_FILE} exists: remove it when the way is free again')
    chosen = [sections[k] for k in (args.sections.split(',') if args.sections else sections)]
    only_seeds = set(args.seeds.split(',')) if args.seeds else None
    plan = [(s, k) for s in chosen for k in (sorted(only_seeds) if only_seeds and s.get('anySeed') else s['seeds']) if not only_seeds or k in only_seeds]
    batch = args.batch or ('rig-' + trials.jst_stamp())
    folder = os.path.join(trials.RESULTS, batch)
    os.makedirs(folder, exist_ok=True)
    asking = [s for s, _ in plan if s.get('requiresOwnerOk')]
    if asking and not args.owner_ok_supply:
        raise trials.Stop(f'S{", S".join(sorted({str(s["id"]) for s in asking}))} give items, teleport or build in the rig\'s lab world; the owner has not confirmed that yet. --owner-ok-supply "<who, when>"')
    if args.model == 'real' and not os.path.exists(args.env_file): raise trials.Stop(f'no env file {args.env_file} for the real model (the keys are read there, on the VM only)')
    trials.MAX_SECTION_YEN = args.max_section_yen or None
    batch_cap = args.batch_cap_yen or cfg['batchCapYen']
    trials.save_json(os.path.join(folder, 'plan.json'), {'batch': batch, 'createdAt': trials.now_iso(), 'model': 'rig-' + args.model, 'batchCapYen': batch_cap,
                                                          'maxSectionYen': trials.MAX_SECTION_YEN, 'ownerOk': args.owner_ok_supply, 'dryRun': False,
                                                          'plan': [{'section': s['id'], 'seed': k} for s, k in plan], 'rig': True})
    trials.log(f'rig batch {batch}: {len(plan)} trials: {", ".join(f"S{s["id"]}/{k}" for s, k in plan)}; model {args.model}; ceiling ¥{trials.MAX_SECTION_YEN}, batch ¥{batch_cap}')
    spent = 0.0
    watch = LoadWatch(args.load_limit if args.load_limit is not None else (3.5 if (os.cpu_count() or 2) <= 4 else 0), args.load_minutes).__enter__()
    try:
        spent = run_plan(args, cfg, plan, batch, folder, batch_cap, spent)
    finally:
        watch.__exit__(None, None, None)
    trials.write_report(batch)
    return 0


def run_plan(args, cfg, plan, batch, folder, batch_cap, spent):
    for section, seed_key in plan:
        if trials.stop_requested(): trials.log(f'batch: {trials.STOP_FILE} exists: stopping before S{section["id"]}'); break
        if spent + trials.section_cap(section, cfg) > batch_cap:
            trials.log(f'batch: ¥{spent:.0f} spent; S{section["id"]} could take {trials.section_cap(section, cfg)} more and pass ¥{batch_cap}: stopping'); break
        variant = (trials.load_json(os.path.join(HERE, 'seeds.json'), {}).get('variants') or {}).get(seed_key, {})
        world_key = variant.get('world', seed_key)
        world = os.path.join(trials.PRISTINE, world_key, 'world')
        facts = trials.load_json(os.path.join(trials.PRISTINE, world_key, 'facts.json'), {})
        trial_section = {**section, 'limitMinutes': 1} if args.smoke else section
        rig = Rig(args, section, seed_key, batch, world, facts)
        try:
            rig.start()
            result = trials.run_trial(trial_section, seed_key, batch, cfg, False, args.owner_ok_supply)
        except trials.Stop as error:
            trials.log(f'rig trial S{section["id"]}/{seed_key} could not run: {error}')
            result = {'trial': f'{batch}-s{section["id"]}-{seed_key}', 'batch': batch, 'section': section['id'], 'sectionName': section['name'], 'seedKey': seed_key,
                      'targetSeconds': section['targetSeconds'], 'ok': False, 'reason': f'rig_failed:{error}'[:300], 'seconds': None, 'yen': 0, 'milestones': {},
                      'prediction': section.get('prediction'), 'supplied': True, 'supplyKinds': trials.supply_kinds(section), 'ownerOk': args.owner_ok_supply}
        finally:
            usd = rig.usage_usd()
            rig.stop()
        result['model'] = 'rig-' + args.model
        result['rig'] = {'headPin': os.path.basename(args.head_pin), 'bodyPin': os.path.basename(args.body_pin), 'usd': usd}
        result['builds'] = {'head': os.path.basename(args.head_pin).replace('head-', ''), 'body': os.path.basename(args.body_pin).replace('body-', '')}
        spent += result.get('yen') or 0
        result['batchYenAfter'] = round(spent, 2)
        trials.save_json(os.path.join(folder, f'{result["trial"]}.json'), result)
        with open(os.path.join(trials.RESULTS, 'history.jsonl'), 'a', encoding='utf-8') as handle: handle.write(json.dumps(result, ensure_ascii=False) + '\n')
        trials.log(f'trial {result["trial"]}: ok={result["ok"]} reason={result["reason"]} s={result.get("seconds")} decisions={result.get("decisions")} yen={result.get("yen")} (batch {spent:.0f})')
        if result['reason'] == 'stopped_by_file': trials.log('batch: the stop file ended this trial; no more trials'); break
        if str(result['reason']).startswith('rig_failed') and not args.keep_going: trials.log('batch: stopping after a rig failure'); break
    return spent


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('run')
    p.add_argument('--head-pin', required=True); p.add_argument('--body-pin', required=True)
    p.add_argument('--node', default=trials.NODE, help='the head\'s node (default: the production runtime\'s)')
    p.add_argument('--body-node', default=os.path.join(HOME, '.nvm', 'versions', 'node', 'v22.21.1', 'bin', 'node'), help='the node that runs esbuild for the body bundle')
    p.add_argument('--sections'); p.add_argument('--seeds', default='c1'); p.add_argument('--batch')
    p.add_argument('--model', choices=['real', 'script'], default='real'); p.add_argument('--env-file', default=PRODUCTION_ENV)
    p.add_argument('--max-section-yen', type=int); p.add_argument('--batch-cap-yen', type=int); p.add_argument('--owner-ok-supply')
    p.add_argument('--smoke', action='store_true', help='cut every trial to one minute (the plumbing test)')
    p.add_argument('--slot-offset', type=int, default=0, help='added to the lab slot (game port 25570 + slot)')
    p.add_argument('--heap', default='2G'); p.add_argument('--cores', type=int, default=3); p.add_argument('--ready-seconds', type=int, default=150)
    p.add_argument('--load-limit', type=float, help='give way (make the stop file) when the 1-minute load stays above this (default 3.5 on a machine of 4 cores or fewer, off otherwise; 0 = off)')
    p.add_argument('--load-minutes', type=float, default=3.0)
    p.add_argument('--keep', action='store_true', help='keep the rig directory (database, log) after a trial')
    p.add_argument('--keep-going', action='store_true')
    p = sub.add_parser('report'); p.add_argument('--batch')
    args = parser.parse_args(argv)
    try:
        if args.cmd == 'run': return cmd_run(args)
        trials.cmd_report(args); return 0
    except trials.Stop as error:
        print(f'stopped: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
