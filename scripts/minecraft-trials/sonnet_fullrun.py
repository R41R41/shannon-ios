#!/usr/bin/env python3
"""One explicit Sonnet full mission in a fresh isolated world. Default: inspect plan only (no server/key/API).
Use under the existing lab-slot/hands/memory guard. No retry/resume. The existing Haiku rig CLI remains strict.
"""
import argparse
import datetime as dt
from decimal import Decimal
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import sqlite3
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import rig
import trials

MODEL = 'claude-sonnet-5-5'
GOAL = 'エンドラを討伐してください'
CAP, PRIOR, REMAINING, MAX_SECONDS = 1000, 144, 856, 10800
ADVANCEMENT = 'minecraft:end/kill_dragon'
RULES = {'keep_inventory': False, 'advance_time': True, 'advance_weather': True,
         'spawn_mobs': True, 'natural_health_regeneration': True,
         'fall_damage': True, 'fire_damage': True, 'drowning_damage': True}


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(path)


def read(path):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return None


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def private_database_budget(db_path):
    """Explicit private DB only, after model/driver drain. Never consult restored trials.DB or create a missing DB."""
    p = Path(db_path).resolve(strict=True)
    if not p.is_file() or p.name != 'shannon.db' or p.parent.name != 'head':
        raise ValueError('FULLRUN_PRIVATE_DATABASE_PATH')
    with sqlite3.connect(p.as_uri() + '?mode=ro', uri=True, timeout=10) as connection:
        confirmed = connection.execute('SELECT COALESCE(SUM(yen),0) FROM fca_task_budget').fetchone()[0]
        estimated = connection.execute('SELECT COALESCE(SUM(yen),0) FROM fca_task_budget_estimates WHERE settled_at IS NULL').fetchone()[0]
    for value in (confirmed, estimated):
        if not isinstance(value, (float, int)) or not math.isfinite(value) or value < 0:
            raise ValueError('FULLRUN_DATABASE_ACCOUNTING_UNKNOWN')
    return {'confirmedYen': math.ceil(confirmed), 'estimatedYen': math.ceil(estimated),
            'usedYen': math.ceil(confirmed + estimated), 'path': str(p), 'readOnly': True}


def native_goal_definition(body_pin, node):
    """Read the pinned TS constant as literals; do not import/execute core or read any credential/config."""
    source = Path(body_pin)/'backend/src/services/minebot/integration/commonFca/goalEvidence.ts'
    package = Path(body_pin)/'backend/package.json'
    script = r'''const fs=require('node:fs'), {createRequire}=require('node:module');
const ts=createRequire(process.argv[2])('typescript');
const file=ts.createSourceFile('goal.ts',fs.readFileSync(process.argv[1],'utf8'),ts.ScriptTarget.Latest,true);
function literal(n){
 if(ts.isObjectLiteralExpression(n)) return Object.fromEntries(n.properties.map(p=>{
   if(!ts.isPropertyAssignment(p)||!(ts.isIdentifier(p.name)||ts.isStringLiteral(p.name))) throw Error('NON_LITERAL');
   return [p.name.text,literal(p.initializer)];}));
 if(ts.isArrayLiteralExpression(n)) return n.elements.map(literal);
 if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
 if(n.kind===ts.SyntaxKind.TrueKeyword) return true;
 if(n.kind===ts.SyntaxKind.FalseKeyword) return false;
 if(n.kind===ts.SyntaxKind.NullKeyword) return null;
 if(ts.isNumericLiteral(n)) return Number(n.text);
 throw Error('NON_LITERAL');
}
let found=[];function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(file)==='GOAL_EVIDENCE_SKILL')found.push(literal(n.initializer));ts.forEachChild(n,visit);}visit(file);
if(found.length!==1)throw Error('RESERVED_DEFINITION_COUNT');console.log(JSON.stringify(found[0]));'''
    run = __import__('subprocess').run([node, '-e', script, str(source), str(package)],
        cwd=Path(body_pin)/'backend', env={'HOME': '/home/azureuser', 'PATH': str(Path(node).parent)+':/usr/bin:/bin'},
        text=True, capture_output=True, timeout=30)
    if run.returncode != 0:
        raise ValueError('FULLRUN_RESERVED_DEFINITION_UNREADABLE')
    result = json.loads(run.stdout)
    if result.get('name') != 'goal-evidence' or result.get('readOnly') is not True:
        raise ValueError('FULLRUN_RESERVED_DEFINITION_INVALID')
    return result


