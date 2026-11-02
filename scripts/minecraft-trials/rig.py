#!/usr/bin/env python3
"""Section trials in an isolated head + body rig: the same trial as trials.py (start state, milestones, caps, report), but the head, the body and the world are the
rig's own, so a real run can go on beside it (VM with 4 vCPU; the lab-slot rules apply: take the slot first, `--allow-run` is the coordinator's decision).

What is shared with production: nothing that it could break. For each trial three processes are started and stopped again: a lab Minecraft server (seedscan.Lab: a copy
of the pristine world, the production's difficulty and distances, monsters on); the head's rig (services/api/scripts/minecraft-rig.ts: the head's own code with its own
database file, operator socket and loopback door, the production's model factory and budget); and the body (the body tree's scripts/lab/rig-body-run.ts, run as the lab
probes run: the real native body over a mineflayer bot, polling the rig's door as it polls the API). shannon-home, the production body account, the services and their
database are not opened. The model keys are read by the head's rig process from the env file given, and are not printed.

  python3 -I rig.py run --head-pin ~/s4-pins/head-<sha> --body-pin ~/s4-pins/body-<sha> --sections 6,7,9 --seeds c1 --max-section-yen 500 --batch-cap-yen 3000 \\
        --owner-ok-supply "<who, when>" [--model real|script] [--smoke]
  python3 -I rig.py report [--batch B]          (the same report as trials.py)

The head pin is `git archive` of the head tree under test with node_modules linked in (the rig script itself is copied into it); the body pin is the body tree under
test (src, scripts, package files), with ~/Shannon-dev's node_modules linked in (rig.py does that, and writes the body's runner into the pin).
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

EXIT_PLAN_DONE = 10      # `run` ends with this when nothing of the plan is left that could still run (all done, or the rest does not fit the batch cap)
HOME = os.path.expanduser('~')
RIG_ROOT =os.path.join(HOME, '.cache', 'minebot-lab', 'rig')
PRODUCTION_ENV = os.path.join(HOME, '.config', 'shannon-ios', 'api.env')
BODY_RUN_RELATIVE = os.path.join('scripts', 'lab', 'rig-body-run.ts')
BODY_RUN_SOURCE = """// The body's half of S4's isolated head + body rig (rig.py writes this file into the body pin; the same text is backend/scripts/lab/rig-body-run.ts).
import { createProbeBot, closeProbeBot } from '../../src/services/minebot/testing/MinecraftProbeBot.js';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import { CommonFcaControlLoop } from '../../src/services/minebot/integration/commonFca/controlLoop.js';

const port = Number(process.env.RIG_MC_PORT), name = process.env.RIG_BODY_NAME ?? 'I_am_Shannon', head = process.env.RIG_HEAD_URL ?? '';
if (!Number.isInteger(port) || !head) throw new Error('RIG_MC_PORT and RIG_HEAD_URL are required');
const say = (tag: string, value: unknown) => console.log(`${tag} ${JSON.stringify(value)}`);

