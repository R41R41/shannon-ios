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


SITES = {'spawn': [0, 64, 0], 'netherArrival': [10, 70, -4], 'blazeStand': [111, 77, -295], 'blazeSpawner': [116, 77, -293],
         'strongholdPortalCenter': [735, 18, 1473], 'strongholdStand': [731, 18, 1470],
         'strongholdFrames': [{'x': 734, 'y': 18, 'z': 1471, 'facing': 'south', 'eye': True}, {'x': 735, 'y': 18, 'z': 1471, 'facing': 'south', 'eye': False}],
         'endPlatform': [100, 49, 0], 'fortress': {'spawners': [{'at': [116, 77, -293]}]}}


class SitesTest(unittest.TestCase):
    def test_a_site_by_name_path_offset_or_literal(self):
        self.assertEqual(trials.site_ref(SITES, 'netherArrival'), [10, 70, -4])
        self.assertEqual(trials.site_ref(SITES, 'fortress.spawners.0.at'), [116, 77, -293])
        self.assertEqual(trials.site_ref(SITES, {'site': 'endPlatform', 'offset': [1, 0, -1]}), [101, 49, -1])
        self.assertEqual(trials.site_ref(SITES, [1, 2, 3]), [1, 2, 3])

    def test_a_missing_or_malformed_site_stops_the_batch(self):
        with self.assertRaises(trials.Stop): trials.site_ref(SITES, 'nowhere')
        with self.assertRaises(trials.Stop): trials.site_ref(SITES, 'fortress.spawners.3.at')
        with self.assertRaises(trials.Stop): trials.site_ref(SITES, 'strongholdFrames')       # a list of frames is not a position

    def test_the_shipped_sections_are_consistent(self):
        cfg = trials.load_json(os.path.join(trials.HERE, 'sections.json'))
        self.assertEqual(trials.validate_sections(cfg), [])
        ids = [str(s['id']) for s in cfg['sections']]
        self.assertEqual(ids, ['1', '2', '3', '4', '5', '6', '7', '8a', '8b', '9', '10', '11'])

    def test_validation_names_what_is_wrong(self):
        base = {'trialCapYen': 300, 'sections': [{'id': 6, 'name': 'x', 'targetSeconds': 100, 'limitMinutes': 130, 'capYen': 3000,
                'start': {'dimension': 'minecraft:the_nether', 'at': 'nowhereAtAll'}, 'milestones': [{'name': 'a'}], 'seeds': []}]}
        problems = ' | '.join(trials.validate_sections(base))
        for needle in ('no end milestone', 'operator CLI limit of 120', 'operator CLI limit of 2000', 'unknown site nowhereAtAll', 'not marked requiresOwnerOk'):
            self.assertIn(needle, problems)

    def test_supply_is_named(self):
        cfg = trials.load_json(os.path.join(trials.HERE, 'sections.json'))
        by_id = {str(s['id']): s for s in cfg['sections']}
        self.assertEqual(trials.supply_kinds(by_id['1']), [])
        self.assertIn('tp', trials.supply_kinds(by_id['6']))
        self.assertIn('fill', trials.supply_kinds(by_id['6']))
        self.assertIn('summon', trials.supply_kinds(by_id['8b']))
        self.assertIn('framesEmpty', trials.supply_kinds(by_id['10']))


class PrepTest(unittest.TestCase):
    def test_steps_become_commands_relative_to_the_start(self):
        at = [10, 70, -4]
        self.assertEqual(trials.expand_prep({'fill': [1, 0, -2, 8, 4, 2, 'minecraft:air']}, at, SITES), ['fill 11 70 -6 18 74 -2 minecraft:air'])
        self.assertEqual(trials.expand_prep({'setblock': [0, -1, 0, 'minecraft:stone']}, at, SITES), ['setblock 10 69 -4 minecraft:stone'])
        self.assertEqual(trials.expand_prep({'summon': [4, 0, 0, 'minecraft:piglin', '{PersistenceRequired:1b}']}, at, SITES),
                         ['summon minecraft:piglin 14 70 -4 {PersistenceRequired:1b}'])
        commands = trials.expand_prep({'framesEmpty': True}, at, SITES)
        self.assertEqual(len(commands), 2)
        self.assertIn('setblock 734 18 1471 minecraft:end_portal_frame[facing=south,eye=false] replace', commands)

    def test_the_prep_box_covers_every_step_with_a_margin(self):
        start = {'prep': [{'fill': [1, 0, -2, 8, 4, 2, 'minecraft:air']}, {'summon': [4, 0, 9, 'minecraft:piglin']}]}
        x0, z0, x1, z1 = trials.prep_box(start, [10, 70, -4])
        self.assertLessEqual(x0, 10 - 4); self.assertGreaterEqual(x1, 18 + 4)
        self.assertLessEqual(z0, -6 - 4); self.assertGreaterEqual(z1, 5 + 4)