def prepare_body_adapter(head_pin, body_pin, manifest, node):
    """Stage verified adapters only. Never copy dependencies from normal Shannon-dev as the Haiku convenience helper can."""
    root, backend = Path(body_pin), Path(body_pin)/'backend'
    if not (root/'node_modules').is_dir():
        raise ValueError('FULLRUN_PRIVATE_DEPENDENCIES_REQUIRED')
    (backend/'scripts/lab').mkdir(parents=True, exist_ok=True)
    copies = {'scripts/lab/rig-spawn-scan.ts': Path(head_pin)/'services/api/scripts/minecraftRigSpawnScan.ts',
              'scripts/lab/sonnet-fullrun-body-run.ts': Path(head_pin)/'scripts/minecraft-trials/sonnet-body-run.ts.txt',
              'scripts/lab/sonnet-fullrun-body-adapter.ts': Path(head_pin)/'services/api/scripts/minecraftFullrunBodyAdapter.ts'}
    for rel, source in copies.items():
        (backend/rel).write_bytes(source.read_bytes())
    (root/'.shannon-development').touch()
    verify_body_runtime(root, manifest)
    script = "const fs=require('node:fs'),p=require('node:path'),r=require('node:module').createRequire(process.argv[1]);const pkg=r.resolve('mineflayer/package.json');console.log(JSON.stringify(['entities.js','inventory.js'].map(n=>p.relative(process.argv[2],p.join(p.dirname(pkg),'lib/plugins',n)))));"
    out = __import__('subprocess').run([node, '-e', script, str(backend/'package.json'), str(root.resolve())],
        cwd=backend, env={'HOME':'/home/azureuser','PATH':str(Path(node).parent)+':/usr/bin:/bin'}, text=True, capture_output=True, timeout=30)
    if out.returncode != 0 or set(json.loads(out.stdout)) != set(manifest['dependencyFiles']):
        raise ValueError('FULLRUN_RESOLVED_DEPENDENCIES_MISMATCH')
    return str(backend), native_goal_definition(root, node)


def verify_pin(root, manifest):
    """Manifest is a reviewed path/hash list. No git command, symlink escape, secret file or normal service access."""
    root = Path(root).resolve()
    files = manifest.get('files')
    if not isinstance(files, dict) or not files:
        raise ValueError('FULLRUN_PIN_MANIFEST')
    for name, digest in files.items():
        p = (root / name).resolve()
        if not p.is_relative_to(root) or not re.fullmatch(r'[a-f0-9]{64}', digest) or sha(p) != digest:
            raise ValueError('FULLRUN_PIN_MISMATCH:' + name)
    return len(files)


def verify_body_runtime(body_pin, manifest):
    """Called after the legacy helper prepared this private pin and before spawning the body."""
    root = Path(body_pin).resolve()
    runtime, dependencies = manifest.get('adapterFiles'), manifest.get('dependencyFiles')
    if not isinstance(runtime, dict) or not runtime or not isinstance(dependencies, dict) or not dependencies:
        raise ValueError('FULLRUN_RUNTIME_AND_PATCH_HASHES_REQUIRED')
    verify_pin(root, {'files': runtime})
    # Dependency links may point inside the private package store, but never to shared Shannon-dev plugin inodes.
    for rel, digest in dependencies.items():
        if not re.fullmatch(r'(backend/)?node_modules/mineflayer/lib/plugins/[A-Za-z0-9_-]+\.js', rel):
            raise ValueError('FULLRUN_DEPENDENCY_PATH')
        item = root / rel
        if sha(item) != digest:
            raise ValueError('FULLRUN_PATCH_HASH_MISMATCH')
        shared = Path('/home/azureuser/Shannon-dev') / rel
        if shared.exists() and os.path.samefile(item, shared):
            raise ValueError('FULLRUN_SHARED_PLUGIN_INODE')


def strict_bool(text):
    found = re.search(r'(?:=|is|:)\s*(true|false)\s*$', text.strip(), re.I)
    return found.group(1).lower() == 'true' if found else None


def read_only(r, command):
    data = re.fullmatch(r'data get entity [A-Za-z0-9_]{1,16} (Dimension|Pos|Health|foodLevel|playerGameType|Inventory|active_effects|UUID)', command)
    advance = re.fullmatch(r'execute if entity @a\[name=[A-Za-z0-9_]{1,16},advancements=\{minecraft:end/kill_dragon=true\}\]', command)
    rule = command in {'gamerule minecraft:' + name for name in RULES}
    score = re.fullmatch(r'scoreboard players get [A-Za-z0-9_]{1,16} fullrun_deaths', command)
    if not (data or advance or rule or score):
        raise ValueError('FULLRUN_MONITOR_WRITE_REFUSED')
    return r.cmd(command)


