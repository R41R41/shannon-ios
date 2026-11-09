#!/usr/bin/env python3
"""Explicit root-approved a2, from a stopped self-earned a1 world. Default: offline plan only."""
from pathlib import Path
import gzip
import hashlib
import json
import math
import os
import re
import stat
import struct
import sys
import uuid
from types import MappingProxyType

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sonnet_fullrun as base

PROFILE = 'retained-self-earned-sonnet-v1'
PRIVATE = Path('/home/azureuser/.cache/minebot-lab')
SOURCE_WORLD = PRIVATE/'seedscan/rig-sonnet-one-sFULL-natural/world'
SOURCE_RESULT = PRIVATE/'sonnet/a1'
BODY_COMMIT = 'dc195f796a40092528d7882de4d9d7d380ff7115'
PRIOR, ADDITIONAL, CAP, RESERVE = 881, 4000, 4881, 9600
A2 = MappingProxyType({'attempt': 'a2', 'sourceAttempt': 'a1', 'profile': PROFILE, 'prior': PRIOR, 'additional': ADDITIONAL})
A3_PROFILE = 'retained-self-earned-sonnet-a3-v1'
A3 = MappingProxyType({'attempt': 'a3', 'sourceAttempt': 'a2', 'profile': A3_PROFILE, 'prior': 1919, 'additional': 2962})
A3_SOURCE_WORLD = PRIVATE/'seedscan/rig-sonnet-a2-sFULL-retained/world'
A3_SOURCE_RESULT = PRIVATE/'sonnet/a2'
A2_TOOL = PRIVATE/'sonnet-a2-stage-90b5fcc0-20261105/preflight-tools/sonnet-a2'
A1_TOOL = PRIVATE/'sonnet-stage-headdeps-ba459-20261105/preflight-tools/sonnet-launch'
A2_REPORT_SHA = 'ee3dd6430fea26c26f4c5089c95d7d4827b7faf99592de937e5355d1f8340572'
A2_RECONCILIATION_SHA = '6b2774a84c0a79c80694cfe94f7b1137097e6170488890376baa77c2885a95e3'
A2_WORLD_TREE_SHA = '37aaa6118d3058ad37e3e79cb6d899a151aa30e06150c5c41d466b9a93e541c4'
A2_HEAD = '90b5fcc0a1c1645ec6d4a1798a4b99928eca70f3'
PLAYER_UUID = '289e7388-a54c-3c67-9d68-61a45cf660ba'
A1_MANIFEST_SHA = 'bec8958f5a63b2efbb14f921feb55ca0c2f636d44f0b87f8dfa2ecdb371839a8'
A2_APPROVAL_SHA = '53532943bea4aec3c07653a7e154166cc080b189d4e31f1639ad1052be9cb48e'
A1_APPROVAL_SHA = 'b26c0ef9be8f65e6ec6974757a619867a0325befd251d506c07c39f4cf00b23c'


def fixed_descriptor(value):
    if value is not A2 and value is not A3:
        raise ValueError('RETAINED_FIXED_ATTEMPT_REQUIRED')
    return value


def private_json(path, expected_sha=None):
    path = Path(path)
    real = path.resolve(strict=True)
    st = path.lstat()
    if (not real.is_relative_to(PRIVATE) or not stat.S_ISREG(st.st_mode) or path.is_symlink()
            or st.st_uid != os.getuid() or st.st_mode & 0o077):
        raise ValueError('RETAINED_PRIVATE_APPROVAL_FILE')
    if expected_sha is not None and base.sha(path) != expected_sha:
        raise ValueError('RETAINED_APPROVAL_HASH')
    return json.loads(path.read_text())


def tree_files(world):
    """A bounded saved-world read; copytree's sole ignored basename is session.lock."""
    root = Path(world)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('RETAINED_WORLD_DIRECTORY')
    files = []
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('RETAINED_WORLD_SYMLINK')
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError('RETAINED_WORLD_SPECIAL_FILE')
        if path.name == 'session.lock':
            continue
        files.append({'path': path.relative_to(root).as_posix(), 'bytes': path.stat().st_size,
                      'sha256': base.sha(path)})
    return files