class ServerFactMilestoneTest(unittest.TestCase):
    section = {'milestones': [
        {'name': 'fortress', 'advancement': 'minecraft:nether/find_fortress', 'end': True},
        {'name': 'near spawner', 'near': 'blazeStand', 'within': 24, 'dimension': 'minecraft:the_nether'},
        {'name': 'rods 6', 'weighted': {'minecraft:blaze_rod': 1, 'minecraft:blaze_powder': 0.5, 'minecraft:ender_eye': 0.5}, 'count': 6},
        {'name': 'frames 12', 'framesFilled': 12},
        {'name': 'dragon', 'entity': '@e[type=minecraft:ender_dragon]', 'dimension': 'minecraft:the_end'},
        {'name': 'the end', 'dimension': 'minecraft:the_end'}]}

    def test_each_kind_reads_the_fact_it_names(self):
        latched, maxima = {}, {}
        state = {'dimension': 'minecraft:the_nether', 'extra': {'near:near spawner': True, 'adv:minecraft:nether/find_fortress': False, 'frames': 11}}
        counts = {'minecraft:blaze_rod': 4, 'minecraft:blaze_powder': 3, 'minecraft:ender_eye': 1}      # 4 + 1.5 + 0.5 = 6
        self.assertFalse(trials.check_milestones(self.section, counts, state, latched, maxima, 12))
        self.assertEqual(sorted(latched), ['near spawner', 'rods 6'])
        state['extra']['adv:minecraft:nether/find_fortress'] = True
        self.assertTrue(trials.check_milestones(self.section, counts, state, latched, maxima, 30))
        self.assertEqual(trials.end_seconds(self.section, latched), 30)
        self.assertNotIn('frames 12', latched)
        self.assertNotIn('the end', latched)       # a `dimension` milestone is not confused with a `near` / `entity` one that names a dimension
        self.assertNotIn('dragon', latched)

    def test_the_end_dimension_still_counts_when_it_is_only_a_dimension(self):
        latched = {}
        trials.check_milestones(self.section, {}, {'dimension': 'minecraft:the_end', 'extra': {'ent:@e[type=minecraft:ender_dragon]': True}}, latched, {}, 5)
        self.assertEqual(sorted(latched), ['dragon', 'the end'])

    def test_weighted_items_are_tracked_for_counting(self):
        self.assertIn('minecraft:blaze_powder', trials.tracked_items(self.section))
        also = dict(self.section, alsoCount=['minecraft:ender_pearl'])
        self.assertIn('minecraft:ender_pearl', trials.tracked_items(also))


class FailRuleTest(unittest.TestCase):
    section = {'failIf': [{'name': 'home', 'dimension': 'minecraft:overworld', 'holdSeconds': 30},
                          {'name': 'left the end', 'dimensionIsNot': 'minecraft:the_end', 'holdSeconds': 0}]}

    def test_a_rule_needs_its_hold_time_and_forgets_when_the_body_is_back(self):
        since = {}
        self.assertIsNone(trials.fail_rule_hit(self.section, {'dimension': 'minecraft:the_end'}, since, 0))
        self.assertIsNone(trials.fail_rule_hit({'failIf': self.section['failIf'][:1]}, {'dimension': 'minecraft:overworld'}, since, 10))
        self.assertIsNone(trials.fail_rule_hit({'failIf': self.section['failIf'][:1]}, {'dimension': 'minecraft:overworld'}, since, 39))
        self.assertEqual(trials.fail_rule_hit({'failIf': self.section['failIf'][:1]}, {'dimension': 'minecraft:overworld'}, since, 41), 'home')
        trials.fail_rule_hit({'failIf': self.section['failIf'][:1]}, {'dimension': 'minecraft:the_nether'}, since, 50)
        self.assertEqual(since, {})

    def test_an_unknown_dimension_never_fails(self):
        self.assertIsNone(trials.fail_rule_hit(self.section, {}, {}, 100))


class ModelAndCapTest(unittest.TestCase):
    def test_model_follows_the_sections(self):
        old, new = {'id': 1}, {'id': 6, 'defaultModel': 'current'}
        self.assertEqual(trials.resolve_model(None, [old]), 'sonnet')
        self.assertEqual(trials.resolve_model(None, [new, new]), 'current')
        self.assertEqual(trials.resolve_model('sonnet', [new]), 'sonnet')
        with self.assertRaises(trials.Stop): trials.resolve_model(None, [old, new])

    def test_cap_is_the_sections_own_or_the_default(self):
        cfg = {'trialCapYen': 300}
        self.assertEqual(trials.section_cap({'id': 1}, cfg), 300)
        self.assertEqual(trials.section_cap({'id': 11, 'capYen': 800}, cfg), 800)


