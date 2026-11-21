"""python3 -m unittest queue_trial_test (from this directory). No server, no model: a small simulated queue stands in for the head."""
import http.server
import json
import os
import sqlite3
import tempfile
import threading
import unittest

import queue_trial
import trials

CFG = trials.load_json(os.path.join(trials.HERE, 'sections.json'))
SECTIONS = {str(s['id']): s for s in CFG['sections']}


class SimQueue:
    """The queue's rules as the spec states them, with the head's database table in a temp file. One row runs at a time; a stopped hand needs `settle` seconds
    before the next row starts (the body's ack), so the body stands still in between."""

    def __init__(self, path, durations, settle=10, camel=False):
        self.path, self.durations, self.settle, self.camel = path, durations, settle, camel
        self.rows, self.auto, self.now, self.block_until, self.seq = [], False, 0.0, 0.0, 0
        self.progress = {}
        self.sent = []
        self.write()

    def by_id(self, rid): return next((r for r in self.rows if r['id'] == rid), None)

    def active(self): return [r for r in self.rows if r['state'] not in queue_trial.TERMINAL]

    def apply(self, target, body):
        self.sent.append(dict(body))
        op, rid = body['op'], body.get('id')
        code = 'ok'
        if op == 'add':
            self.seq += 1
            self.rows.append({'id': f'e{self.seq}', 'seq': self.seq, 'goal': body['goal'], 'state': 'queued', 'task_id': None})
            self.auto = True
        elif op == 'stop':
            for r in self.rows:
                if r['state'] == 'running': r['state'] = 'stopped'; self.block_until = self.now + self.settle
            self.auto = False
        else:
            row = self.by_id(rid) if rid else None
            if op != 'start' and row is None: return {'ok': False, 'code': 'not_found', 'queue': None}
            if op == 'delete':
                if row['state'] == 'running': return {'ok': False, 'code': 'running', 'queue': None}
                self.rows.remove(row)
            elif op == 'cancel':
                if row['state'] == 'running': self.block_until = self.now + self.settle
                row['state'] = 'cancelled'
            elif op == 'hold':
                if row['state'] == 'running': self.block_until = self.now + self.settle
                row['state'] = 'paused'
            elif op == 'resume':
                if row['state'] not in ('paused', 'stopped'): code = 'bad_state'
                else: row['state'] = 'queued'
            elif op == 'move':
                before = self.by_id(body.get('before')) if body.get('before') else None
                self.rows.remove(row)
                self.rows.insert(self.rows.index(before) if before else len(self.rows), row)
            elif op == 'start':
                self.auto = True
                if row:
                    for r in self.rows:
                        if r['state'] == 'running': r['state'] = 'paused'; self.block_until = self.now + self.settle
                    self.rows.remove(row); self.rows.insert(0, row)
                    row['state'] = 'queued'
        self.pump(); self.write()
        return {'ok': code == 'ok', 'code': code, 'queue': None}

    def pump(self):
        if self.auto and self.now >= self.block_until and not any(r['state'] == 'running' for r in self.rows):
            nxt = next((r for r in self.rows if r['state'] == 'queued'), None)
            if nxt: nxt['state'] = 'running'

    def tick(self, dt):
        self.now += dt
        for r in self.rows:
            if r['state'] == 'running':
                ref = r['goal']
                self.progress[ref] = self.progress.get(ref, 0) + dt
                if self.progress[ref] >= self.durations[ref]: r['state'] = 'done'
        self.pump(); self.write()

    def running(self): return any(r['state'] == 'running' for r in self.rows)

    def write(self):
        con = sqlite3.connect(self.path)
        con.execute('DROP TABLE IF EXISTS minecraft_request_queue')
        cols = 'id, seq, goal, state, pos, taskId' if self.camel else 'id, seq, goal, state, pos, task_id'
        con.execute(f'CREATE TABLE minecraft_request_queue ({cols})')
        for n, r in enumerate(self.rows): con.execute('INSERT INTO minecraft_request_queue VALUES (?,?,?,?,?,?)', (r['id'], r['seq'], r['goal'], r['state'], n, r['task_id']))
        con.commit(); con.close()