const actor: any = await createProbeBot(port, name);
actor.on('error', (error: Error) => say('RIG_BODY_ERROR', String(error?.message ?? error).slice(0, 200)));
actor.on('death', () => say('RIG_EVENT', { event: 'death', at: new Date().toISOString() }));
actor.on('end', (reason: unknown) => say('RIG_EVENT', { event: 'body_end', reason: String(reason).slice(0, 120) }));
const body = new NativeCommonFcaBody(actor, { serverId: 'rig', capture: async () => { throw new Error('no picture in the rig'); }, rendererConfigured: () => false });
const loop = new CommonFcaControlLoop({ baseUrl: head, token: 'rig-device-token-0000', serverId: 'rig', actuator: body, pollMilliseconds: 150 });
loop.start();
say('RIG_BODY_UP', { name, port, head });

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await loop.stop().catch(() => undefined);
  try { closeProbeBot(actor); } catch { /* the lab is closing */ }
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
"""


def ensure_body(body_pin, dev=os.path.join(HOME, 'Shannon-dev')):
    """The body pin made ready to run the rig's body: its runner script written, node_modules linked in from ~/Shannon-dev. Returns the body's backend directory."""
    backend = os.path.join(body_pin, 'backend')
    runner = os.path.join(backend, BODY_RUN_RELATIVE)
    os.makedirs(os.path.dirname(runner), exist_ok=True)
    if not os.path.exists(runner) or open(runner, encoding='utf-8').read() != BODY_RUN_SOURCE:
        with open(runner, 'w', encoding='utf-8') as handle: handle.write(BODY_RUN_SOURCE)
    for name in ('node_modules', os.path.join('backend', 'node_modules')):
        link, original = os.path.join(body_pin, name), os.path.join(dev, name)
        if not os.path.exists(link) and os.path.isdir(original):
            subprocess.run(['cp', '-al', original, link], check=True)
    if not os.path.isdir(os.path.join(body_pin, 'node_modules')): raise trials.Stop(f'no node_modules in {body_pin} (link ~/Shannon-dev/node_modules into the body pin)')
    for name in ('.nvmrc',):
        if not os.path.exists(os.path.join(body_pin, name)) and os.path.exists(os.path.join(dev, name)): shutil.copy2(os.path.join(dev, name), os.path.join(body_pin, name))
    open(os.path.join(body_pin, '.shannon-development'), 'a').close()
    return backend


def free_slot(port_from, port_to):
    """The lab slot (game port = 25570 + slot) of the first port in the range whose game and RCON ports are both free."""
    for port in range(port_from, port_to + 1):
        slot = port - seedscan.GAME_PORT_BASE
        if seedscan.port_free(port) and seedscan.port_free(seedscan.GAME_PORT_BASE + 1000 + slot): return slot
    raise trials.Stop(f'no free port in {port_from}-{port_to} (and +1000 for RCON)')


class Rig:
    """One trial's lab server, head rig and body. start() points trials.py at them (RCON, database, operator CLI); stop() puts everything back."""

    def __init__(self, args, section, seed_key, batch, world, facts):
        self.args, self.section, self.seed_key, self.batch = args, section, seed_key, batch
        self.label = f'{batch}-s{section["id"]}-{seed_key}'.replace('/', '_')[:60]
        self.dir = os.path.join(RIG_ROOT, self.label)
        self.world, self.facts = world, facts
        self.lab, self.head, self.body = None, None, None
        self.ready, self.http, self.body_up, self.usage, self.lines = None, None, False, {}, []
        self.saved = {}

    def start(self):
        a = self.args
        os.makedirs(self.dir, exist_ok=True)
        slot = free_slot(a.port_from, a.port_to)
        self.lab = seedscan.Lab(f'rig-{self.label}', self.facts.get('seed', '0'), slot, heap=a.heap, cores=a.cores, world_from=self.world, difficulty='normal', monsters=True,
                                view=10, simulation=8, max_players=3)
        self.lab.start()
        seedscan.log(f'rig: lab server {self.lab.dir} on port {self.lab.port}')
        self.lab.wait_ready().close()
        backend = ensure_body(a.body_pin)
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': HOME, 'RIG_DIR': self.dir, 'RIG_PORT': str(self.lab.port), 'RIG_BODY_NAME': trials.BODY, 'RIG_MODEL': a.model,
               'NODE_ENV': 'production'}
        if a.model == 'real': env['RIG_ENV_FILE'] = a.env_file
        self.head = subprocess.Popen([a.node, '--import', 'tsx', 'scripts/minecraft-rig.ts'], cwd=os.path.join(a.head_pin, 'services', 'api'), env=env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        threading.Thread(target=self._drain, args=(self.head, 'rig.log'), daemon=True).start()
        self._wait(lambda: self.http is not None, 90, 'the head\'s rig did not open its door', self.head)
        node_dir = os.path.dirname(a.body_node)
        body_env = {'HOME': HOME, 'PATH': f'{node_dir}:/usr/bin:/bin', 'OPENAI_API_KEY': 'offline-test-not-used', 'MONGODB_URI': 'mongodb://127.0.0.1:1/shannon-offline-not-used',
                    'SHANNON_ISOLATED_MINEBOT_PROBE': 'true', 'MINECRAFT_COGNITION_MODE': 'off', 'MINECRAFT_OUTAGE_NO_LLM': 'true', 'MINECRAFT_HUNT_NO_LLM': 'true',
                    'MINECRAFT_PROBE_FLOOR': 'default', 'TS_NODE_TRANSPILE_ONLY': 'true', 'RIG_MC_PORT': str(self.lab.port), 'RIG_HEAD_URL': self.http['url'], 'RIG_BODY_NAME': trials.BODY}
        self.body = subprocess.Popen(['nice', '-n', '5', a.body_node, '--loader', 'ts-node/esm', BODY_RUN_RELATIVE], cwd=backend, env=body_env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        threading.Thread(target=self._drain, args=(self.body, 'body.log'), daemon=True).start()
        self._wait(lambda: self.ready is not None, a.ready_seconds, 'the rig did not come up', self.head, self.body)
        self.saved = {'DB': trials.DB, 'IOS': trials.IOS, 'NODE': trials.NODE, 'RCON_TARGET': trials.RCON_TARGET}
        trials.DB, trials.IOS, trials.NODE = self.ready['db'], a.head_pin, a.node
        trials.RCON_TARGET = ('127.0.0.1', self.lab.rcon_port, self.lab.password)
        return self

    def _wait(self, done, seconds, what, *procs):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not done():
            if any(p.poll() is not None for p in procs): break
            time.sleep(0.5)
        if not done():
            raise trials.Stop(f'{what} (exit {[p.poll() for p in procs]}): ' + ' | '.join(self.lines[-8:])[-800:])

    def _drain(self, proc, name):
        with open(os.path.join(self.dir, name), 'a', encoding='utf-8') as handle:
            for line in proc.stdout:
                line = line.rstrip('\n')
                handle.write(line + '\n'); handle.flush()
                self.lines.append(line)
                for tag, key in (('RIG_HTTP ', 'http'), ('RIG_READY ', 'ready'), ('RIG_USAGE ', 'usage')):
                    if line.startswith(tag):
                        try: setattr(self, key, json.loads(line[len(tag):]))
                        except ValueError: pass
                if line.startswith('RIG_BODY_UP'): self.body_up = True

    def usage_usd(self):
        return self.usage.get('totalUsd')

    def stop(self):
        if self.saved:
            trials.DB, trials.IOS, trials.NODE, trials.RCON_TARGET = (self.saved[k] for k in ('DB', 'IOS', 'NODE', 'RCON_TARGET'))
            self.saved = {}
        for proc in (self.body, self.head):          # the body first: it polls the head
            if proc and proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=25)
                except subprocess.TimeoutExpired:
                    proc.kill(); proc.wait()
        if self.lab: self.lab.stop(remove=True)
        if not self.args.keep and os.path.isdir(self.dir) and os.path.abspath(self.dir).startswith(os.path.abspath(RIG_ROOT) + os.sep):
            os.makedirs(os.path.join(trials.RESULTS, self.batch), exist_ok=True)
            for name in ('rig.log', 'body.log'):
                if os.path.exists(os.path.join(self.dir, name)): shutil.copy2(os.path.join(self.dir, name), os.path.join(trials.RESULTS, self.batch, f'{name[:-4]}-{self.label}.log'))
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
    limit = args.load_limit if args.load_limit is not None else (3.5 if (os.cpu_count() or 2) <= 4 else 0)
    with LoadWatch(limit, args.load_minutes):
        left = run_plan(args, cfg, plan, batch, folder, batch_cap)
    trials.write_report(batch)
    return 0 if left else EXIT_PLAN_DONE


def run_plan(args, cfg, plan, batch, folder, batch_cap):
    """Runs the trials of the plan that have no result yet (a batch folder is resumed, its spending counted), at most --limit of them. Returns how many trials remain
    that could still run (0 = the plan is done, or what is left does not fit the batch cap)."""
    finished, interrupted = trials.batch_rows(batch)
    done = {r['trial'] for r in finished}
    spent = sum((r.get('yen') or 0) for r in finished + interrupted)
    ran, stopped = 0, False
    for section, seed_key in plan:
        if f'{batch}-s{section["id"]}-{seed_key}' in done: continue
        if args.limit and ran >= args.limit: break
        if trials.stop_requested(): trials.log(f'batch: {trials.STOP_FILE} exists: stopping before S{section["id"]}'); stopped = True; break
        if spent + trials.section_cap(section, cfg) > batch_cap:
            trials.log(f'batch: ¥{spent:.0f} spent; S{section["id"]} could take {trials.section_cap(section, cfg)} more and pass ¥{batch_cap}: stopping'); break
        variant = (trials.load_json(os.path.join(HERE, 'seeds.json'), {}).get('variants') or {}).get(seed_key, {})
        world_key = variant.get('world', seed_key)
        world = os.path.join(trials.PRISTINE, world_key, 'world')
        facts = trials.load_json(os.path.join(trials.PRISTINE, world_key, 'facts.json'), {})
        trial_section = {**section, 'limitMinutes': 1} if args.smoke else section
        rig = Rig(args, section, seed_key, batch, world, facts)
        usd = None
        try:
            rig.start()
            result = trials.run_trial(trial_section, seed_key, batch, cfg, False, args.owner_ok_supply)
        except trials.Stop as error:
            trials.log(f'rig trial S{section["id"]}/{seed_key} could not run: {error}')
            result = {'trial': f'{batch}-s{section["id"]}-{seed_key}', 'batch': batch, 'section': section['id'], 'sectionName': section['name'], 'seedKey': seed_key,
                      'targetSeconds': section['targetSeconds'], 'ok': False, 'reason': f'rig_failed:{error}'[:400], 'seconds': None, 'yen': 0, 'milestones': {},
                      'prediction': section.get('prediction'), 'supplied': True, 'supplyKinds': trials.supply_kinds(section), 'ownerOk': args.owner_ok_supply}
        finally:
            usd = rig.usage_usd()
            rig.stop()
        result['model'] = 'rig-' + args.model
        result['rig'] = {'headPin': os.path.basename(args.head_pin), 'bodyPin': os.path.basename(args.body_pin), 'usd': usd}
        result['builds'] = {'head': os.path.basename(args.head_pin).replace('head-', ''), 'body': os.path.basename(args.body_pin).replace('body-', '')}
        spent += result.get('yen') or 0
        ran += 1
        result['batchYenAfter'] = round(spent, 2)
        # A trial that the rig could not run, or that the stop file cut off, is not done: it is kept as an `interrupted` result (its yen still count) and runs again in a later window.
        again = str(result['reason']).startswith('rig_failed') or result['reason'] == 'stopped_by_file'
        name = f'{result["trial"]}.interrupted-{"rigfail" if str(result["reason"]).startswith("rig_failed") else "stop"}-{trials.jst_stamp(True)}.json' if again else f'{result["trial"]}.json'
        trials.save_json(os.path.join(folder, name), result)
        with open(os.path.join(trials.RESULTS, 'history.jsonl'), 'a', encoding='utf-8') as handle: handle.write(json.dumps(result, ensure_ascii=False) + '\n')
        trials.log(f'trial {result["trial"]}: ok={result["ok"]} reason={result["reason"]} s={result.get("seconds")} decisions={result.get("decisions")} yen={result.get("yen")} (batch {spent:.0f})')
        if result['reason'] == 'stopped_by_file': trials.log('batch: the stop file ended this trial; no more trials'); stopped = True; break
        if str(result['reason']).startswith('rig_failed') and not args.keep_going: trials.log('batch: stopping after a rig failure'); stopped = True; break
    finished, interrupted = trials.batch_rows(batch)
    done = {r['trial'] for r in finished}
    spent = sum((r.get('yen') or 0) for r in finished + interrupted)
    left = [(s, k) for s, k in plan if f'{batch}-s{s["id"]}-{k}' not in done and spent + trials.section_cap(s, cfg) <= batch_cap]
    return len(left)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('run')
    p.add_argument('--head-pin', required=True); p.add_argument('--body-pin', required=True)
    p.add_argument('--node', default=trials.NODE, help='the head\'s node (default: the production runtime\'s)')
    p.add_argument('--body-node', default=os.path.join(HOME, '.nvm', 'versions', 'node', 'v22.21.1', 'bin', 'node'), help='the body\'s node (the lab probes\' pinned one)')
    p.add_argument('--sections'); p.add_argument('--seeds', default='c1'); p.add_argument('--batch')
    p.add_argument('--model', choices=['real', 'script'], default='real'); p.add_argument('--env-file', default=PRODUCTION_ENV)
    p.add_argument('--max-section-yen', type=int); p.add_argument('--batch-cap-yen', type=int); p.add_argument('--owner-ok-supply')
    p.add_argument('--smoke', action='store_true', help='cut every trial to one minute (the plumbing test)')
    p.add_argument('--limit', type=int, help='run at most this many trials in this call (the batch folder is resumed: finished trials are skipped, their yen counted)')
    p.add_argument('--port-from', type=int, default=25580); p.add_argument('--port-to', type=int, default=25589,
                   help='the rig\'s own game ports (its RCON is +1000): other sessions\' labs use 25590-25599 or ports they name, so the rig keeps below them')
    p.add_argument('--heap', default='2G'); p.add_argument('--cores', type=int, default=3); p.add_argument('--ready-seconds', type=int, default=180)
    p.add_argument('--load-limit', type=float, help='give way (make the stop file) when the 1-minute load stays above this (default 3.5 on a machine of 4 cores or fewer, off otherwise; 0 = off)')
    p.add_argument('--load-minutes', type=float, default=3.0)
    p.add_argument('--keep', action='store_true', help='keep the rig directory (database, logs) after a trial')
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
