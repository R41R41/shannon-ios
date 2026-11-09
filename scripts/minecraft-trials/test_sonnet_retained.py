import importlib.util
from pathlib import Path
import gzip
import hashlib
import json
import os
import shutil
import struct
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sonnet_retained', Path(__file__).with_name('sonnet_retained.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RetainedTest(unittest.TestCase):
    def pins(self):
        return {'profile': r.PROFILE, 'head': {'commit': 'a'*40}, 'body': {'commit': r.BODY_COMMIT}}

    def approval(self):
        return {'rootApproved': True, 'attempt': 'a2', 'profile': r.PROFILE,
                'priorBookedYen': 881, 'additionalCapYen': 4000, 'globalCapYen': 4881,
                'productionReserveYen': 9600, 'maxSeconds': 10800, 'sourceAttempt': 'a1',
                'sourceClosedCumulativeBookedYen': 881, 'otherPaidLanesStopped': True,
                'noAutomaticRetry': True, 'headCommit': 'a'*40, 'bodyCommit': r.BODY_COMMIT,
                'pinsSha256': 'b'*64, 'sourceWorldManifestSha256': 'c'*64,
                'sourceWorldTreeSha256': 'd'*64, 'expectedDimension': 'overworld'}

    def state(self):
        return {'killAdvancement': False, 'raw': {'Dimension': 'p: "minecraft:overworld"',
                'Pos': 'p: [3.0d, 65.0d, 4.0d]', 'Health': 'p: 13.0f', 'foodLevel': 'p: 14',
                'playerGameType': 'p: 0', 'Inventory': 'p: [{id:"minecraft:oak_log",count:6}]',
                'active_effects': 'p: []', 'UUID': 'p: [I;1,2,3,4]'}}

    def world(self, root):
        world = root/'source/world'
        (world/'playerdata').mkdir(parents=True)
        (world/'stats').mkdir()
        (world/'advancements').mkdir()
        for name, data in [('level.dat', b'saved level'), ('playerdata/player.dat', b'saved player'),
                           ('stats/player.json', b'{"saved":true}'), ('advancements/player.json', b'{}'),
                           ('session.lock', b'old session lock')]:
            (world/name).write_bytes(data)
        return world

    def profile(self, world):
        profile = r.RetainedProfile()
        profile.world = world
        files = r.tree_files(world)
        profile.source = {'files': files, 'treeSha256': r.tree_sha(files), 'a1ElapsedAtLastMonitorSeconds':1198.27}
        profile.approval = self.approval()
        return profile

    def test_only_the_approved_4000_policy_and_same_final_pins_are_accepted(self):
        value = self.approval()
        self.assertEqual(r.approved_policy(value, self.pins(), 'b'*64), value)
        for changes in ({'rootApproved':False}, {'rootApproved':1}, {'additionalCapYen':5000,'globalCapYen':5881},
                        {'priorBookedYen':144}, {'productionReserveYen':0}, {'noAutomaticRetry':False},
                        {'headCommit':'f'*40}, {'sourceWorldTreeSha256':''}, {'expectedDimension':'unknown'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                r.approved_policy({**value,**changes},self.pins(),'b'*64)

    def test_fresh_gate_stays_empty_but_retained_gate_accepts_observed_self_earned_inventory(self):
        state = self.state()
        self.assertFalse(r.base.initial_gate(state)['emptyInventory'])
        profile = r.RetainedProfile(); profile.approval = self.approval()
        profile.saved_player = {'uuidIntArray':[1,2,3,4]}
        self.assertTrue(all(profile.initial_gate(state).values()))
        state['killAdvancement'] = True
        self.assertFalse(profile.initial_gate(state)['noOldKill'])
        state['killAdvancement'] = False
        state['raw']['Dimension'] = 'p: "minecraft:the_end"'
        self.assertFalse(profile.initial_gate(state)['retainedDimension'])
        state['raw']['UUID'] = 'p: [I;1,2,3,5]'
        self.assertFalse(profile.initial_gate(state)['sameSavedPlayer'])

    def test_saved_world_manifest_includes_player_stats_advancements_and_excludes_only_session_lock(self):
        with tempfile.TemporaryDirectory() as d:
            world = self.world(Path(d))
            files = r.tree_files(world)
            self.assertEqual([v['path'] for v in files],
                             ['advancements/player.json','level.dat','playerdata/player.dat','stats/player.json'])
            before = r.tree_sha(files)
            (world/'session.lock').write_bytes(b'new ephemeral lock')
            self.assertEqual(r.tree_sha(r.tree_files(world)), before)
            (world/'playerdata/player.dat').write_bytes(b'changed player')
            self.assertNotEqual(r.tree_sha(r.tree_files(world)), before)

    def test_source_tamper_and_symlink_are_refused(self):
        with tempfile.TemporaryDirectory() as d:
            world = self.world(Path(d)); profile = self.profile(world)
            profile.verify_source()
            (world/'level.dat').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'WORLD_CHANGED'): profile.verify_source()
            (world/'escape').symlink_to(Path(d))
            with self.assertRaisesRegex(ValueError,'SYMLINK'): r.tree_files(world)

    def copied_start(self, root, corrupt=False):
        world = self.world(root); profile = self.profile(world); started = []
        class FakeLab:
            def __init__(self): self.world_from = str(world); self.dir = str(root/'new-a2')
            def prepare(self):
                shutil.copytree(self.world_from,Path(self.dir)/'world',ignore=shutil.ignore_patterns('session.lock'))
                if corrupt: (Path(self.dir)/'world/playerdata/player.dat').write_bytes(b'corrupt')
        def fake_super(obj):
            obj.lab = r.base.rig.seedscan.Lab()
            obj.lab.prepare()
            started.append('would-start-server')
            return obj
        obj = object.__new__(r.RetainedRig); obj.args = SimpleNamespace(retained_profile=profile)
        with patch.object(r.base.rig.seedscan,'Lab',FakeLab), patch.object(r.base.SonnetRig,'start',fake_super):
            original = r.base.rig.seedscan.Lab
            if corrupt:
                with self.assertRaisesRegex(ValueError,'COPY_HASH'): obj.start()
                self.assertEqual(started,[])
            else:
                obj.start()
                self.assertEqual(started,['would-start-server'])
                self.assertTrue(obj.lab.retained_copy_proof['beforeServerStart'])
                self.assertTrue(obj.lab.retained_copy_proof['distinctInodes'])
                self.assertEqual(r.tree_files(world),profile.source['files'])
                self.assertFalse((Path(obj.lab.dir)/'head/shannon.db').exists())
            self.assertIs(r.base.rig.seedscan.Lab,original)

    def test_verified_distinct_inode_copy_precedes_server_and_keeps_original_playerdata(self):
        with tempfile.TemporaryDirectory() as d: self.copied_start(Path(d))

    def test_bad_copy_cannot_start_server_and_factory_restores_on_error(self):
        with tempfile.TemporaryDirectory() as d: self.copied_start(Path(d),corrupt=True)

    def test_private_approval_refuses_public_mode_and_symlink_and_changed_bytes(self):
        with tempfile.TemporaryDirectory() as d, patch.object(r,'PRIVATE',Path(d)):
            path = Path(d)/'approval.json'; path.write_text('{}'); path.chmod(0o600)
            self.assertEqual(r.private_json(path,r.base.sha(path)),{})
            with self.assertRaisesRegex(ValueError,'HASH'): r.private_json(path,'0'*64)
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError,'PRIVATE'): r.private_json(path)
            link = Path(d)/'link'; link.symlink_to(path)
            with self.assertRaisesRegex(ValueError,'PRIVATE'): r.private_json(link)

    def test_new_rig_gets_world_only_and_no_seed_selection_or_old_database(self):
        profile = r.RetainedProfile(); profile.world = Path('/private/a1/world')
        obj = profile.machine(SimpleNamespace(), {'id':'FULL','name':r.base.GOAL})
        self.assertEqual(obj.world,'/private/a1/world')
        self.assertEqual(obj.facts,{})
        self.assertEqual(obj.label,'sonnet-a2-sFULL-retained')
        self.assertIsNone(obj.ready)
        self.assertEqual(obj.saved,{})

    def test_saved_player_reads_the_actual_nbt_identity_and_refuses_a_preexisting_kill(self):
        def string(value):
            data = value.encode(); return struct.pack('>H',len(data))+data
        def tag(kind,name,data): return bytes([kind])+string(name)+data
        identity = uuid.UUID(bytes=hashlib.md5(('OfflinePlayer:'+r.base.trials.BODY).encode()).digest(),version=3)
        ints = list(struct.unpack('>4i',identity.bytes))
        with tempfile.TemporaryDirectory() as d:
            world = Path(d); (world/'playerdata').mkdir(); (world/'advancements').mkdir()
            fields = tag(11,'UUID',struct.pack('>i4i',4,*ints))
            fields += tag(8,'Dimension',string('minecraft:overworld'))
            fields += tag(5,'Health',struct.pack('>f',13)) + tag(3,'foodLevel',struct.pack('>i',14))
            fields += tag(9,'Pos',struct.pack('>bi3d',6,3,3,65,4))
            item = tag(8,'id',string('minecraft:oak_log'))+tag(3,'count',struct.pack('>i',6))+b'\0'
            fields += tag(9,'Inventory',struct.pack('>bi',10,1)+item)
            data = b'\x0a\x00\x00'+fields+b'\0'
            (world/'playerdata'/f'{identity}.dat').write_bytes(gzip.compress(data))
            advance = world/'advancements'/f'{identity}.json'; advance.write_text('{}')
            result = r.saved_player(world)
            self.assertEqual(result['uuidIntArray'],ints)
            self.assertEqual(result['health'],13)
            self.assertEqual(result['food'],14)
            self.assertEqual(result['inventory'][0],{'id':'minecraft:oak_log','count':6,'slot':None})
            advance.write_text(json.dumps({r.base.ADVANCEMENT:{'done':True}}))
            with self.assertRaisesRegex(ValueError,'OLD_KILL'): r.saved_player(world)

    def test_a1_a2_time_is_kept_separate_and_never_claimed_new_fresh_three_hours(self):
        with tempfile.TemporaryDirectory() as d:
            world = self.world(Path(d)); profile = self.profile(world)
            result = {'ok':False,'elapsed':10.5}
            profile.finish(result,SimpleNamespace(lab=None))
            self.assertEqual(result['continuation']['cumulativeElapsedAtLastMonitorsSeconds'],1208.77)
            self.assertFalse(result['continuation']['freshZeroStartThreeHourClaim'])
            self.assertTrue(result['continuation']['sourceWorldUnchanged'])

    def test_offline_entry_never_approves_or_starts_a_world_or_opens_credentials(self):
        profile = r.RetainedProfile()
        with patch.object(profile,'approve',side_effect=AssertionError('no approval read')):
            self.assertEqual(r.base.main(['--directory','not-created','--pins','not-read','--head-pin','not-read',
                '--body-pin','not-read','--env-file','not-read','--root-approval','not-read'],continuation=profile),0)


if __name__ == '__main__': unittest.main()