def play(section_id, durations, settle=10, keep_moving=False, camel=False, limit=900, stale=False):
    """Runs one queue section's script against the simulated queue the way run_trial's loop does; returns (trial, latched, sim, ended_at)."""
    section = SECTIONS[section_id]
    fd, path = tempfile.mkstemp(suffix='.sqlite'); os.close(fd)
    goal_of = {e['ref']: e['goal'] for e in section['queue']['entries']}
    sim = SimQueue(path, {goal_of[k]: v for k, v in durations.items()}, settle, camel)
    if stale:          # finished rows of an earlier run: the same goals, a failed one among them, with task ids
        for n, state in enumerate(('failed', 'done', 'cancelled'), start=1):
            sim.rows.append({'id': f'old{n}', 'seq': -n, 'goal': list(goal_of.values())[n - 1], 'state': state, 'task_id': f'task-old{n}'})
        sim.write()
    old_db, old_post = trials.DB, queue_trial.post
    trials.DB, queue_trial.post = path, sim.apply
    try:
        q = trials.QueueRun(section, 'trial-1')
        q.snapshot()
        assert q.add_all() is None
        q.read()
        assert q.goals_ok()
        latched, maxima, t = {}, {}, 0
        while t < limit:
            t += 2
            sim.tick(2)
            logs = 1 if sim.progress.get(goal_of['a'], 0) >= 4 else 0
            counts = {'#minecraft:logs': logs}
            state = {'pos': [float(t), 64.0, 0.0] if (sim.running() or keep_moving) else [0.0, 64.0, 0.0], 'extra': {}}
            q.poll(t, state, counts, latched)
            state['extra'].update(q.milestone_facts(section))
            if trials.check_milestones(section, counts, state, latched, maxima, t): return q, latched, sim, t
        return q, latched, sim, None
    finally:
        trials.DB, queue_trial.post = old_db, old_post
        os.remove(path)


class ScriptedSectionsTest(unittest.TestCase):
    def test_q1_holds_one_row_reorders_and_resumes(self):
        q, latched, sim, ended = play('Q1', {'a': 40, 'b': 10, 'c': 10})
        self.assertIsNotNone(ended)
        self.assertEqual(q.trial.verdict(), [])
        self.assertEqual(q.trial.completed, ['c', 'b', 'a'])
        self.assertEqual([f['id'] for f in q.trial.fired], ['moveC', 'holdA', 'resumeA'])
        ops = [(s['op'], s.get('id'), s.get('before')) for s in sim.sent if s['op'] != 'add']
        self.assertEqual([o[0] for o in ops], ['move', 'hold', 'resume'])
        self.assertIn('原木 1', latched)

    def test_q2_starts_stops_deletes_cancels_and_leaves_the_right_rows(self):
        q, latched, sim, ended = play('Q2', {'a': 40, 'b': 10, 'c': 10, 'd': 30})
        self.assertIsNotNone(ended)
        self.assertEqual(q.trial.verdict(), [])
        self.assertEqual(q.trial.states, {'a': 'done', 'b': 'cancelled', 'c': 'absent', 'd': 'done'})
        self.assertEqual([f['id'] for f in q.trial.fired], ['startD', 'stopAll', 'resumeD', 'startAll', 'deleteC', 'cancelB', 'resumeA'])
        stop_at = q.trial.fired_at('stopAll')
        self.assertFalse([t for t in q.trial.running_at if stop_at < t <= stop_at + 20])        # nothing ran for the 20 s after the stop

    def test_the_queue_is_read_with_camel_case_columns_too(self):
        q, _, _, ended = play('Q1', {'a': 40, 'b': 10, 'c': 10}, camel=True)
        self.assertIsNotNone(ended)
        self.assertEqual(q.trial.verdict(), [])

    def test_a_body_that_keeps_moving_after_the_hold_fails_the_halt_check(self):
        q, _, _, ended = play('Q1', {'a': 40, 'b': 10, 'c': 10}, keep_moving=True)
        self.assertIsNotNone(ended)
        self.assertIn('halt:body_kept_moving', q.trial.verdict())

    def test_the_halt_check_reads_the_held_rows_task_and_not_the_body(self):
        cfg = SECTIONS['Q1']['queue']
        def run(settles_at):
            t = queue_trial.QueueTrial(cfg)
            rows = lambda st: [{'id': 'r1', 'goal': 'オークの原木を 5 個集める', 'state': st, 'taskId': 'tk'}, {'id': 'r2', 'goal': '作業台を作る', 'state': 'queued', 'taskId': None},
                               {'id': 'r3', 'goal': '木の棒を 4 本作る', 'state': 'queued', 'taskId': None}]
            t.observe(1.0, rows('running'), {'pos': (0, 0, 0), 'items': 0}, {}, {'tk': True})
            t.next = 1                                   # moveC has run; holdA fires at 20 s
            t.fired.append({'id': 'holdA', 'index': 1, 'op': 'hold', 'ref': 'a', 'at': 20.0})
            t.next = 2
            for sec in (22.0, 26.0, 40.0):
                t.observe(sec, rows('paused'), {'pos': (sec, 0, 0), 'items': 5}, {}, {'tk': sec < settles_at})      # the body keeps moving (the next row works)
            t.next = len(t.script)
            return t.verdict()
        self.assertNotIn('halt:body_kept_moving', run(24.0))
        self.assertNotIn('halt:task_kept_the_body', run(24.0))
        self.assertIn('halt:task_kept_the_body', run(99.0))

    def test_a_row_that_still_reads_running_just_after_the_stop_is_inside_the_grace(self):
        t = queue_trial.QueueTrial(SECTIONS['Q2']['queue'])
        t.fired.append({'id': 'stopAll', 'index': 1, 'op': 'stop', 'ref': None, 'at': 100.0})
        t.running_at = [102.0, 104.0]
        t.last_t = 130.0
        t.next = len(t.script)
        self.assertNotIn('quiet:a_row_ran', t.verdict())
        t.running_at = [102.0, 106.0]
        self.assertIn('quiet:a_row_ran', t.verdict())

    def test_a_next_row_that_starts_at_once_after_the_stop_fails_the_quiet_check(self):
        section = SECTIONS['Q2']
        t = queue_trial.QueueTrial(section['queue'])
        t.fired.append({'id': 'stopAll', 'index': 1, 'op': 'stop', 'ref': None, 'at': 100.0})
        t.running_at = [90.0, 110.0]
        t.last_t = 130.0
        t.next = len(t.script)
        self.assertIn('quiet:a_row_ran', t.verdict())
        t.running_at = [90.0, 121.0]
        t.next = len(t.script)
        self.assertNotIn('quiet:a_row_ran', t.verdict())

    def test_two_running_rows_are_a_violation_when_first_read(self):
        t = queue_trial.QueueTrial(SECTIONS['Q1']['queue'])
        rows = [{'id': 'x1', 'goal': 'オークの原木を 5 個集める', 'state': 'running', 'taskId': None},
                {'id': 'x2', 'goal': '作業台を作る', 'state': 'running', 'taskId': None}]
        t.observe(4.0, rows)
        self.assertTrue(t.violations and t.violations[0].startswith('running_2_at_4s'))

    def test_rows_left_by_an_earlier_run_are_never_read_as_this_runs(self):
        q, _, sim, ended = play('Q1', {'a': 40, 'b': 10, 'c': 10}, stale=True)
        self.assertIsNotNone(ended)
        self.assertEqual(q.trial.verdict(), [])
        self.assertEqual(q.trial.completed, ['c', 'b', 'a'])
        self.assertEqual(q.row()['status'], 'running')          # the old failed row does not end the trial
        self.assertEqual(q.task_ids(), [])
        self.assertTrue(all(s['requestId'] == f'trials:trial-1:{s["goal"] and q.trial.goal_ref[s["goal"]]}' for s in sim.sent if s['op'] == 'add'))

    def test_a_script_that_never_finishes_is_a_failure(self):
        q, _, _, ended = play('Q1', {'a': 40, 'b': 10, 'c': 10}, limit=8)       # cut after the first steps
        self.assertIsNone(ended)
        self.assertTrue(any(v.startswith('script_stopped_at_step_') for v in q.trial.verdict()))