def snapshot(r):
    name = trials.BODY
    raw = {key: read_only(r, f'data get entity {name} {key}') for key in
           ('Dimension', 'Pos', 'Health', 'foodLevel', 'playerGameType', 'Inventory', 'active_effects')}
    advance = read_only(r, f'execute if entity @a[name={name},advancements={{{ADVANCEMENT}=true}}]')
    earned = True if 'Test passed' in advance else False if 'Test failed' in advance else None
    return {'at': trials.now_iso(), 'raw': raw, 'killAdvancement': earned, 'advancementReply': advance}


def initial_gate(s):
    raw = s['raw']
    # Fresh world: never erase an unexpected item/effect/advancement to make this pass.
    return {'overworld': '"minecraft:overworld"' in raw['Dimension'],
            'survival': re.search(r':\s*0\s*$', raw['playerGameType']) is not None,
            'emptyInventory': re.search(r':\s*\[\]\s*$', raw['Inventory']) is not None,
            'noEffects': re.search(r':\s*\[\]\s*$', raw['active_effects']) is not None
                         or 'Found no elements matching' in raw['active_effects'],
            'noOldKill': s['killAdvancement'] is False,
            'healthKnown': re.search(r':\s*(?:[1-9]\d*(?:\.\d+)?|0\.\d+)f\s*$', raw['Health']) is not None,
            'positionKnown': len(re.findall(r'-?\d+(?:\.\d+)?d', raw['Pos'])) == 3}


def final_gate(task_id, native, state, deadline_ms):
    """Neither advancement alone nor a task-complete/enter-End signal can prove this original request."""
    try:
        stamp = dt.datetime.fromisoformat(native['evidence']['boss']['witness']['observedAt'].replace('Z', '+00:00'))
        before_deadline = stamp.tzinfo is not None and stamp.timestamp()*1000 <= deadline_ms
    except (KeyError, TypeError, AttributeError, ValueError):
        before_deadline = False
    return (isinstance(native, dict) and before_deadline and native.get('deadlineMs') == deadline_ms
            and native.get('verified') is True and native.get('taskId') == task_id
            and native.get('expected', {}).get('taskId') == task_id
            and native.get('expected', {}).get('goal') == GOAL
            and native.get('evidence', {}).get('taskId') == task_id
            and native.get('evidence', {}).get('boss', {}).get('verified') is True
            and state.get('killAdvancement') is True)


class SonnetRig(rig.Rig):
    def head_entry(self):
        return 'scripts/minecraft-fullrun.ts'

    def head_environment(self):
        return {'FULLRUN_PROFILE': 'natural-sonnet-v1', 'FULLRUN_DEADLINE': str(self.args.deadline_ms),
                'FULLRUN_BODY_REV': self.args.body_revision, **getattr(self.args, 'retained_head_environment', {})}

    def body_entry(self):
        return 'scripts/lab/sonnet-fullrun-body-run.ts'

    def body_environment(self):
        return {'SHANNON_BODY_REV': self.args.body_revision}

    def check_models(self):
        expected = {**dict.fromkeys(('main', 'plan', 'summary', 'redecide'), MODEL), 'escalate': None}
        if not isinstance(self.models, dict) or any(self.models.get(k, 'missing') != v for k, v in expected.items()):
            raise trials.Stop('FULLRUN_MODELS: all paid roles must be fixed Sonnet, escalation none')

    def stop(self):
        # Keep expensive natural-world progress; reuse the full existing process/drain/reader cleanup.
        # Server save/stop runs only after mission input is stopped, never as a gameplay intervention.
        lab = self.lab
        original = lab.stop if lab else None
        if lab:
            lab.stop = lambda remove=True, fast=True: original(remove=False, fast=False)
        try:
            return super().stop()
        finally:
            if lab:
                lab.stop = original


def plan(args):
    return {'profile': 'natural-sonnet-v1', 'goal': GOAL, 'models': {**dict.fromkeys(('main', 'plan', 'summary', 'redecide'), MODEL), 'escalate': None},
            'capYen': CAP, 'priorYen': PRIOR, 'remainingYen': REMAINING, 'yenPerUsd': 160, 'maxSeconds': MAX_SECONDS,
            'maxRuns': 1, 'seed': args.seed, 'freshWorld': True, 'start': {'time': 0, 'give': {}, 'naturalSpawn': True},
            'timedOperatorWrites': 0, 'success': 'original task native proof AND new actual kill advancement',
            'api': None if args.run else 0, 'minecraft': None if args.run else 0,
            'credentialReads': None if args.run else 0, 'runRequested': args.run}


