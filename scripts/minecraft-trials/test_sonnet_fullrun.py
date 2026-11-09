import importlib.util
from pathlib import Path
import tempfile
import sqlite3
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sonnet_fullrun', Path(__file__).with_name('sonnet_fullrun.py'))
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
DEADLINE = int(f.dt.datetime(2026, 11, 5, tzinfo=f.dt.timezone.utc).timestamp()*1000) + 10000


class FullrunTest(unittest.TestCase):
    def state(self):
        return {'killAdvancement': False, 'raw': {'Dimension': 'x: "minecraft:overworld"', 'Pos': 'x: [0.5d, 64.0d, 0.5d]',
            'Inventory': 'x: []', 'active_effects': 'Found no elements matching active_effects', 'Health': 'x: 20.0f', 'playerGameType': 'x: 0'}}

    def test_natural_spawn_requires_empty_and_no_old_advancement(self):
        state = self.state()
        self.assertTrue(all(f.initial_gate(state).values()))
        state['killAdvancement'] = True
        self.assertFalse(f.initial_gate(state)['noOldKill'])
        state['raw']['Inventory'] = 'x: [{id:"minecraft:stone"}]'
        self.assertFalse(f.initial_gate(state)['emptyInventory'])

    def test_falsecomplete_enterend_or_advancement_alone_is_not_kill(self):
        self.assertFalse(f.final_gate('t', {'status': 'completed'}, {'killAdvancement': True}, DEADLINE))
        self.assertFalse(f.final_gate('t', {'verified': True, 'taskId': 't'}, {'killAdvancement': True}, DEADLINE))

    def test_native_and_new_advancement_must_name_original_task(self):
        n = {'verified': True, 'taskId': 't', 'deadlineMs': DEADLINE, 'expected': {'taskId': 't', 'goal': f.GOAL},
             'evidence': {'taskId': 't', 'boss': {'verified': True, 'witness': {'observedAt': '2026-11-05T00:00:10Z'}}}}
        self.assertTrue(f.final_gate('t', n, {'killAdvancement': True}, DEADLINE))
        self.assertFalse(f.final_gate('other', n, {'killAdvancement': True}, DEADLINE))
        self.assertFalse(f.final_gate('t', n, {'killAdvancement': False}, DEADLINE))
        n['at'] = '2026-11-05T00:00:11Z'  # collection can be later; witness remains inside the mission
        self.assertTrue(f.final_gate('t', n, {'killAdvancement': True}, DEADLINE))
        n['evidence']['boss']['witness']['observedAt'] = '2026-11-05T00:00:10.001Z'
        self.assertFalse(f.final_gate('t', n, {'killAdvancement': True}, DEADLINE))

    def test_monitor_refuses_writes(self):
        class R:
            def cmd(self, c): return c
        for bad in ('tp player 0 64 0', 'give p stone', 'time set 0', 'effect give p saturation',
                    'gamerule minecraft:keep_inventory true', 'execute if entity @p run kill @e'):
            with self.assertRaises(ValueError): f.read_only(R(), bad)

    def test_model_checks_do_not_relax_haiku_base_class(self):
        args = type('Args', (), {'model': 'real'})()
        obj = object.__new__(f.SonnetRig); obj.args = args
        obj.models = {**dict.fromkeys(('main','plan','summary','redecide'), f.MODEL), 'escalate': None}
        obj.check_models()
        with self.assertRaises(f.trials.Stop): f.rig.Rig.check_models(obj)
        obj.models['summary'] = 'claude-haiku-5-5'
        with self.assertRaises(f.trials.Stop): obj.check_models()

    def test_offline_plan_does_not_read_key_or_start_server(self):
        with patch.object(f, 'execute', side_effect=AssertionError('no run')):
            self.assertEqual(f.main(['--directory','not-opened','--pins','not-read','--head-pin','not-opened',
                '--body-pin','not-opened','--env-file','not-read']), 0)

    def test_pin_manifest_fences_paths_and_exact_source(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)/'a'; p.write_text('source')
            self.assertEqual(f.verify_pin(d, {'files': {'a': f.sha(p)}}), 1)
            with self.assertRaises(ValueError): f.verify_pin(d, {'files': {'a': '0'*64}})
            with self.assertRaises(ValueError): f.verify_pin(d, {'files': {'../escape': '0'*64}})

    def test_emitted_hoisted_layout_verifies_without_a_backend_mineflayer_alias(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            adapter = root/'backend/scripts/lab/a.ts'; adapter.parent.mkdir(parents=True); adapter.write_text('fixture')
            deps = {}
            for name in ('entities.js','inventory.js'):
                p = root/'node_modules/mineflayer/lib/plugins'/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(name)
                deps[p.relative_to(root).as_posix()] = f.sha(p)
            self.assertFalse((root/'backend/node_modules/mineflayer').exists())
            f.verify_body_runtime(root, {'adapterFiles': {'backend/scripts/lab/a.ts':f.sha(adapter)}, 'dependencyFiles':deps})

    def test_final_db_ceil_max_uses_explicit_readonly_private_path_after_globals_restore(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)/'head/shannon.db'; path.parent.mkdir()
            with sqlite3.connect(path) as connection:
                connection.execute('CREATE TABLE fca_task_budget (yen REAL)')
                connection.execute('CREATE TABLE fca_task_budget_estimates (yen REAL, settled_at TEXT)')
                connection.executemany('INSERT INTO fca_task_budget VALUES (?)', [(1,), (1,)])
            with patch.object(f.trials, 'DB', '/normal/forbidden.sqlite'):
                record = f.private_database_budget(path)
            self.assertEqual(record['confirmedYen'], 2)
            provider_yen = __import__('math').ceil(.002 * 160)
            self.assertEqual(provider_yen, 1)
            self.assertEqual(144 + max(provider_yen, record['usedYen']), 146)
            self.assertEqual(f.trials.DB != str(path), True)
            with self.assertRaises(FileNotFoundError): f.private_database_budget(Path(d)/'absent/head/shannon.db')

    def test_sonnet_cleanup_ends_processes_and_readers_but_saves_world_and_haiku_default_still_removes(self):
        events = []
        class Process:
            def __init__(self, name): self.name = name; self.alive = True
            def poll(self): return None if self.alive else 0
            def wait(self, timeout): self.alive = False; events.append(('wait', self.name, timeout))
        class Reader:
            def join(self, timeout): events.append(('join', timeout))
            def is_alive(self): return False
        class Lab:
            def __init__(self): self.port_open = True; self.world_exists = True
            def stop(self, remove=True, fast=False):
                self.port_open = False
                if remove: self.world_exists = False
                events.append(('server-stop', remove, fast))
        obj = object.__new__(f.SonnetRig)
        obj.saved, obj.body, obj.head, obj.lab = {}, Process('body'), Process('head'), Lab()
        obj.readers, obj.args, obj.forced = [Reader()], SimpleNamespace(keep=True), False
        with patch.object(f.rig, 'kill_group', side_effect=lambda proc, _sig: events.append(('signal', proc.name))):
            obj.stop()
        self.assertFalse(obj.body.alive or obj.head.alive)
        self.assertFalse(obj.lab.port_open)
        self.assertTrue(obj.lab.world_exists)
        self.assertIn(('server-stop', False, False), events)
        self.assertLess(events.index(('signal', 'body')), events.index(('signal', 'head')))
        self.assertLess(events.index(('join', 5)), events.index(('server-stop', False, False)))
        events.clear()
        base = object.__new__(f.rig.Rig)
        base.saved, base.body, base.head, base.readers, base.args, base.lab = {}, None, None, [], SimpleNamespace(keep=True), Lab()
        f.rig.Rig.stop(base)
        self.assertEqual(events, [('server-stop', True, True)])


if __name__ == '__main__': unittest.main()