class PostTest(unittest.TestCase):
    def serve(self, reply):
        seen = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                seen['path'], seen['auth'] = self.path, self.headers.get('authorization')
                seen['body'] = json.loads(self.rfile.read(int(self.headers['content-length'])))
                data = json.dumps(reply).encode()
                self.send_response(200); self.send_header('content-length', str(len(data))); self.end_headers(); self.wfile.write(data)

            def log_message(self, *a): pass
        server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        return server, seen

    def test_the_body_door_gets_the_sender_and_no_token(self):
        server, seen = self.serve({'success': True, 'result': 'ok', 'queue': {'rev': 3}})
        old = queue_trial.BODY_URL
        queue_trial.BODY_URL = f'http://127.0.0.1:{server.server_address[1]}/queue'
        try: reply = queue_trial.post(None, {'op': 'hold', 'id': 'e1', 'before': None})
        finally: queue_trial.BODY_URL = old
        self.assertEqual(reply, {'ok': True, 'code': 'ok', 'queue': {'rev': 3}})
        self.assertEqual(seen['path'], '/queue')
        self.assertIsNone(seen['auth'])
        self.assertEqual(seen['body'], {'op': 'hold', 'id': 'e1', 'before': None, 'sender': 'trials'})

    def test_the_head_door_gets_the_device_token_and_the_contract_path(self):
        server, seen = self.serve({'ok': False, 'code': 'queue_full', 'queue': None})
        reply = queue_trial.post(('head', f'http://127.0.0.1:{server.server_address[1]}', 'tok-1'), {'op': 'add', 'goal': 'x', 'placement': 'end'})
        self.assertEqual((reply['ok'], reply['code']), (False, 'queue_full'))
        self.assertEqual(seen['path'], '/v1/body/minecraft/queue')
        self.assertEqual(seen['auth'], 'Bearer tok-1')
        self.assertNotIn('sender', seen['body'])

    def test_an_unreachable_door_is_a_refusal_and_not_a_crash(self):
        reply = queue_trial.post(('head', 'http://127.0.0.1:9', 't'), {'op': 'stop'}, timeout=2)
        self.assertFalse(reply['ok'])
        self.assertTrue(reply['code'].startswith('unreachable'))


