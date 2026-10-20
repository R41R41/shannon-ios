"""python3 -m unittest trials_test (from this directory)."""
import json
import os
import struct
import tempfile
import unittest

import trials


def nbt_string(text):
    raw = text.encode('utf-8')
    return struct.pack('>H', len(raw)) + raw


class NbtTest(unittest.TestCase):
    def test_compound_with_list_and_long_array(self):
        body = (b'\x0a' + nbt_string('') +
                b'\x08' + nbt_string('Name') + nbt_string('minecraft:lava') +
                b'\x0c' + nbt_string('data') + struct.pack('>i', 2) + struct.pack('>qq', 1, -1) +
                b'\x09' + nbt_string('Pos') + b'\x06' + struct.pack('>i', 2) + struct.pack('>dd', 1.5, -2.0) +
                b'\x00')
        self.assertEqual(trials.nbt_read(body), {'Name': 'minecraft:lava', 'data': [1, -1], 'Pos': [1.5, -2.0]})

    def test_unpack_indices_without_spanning(self):
        # 4 bits: 16 values a long, lowest bits first
        value = sum(i << (4 * i) for i in range(16)) - (1 << 64 if (15 << 60) else 0)
        self.assertEqual(trials.unpack_indices([value], 4, 16), list(range(16)))
        # 5 bits: 12 values a long, the top 4 bits unused
        packed = sum((i % 32) << (5 * i) for i in range(12))
        self.assertEqual(trials.unpack_indices([packed], 5, 12), list(range(12)))


class MilestoneTest(unittest.TestCase):
    section = {'milestones': [
        {'name': 'pick2', 'any': ['minecraft:iron_pickaxe', 'minecraft:diamond_pickaxe'], 'count': 2, 'end': True},
        {'name': 'bed', 'any': ['#minecraft:beds'], 'orRespawn': True, 'end': True},
        {'name': 'armor', 'all': ['minecraft:iron_helmet', 'minecraft:iron_boots'], 'end': True},
        {'name': 'gate', 'dropFrom': 'minecraft:obsidian', 'after': 10, 'drop': 8},
        {'name': 'nether', 'dimension': 'minecraft:the_nether'}]}

    def test_latches_and_ends_only_when_every_end_milestone_held_once(self):
        latched, maxima = {}, {}
        counts = {'minecraft:iron_pickaxe': 1, 'minecraft:diamond_pickaxe': 1, 'minecraft:iron_helmet': 1}
        self.assertFalse(trials.check_milestones(self.section, counts, {}, latched, maxima, 10))
        self.assertEqual(latched, {'pick2': 10})
        # the pickaxe breaks later: pick2 stays done; the bed is placed and slept in (respawn set)
        counts = {'minecraft:iron_pickaxe': 0, 'minecraft:iron_helmet': 1, 'minecraft:iron_boots': 1}
        self.assertTrue(trials.check_milestones(self.section, counts, {'respawnSet': True}, latched, maxima, 20))
        self.assertEqual(trials.end_seconds(self.section, latched), 20)

    def test_gate_is_obsidian_placed_after_ten(self):
        latched, maxima = {}, {'minecraft:obsidian': 10}
        trials.check_milestones(self.section, {'minecraft:obsidian': 3}, {}, latched, maxima, 5)
        self.assertNotIn('gate', latched)
        trials.check_milestones(self.section, {'minecraft:obsidian': 2}, {'dimension': 'minecraft:the_nether'}, latched, maxima, 6)
        self.assertEqual(latched['gate'], 6)
        self.assertEqual(latched['nether'], 6)

    def test_tracked_items(self):
        self.assertIn('minecraft:obsidian', trials.tracked_items(self.section))
        self.assertIn('minecraft:iron_boots', trials.tracked_items(self.section))


class SettledTest(unittest.TestCase):
    def test_an_unknown_pause_still_holds_the_body(self):
        self.assertFalse(trials.settled({'status': 'paused', 'execState': 'unknown'}))
        self.assertTrue(trials.settled({'status': 'paused', 'execState': 'stopped'}))
        self.assertTrue(trials.settled({'status': 'failed', 'execState': 'failed'}))
        self.assertFalse(trials.settled({'status': 'running', 'execState': 'waiting'}))


class ReportTest(unittest.TestCase):
    def test_previous_result_and_delta(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = trials.RESULTS
            trials.RESULTS = tmp
            try:
                base = {'section': 1, 'sectionName': 'ゼロ→石器', 'seedKey': 'a', 'targetSeconds': 150, 'ok': True, 'decisions': 6, 'yen': 40}
                rows = [dict(base, trial='20261020T1400-s1-a', batch='20261020T1400', seconds=180.0),
                        dict(base, trial='20261021T0900-s1-a', batch='20261021T0900', seconds=150.0)]
                with open(os.path.join(tmp, 'history.jsonl'), 'w', encoding='utf-8') as handle:
                    for r in rows: handle.write(json.dumps(r, ensure_ascii=False) + '\n')
                os.makedirs(os.path.join(tmp, '20261021T0900'))
                trials.save_json(os.path.join(tmp, '20261021T0900', rows[1]['trial'] + '.json'), rows[1])
                trials.write_report('20261021T0900')
                report = trials.load_json(os.path.join(tmp, '20261021T0900', 'report.json'))
                self.assertEqual(report['rows'][0]['deltaSeconds'], -30.0)
                self.assertEqual(report['rows'][0]['verdict'], '速くなった')
            finally:
                trials.RESULTS = old


if __name__ == '__main__':
    unittest.main()