def execute(args, continuation=None):
    # Refuse active paths and absent external guards before starting anything or opening a credential file.
    if not os.environ.get('LAB_SLOT') or not os.environ.get('LAB_PORT') or not os.environ.get('MINEBOT_LAB_SCRATCH'):
        raise ValueError('FULLRUN_REQUIRES_SLOT_ALLOCATOR')
    args.port_from = args.port_to = int(os.environ['LAB_PORT'])
    folder = Path(args.directory).resolve()
    private_root = Path('/home/azureuser/.cache/minebot-lab/sonnet')
    if folder == private_root or not folder.is_relative_to(private_root):
        raise ValueError('FULLRUN_PRIVATE_RESULT_DIRECTORY')
    if continuation:
        continuation.approve(args)
    prior = continuation.prior if continuation else PRIOR
    remaining = continuation.remaining if continuation else REMAINING
    folder.mkdir(parents=True, exist_ok=True)
    marker = folder / 'one-shot.json'
    with marker.open('x') as out:
        json.dump({'startedAt': trials.now_iso(), 'status': 'unreconciled', 'maxRuns': 1}, out)
    manifest = read(args.pins)
    if not manifest or manifest.get('profile') != (continuation.name if continuation else 'natural-sonnet-v1'):
        raise ValueError('FULLRUN_PINS_REQUIRED')
    for field in ('fullSourceArchiveSha256', 'fullSourceManifestSha256'):
        if not re.fullmatch(r'[a-f0-9]{64}', str(manifest['head'].get(field, ''))):
            raise ValueError('FULLRUN_WHOLE_HEAD_SOURCE_PIN_REQUIRED')
    if not re.fullmatch(r'[a-f0-9]{64}', str(manifest['body'].get('fullSourceArchiveSha256', ''))):
        raise ValueError('FULLRUN_WHOLE_SOURCE_ARCHIVE_PIN_REQUIRED')
    if not re.fullmatch(r'[a-f0-9]{64}', str(manifest['body'].get('fullSourceManifestSha256', ''))) \
            or manifest['body'].get('fullSourceFiles') != len(manifest['body'].get('files', {})):
        raise ValueError('FULLRUN_WHOLE_SOURCE_MANIFEST_REQUIRED')
    args.body_revision = manifest['body'].get('commit')
    if not isinstance(args.body_revision, str) or not re.fullmatch(r'[a-f0-9]{40}', args.body_revision):
        raise ValueError('FULLRUN_BODY_REVISION_REQUIRED')
    counts = {key: verify_pin(getattr(args, key + '_pin'), manifest[key]) for key in ('head', 'body')}
    if not manifest['body'].get('adapterFiles') or not manifest['body'].get('dependencyFiles'):
        raise ValueError('FULLRUN_PRIVATE_DEPENDENCY_PREFLIGHT_REQUIRED')
    for name in ('head_pin', 'body_pin'):
        p = str(Path(getattr(args, name)).resolve())
        if '/Shannon-' not in p or not p.startswith('/home/azureuser/'):
            raise ValueError('FULLRUN_PRIVATE_PIN_PATH')
    if Path(args.head_pin).resolve() == Path(args.body_pin).resolve():
        raise ValueError('FULLRUN_DISTINCT_PINS')
    # No configuration values or keys read by this Python process. Only the isolated head receives the explicit file path.
    started = time.monotonic()
    args.deadline_ms = int(time.time() * 1000) + MAX_SECONDS * 1000
    args.model, args.llm_model, args.keep, args.capture_first_payload = 'real', MODEL, True, False
    section = {'id': 'FULL', 'name': GOAL}
    machine = continuation.machine(args, section) if continuation else SonnetRig(args, section, 'natural', 'sonnet-one', None, {'seed': args.seed})
    machine.dir = str(folder / 'rig')
    if len(str(folder / 'rig/head/operator-runtime/operator.sock').encode()) >= 108:
        raise ValueError('FULLRUN_SOCKET_PATH_TOO_LONG')
    result = {'ok': False, 'reason': 'setup', 'profile': continuation.plan(args) if continuation else plan(args),
              'pinCounts': counts, 'operatorWrites': [], 'taskId': None}
    lab_path = Path(rig.seedscan.ROOT) / ('rig-' + machine.label)
    if lab_path.exists() or lab_path.is_symlink() or Path(machine.dir).exists() or Path(machine.dir).is_symlink():
        raise ValueError('FULLRUN_REQUIRES_NEW_WORLD_AND_DATABASE')
    original_ensure = rig.ensure_body
    def ensure_private_body(body_pin):
        backend, definition = prepare_body_adapter(args.head_pin, body_pin, manifest['body'], args.body_node)
        save(Path(machine.dir)/'goal-evidence-definition.json', definition)
        return backend
    try:
        rig.ensure_body = ensure_private_body
        try:
            machine.start()
        finally:
            rig.ensure_body = original_ensure
        machine.check_models()
        result['reportedBody'] = machine.ready.get('bodyHandshake')
        if not result['reportedBody'] or result['reportedBody'].get('ok') is not True:
            raise ValueError('FULLRUN_BODY_HANDSHAKE_REQUIRED')
        if any((Path(machine.lab.dir) / 'mods').glob('*.jar')):
            raise ValueError('FULLRUN_MODS_NOT_EMPTY')
        if read(Path(machine.lab.dir) / 'ops.json') != []:
            raise ValueError('FULLRUN_OPERATOR_LIST_NOT_EMPTY')
        if list((Path(machine.lab.dir) / 'world/datapacks').glob('*')):
            raise ValueError('FULLRUN_DATAPACKS_NOT_EMPTY')
        result['worldProof'] = {'freshWorld': continuation is None,
                                'worldFrom': str(continuation.world) if continuation else None,
                                'retainedSelfEarned': continuation is not None,
                                'modsEmpty': True, 'opsEmpty': True,
                                'datapacksEmpty': True, 'difficulty': machine.lab.difficulty,
                                'monsters': machine.lab.monsters, 'viewDistance': machine.lab.view,
                                'simulationDistance': machine.lab.simulation}
        # Fresh Lab does not copy template world/server.properties/mods/ops. All rules are read and recorded, not guessed.
        r = trials.Rcon()
        try:
            rules = {name: strict_bool(read_only(r, 'gamerule minecraft:' + name)) for name in RULES}
            result['rules'] = rules
            if any(rules[name] is not value for name, value in RULES.items()):
                raise ValueError('FULLRUN_VANILLA_RULES_NOT_CONFIRMED')
            # Only pre-mission changes: initial daytime and a death-count measurement objective. No heal/clear/TP/supply.
            for command in (() if continuation else ('time set 0', 'scoreboard objectives add fullrun_deaths deathCount')):
                reply = r.cmd(command)
                result['operatorWrites'].append({'beforeMission': True, 'command': command, 'reply': reply})
            state = snapshot(r)
            if continuation:
                state['raw']['UUID'] = read_only(r, f'data get entity {trials.BODY} UUID')
                state['deathReply'] = read_only(r, f'scoreboard players get {trials.BODY} fullrun_deaths')
            checks = continuation.initial_gate(state) if continuation else initial_gate(state)
            result['initial'] = state
            result['initialGate'] = checks
            save(folder / 'initial.json', result)
            if not all(checks.values()):
                raise ValueError('FULLRUN_NATURAL_SPAWN_NOT_CONFIRMED')
        finally:
            r.close()
        minutes = max(1, math.floor((MAX_SECONDS - (time.monotonic() - started)) / 60))
        request = trials.ops('request', '--max-minutes', str(minutes), '--budget-yen', str(remaining), GOAL)
        task_id = request.get('taskId')
        if request.get('outcome') != 'accepted' or not task_id:
            raise ValueError('FULLRUN_REQUEST_REFUSED')
        result['taskId'] = task_id
        row = trials.task_row(task_id) or {}
        if row.get('goal') != GOAL:
            raise ValueError('FULLRUN_ORIGINAL_GOAL_MISMATCH')
        save(folder / 'mission.json', {'taskId': task_id, 'goal': GOAL, 'deadlineMs': args.deadline_ms, 'start': state})
        while True:
            elapsed = time.monotonic() - started
            r = trials.Rcon()
            try:
                state = snapshot(r)
                state['deathReply'] = read_only(r, f'scoreboard players get {trials.BODY} fullrun_deaths')
            finally:
                r.close()
            native = read(folder / 'rig/native-verdict.json')
            row = trials.task_row(task_id) or {}
            result.update(elapsed=round(elapsed, 3), final=state, native=native, task=row)
            result['ok'] = bool(final_gate(task_id, native, state, args.deadline_ms))
            save(folder / 'progress.json', result)
            if result['ok']:
                result['reason'] = 'native_original_task_kill'
                break
            if (folder / 'rig/rig.stop').exists() or trials.stop_requested():
                result['reason'] = 'stop_or_budget_or_unknown'
                break
            if elapsed >= MAX_SECONDS:
                result['reason'] = 'time_limit'
                break
            if row.get('status') in trials.FINISHED or trials.settled(row):
                result['reason'] = 'task_ended_without_native_kill'
                break
            if machine.head.poll() is not None or machine.body.poll() is not None:
                result['reason'] = 'process_ended'
                break
            time.sleep(2)
    except BaseException as error:
        result.update(ok=False, reason=type(error).__name__ + ':' + str(error)[:100])
    finally:
        machine.stop()  # existing stop: body, head accept-stop/driver-close/model-drain/final usage, readers, private world.
        result['accounting'] = machine.accounting()
        result['transport'] = read(folder / 'rig/transport-final.json') or read(folder / 'rig/transport-ledger.json')
        result['nativeAfterDrain'] = read(folder / 'rig/native-verdict.json')  # late raw kill proof remains visible, never granted a later deadline
        try:
            result['databaseBudget'] = private_database_budget(Path(machine.dir)/'head/shannon.db')
        except (OSError, ValueError, sqlite3.Error):
            result['databaseBudget'] = None
            result['databaseAccounting'] = 'unknown'
        if result['accounting']['status'] != 'complete' or not result['transport'] or result['transport'].get('complete') is not True:
            result.update(ok=False, accountingStatus='unknown')
        if result['databaseBudget'] is None or result['databaseBudget']['estimatedYen'] > 0:
            result.update(ok=False, accountingStatus='unknown')
        result['inferenceCalls'] = machine.calls
        result['countCalls'] = (result.get('transport') or {}).get('countCalls', 0)
        transport = result.get('transport') or {}
        known_floor = max(result['accounting']['usageYen'], math.ceil(160 * (transport.get('spentUsd', 0) + transport.get('reservedUsd', 0))))
        result['cumulativeBookedYen'] = prior + max(known_floor, result['databaseBudget']['usedYen']) if result['databaseBudget'] is not None else None
        result['cumulativeKnownFloorYen'] = prior + known_floor
        result['costInterpretation'] = 'known usage only' if result.get('accountingStatus') != 'unknown' else 'unknown reservations retained; not an observed invoice'
        result['worldKept'] = bool(machine.lab and Path(machine.lab.dir).is_dir())
        result['worldDirectory'] = machine.lab.dir if machine.lab else None  # private host path, no server.properties/password export
        if continuation:
            continuation.finish(result, machine)
        save(folder / 'report.json', result)
        save(marker, {'status': 'finished-no-retry', 'ok': result['ok'], 'reason': result['reason'], 'accounting': result['accounting']})
    return 0 if result['ok'] else 1