def tree_sha(files):
    return hashlib.sha256(json.dumps(files, separators=(',', ':'), sort_keys=True).encode()).hexdigest()


def saved_player(world):
    identity = uuid.UUID(bytes=hashlib.md5(('OfflinePlayer:'+base.trials.BODY).encode()).digest(), version=3)
    path = Path(world)/'playerdata'/f'{identity}.dat'
    value = base.trials.nbt_read(gzip.decompress(path.read_bytes()))
    ints = list(struct.unpack('>4i', identity.bytes))
    advancement = base.read(Path(world)/'advancements'/f'{identity}.json')
    if (value.get('UUID') != ints or not isinstance(advancement, dict)
            or advancement.get(base.ADVANCEMENT, {}).get('done') is True):
        raise ValueError('RETAINED_SAVED_PLAYER_IDENTITY_OR_OLD_KILL')
    return {'uuid': str(identity), 'uuidIntArray': ints, 'playerFileSha256': base.sha(path),
            'dimension': value.get('Dimension'), 'position': value.get('Pos'),
            'health': value.get('Health'), 'food': value.get('foodLevel'),
            'inventory': [{'id': item.get('id'), 'count': item.get('count', item.get('Count')),
                           'slot': item.get('Slot')} for item in value.get('Inventory', [])],
            'oldKillAdvancement': False}


def approved_policy(value, pins, pins_sha, descriptor=A2):
    spec = fixed_descriptor(descriptor)
    target_body = BODY_COMMIT if spec is A2 else pins.get('body', {}).get('commit')
    exact = {
        'rootApproved': True, 'attempt': spec['attempt'], 'profile': spec['profile'],
        'priorBookedYen': spec['prior'], 'additionalCapYen': spec['additional'], 'globalCapYen': CAP,
        'productionReserveYen': RESERVE, 'maxSeconds': base.MAX_SECONDS,
        'sourceAttempt': spec['sourceAttempt'], 'sourceClosedCumulativeBookedYen': spec['prior'],
        'otherPaidLanesStopped': True, 'noAutomaticRetry': True,
        'headCommit': pins.get('head', {}).get('commit'), 'bodyCommit': target_body,
        'pinsSha256': pins_sha,
    }
    if spec is A3:
        exact.update(sourceReportSha256=A2_REPORT_SHA, sourceReconciliationSha256=A2_RECONCILIATION_SHA,
                     sourceWorldTreeSha256=A2_WORLD_TREE_SHA, sourcePlayerUuid=PLAYER_UUID)
    if not isinstance(value, dict) or any(type(value.get(key)) is not type(wanted) or value.get(key) != wanted
                                          for key, wanted in exact.items()):
        raise ValueError('RETAINED_ROOT_APPROVAL_POLICY')
    for key in ('sourceWorldManifestSha256', 'sourceWorldTreeSha256'):
        if not re.fullmatch(r'[a-f0-9]{64}', str(value.get(key, ''))):
            raise ValueError('RETAINED_ROOT_APPROVAL_SOURCE_HASH')
    if (pins.get('profile') != spec['profile'] or pins.get('body', {}).get('commit') != target_body
            or not re.fullmatch(r'[a-f0-9]{40}', str(target_body))
            or not re.fullmatch(r'[a-f0-9]{40}', str(exact['headCommit']))):
        raise ValueError('RETAINED_ROOT_APPROVAL_PINS')
    if value.get('expectedDimension') not in ('overworld', 'the_nether', 'the_end'):
        raise ValueError('RETAINED_ROOT_APPROVAL_DIMENSION')
    return value


