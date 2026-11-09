"""Synthetic sealed-record semantics. Real private-file/hash/NBT/copy guards stay covered by a2 tests."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import test_sonnet_retained as old

r = old.r


class A3Test(unittest.TestCase):
    def approval(self):
        return {**old.RetainedTest().approval(), 'attempt': 'a3', 'profile': r.A3_PROFILE,
            'priorBookedYen': 1919, 'additionalCapYen': 2962, 'sourceAttempt': 'a2',
            'sourceClosedCumulativeBookedYen': 1919, 'bodyCommit': 'e'*40,
            'sourceReportSha256': r.A2_REPORT_SHA, 'sourceReconciliationSha256': r.A2_RECONCILIATION_SHA,
            'sourceWorldTreeSha256': r.A2_WORLD_TREE_SHA, 'sourcePlayerUuid': r.PLAYER_UUID,
            'sourceWorldManifest': '/private/a2-source.json'}

    def pins(self):
        return {'profile': r.A3_PROFILE, 'head': {'commit': 'a'*40}, 'body': {'commit': 'e'*40}}

    def fixture(self):
        profile = r.RetainedProfile(r.A3)
        profile.approval = self.approval()
        profile.source_path = Path('/private/a2-source.json')
        values, digests = {}, {}
        def sealed(path, value, digest='f'*64):
            values[Path(path)] = value
            digests[Path(path)] = digest
            return {'path': str(path), 'sha256': digest}
        world = {'modsEmpty': True, 'opsEmpty': True, 'datapacksEmpty': True, 'difficulty': 'normal', 'monsters': True}
        closed = {'cumulativeBookedYen': 881, 'accounting': {'status': 'complete'},
                  'transport': {'complete': True, 'pending': 0}, 'databaseBudget': {'estimatedYen': 0}, 'worldKept': True}
        state = old.RetainedTest().state()
        state['raw'].update(Inventory='p: []', Health='p: 20.0f', foodLevel='p: 20')
        a1_report = {**deepcopy(closed), 'worldProof': {**world, 'freshWorld': True, 'worldFrom': None}, 'rules': dict(r.base.RULES)}
        a1_initial = {'initial': state, 'initialGate': r.base.initial_gate(state)}
        self.assertTrue(all(a1_initial['initialGate'].values()))
        free = {'accountingUnknown': False, 'knownProcesses': [], 'ports': {'25590': False, '26590': False},
                'service': {'state': 'inactive'}, 'locks': {str(i): 'free_at_postflight' for i in range(4)}}
        a1_records = {}
        for name, value in [('report.json', a1_report), ('initial.json', a1_initial), ('mission.json', {}), ('one-shot.json', {})]:
            a1_records[name] = sealed(r.SOURCE_RESULT/name, value)
        for name in ('inside-postflight.json', 'outer-postflight.json'):
            a1_records[name] = sealed(r.A1_TOOL/'launch-evidence/a1'/name, deepcopy(free))
        ancestor = {'attempt': 'a1', 'sourceWorld': str(r.SOURCE_WORLD), 'sourceBodyCommit': r.BODY_COMMIT,
                    'sourceHeadCommit': 'd'*40, 'originalFreshVanillaC1': True, 'cumulativeBookedYen': 881,
                    'treeSha256': 'a'*64, 'files': list(range(40)), 'records': a1_records}
        root_a1 = {'rootApproved': True, 'attempt': 'a1', 'bodyCommit': r.BODY_COMMIT,
                   'headCommit': 'd'*40, 'noAutomaticRetry': True}
        sealed(r.A1_TOOL/'root-approval-a1.json', root_a1, r.A1_APPROVAL_SHA)
        a2_approval = old.RetainedTest().approval()
        a2_approval.update(headCommit=r.A2_HEAD, sourceWorldManifestSha256=r.A1_MANIFEST_SHA)
        old_pins = {'profile': r.PROFILE, 'head': {'commit': r.A2_HEAD}, 'body': {'commit': r.BODY_COMMIT}}
        sealed(r.A2_TOOL/'pins-final-90b5fcc0-dc195f79-a2.json', old_pins, a2_approval['pinsSha256'])
        link = {'sourceAttempt': 'a1', 'sourceWorldUnchanged': True, 'sourceWorldManifestSha256': r.A1_MANIFEST_SHA,
                'sourceWorldTreeSha256': ancestor['treeSha256'], 'copyProof': {'treeSha256': ancestor['treeSha256'],
                'beforeServerStart': True, 'distinctInodes': True, 'files': 40},
                'a1ElapsedAtLastMonitorSeconds': 1198.271, 'a2ElapsedAtLastMonitorSeconds': 1730.435,
                'cumulativeElapsedAtLastMonitorsSeconds': 2928.706}
        report = {**deepcopy(closed), 'cumulativeBookedYen': 1919, 'operatorWrites': [], 'reportedBody': {'ok': True},
                  'worldProof': {**world, 'freshWorld': False, 'retainedSelfEarned': True, 'worldFrom': str(r.SOURCE_WORLD)},
                  'rules': dict(r.base.RULES), 'continuation': link, 'elapsed': 1730.435,
                  'final': {'killAdvancement': False, 'raw': {'Dimension': 'p: "minecraft:overworld"'}}}
        records = {}
        for name, value in [('report.json', report), ('initial.json', {'initialGate': {'sameSavedPlayer': True}}),
                            ('mission.json', {}), ('one-shot.json', {})]:
            records[name] = sealed(r.A3_SOURCE_RESULT/name, value, r.A2_REPORT_SHA if name == 'report.json' else 'f'*64)
        for name in ('inside-postflight.json', 'outer-postflight.json'):
            records[name] = sealed(r.A2_TOOL/'launch-evidence/a2'/name, deepcopy(free))
        records['root-approval-a2.json'] = sealed(r.A2_TOOL/'root-approval-a2.json', a2_approval, r.A2_APPROVAL_SHA)
        records['a1-source-manifest.json'] = sealed(r.A2_TOOL/'a1-world-source-manifest.json', ancestor, r.A1_MANIFEST_SHA)
        records['reconciliation.json'] = sealed(profile.source_path.parent/'a2-final-reconciliation.json',
            {'status': 'reconciled', 'checks': {'complete': True}, 'privateDb': {'unsettledEstimatedYen': 0},
             'cost': {'cumulativeBookedYen': 1919, 'unallocatedRemainingYen': 2962, 'productionReserveYen': 9600}},
            r.A2_RECONCILIATION_SHA)
        profile.source = {'schema': 1, 'profile': 'retained-self-earned-source-v1', 'attempt': 'a2',
            'sourceWorld': str(r.A3_SOURCE_WORLD), 'sourceStopped': True, 'accountingComplete': True,
            'cumulativeBookedYen': 1919, 'originalFreshVanillaC1': True, 'initialGatePassed': True,
            'oldKillAdvancement': False, 'sourceBodyCommit': r.BODY_COMMIT, 'sourceHeadCommit': r.A2_HEAD,
            'sourcePlayerUuid': r.PLAYER_UUID, 'treeSha256': r.A2_WORLD_TREE_SHA, 'files': list(range(40)), 'records': records}
        def read(path, expected_sha=None):
            path = Path(path)
            if path not in values or expected_sha is not None and expected_sha != digests[path]:
                raise ValueError('SYNTHETIC_RECORD_HASH_MISMATCH')
            return deepcopy(values[path])
        return profile, values, digests, read

    def test_fixed_a3_policy_separates_old_source_body_from_approved_new_target(self):
        value = self.approval()
        self.assertEqual(r.approved_policy(value, self.pins(), 'b'*64, r.A3), value)
        self.assertNotEqual(value['bodyCommit'], r.BODY_COMMIT)
        for changes in ({'additionalCapYen': 4000}, {'priorBookedYen': 881}, {'sourceAttempt': 'a1'},
                        {'sourceReportSha256': '0'*64}, {'sourceReconciliationSha256': '0'*64},
                        {'sourcePlayerUuid': 'other'}, {'rootApproved': 1}, {'bodyCommit': 'f'*40}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                r.approved_policy({**value, **changes}, self.pins(), 'b'*64, r.A3)
        with self.assertRaises(ValueError): r.RetainedProfile(dict(r.A3))

    def test_real_record_semantics_accept_the_retained_to_natural_chain(self):
        profile, _, _, read = self.fixture()
        with patch.object(r, 'private_json', read): profile.verify_records()
        self.assertEqual(sum(profile.prior_monitors.values()), 2928.706)

    def test_missing_hash_root_record_tampered_copy_or_unsettled_accounting_is_refused(self):
        for kind in ('missing_record', 'missing_hash', 'copy', 'source_changed', 'not_closed', 'reconciliation', 'clock', 'opwrite', 'vanilla', 'a1_inventory'):
            with self.subTest(kind=kind):
                profile, values, _, read = self.fixture()
                report = values[r.A3_SOURCE_RESULT/'report.json']
                if kind == 'missing_record': del profile.source['records']['root-approval-a2.json']
                elif kind == 'missing_hash': del profile.source['records']['initial.json']['sha256']
                elif kind == 'copy': report['continuation']['copyProof']['distinctInodes'] = False
                elif kind == 'source_changed': report['continuation']['sourceWorldUnchanged'] = False
                elif kind == 'not_closed': report['transport']['pending'] = 1
                elif kind == 'reconciliation': values[profile.source_path.parent/'a2-final-reconciliation.json']['privateDb']['unsettledEstimatedYen'] = 1
                elif kind == 'clock': report['continuation']['a2ElapsedAtLastMonitorSeconds'] = None
                elif kind == 'opwrite': report['operatorWrites'] = [{'command': 'give'}]
                elif kind == 'vanilla': values[r.SOURCE_RESULT/'report.json']['worldProof']['modsEmpty'] = False
                elif kind == 'a1_inventory': values[r.SOURCE_RESULT/'initial.json']['initial']['raw']['Inventory'] = 'p: [{id:"diamond"}]'
                with patch.object(r, 'private_json', read), self.assertRaises(ValueError): profile.verify_records()

    def test_approve_binds_source_version_but_not_the_future_body_to_the_old_version(self):
        with tempfile.TemporaryDirectory() as directory:
            for bad_source in (False, True):
                profile, values, digests, read = self.fixture()
                world = Path(directory)
                profile.source['sourceWorld'] = str(world)
                if bad_source: profile.source['sourceBodyCommit'] = 'f'*40
                values[profile.source_path] = profile.source
                digests[profile.source_path] = 'c'*64
                approved = Path('/private/approval.json')
                values[approved], digests[approved] = self.approval(), 'a'*64
                args = SimpleNamespace(root_approval=str(approved), pins='test-pins')
                with patch.object(profile, 'source_world', return_value=world), patch.object(r, 'private_json', read), \
                     patch.object(r.base, 'read', return_value=self.pins()), patch.object(r.base, 'sha', return_value='b'*64), \
                     patch.object(profile, 'verify_source'), patch.object(r, 'saved_player', return_value={'uuid': r.PLAYER_UUID, 'dimension': 'minecraft:overworld'}):
                    if bad_source:
                        with self.assertRaisesRegex(ValueError, 'PROVENANCE'): profile.approve(args)
                    else:
                        profile.approve(args)
                        self.assertEqual(args.retained_head_environment['FULLRUN_PROFILE'], r.A3_PROFILE)

    def test_new_rig_and_three_monitor_clocks_inherit_no_task_or_database(self):
        profile, _, _, read = self.fixture()
        with patch.object(r, 'private_json', read): profile.verify_records()
        profile.world = r.A3_SOURCE_WORLD
        rig = profile.machine(SimpleNamespace(), {'id': 'FULL', 'name': r.base.GOAL})
        self.assertEqual(rig.label, 'sonnet-a3-sFULL-retained')
        self.assertEqual(rig.facts, {})
        self.assertEqual(rig.saved, {})
        result = {'ok': False, 'elapsed': 10.5}
        with patch.object(profile, 'verify_source'): profile.finish(result, SimpleNamespace(lab=None))
        clock = result['continuation']
        self.assertEqual(clock['sourceAttempt'], 'a2')
        self.assertEqual(clock['a1ElapsedAtLastMonitorSeconds'], 1198.271)
        self.assertEqual(clock['a2ElapsedAtLastMonitorSeconds'], 1730.435)
        self.assertEqual(clock['a3ElapsedAtLastMonitorSeconds'], 10.5)
        self.assertAlmostEqual(clock['cumulativeElapsedAtLastMonitorsSeconds'], 2939.206)
        self.assertFalse(clock['freshZeroStartThreeHourClaim'])

    def test_offline_a3_does_not_read_approval_or_create_marker_or_world(self):
        profile = r.RetainedProfile(r.A3)
        with tempfile.TemporaryDirectory() as directory, patch.object(profile, 'approve', side_effect=AssertionError('no approval read')):
            target = Path(directory)/'not-created'
            self.assertEqual(r.base.main(['--directory', str(target), '--pins', 'not-read', '--head-pin', 'not-read',
                '--body-pin', 'not-read', '--env-file', 'not-read', '--root-approval', 'not-read'], continuation=profile), 0)
            self.assertFalse(target.exists())


if __name__ == '__main__': unittest.main()