def main(argv=None, continuation=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='explicit one-shot execution; default is offline plan')
    parser.add_argument('--directory', required=True)
    parser.add_argument('--pins', required=True)
    parser.add_argument('--head-pin', required=True)
    parser.add_argument('--body-pin', required=True)
    parser.add_argument('--env-file', required=True, help='path only; never opened in offline plan')
    parser.add_argument('--seed', default='0')
    parser.add_argument('--node', default=trials.NODE)
    parser.add_argument('--body-node', default='/home/azureuser/.nvm/versions/node/v22.21.1/bin/node')
    parser.add_argument('--heap', default='2G')
    parser.add_argument('--cores', type=int, default=2)
    parser.add_argument('--port-from', type=int, default=25590)
    parser.add_argument('--port-to', type=int, default=25590)
    parser.add_argument('--ready-seconds', type=int, default=180)
    if continuation:
        parser.add_argument('--root-approval', required=True, help='owned private explicit a2 approval; never a model/tool argument')
    args = parser.parse_args(argv)
    if not args.run:
        print(json.dumps(continuation.plan(args) if continuation else plan(args), ensure_ascii=False))
        return 0
    def stop_signal(_number, _frame):
        raise KeyboardInterrupt('operator_signal')
    signal.signal(signal.SIGTERM, stop_signal)
    signal.signal(signal.SIGINT, stop_signal)
    return execute(args, continuation) if continuation else execute(args)


if __name__ == '__main__':
    raise SystemExit(main())