class RetainedRig(base.SonnetRig):
    def start(self):
        original = base.rig.seedscan.Lab
        profile = self.args.retained_profile

        class VerifiedCopyLab(original):
            def prepare(self):
                profile.verify_source()
                if Path(self.world_from).resolve() != profile.world:
                    raise ValueError('RETAINED_WORLD_FROM_MISMATCH')
                if (Path(self.dir)/'world').exists() or (Path(self.dir)/'world').is_symlink():
                    raise ValueError('RETAINED_COPY_TARGET_ALREADY_EXISTS')
                super().prepare()
                copied = tree_files(Path(self.dir)/'world')
                if copied != profile.source['files']:
                    raise ValueError('RETAINED_WORLD_COPY_HASH')
                for row in copied:
                    if os.path.samefile(profile.world/row['path'], Path(self.dir)/'world'/row['path']):
                        raise ValueError('RETAINED_WORLD_SHARED_INODE')
                profile.verify_source()
                self.retained_copy_proof = {'beforeServerStart': True, 'files': len(copied),
                                           'treeSha256': tree_sha(copied), 'distinctInodes': True}

        # This isolated CLI owns one rig. Restore the legacy factory even when startup fails.
        base.rig.seedscan.Lab = VerifiedCopyLab
        try:
            return super().start()
        finally:
            base.rig.seedscan.Lab = original


