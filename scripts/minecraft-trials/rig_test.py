"""Pure fake tests: python3 -m unittest rig_test (no server, model, or VM)."""
import argparse
import json
import os
import queue
import tempfile
import unittest
from unittest.mock import Mock, patch

import rig
import trials


REAL_RIG = rig.Rig
MODELS = {**dict.fromkeys(('main', 'plan', 'summary', 'redecide'), rig.HAIKU_MODEL), 'escalate': None}


class RigSafetyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = os.path.join(self.tmp.name, 'B')
        os.makedirs(self.folder)
        for target, name, value in ((trials, 'RESULTS', self.tmp.name), (rig, 'RIG_ROOT', os.path.join(self.tmp.name, 'rigs')),
                                    (trials, 'MAX_SECTION_YEN', None)):
            changed = patch.object(target, name, value)
            changed.start(); self.addCleanup(changed.stop)
        stopped = patch.object(trials, 'stop_requested', return_value=False)
        stopped.start(); self.addCleanup(stopped.stop)
        self.args = argparse.Namespace(model='real', llm_model='haiku', keep=True, head_pin='/pins/head-test', body_pin='/pins/body-test',
                                       limit=None, smoke=False, owner_ok_supply=None, keep_going=False,
                                       max_section_yen=100, batch_cap_yen=150)
        self.section = {'id': 'O', 'name': 'opening', 'targetSeconds': 100, 'limitMinutes': 10, 'capYen': 100,
                        'start': {}, 'milestones': []}
        self.cfg = {'trialCapYen': 100}
        self.plan = [(self.section, 'c1')]

    def driver(self, final='0.5', models=None, complete=True, initial=0.25):
        made = []

        def create(*args):
            instance = REAL_RIG(*args)
            instance.head_started = True
            instance.models = dict(MODELS if models is None else models)
            instance._observe_line('RIG_USAGE ' + json.dumps({'n': 1, 'totalUsd': initial, 'complete': True}))
            instance.start = Mock(return_value=instance)

            def stop():
                if final is None:
                    instance.forced = True
                else:
                    instance._observe_line('RIG_STOPPED ' + json.dumps({'calls': 2, 'totalUsd': float(final), 'complete': complete}))
            instance.stop = Mock(side_effect=stop)
            made.append(instance)
            return instance
        return create, made

    def run_plan(self):
        return rig.run_plan(self.args, self.cfg, self.plan, 'B', self.folder, 150)

    def test_body_runner_stages_the_head_pins_spawn_adapter_without_changing_body_source(self):
        body = os.path.join(self.tmp.name, 'body')
        dev = os.path.join(self.tmp.name, 'dev')
        os.makedirs(os.path.join(body, 'node_modules'))
        os.makedirs(os.path.join(body, 'backend', 'src'))
        source = os.path.join(body, 'backend', 'src', 'untouched.ts')
        with open(source, 'w', encoding='utf-8') as handle: handle.write('body source unchanged\n')
        rig.ensure_body(body, dev)
        with open(os.path.join(body, 'backend', rig.BODY_RUN_RELATIVE), encoding='utf-8') as handle:
            self.assertEqual(handle.read(), rig.BODY_RUN_SOURCE)
        with open(os.path.join(body, 'backend', 'scripts', 'lab', 'rig-spawn-scan.ts'), 'rb') as handle:
            staged = handle.read()
        with open(os.path.join(rig.HERE, '..', '..', 'services', 'api', 'scripts', 'minecraftRigSpawnScan.ts'), 'rb') as handle:
            self.assertEqual(staged, handle.read())
        with open(source, encoding='utf-8') as handle: self.assertEqual(handle.read(), 'body source unchanged\n')

    def test_paid_failure_is_saved_and_resume_cannot_reserve_another_section(self):
        create, made = self.driver()
        with patch.object(rig, 'Rig', side_effect=create), patch.object(trials, 'run_trial', side_effect=trials.Stop('failed after a paid call')) as request:
            self.assertEqual(self.run_plan(), 0)
            finished, cut = trials.batch_rows('B')
            self.assertEqual(finished, [])
            self.assertEqual(cut[0]['yen'], 80)
            self.assertEqual(cut[0]['accounting']['status'], 'complete')
            self.assertEqual(self.run_plan(), 0)
            self.assertEqual(len(made), 1)
            request.assert_called_once()

    def test_keyboard_interrupt_still_stops_and_saves_final_usage(self):
        create, made = self.driver(final='0.4')
        with patch.object(rig, 'Rig', side_effect=create), patch.object(trials, 'run_trial', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt): self.run_plan()
        made[0].stop.assert_called_once()
        finished, cut = trials.batch_rows('B')
        self.assertEqual(finished, [])
        self.assertEqual(cut[0]['reason'], 'interrupted')
        self.assertEqual(cut[0]['yen'], 64)
        self.assertFalse(any(name.startswith('attempt-') for name in os.listdir(self.folder)))

    def test_long_trial_label_keeps_socket_short_and_retains_attempt_accounting(self):
        create, made = self.driver(final='0.4')
        batch = 'codex-haiku-entry-20261105-' + 'long-label-' * 3
        folder = os.path.join(self.tmp.name, batch)
        os.makedirs(folder)
        attempt = '9999999999999999999'
        vm_root = '/home/azureuser/.cache/minebot-lab/rig'

        def request(*_):
            marker = trials.load_json(os.path.join(folder, f'attempt-{batch}-sO-c1.json'))
            self.assertEqual(marker['trial'], f'{batch}-sO-c1')
            self.assertEqual(marker['rigDir'], f'{vm_root}/{attempt}')
            return {'ok': True, 'reason': 'milestones', 'yen': 0}

        with patch.object(rig, 'RIG_ROOT', vm_root), patch.object(rig.time, 'time_ns', return_value=int(attempt)), \
                patch.object(rig, 'Rig', side_effect=create), patch.object(trials, 'run_trial', side_effect=request):
            self.assertEqual(rig.run_plan(self.args, self.cfg, self.plan, batch, folder, 150), 0)
        socket_path = f'{made[0].dir}/head/operator-runtime/operator.sock'
        self.assertLessEqual(len(socket_path.encode('utf-8')), 107)
        self.assertEqual(made[0].label, f'{batch}-sO-c1'[:60])
        result = trials.load_json(os.path.join(folder, f'{batch}-sO-c1.json'))
        self.assertEqual(result['attemptId'], attempt)
        self.assertEqual(result['rigDir'], made[0].dir)
        self.assertEqual(result['yen'], 64)
        self.assertEqual(result['accounting']['status'], 'complete')

    def test_model_mismatch_makes_no_request(self):
        create, _ = self.driver(final='0', models={**MODELS, 'plan': 'claude-sonnet-5-5'}, initial=0)
        with patch.object(rig, 'Rig', side_effect=create), patch.object(trials, 'run_trial') as request:
            self.assertEqual(self.run_plan(), 1)
            request.assert_not_called()

    def test_db_and_usage_are_one_attempt_and_are_not_added(self):
        instance = REAL_RIG(self.args, self.section, 'c1', 'B', '', {})
        instance.head_started = True
        instance._observe_line('RIG_STOPPED {"totalUsd":0.5001,"calls":1,"complete":true}')
        self.assertEqual(rig.account_result(instance, {'yen': 70})['yen'], 81)
        self.assertEqual(rig.account_result(instance, {'yen': 95})['yen'], 95)

    def test_forced_shutdown_preserves_known_cost_and_blocks_later_retry(self):
        create, made = self.driver(final=None)
        with patch.object(rig, 'Rig', side_effect=create), patch.object(trials, 'run_trial', side_effect=RuntimeError('failed')) as request:
            with self.assertRaises(trials.Stop): self.run_plan()
            _, cut = trials.batch_rows('B')
            self.assertEqual(cut[0]['yen'], 40)
            self.assertEqual(cut[0]['accounting']['status'], 'unknown')
            with self.assertRaises(trials.Stop): self.run_plan()
            self.assertEqual(len(made), 1)
            request.assert_called_once()

    def test_unknown_usage_is_not_made_complete_by_a_later_final_receipt(self):
        instance = REAL_RIG(self.args, self.section, 'c1', 'B', '', {})
        instance.head_started = True
        instance._observe_line('RIG_USAGE {"totalUsd":0.2,"n":1,"complete":false}')
        instance._observe_line('RIG_STOPPED {"totalUsd":0.3,"calls":1,"complete":true}')
        self.assertEqual(instance.accounting()['status'], 'unknown')
        self.assertEqual(instance.accounting()['usageYen'], 48)

    def test_usage_after_stopped_invalidates_its_final_receipt(self):
        instance = REAL_RIG(self.args, self.section, 'c1', 'B', '', {})
        instance.head_started = True
        instance._observe_line('RIG_STOPPED {"totalUsd":0.3,"calls":1,"complete":true}')
        instance._observe_line('RIG_USAGE {"totalUsd":0.4,"n":2,"complete":true}')
        self.assertEqual(instance.accounting()['status'], 'unknown')
        self.assertEqual(instance.accounting()['usageYen'], 64)

    def test_killed_python_recovers_saved_log_and_refuses_automatic_retry(self):
        directory = os.path.join(rig.RIG_ROOT, 'killed-attempt')
        os.makedirs(directory)
        marker = {'trial': 'B-sO-c1', 'attemptId': 'killed', 'batch': 'B', 'section': 'O', 'sectionName': 'opening',
                  'seedKey': 'c1', 'targetSeconds': 100, 'model': 'rig-real', 'rigDir': directory, 'yen': 0}
        trials.save_json(os.path.join(self.folder, 'attempt-B-sO-c1.json'), marker)
        with open(os.path.join(directory, 'rig.log'), 'w', encoding='utf-8') as handle:
            handle.write('RIG_USAGE {"totalUsd":0.25,"n":1,"complete":true}\n')
        with patch.object(trials, 'run_trial') as request:
            with self.assertRaises(trials.Stop): self.run_plan()
            request.assert_not_called()
        _, cut = trials.batch_rows('B')
        self.assertEqual(len(cut), 1)
        self.assertEqual(cut[0]['yen'], 40)
        self.assertEqual(cut[0]['accounting']['status'], 'unknown')

    def test_recovery_after_result_save_does_not_count_the_partial_twice(self):
        row = {'trial': 'B-sO-c1', 'attemptId': 'saved', 'batch': 'B', 'section': 'O', 'sectionName': 'opening', 'seedKey': 'c1',
               'targetSeconds': 100, 'ok': False, 'reason': 'rig_failed:Stop', 'yen': 80, 'accounting': {'status': 'complete'}}
        trials.save_json(os.path.join(self.folder, 'B-sO-c1.interrupted-saved.json'), row)
        trials.save_json(os.path.join(self.folder, 'attempt-B-sO-c1.json'), row)
        trials.save_json(trials.partial_path('B', row['trial']), row)
        self.assertEqual(self.run_plan(), 0)
        _, cut = trials.batch_rows('B')
        self.assertEqual(len(cut), 1)
        self.assertEqual(cut[0]['yen'], 80)

    def test_real_run_requires_keep_and_explicit_positive_caps_before_config(self):
        for name, value in (('keep', False), ('max_section_yen', None), ('max_section_yen', -1), ('batch_cap_yen', 0)):
            with self.subTest(name=name, value=value), patch.object(trials, 'config') as config:
                changed = argparse.Namespace(**{**vars(self.args), name: value})
                with self.assertRaises(trials.Stop): rig.cmd_run(changed)
                config.assert_not_called()

    def test_first_payload_capture_requires_kept_real_rig_before_any_configuration(self):
        for overrides in ({'keep': False}, {'model': 'script'}):
            with self.subTest(**overrides), patch.object(trials, 'config') as config:
                changed = argparse.Namespace(**{**vars(self.args), 'capture_first_payload': True, **overrides})
                with self.assertRaises(trials.Stop): rig.cmd_run(changed)
                config.assert_not_called()

    def test_start_passes_only_the_requested_nonsecret_model_selection(self):
        instance = REAL_RIG(self.args, self.section, 'c1', 'B', '', {})
        for name, value in {'port_from': 25580, 'port_to': 25580, 'heap': '1G', 'cores': 1, 'env_file': '/vm-only/api.env',
                            'node': '/node', 'body_node': '/node', 'ready_seconds': 1}.items():
            setattr(self.args, name, value)

        def reader(*_):
            instance.http = {'url': 'http://127.0.0.1:1'}
            instance.models = dict(MODELS)
            instance.ready = {'db': '/fake/rig.db'}
        instance._reader = reader
        with patch.object(rig, 'free_slot', return_value=10), patch.object(rig, 'ensure_body', return_value='/fake/backend'), \
                patch.object(rig.seedscan, 'Lab') as lab, patch.object(rig.subprocess, 'Popen') as process, \
                patch.multiple(trials, DB='old-db', IOS='old-ios', NODE='old-node', RCON_TARGET=None):
            lab.return_value.port = 25580
            lab.return_value.rcon_port = 26580
            lab.return_value.password = 'fake-rcon'
            instance.start()
            env = process.call_args_list[0].kwargs['env']
            self.assertEqual(env['RIG_LLM_MODEL'], 'haiku')
            self.assertEqual(env['RIG_ENV_FILE'], '/vm-only/api.env')
            self.assertEqual(env['RIG_KEEP'], 'true')
            self.assertEqual(env['RIG_CAPTURE_FIRST_PAYLOAD'], 'off')
            self.assertNotIn('SHANNON_FCA_MODEL', env)

    def test_stop_waits_for_stdout_and_includes_the_last_usage(self):
        instance = REAL_RIG(self.args, self.section, 'c1', 'B', '', {})
        os.makedirs(instance.dir)
        instance.head_started = True
        messages = queue.Queue()

        class Process:
            pid, exited = 999999, False
            @property
            def stdout(self):
                return iter(messages.get, None)
            def poll(self): return 0 if self.exited else None
            def wait(self, timeout=None):
                self.last_timeout = timeout
                messages.put('RIG_USAGE {"totalUsd":0.4,"n":2,"complete":true}\n')
                messages.put('RIG_STOPPED {"totalUsd":0.5,"calls":2,"complete":true}\n')
                messages.put(None)
                self.exited = True
                return 0

        instance.head = Process()
        instance._reader(instance.head, 'rig.log')
        with patch.object(rig, 'kill_group'): instance.stop()
        self.assertFalse(instance.readers[0].is_alive())
        self.assertEqual(instance.head.last_timeout, 25)
        self.assertEqual(instance.accounting()['status'], 'complete')
        self.assertEqual(instance.accounting()['usageYen'], 80)


if __name__ == '__main__':
    unittest.main()