class ValidationTest(unittest.TestCase):
    def test_the_shipped_queue_sections_are_valid_and_the_old_ones_are_unchanged(self):
        self.assertEqual(trials.validate_sections(CFG), [])
        for sid in ('1', '6', '67', 'T'): self.assertNotIn('via', SECTIONS[sid])
        for sid in ('C1', 'C2', 'Q1', 'Q2'): self.assertEqual(SECTIONS[sid]['via'], 'queue')

    def test_validation_names_what_is_wrong_in_a_queue_section(self):
        bad = {'trialCapYen': 300, 'sections': [{'id': 'Q', 'name': 'x', 'via': 'queue', 'targetSeconds': 10, 'limitMinutes': 5, 'start': {}, 'seeds': [],
               'milestones': [{'name': 'end', 'queue': {'ref': 'zz', 'state': 'done'}, 'end': True}],
               'queue': {'entries': [{'ref': 'a', 'goal': 'g'}, {'ref': 'a', 'goal': 'g'}],
                         'script': [{'when': {'ref': 'q', 'state': 'running'}, 'op': 'hold', 'ref': 'a'}, {'when': {}, 'op': 'frob'}, {'when': {'milestone': 'no'}, 'op': 'stop'}],
                         'expect': {'halt': {'step': 'nostep'}, 'order': ['zz'], 'bogus': 1}}}]}
        text = ' | '.join(trials.validate_sections(bad))
        for needle in ('refs must be distinct', 'goals must be distinct', 'needs an entry ref', 'no when', "op 'frob'", "milestone 'no' is not in the section",
                       'halt names a step that has no id', "names 'zz'", "expect key 'bogus'", 'milestone end: queue needs'):
            self.assertIn(needle, text)

    def test_a_queue_block_on_an_operator_section_is_refused(self):
        s = dict(SECTIONS['1'], queue={'entries': []})
        self.assertIn('has a queue but is not via queue', ' | '.join(trials.validate_sections({'trialCapYen': 300, 'sections': [s]})))

    def test_each_section_may_name_its_goal_and_the_default_is_the_old_one(self):
        self.assertEqual(trials.section_goal(SECTIONS['1']), trials.GOAL)
        self.assertEqual(trials.section_goal(SECTIONS['C1']), 'ケーキを作ってください')


class FakePos:
    def __init__(self): self.log = []

    def cmd(self, text):
        self.log.append(text)
        if text.startswith('data get entity') and text.endswith('Pos'): return 'I_am_Shannon has the following entity data: [12.3d, 70.0d, -4.8d]'
        return 'Test passed'


class PrepAtBodyTest(unittest.TestCase):
    def test_c2_builds_the_garden_around_where_she_stands_after_the_gift(self):
        r = FakePos()
        trials.setup_body(r, SECTIONS['C2'], None, {})
        text = '\n'.join(r.log)
        self.assertLess(text.index('give I_am_Shannon minecraft:crafting_table 1'), text.index('forceload add'))
        self.assertIn('execute in minecraft:overworld run fill 15 69 -3 18 69 -3 minecraft:farmland[moisture=7]', r.log)
        self.assertIn('execute in minecraft:overworld run setblock 15 70 -7 minecraft:sugar_cane[age=0]', r.log)
        chickens = [c for c in r.log if 'minecraft:chicken' in c]
        self.assertEqual(len(chickens), 3)
        self.assertTrue(all('EggLayTime:200' in c for c in chickens))
        self.assertTrue(text.index('forceload remove all') < text.index('time set 1000'))

    def test_a_section_without_prep_at_body_does_not_ask_for_her_position(self):
        r = FakePos()
        trials.setup_body(r, SECTIONS['Q1'], None, {})
        self.assertFalse([c for c in r.log if c.startswith('data get entity') and c.endswith('Pos')])
        self.assertFalse([c for c in r.log if 'forceload' in c])


class CriticalMilestoneTest(unittest.TestCase):
    def test_a_queue_milestone_reads_the_fact_and_is_not_an_item(self):
        s = SECTIONS['C1']
        latched = {}
        done = trials.check_milestones(s, {'minecraft:cake': 1}, {'extra': {}}, latched, {}, 30)
        self.assertFalse(done)
        self.assertIn('ケーキ', latched)
        done = trials.check_milestones(s, {'minecraft:cake': 1}, {'extra': {'queue:列の依頼が done': True}}, latched, {}, 40)
        self.assertTrue(done)
        self.assertEqual(trials.end_seconds(s, latched), 40)


if __name__ == '__main__':
    unittest.main()