class RetainedProfile:
    name, prior, remaining = PROFILE, PRIOR, ADDITIONAL

    def __init__(self, descriptor=A2):
        self.descriptor = fixed_descriptor(descriptor)
        self.name, self.prior, self.remaining = descriptor['profile'], descriptor['prior'], descriptor['additional']

    def source_world(self):
        return SOURCE_WORLD if self.descriptor is A2 else A3_SOURCE_WORLD

    def plan(self, args):
        return {'profile': self.name, 'goal': base.GOAL, 'models': {
            **dict.fromkeys(('main', 'plan', 'summary', 'redecide'), base.MODEL), 'escalate': None},
            'capYen': CAP, 'priorYen': self.prior, 'remainingYen': self.remaining,
            'productionReserveYen': RESERVE, 'yenPerUsd': 160, 'maxSeconds': base.MAX_SECONDS,
            'maxRuns': 1, 'freshWorld': False, 'retainedSelfEarned': True, 'sourceAttempt': self.descriptor['sourceAttempt'],
            'sourceWorld': str(self.source_world()), 'newDatabase': True, 'newOriginalTask': True,
            'setupOperatorWrites': 0, 'timedOperatorWrites': 0, 'inheritOldKillWitness': False,
            'success': 'original task native proof AND new actual kill advancement; bed-credit audit retained',
            'freshZeroStartThreeHourClaim': False,
            'api': None if args.run else 0, 'minecraft': None if args.run else 0,
            'credentialReads': None if args.run else 0, 'runRequested': args.run}

    def approve(self, args):
        pins = base.read(args.pins)
        if not isinstance(pins, dict):
            raise ValueError('RETAINED_PINS_REQUIRED')
        self.approval = approved_policy(private_json(args.root_approval), pins, base.sha(args.pins), self.descriptor)
        source_path = self.approval.get('sourceWorldManifest')
        self.source_path = Path(source_path)
        self.source = private_json(source_path, self.approval['sourceWorldManifestSha256'])
        source_world = self.source_world()
        self.world = source_world.resolve(strict=True)
        expected = {'schema': 1, 'profile': 'retained-self-earned-source-v1', 'attempt': self.descriptor['sourceAttempt'],
                    'sourceWorld': str(source_world), 'sourceStopped': True, 'accountingComplete': True,
                    'cumulativeBookedYen': self.prior, 'originalFreshVanillaC1': True,
                    'initialGatePassed': True, 'oldKillAdvancement': False,
                    'sourceBodyCommit': BODY_COMMIT}
        if self.descriptor is A3:
            expected.update(sourceHeadCommit=A2_HEAD, sourcePlayerUuid=PLAYER_UUID)
        if (self.world != source_world or source_world.is_symlink()
                or any(self.source.get(key) != wanted for key, wanted in expected.items())
                or self.source.get('treeSha256') != self.approval['sourceWorldTreeSha256']):
            raise ValueError('RETAINED_SELF_EARNED_SOURCE_PROVENANCE')
        self.verify_records()
        self.verify_source()
        self.saved_player = saved_player(self.world)
        if self.descriptor is A3 and self.saved_player['uuid'] != PLAYER_UUID:
            raise ValueError('RETAINED_SAVED_PLAYER_IDENTITY_OR_OLD_KILL')
        if self.saved_player['dimension'] != 'minecraft:'+self.approval['expectedDimension']:
            raise ValueError('RETAINED_SAVED_DIMENSION_MISMATCH')
        args.retained_profile = self
        args.retained_head_environment = {
            'FULLRUN_PROFILE': self.name, 'FULLRUN_ROOT_APPROVAL': str(Path(args.root_approval).resolve()),
            'FULLRUN_APPROVAL_SHA256': base.sha(args.root_approval),
            'FULLRUN_HEAD_REV': pins['head']['commit'], 'FULLRUN_PINS_SHA256': base.sha(args.pins)}

    def verify_records(self):
        if self.descriptor is A3:
            return self.verify_a3_records()
        records = self.source.get('records', {})
        result_records = ('report.json', 'initial.json', 'mission.json', 'one-shot.json')
        for name in result_records:
            record = records.get(name, {})
            if record.get('path') != str(SOURCE_RESULT/name) or base.sha(record['path']) != record.get('sha256'):
                raise ValueError('RETAINED_SOURCE_RECORD_HASH')
        launch = PRIVATE/'sonnet-stage-headdeps-ba459-20261105/preflight-tools/sonnet-launch/launch-evidence/a1'
        for name in ('inside-postflight.json', 'outer-postflight.json'):
            record = records.get(name, {})
            if record.get('path') != str(launch/name) or base.sha(record['path']) != record.get('sha256'):
                raise ValueError('RETAINED_SOURCE_POSTFLIGHT_HASH')
        report = base.read(SOURCE_RESULT/'report.json')
        outer = base.read(launch/'outer-postflight.json')
        if (not report or report.get('cumulativeBookedYen') != PRIOR or report.get('accountingStatus') == 'unknown'
                or report.get('accounting', {}).get('status') != 'complete'
                or report.get('transport', {}).get('complete') is not True
                or report.get('transport', {}).get('pending') != 0
                or report.get('databaseBudget', {}).get('estimatedYen') != 0
                or report.get('worldKept') is not True
                or report.get('worldProof', {}).get('freshWorld') is not True
                or report.get('worldProof', {}).get('worldFrom') is not None
                or not outer or outer.get('accountingUnknown') is not False
                or outer.get('knownProcesses') != [] or any(outer.get('ports', {}).values())):
            raise ValueError('RETAINED_SOURCE_NOT_CLOSED')
        initial = base.read(SOURCE_RESULT/'initial.json')
        if (not initial or not initial.get('initialGate') or not all(initial['initialGate'].values())
                or not all(base.initial_gate(initial.get('initial', {})).values())):
            raise ValueError('RETAINED_SOURCE_NOT_ORIGINAL_NATURAL')
        dim = re.search(r'"minecraft:([a-z_]+)"', report.get('final', {}).get('raw', {}).get('Dimension', ''))
        if (not dim or dim.group(1) != self.approval['expectedDimension']
                or report.get('final', {}).get('killAdvancement') is not False):
            raise ValueError('RETAINED_SOURCE_STATE_NOT_CONFIRMED')

    def verify_a3_records(self):
        records = self.source.get('records', {})

        def record(name, path, expected_sha=None, table=records):
            row = table.get(name, {})
            if (row.get('path') != str(path) or not re.fullmatch(r'[a-f0-9]{64}', str(row.get('sha256', '')))
                    or expected_sha is not None and row.get('sha256') != expected_sha):
                raise ValueError('RETAINED_SOURCE_RECORD_HASH')
            return private_json(path, row.get('sha256'))

        report = record('report.json', A3_SOURCE_RESULT/'report.json', A2_REPORT_SHA)
        initial = record('initial.json', A3_SOURCE_RESULT/'initial.json')
        record('mission.json', A3_SOURCE_RESULT/'mission.json')
        record('one-shot.json', A3_SOURCE_RESULT/'one-shot.json')
        launch = A2_TOOL/'launch-evidence/a2'
        record('inside-postflight.json', launch/'inside-postflight.json')
        outer = record('outer-postflight.json', launch/'outer-postflight.json')
        approved = record('root-approval-a2.json', A2_TOOL/'root-approval-a2.json', A2_APPROVAL_SHA)
        old_pins = private_json(A2_TOOL/'pins-final-90b5fcc0-dc195f79-a2.json', approved.get('pinsSha256'))
        approved_policy(approved, old_pins, approved.get('pinsSha256'))
        if approved.get('headCommit') != A2_HEAD or approved.get('sourceWorldManifestSha256') != A1_MANIFEST_SHA:
            raise ValueError('RETAINED_A2_ROOT_LINEAGE')
        ancestor = record('a1-source-manifest.json', A2_TOOL/'a1-world-source-manifest.json', A1_MANIFEST_SHA)
        reconciliation = record('reconciliation.json', self.source_path.parent/'a2-final-reconciliation.json', A2_RECONCILIATION_SHA)
        cost = reconciliation.get('cost', {})
        if (reconciliation.get('status') != 'reconciled' or not reconciliation.get('checks')
                or any(value is not True for value in reconciliation['checks'].values())
                or cost.get('cumulativeBookedYen') != 1919 or cost.get('unallocatedRemainingYen') != 2962
                or cost.get('productionReserveYen') != RESERVE
                or reconciliation.get('privateDb', {}).get('unsettledEstimatedYen') != 0):
            raise ValueError('RETAINED_A2_RECONCILIATION')
        if (report.get('cumulativeBookedYen') != 1919 or report.get('accountingStatus') == 'unknown'
                or report.get('accounting', {}).get('status') != 'complete'
                or report.get('transport', {}).get('complete') is not True or report['transport'].get('pending') != 0
                or report.get('databaseBudget', {}).get('estimatedYen') != 0 or report.get('worldKept') is not True
                or report.get('operatorWrites') != [] or report.get('reportedBody', {}).get('ok') is not True
                or outer.get('accountingUnknown') is not False or outer.get('knownProcesses') != []
                or any(outer.get('ports', {}).values()) or outer.get('service', {}).get('state') != 'inactive'
                or len(outer.get('locks', {})) != 4 or any(v != 'free_at_postflight' for v in outer['locks'].values())):
            raise ValueError('RETAINED_SOURCE_NOT_CLOSED')
        world = report.get('worldProof', {})
        link = report.get('continuation', {})
        copy = link.get('copyProof', {})
        if (world.get('freshWorld') is not False or world.get('retainedSelfEarned') is not True
                or world.get('worldFrom') != str(SOURCE_WORLD)
                or any(world.get(key) is not True for key in ('modsEmpty', 'opsEmpty', 'datapacksEmpty'))
                or world.get('difficulty') != 'normal' or world.get('monsters') is not True
                or any(report.get('rules', {}).get(key) is not value for key, value in base.RULES.items())
                or link.get('sourceAttempt') != 'a1' or link.get('sourceWorldUnchanged') is not True
                or link.get('sourceWorldManifestSha256') != A1_MANIFEST_SHA
                or link.get('sourceWorldTreeSha256') != ancestor.get('treeSha256')
                or copy.get('treeSha256') != ancestor.get('treeSha256')
                or copy.get('beforeServerStart') is not True or copy.get('distinctInodes') is not True
                or copy.get('files') != len(ancestor.get('files', []))
                or self.source.get('treeSha256') != A2_WORLD_TREE_SHA or len(self.source.get('files', [])) != 40):
            raise ValueError('RETAINED_A2_COPY_LINEAGE')
        if (link.get('a1ElapsedAtLastMonitorSeconds') != 1198.271
                or link.get('a2ElapsedAtLastMonitorSeconds') != 1730.435
                or link.get('cumulativeElapsedAtLastMonitorsSeconds') != 2928.706
                or report.get('elapsed') != 1730.435):
            raise ValueError('RETAINED_SOURCE_CLOCKS')
        self.prior_monitors = {'a1ElapsedAtLastMonitorSeconds': link['a1ElapsedAtLastMonitorSeconds'],
                               'a2ElapsedAtLastMonitorSeconds': link['a2ElapsedAtLastMonitorSeconds']}
        dim = re.search(r'"minecraft:([a-z_]+)"', report.get('final', {}).get('raw', {}).get('Dimension', ''))
        if (not initial.get('initialGate') or not all(v is True for v in initial['initialGate'].values())
                or report.get('final', {}).get('killAdvancement') is not False
                or not dim or dim.group(1) != self.approval['expectedDimension']):
            raise ValueError('RETAINED_SOURCE_STATE_NOT_CONFIRMED')
        self.verify_natural_ancestor(ancestor, record)

    def verify_natural_ancestor(self, ancestor, record):
        if (ancestor.get('attempt') != 'a1' or ancestor.get('sourceWorld') != str(SOURCE_WORLD)
                or ancestor.get('sourceBodyCommit') != BODY_COMMIT
                or ancestor.get('originalFreshVanillaC1') is not True
                or ancestor.get('cumulativeBookedYen') != 881):
            raise ValueError('RETAINED_A1_NATURAL_LINEAGE')
        table = ancestor.get('records', {})
        report = record('report.json', SOURCE_RESULT/'report.json', table=table)
        initial = record('initial.json', SOURCE_RESULT/'initial.json', table=table)
        record('mission.json', SOURCE_RESULT/'mission.json', table=table)
        record('one-shot.json', SOURCE_RESULT/'one-shot.json', table=table)
        record('inside-postflight.json', A1_TOOL/'launch-evidence/a1/inside-postflight.json', table=table)
        outer = record('outer-postflight.json', A1_TOOL/'launch-evidence/a1/outer-postflight.json', table=table)
        root = private_json(A1_TOOL/'root-approval-a1.json', A1_APPROVAL_SHA)
        world = report.get('worldProof', {})
        if (root.get('rootApproved') is not True or root.get('attempt') != 'a1'
                or root.get('bodyCommit') != BODY_COMMIT or root.get('noAutomaticRetry') is not True
                or root.get('headCommit') != ancestor.get('sourceHeadCommit')
                or report.get('cumulativeBookedYen') != 881 or report.get('accountingStatus') == 'unknown'
                or report.get('accounting', {}).get('status') != 'complete'
                or report.get('transport', {}).get('complete') is not True or report['transport'].get('pending') != 0
                or report.get('databaseBudget', {}).get('estimatedYen') != 0 or report.get('worldKept') is not True
                or outer.get('accountingUnknown') is not False or outer.get('knownProcesses') != []
                or any(outer.get('ports', {}).values())
                or world.get('freshWorld') is not True or world.get('worldFrom') is not None
                or any(world.get(key) is not True for key in ('modsEmpty', 'opsEmpty', 'datapacksEmpty'))
                or world.get('difficulty') != 'normal' or world.get('monsters') is not True
                or any(report.get('rules', {}).get(key) is not value for key, value in base.RULES.items())
                or not initial.get('initialGate') or not all(initial['initialGate'].values())
                or not all(base.initial_gate(initial.get('initial', {})).values())):
            raise ValueError('RETAINED_A1_NATURAL_LINEAGE')

    def verify_source(self):
        session = self.world/'session.lock'
        if session.exists():
            info = session.stat()
            device = f'{os.major(info.st_dev):02x}:{os.minor(info.st_dev):02x}:{info.st_ino}'
            if any(device in row.split() for row in Path('/proc/locks').read_text().splitlines()):
                raise ValueError('RETAINED_SOURCE_WORLD_LOCKED')
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit():
                continue
            try:
                cwd = (proc/'cwd').resolve(strict=True)
            except (OSError, PermissionError):
                continue
            if cwd == self.world.parent or cwd.is_relative_to(self.world.parent):
                raise ValueError('RETAINED_SOURCE_WORLD_RUNNING')
        if tree_files(self.world) != self.source.get('files') or tree_sha(self.source['files']) != self.source['treeSha256']:
            raise ValueError('RETAINED_SOURCE_WORLD_CHANGED')

    def machine(self, args, section):
        # Seed is unused for an existing world; no pristine/facts/seed-selection input is copied to the head.
        return RetainedRig(args, section, 'retained', 'sonnet-'+self.descriptor['attempt'], str(self.world), {})

    def initial_gate(self, state):
        raw = state['raw']
        reported_uuid = re.search(r'\[I;\s*([^\]]+)\]', raw.get('UUID', ''))
        uuid_ints = [int(value) for value in re.findall(r'-?\d+', reported_uuid.group(1))] if reported_uuid else None
        return {'retainedDimension': f'"minecraft:{self.approval["expectedDimension"]}"' in raw['Dimension'],
                'sameSavedPlayer': uuid_ints == self.saved_player['uuidIntArray'],
                'survival': re.search(r':\s*0\s*$', raw['playerGameType']) is not None,
                'noOldKill': state['killAdvancement'] is False,
                'inventoryObserved': re.search(r':\s*\[.*\]\s*$', raw['Inventory'], re.S) is not None,
                'healthKnown': re.search(r':\s*(?:[1-9]\d*(?:\.\d+)?|0\.\d+)f\s*$', raw['Health']) is not None,
                'foodKnown': re.search(r':\s*(?:[0-9]|1[0-9]|20)\s*$', raw['foodLevel']) is not None,
                'positionKnown': len(re.findall(r'-?\d+(?:\.\d+)?d', raw['Pos'])) == 3}

    def finish(self, result, machine):
        source_unchanged = False
        try:
            self.verify_source()
            source_unchanged = True
        except (OSError, ValueError):
            result.update(ok=False, reason='retained_source_world_changed')
        prior_elapsed = (self.source.get('a1ElapsedAtLastMonitorSeconds') if self.descriptor is A2
                         else sum(self.prior_monitors.values()))
        current_elapsed = result.get('elapsed')
        known = all(isinstance(v, (int, float)) and math.isfinite(v) and v >= 0 for v in (prior_elapsed, current_elapsed))
        result['continuation'] = {'sourceAttempt': self.descriptor['sourceAttempt'], 'sourceWorldUnchanged': source_unchanged,
            'sourceWorldManifestSha256': self.approval['sourceWorldManifestSha256'],
            'sourceWorldTreeSha256': self.source['treeSha256'],
            'savedPlayerBaseline': getattr(self, 'saved_player', None),
            'copyProof': getattr(machine.lab, 'retained_copy_proof', None),
            'a1ElapsedAtLastMonitorSeconds': prior_elapsed, 'a2ElapsedAtLastMonitorSeconds': current_elapsed,
            'cumulativeElapsedAtLastMonitorsSeconds': prior_elapsed + current_elapsed if known else None,
            'elapsedInterpretation': 'both monotonic run monitor clocks include setup, exclude later drain',
            'freshZeroStartThreeHourClaim': False, 'productionReserveYen': RESERVE}
        if self.descriptor is A3:
            result['continuation'].update(self.prior_monitors)
            result['continuation'].update(a3ElapsedAtLastMonitorSeconds=current_elapsed,
                elapsedInterpretation='three monotonic run monitor clocks include setup, exclude later drain')


if __name__ == '__main__':
    raise SystemExit(base.main(continuation=RetainedProfile()))