class FakeRcon:
    """Records the commands; answers like a server that is happy (passed / loaded)."""
    def __init__(self): self.log = []

    def cmd(self, text):
        self.log.append(text)
        return 'Test passed'


class SetupOrderTest(unittest.TestCase):
    cfg = trials.load_json(os.path.join(trials.HERE, 'sections.json'))
    by_id = {str(s['id']): s for s in cfg['sections']}

    def test_the_nether_start_gives_builds_then_teleports(self):
        r = FakeRcon()
        trials.setup_body(r, self.by_id['6'], None, SITES)
        text = '\n'.join(r.log)
        order = [text.index(k) for k in ('clear I_am_Shannon', 'give I_am_Shannon minecraft:diamond_pickaxe', 'item replace entity I_am_Shannon armor.head',
                                         'forceload add', 'fill 11 70 -6 18 74 -2 minecraft:air', 'minecraft:obsidian', 'nether_portal[axis=x]',
                                         'forceload remove all', 'execute in minecraft:the_nether run tp I_am_Shannon 10.5 70 -3.5')]
        self.assertEqual(order, sorted(order))
        self.assertIn('execute in minecraft:the_nether run forceload add', text)
        self.assertIn('scoreboard players set I_am_Shannon trial_deaths 0', text)

    def test_the_end_start_builds_the_platform_and_checks_for_the_dragon(self):
        r = FakeRcon()
        trials.setup_body(r, self.by_id['11'], None, SITES)
        self.assertIn('execute in minecraft:the_end run tp I_am_Shannon 100.5 49 0.5', r.log)
        self.assertIsNone(trials.preflight(r, self.by_id['11'], SITES))
        self.assertIn('execute in minecraft:the_end if entity @e[type=minecraft:ender_dragon]', r.log)

    def test_a_refused_prep_command_stops_before_the_request(self):
        class Refusing(FakeRcon):
            def cmd(self, text):
                self.log.append(text)
                return 'Unknown or incomplete command' if text.startswith('execute in minecraft:the_nether run fill') else 'Test passed'
        with self.assertRaises(trials.Stop): trials.setup_body(Refusing(), self.by_id['6'], None, SITES)

    def test_the_probes_name_the_body_with_a_selector_that_takes_arguments(self):
        r = FakeRcon()
        trials.extra_probes(r, self.by_id['6'], dict(SITES, blazeStand=[111, 77, -295]), {})
        self.assertIn('execute if entity @a[name=I_am_Shannon,advancements={minecraft:nether/find_fortress=true}]', r.log)
        self.assertIn('execute in minecraft:the_nether positioned 111 77 -295 if entity @a[name=I_am_Shannon,distance=..100]', r.log)


class OwnerGuardTest(unittest.TestCase):
    def test_a_supplied_batch_does_not_run_without_the_owner(self):
        import argparse
        with tempfile.TemporaryDirectory() as tmp:
            old = trials.RESULTS
            trials.RESULTS = tmp
            try:
                args = argparse.Namespace(sections='6', seeds='c1', batch='B9', limit=None, model=None, batch_cap_yen=None, owner_ok_supply=None, dry_run=False, keep_going=False)
                with self.assertRaises(trials.Stop) as caught: trials.cmd_run(args)
                self.assertIn('has not confirmed', str(caught.exception))
                self.assertIn('--owner-ok-supply', str(caught.exception))
            finally:
                trials.RESULTS = old


class ReportPredictionTest(unittest.TestCase):
    def test_prediction_and_supply_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = trials.RESULTS
            trials.RESULTS = tmp
            try:
                row = {'trial': 'B1-s6-c1', 'batch': 'B1', 'section': 6, 'sectionName': 'fortress', 'seedKey': 'c1', 'targetSeconds': 480, 'ok': True, 'seconds': 420.0,
                       'decisions': 30, 'yen': 120, 'supplied': True, 'supplyKinds': ['give', 'tp', 'fill'], 'prediction': {'successRate': 0.25, 'seconds': 600, 'yen': 150}}
                os.makedirs(os.path.join(tmp, 'B1'))
                trials.save_json(os.path.join(tmp, 'B1', row['trial'] + '.json'), row)
                trials.write_report('B1')
                text = open(os.path.join(tmp, 'B1', 'report.md'), encoding='utf-8').read()
                self.assertIn('支給あり: give・tp・fill', text)
                self.assertIn('25%', text)
                self.assertIn('予測との答え合わせ', text)
                report = trials.load_json(os.path.join(tmp, 'B1', 'report.json'))
                self.assertEqual(report['rows'][0]['supplyKinds'], ['give', 'tp', 'fill'])
            finally:
                trials.RESULTS = old


if __name__ == '__main__':
    unittest.main()
