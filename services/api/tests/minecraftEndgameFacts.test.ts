import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planFromSeeds } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { acquired, doneFacts } from '../src/surfaces/minecraft/minecraftConditions.js';
import { doneStatusWords, nodesSeenDone, parseDoneWhen, predicateHolds } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { framesOf, marksOf, seenMarks } from '../src/surfaces/minecraft/minecraftSeenMarks.js';
import { crystalsLeft, endViewOf } from '../src/surfaces/minecraft/minecraftEndView.js';
import { breathLine, crystalLine, deathLine, dragonLine, endFightLines, fireballLine, frameLine, perchLine, placeLine } from '../src/surfaces/minecraft/minecraftEndFacts.js';
import { createEyeLedger, flightOf } from '../src/surfaces/minecraft/minecraftEyeLedger.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';

/** A frame; the End fight, when given, sits directly in the world as the body sends it. */
const frame = (world: object, fight?: object): BodyObservation => ({ connected: true, state: { world: { ...world, ...fight } }, facts: {} }) as unknown as BodyObservation;
const stack = (name: string, count: number) => ({ name, count });
const result = (eye: object) => JSON.stringify({ v: 1, ok: true, done: 1, of: 1, lines: [{ i: 1, do: 'use', status: 'done', line: '' }], at: { x: 0, y: 64, z: 0 }, hp: 20,
  food: 20, ms: 100, eye });

describe('marks in view', () => {
  const landmarks = ['N ネザー要塞 (120,70,-30) 北東30m・上2 レンガ×14', 'S スポナー (130,72,-28) 北東35m 湧く: blaze', '[overworld] P ネザーポータル (10,64,10) 拠点',
    'Q エンドポータルの枠 (10,30,12) 南10m・下2 ×12 アイ入り 3', 'e エンドポータル (10,30,13) 南10m'];
  it('reads the body labels, ignores other dimensions, and counts the frames', () => {
    const seen = seenMarks({ mapLandmarks: landmarks });
    expect([...seen].sort()).toEqual(['blaze_spawner', 'end_portal', 'end_portal_frame', 'fortress', 'spawner']);
    expect(marksOf(landmarks).map(mark => mark.label)).toEqual(['ネザー要塞', 'スポナー', 'エンドポータルの枠', 'エンドポータル']);
    expect(framesOf({ mapLandmarks: landmarks })).toMatchObject({ frames: 12, eyes: 3 });
    expect([...seenMarks({ inside: 'ストロングホールドの中' })]).toEqual(['stronghold']);
    expect(crystalsLeft(frame({}, { crystals: { remaining: 4 } }))).toBe(4);
    expect(crystalsLeft(frame({}, { crystals: { remaining: -1 } }))).toBeNull();
    expect(crystalsLeft(frame({}))).toBeNull();
    expect(crystalsLeft(null)).toBeNull();
  });

  it('closes a node by see: and crystals<=, and says what is missing', () => {
    const fortress = parseDoneWhen('see:fortress')!;
    const here = doneFacts(frame({ dimension: 'the_nether', mapLandmarks: landmarks }))!;
    const away = doneFacts(frame({ dimension: 'the_nether', mapLandmarks: [] }))!;
    expect(predicateHolds(fortress, here)).toBe(true);
    expect(predicateHolds(fortress, away)).toBe(false);
    expect(doneStatusWords('see:fortress', away)).toContain('ネザー要塞');
    const crystals = parseDoneWhen('crystals<=0')!;
    expect(predicateHolds(crystals, doneFacts(frame({ dimension: 'the_end' }, { crystals: { remaining: 0 } }))!)).toBe(true);
    expect(predicateHolds(crystals, doneFacts(frame({ dimension: 'the_end' }, { crystals: { remaining: 3 } }))!)).toBe(false);
    // the body does not count them: unknown is never done
    expect(predicateHolds(crystals, doneFacts(frame({ dimension: 'the_end' }))!)).toBe(false);
    expect(doneStatusWords('crystals<=0', doneFacts(frame({ dimension: 'the_end' }))!)).toContain('数えていない');
    expect(parseDoneWhen('see:nothing_known')).toBeNull();
  });

  it('closes a crystals parent whose children are still open once none are left (what is destroyed stays destroyed)', () => {
    const tree = planFromSeeds([{ title: 'クリスタル', kind: 'dragon', doneWhen: 'crystals<=0', children: [{ title: '弓で撃つ', kind: 'dragon' }, { title: '檻を登る', kind: 'dragon' }] }])!;
    const none = doneFacts(frame({ dimension: 'the_end' }, { crystals: { remaining: 0 } }))!;
    const some = doneFacts(frame({ dimension: 'the_end' }, { crystals: { remaining: 2 } }))!;
    expect(nodesSeenDone(tree, none)).toEqual([tree.nodes[0]!.id]);
    expect(nodesSeenDone(tree, some)).toEqual([]);
  });

  it('keeps a parent with open children from closing on a place', () => {
    const tree = planFromSeeds([{ title: 'ストロングホールド', kind: 'stronghold', doneWhen: 'see:end_portal_frame',
      children: [{ title: '部屋', kind: 'stronghold' }] }])!;
    const facts = doneFacts(frame({ dimension: 'overworld', mapLandmarks: landmarks }))!;
    expect(nodesSeenDone(tree, facts)).toEqual([]);
  });
});

describe('what the work made of the rods and the pearls counts back', () => {
  it('counts rods made into powder and eyes, and pearls made into eyes', () => {
    const counts = new Map([['blaze_rod', 3], ['blaze_powder', 5], ['ender_eye', 3], ['ender_pearl', 2]]);
    expect(acquired(counts, 'blaze_rod')).toBe(3 + 4);
    expect(acquired(counts, 'ender_pearl')).toBe(2 + 3);
    expect(acquired(counts, 'ender_eye')).toBe(3);
    expect(acquired(counts, 'cobblestone')).toBe(0);
  });

  it('closes the rod node with 7 rods even after some became powder, but not with 3 plus nothing', () => {
    const tree = planFromSeeds([{ title: 'ブレイズロッド7', kind: 'blaze', target: { item: 'blaze_rod', count: 7 }, doneWhen: 'have:blaze_rod>=7' }])!;
    const made = doneFacts(frame({ dimension: 'the_nether', inventory: [stack('blaze_rod', 3), stack('blaze_powder', 7)] }))!;
    const few = doneFacts(frame({ dimension: 'the_nether', inventory: [stack('blaze_rod', 3)] }))!;
    expect(nodesSeenDone(tree, made)).toEqual([tree.nodes[0]!.id]);
    expect(nodesSeenDone(tree, few)).toEqual([]);
    expect(doneStatusWords('have:blaze_rod>=7', few, tree.nodes[0]!.target)).toBe('未: blaze_rod 3/7');
  });
});

describe('facts of the way to the dragon', () => {
  /** The shape the body sends (S1's `EndObservation`, the parts of the fight directly in `state.world`; the lab's own captures are in `end-observation.expected.json`). */
  const end = { dragon: { id: 77, health: 142.4, phase: 6, phaseName: 'sitting_scanning', phaseFor: 2.4, perched: true, position: { x: 2, y: 66, z: 1 }, yaw: 1.2,
      distance: 9.6, headPosition: { x: 3, y: 67, z: 6 }, headReach: 4.2, strike: true },
    crystals: { remaining: 4, gone: 6, caged: 1, unseen: [{ x: 10, z: 40 }], list: [{ id: 12, position: { x: 40.5, y: 90, z: 5.5 }, caged: false, distance: 21.2, healing: true,
      blast: 14.3 }, { id: 15, position: { x: -29.5, y: 100, z: 2.5 }, caged: true, distance: 34 }] },
    perch: { x: 0.5, y: 68, z: 0.5 }, dragonBreath: [{ x: 4.5, y: 65, z: 8.5, radius: 6.5, dangerRadius: 9 }], dragonFireballs: 2 };

  it('says the dragon, its phase and reach, the crystals, the breath, the fireballs and the perch', () => {
    const view = endViewOf(frame({ dimension: 'the_end' }, end));
    expect(dragonLine(view)).toBe('竜: 体力 142.4/200・止まり木で見回している（phase 6・この phase 2.4 秒目。矢は効かない）・頭 (3,67,6)・頭の箱まで 4.2m（剣が届く）・#77');
    expect(crystalLine(view)).toBe('エンドクリスタル: 残り 4/10（壊れた 6・檻つき 1・まだ見ていない台座 1）。近い順: '
      + '#12 (40,90,5) 21m 竜を回復中・壊すと爆発（今の立ち位置で体力 −14 の見込み）・#15 (-30,100,2) 34m 檻つき');
    expect(breathLine(view)).toBe('竜の息の雲: (4,8) 避ける半径 9（雲の今の半径 7）（中で立ち止まらない）');
    expect(fireballLine(view)).toBe('火の玉: 2 個が飛んでいる（体の反射が避ける）');
    expect(perchLine(view)).toBe('止まり木: (0,68,0)');
    expect(endFightLines(view)).toHaveLength(5);
  });

  it('counts the crystals as the body counts them, and reads nothing from the earlier forms of the fight (state.end, state.world.end)', () => {
    expect(crystalsLeft(frame({ dimension: 'the_end' }, end))).toBe(4);
    expect(crystalsLeft(frame({ dimension: 'the_end' }, { crystals: { remaining: 0 } }))).toBe(0);
    expect(crystalsLeft(frame({ dimension: 'the_end', end: { crystals: { remaining: 2 } } }))).toBeNull();
    expect(crystalsLeft({ connected: true, state: { world: {}, end: { crystals: { remaining: 2 } } }, facts: {} } as unknown as BodyObservation)).toBeNull();
  });

  it('says how far a dragon in flight is, and reads a frame whose dragon field is absent (not in view) with the crystals alone', () => {
    const flying = endViewOf(frame({ dimension: 'the_end' }, { dragon: { id: 77, health: 200, phase: 0, phaseName: 'holding_pattern', phaseFor: 3, perched: false,
      position: { x: 30.4, y: 90, z: -12.2 }, yaw: 0, distance: 41.6, headReach: null, strike: false }, crystals: { remaining: 10, gone: 0, caged: 0, unseen: [], list: [] },
    dragonBreath: [], dragonFireballs: 0 }));
    expect(dragonLine(flying)).toBe('竜: 体力 200/200・島の上を周回（phase 0）・位置 (30,90,-13) 自分から 42m・#77');
    expect(crystalLine(flying)).toBe('エンドクリスタル: 残り 10/10');
    expect(breathLine(flying)).toBeNull();
    expect(fireballLine(flying)).toBeNull();
    expect(perchLine(flying)).toBeNull();
    const unseen = endViewOf(frame({ dimension: 'the_end' }, { crystals: end.crystals, perch: end.perch }));
    expect(dragonLine(unseen)).toBeNull();
    expect(crystalLine(unseen)).toContain('残り 4/10');
    expect(perchLine(unseen)).toBe('止まり木: (0,68,0)');
  });

  it('says how far the head is when a blow does not reach yet', () => {
    const far = endViewOf(frame({}, { ...end, dragon: { ...end.dragon, headReach: 7.4, strike: false } }));
    expect(dragonLine(far)).toContain('頭の箱まで 7.4m（剣は 5m 以内で届く）');
  });

  it('reads the older map marks when the body sends no fight fields, and says nothing without a dragon', () => {
    const world = { mapLandmarks: ['! エンダードラゴン (3,80,-4) 北20m・上16 id 77 体力 142/200', '! エンドクリスタル (40,90,5) 東40m id 12',
      'X 止まり木 (0,64,0) 出口ポータルの柱の上'] };
    const view = endViewOf(frame(world));
    expect(dragonLine(view)).toContain('体力 142/200');
    expect(crystalLine(view)).toContain('見えている 1 個');
    expect(perchLine(view)).toBe('止まり木: (0,64,0)');
    expect(crystalsLeft(frame(world))).toBeNull();
    expect(dragonLine(endViewOf(frame({})))).toBeNull();
    expect(crystalLine(endViewOf(frame({})))).toBeNull();
    expect(endFightLines(null)).toEqual([]);
  });

  it('says the last death and when its dimension is not this one, the frames still to fill, and the places', () => {
    const world = { dimension: 'overworld', lastDeath: '3分前 the_end (12,60,40) 「void」 落とした物: iron_sword×1。消えるまで最長約5分→拾いに戻れる',
      deaths: [{ dimension: 'the_end' }], mapLandmarks: ['Q エンドポータルの枠 (10,30,12) 南10m・下2 ×12 アイ入り 3'],
      rememberedPlaces: { nether_portal: '34m 北東 (12,63,-40) ↔nether(1,70,-5)', respawn: '120m 北 (0,64,-120) respawn', village: '40m 西 (1,2,3)' } };
    expect(deathLine(world)).toContain('別。行くにはポータルを通る');
    expect(deathLine({ lastDeath: '' })).toBeNull();
    expect(frameLine(world, 5)).toBe('ポータルの枠: 見えている 12 個のうちアイ入り 3・あと 9 個はめる・手持ちのアイ 5 個（4 個足りない）');
    expect(placeLine(world)).toBe('控え（体の記憶、今いる次元）: ポータル 34m 北東 (12,63,-40) ↔nether(1,70,-5)・リスポーン地点 120m 北 (0,64,-120) respawn');
    expect(frameLine({}, 5)).toBeNull();
  });
});

/**
 * The observations the isolated lab made of a real fight (S1, `backend/tests/fixtures/end/observation.expected.json` of the body's branch, copied as it is): the
 * same file is the body's test of what it sends and the head's test of what it reads. Each is the End fields of `state.world` as `endObservation()` made them.
 */
describe('the End fight as the isolated lab made it (S1, 8 situations)', () => {
  const lab = JSON.parse(readFileSync(new URL('./fixtures/minecraft/end-observation.expected.json', import.meta.url), 'utf8')) as
    { situations: Array<{ label: string; expected: Record<string, any> }> };
  const view = (label: string) => endViewOf(frame({ dimension: 'the_end' }, lab.situations.find(situation => situation.label === label)!.expected));

  it('has the eight situations the body\'s test has', () => {
    expect(lab.situations.map(situation => situation.label)).toEqual(['arrival', 'dragon_flying', 'dragon_perched_out_of_reach', 'dragon_perched_in_reach',
      'crystals_near_caged_and_open', 'breath_cloud_just_seen', 'breath_cloud_growing', 'fireball_in_flight']);
  });

  it('reads every situation to a view that keeps the body\'s counts: the crystals, the clouds, the fireballs and whether the dragon is in view', () => {
    for (const situation of lab.situations) {
      const seen = endViewOf(frame({ dimension: 'the_end' }, situation.expected));
      expect(seen, situation.label).not.toBeNull();
      expect(seen!.crystals.remaining, situation.label).toBe(situation.expected.crystals.remaining);
      expect(seen!.crystals.list, situation.label).toHaveLength(situation.expected.crystals.list.length);
      expect(seen!.crystals.unseen, situation.label).toBe(situation.expected.crystals.unseen.length);
      expect(seen!.breath, situation.label).toHaveLength(situation.expected.dragonBreath.length);
      expect(seen!.fireballs, situation.label).toBe(situation.expected.dragonFireballs);
      expect(seen!.dragon !== null, situation.label).toBe('dragon' in situation.expected);
      expect(crystalsLeft(frame({ dimension: 'the_end' }, situation.expected)), situation.label).toBe(situation.expected.crystals.remaining);
    }
  });

  it('says the arrival, the dragon in flight and the dragon on the perch out of reach and in reach', () => {
    expect(dragonLine(view('arrival'))).toBeNull();
    expect(crystalLine(view('arrival'))).toBe('エンドクリスタル: 残り 10/10（まだ見ていない台座 10）');
    expect(perchLine(view('arrival'))).toBeNull();
    expect(dragonLine(view('dragon_flying'))).toBe('竜: 体力 200/200・島の上を周回（phase 0）・位置 (-39,93,39) 自分から 53m・#53');
    expect(dragonLine(view('dragon_perched_out_of_reach'))).toBe(
      '竜: 体力 200/200・止まり木で見回している（phase 6・この phase 0 秒目。矢は効かない）・頭 (-4,67,5)・頭の箱まで 8.4m（剣は 5m 以内で届く）・#53');
    expect(dragonLine(view('dragon_perched_in_reach'))).toBe(
      '竜: 体力 200/200・止まり木で見回している（phase 6・この phase 1.4 秒目。矢は効かない）・頭 (-4,67,5)・頭の箱まで 3.4m（剣が届く）・#53');
    expect(perchLine(view('dragon_perched_in_reach'))).toBe('止まり木: (0,68,0)');
  });

  it('says the caged and the open crystal with the blast, the breath cloud as it is first seen and as it grows, and the fireball', () => {
    expect(crystalLine(view('crystals_near_caged_and_open'))).toContain('残り 10/10（檻つき 3）。近い順: #213 (-7,65,6) 8m 檻つき・壊すと爆発（今の立ち位置で体力 −9 の見込み）');
    expect(breathLine(view('breath_cloud_just_seen'))).toBe('竜の息の雲: (-6,11) 避ける半径 7（雲の今の半径 7）（中で立ち止まらない）');
    expect(breathLine(view('breath_cloud_growing'))).toBe('竜の息の雲: (-6,11) 避ける半径 7（雲の今の半径 3）（中で立ち止まらない）');
    expect(breathLine(view('fireball_in_flight'))).toBeNull();
    expect(fireballLine(view('fireball_in_flight'))).toBe('火の玉: 1 個が飛んでいる（体の反射が避ける）');
    expect(fireballLine(view('dragon_flying'))).toBeNull();
  });
});

describe('the ledger of the thrown eyes', () => {
  const truth = { x: 1000, z: -2000 };
  const bearing = (from: { x: number; z: number }) => Math.round((Math.atan2(truth.x - from.x, -(truth.z - from.z)) * 180 / Math.PI) * 10) / 10;
  const eye = (x: number, z: number, extra: object = {}) => result({ from: { x, y: 64, z }, bearingDeg: bearing({ x, z }), flew: 12,
    to: { x: x + 3, y: 70, z: z - 11 }, broke: false, ...extra });

  it('reads a flight from an act result and nothing from other results', () => {
    expect(flightOf(eye(0, 0))).toMatchObject({ x: 0, z: 0, flew: 12, broke: false });
    expect(flightOf(eye(0, 0))).not.toHaveProperty('down');
    expect(flightOf(result({ from: { x: 0, y: 0, z: 0 } }))).toBeNull();
    expect(flightOf('not json')).toBeNull();
    expect(flightOf(undefined)).toBeNull();
  });

  it('finds a result noted again even when its command id is long (the key is cut to what is stored)', () => {
    const ledger = createEyeLedger(null);
    const id = `command-${'c'.repeat(120)}`;
    expect(ledger.note(id, eye(0, 0), 'overworld', 1000)).toBe(true);
    expect(ledger.note(id, eye(0, 0), 'overworld', 2000)).toBe(false);
    expect(ledger.throws()).toHaveLength(1);
  });

  it('keeps each throw once, only in the overworld, gives the point from two, and survives a checkpoint', () => {
    const ledger = createEyeLedger(null);
    expect(ledger.note('c1', eye(0, 0), 'the_nether', 1000)).toBe(false);
    expect(ledger.note('c1', eye(0, 0), 'overworld', 1000)).toBe(true);
    expect(ledger.note('c1', eye(0, 0), 'overworld', 2000)).toBe(false);
    expect(ledger.lines({ x: 0, z: 0 }, 3000).join('\n')).toContain('交点はまだ無い（線が 1 本だけ）');
    expect(ledger.note('c2', eye(800, 0, { broke: true }), 'overworld', 4000)).toBe(true);
    const fix = ledger.fix()!;
    expect(Math.abs(fix.x - truth.x)).toBeLessThanOrEqual(fix.errorBlocks);
    expect(Math.abs(fix.z - truth.z)).toBeLessThanOrEqual(fix.errorBlocks);
    const text = ledger.lines({ x: 800, z: 0 }, 5000).join('\n');
    expect(text).toContain('目玉の帳簿: 投げた 2 個（割れた 1）');
    expect(text).toContain('交点 (');
    expect(text).toContain('原点から');
    const restored = createEyeLedger(ledger.checkpoint().minecraftEyes);
    expect(restored.throws()).toHaveLength(2);
    expect(restored.fix()).toEqual(fix);
    expect(createEyeLedger({ v: 1, throws: [{ id: 3 }] }).throws()).toEqual([]);
    ledger.clear();
    expect(ledger.lines(null, 6000)).toEqual([]);
  });

  it('forgets throws that are old or far from the newest, and says an eye that sank straight down', () => {
    const ledger = createEyeLedger(null);
    ledger.note('a', eye(0, 0), 'overworld', 0);
    ledger.note('b', eye(9000, 0), 'overworld', 10_000);
    expect(ledger.throws()).toHaveLength(1);
    ledger.note('c', eye(9100, 40, { down: true }), 'overworld', 20_000);
    expect(ledger.lines({ x: 9100, z: 40 }, 21_000).join('\n')).toContain('真下へ沈んだ');
    ledger.note('d', eye(9100, 60), 'overworld', 4 * 3_600_000 + 60_000);
    expect(ledger.throws().map(item => item.id.split(':')[0])).toEqual(['d']);
  });

  it('does not read a throw older than the keep time, whenever it is read and after a restore', () => {
    const ledger = createEyeLedger(null);
    ledger.note('a', eye(0, 0), 'overworld', 1000);
    ledger.note('b', eye(800, 0), 'overworld', 2000);
    expect(ledger.fix(3000)).not.toBeNull();
    const later = 2000 + 4 * 3_600_000 + 60_000;
    expect(ledger.fix(later)).toBeNull();
    expect(ledger.throws(later)).toEqual([]);
    expect(ledger.lines({ x: 0, z: 0 }, later)).toEqual([]);
    expect(createEyeLedger(ledger.checkpoint().minecraftEyes).lines({ x: 0, z: 0 }, later)).toEqual([]);
    expect(createEyeLedger(ledger.checkpoint().minecraftEyes).fix(3000)).toEqual(ledger.fix(3000));
  });

  it('keeps a throw through the whole run (the stronghold does not move), and notes a flight when no frame is there', () => {
    const ledger = createEyeLedger(null);
    expect(ledger.note('a', eye(0, 0), null, 1000)).toBe(true);
    ledger.note('b', eye(800, 0), 'overworld', 2000);
    expect(ledger.fix(2000 + 3 * 3_600_000)).not.toBeNull();
    // Back after 60 minutes, from the checkpoint: the same lines (the point and the next place to throw from).
    const restored = createEyeLedger(ledger.checkpoint().minecraftEyes);
    const hour = 2000 + 60 * 60_000;
    expect(restored.lines({ x: 800, z: 0 }, hour)).toEqual(ledger.lines({ x: 800, z: 0 }, hour));
    expect(restored.lines({ x: 800, z: 0 }, hour).join('\n')).toContain('交点');
    expect(ledger.note('c', eye(0, 0), 'the_end', 3000)).toBe(false);
  });
});

describe('the ledger reads the body\'s full flight report (S2)', () => {
  const report = (extra: object) => result({ from: { x: 100, y: 64, z: 200 }, bearingDeg: 63.43, flew: 12, to: { x: 110, y: 72, z: 195 }, broke: false,
    origin: { x: 100.4, y: 64, z: 200.7 }, unit: { x: 0.89443, z: -0.44721 }, start: { x: 100.4, y: 65.6, z: 200.7 }, end: { x: 111.1, y: 73.6, z: 195.3 }, rise: 8,
    fate: 'dropped', drop: { id: 931, at: { x: 111.5, y: 70, z: 195.2 } }, arrived: false, samples: 40, ms: 3900, ...extra });

  it('reads the exact origin and unit vector, how it ended, and the dropped item', () => {
    expect(flightOf(report({}))).toMatchObject({ x: 100.4, z: 200.7, bearingDeg: 63.43, flew: 12, broke: false, fate: 'dropped', dropId: 931, toX: 111.5, toZ: 195.2,
      unit: { x: 0.89443, z: -0.44721 } });
    expect(flightOf(report({}))).not.toHaveProperty('down');
    expect(flightOf(report({}))).not.toHaveProperty('arrived');
    expect(flightOf(report({ fate: 'shattered', broke: false, drop: undefined }))).toMatchObject({ broke: true, fate: 'shattered', toX: 110, toZ: 195 });
  });

  it('says where an eye that dropped lies, until the time to pick it up has gone, and that an unseen end is unknown', () => {
    const ledger = createEyeLedger(null);
    ledger.note('a', report({}), 'overworld', 1000);
    expect(ledger.lines(null, 2000).join('\n')).toContain('(112,195) で拾える・pickup target=#931');
    expect(ledger.lines(null, 1000 + 6 * 60_000).join('\n')).toContain('拾える期限が過ぎたかもしれない');
    const unseen = createEyeLedger(null);
    unseen.note('b', report({ fate: 'unknown', drop: undefined }), 'overworld', 1000);
    expect(unseen.lines(null, 2000).join('\n')).toContain('落ちたか割れたか見えなかった');
  });

  it('takes an eye that sank as the place itself: no line, no next throw, and the frame search to do', () => {
    const ledger = createEyeLedger(null);
    ledger.note('d', report({ down: true, bearingDeg: 0, unit: null, flew: 0, arrived: true, origin: { x: 300.5, y: 64, z: -400.5 },
      from: { x: 300, y: 64, z: -401 }, to: { x: 300, y: 50, z: -401 } }), 'overworld', 1000);
    const text = ledger.lines({ x: 280, z: -380 }, 2000).join('\n');
    expect(text).toContain('目玉が真下へ沈んだ (301,-400)');
    expect(text).toContain('mc_probe kind=frames');
    expect(text).not.toContain('次に投げる場所の案');
    expect(text).not.toContain('交点はまだ無い');
    expect(ledger.fix()).toMatchObject({ x: 301, z: -400, errorBlocks: 1, throws: 1 });
  });

  it('takes an eye that stopped short as the stronghold at where it stopped, and says that this is a reading of the game', () => {
    const ledger = createEyeLedger(null);
    ledger.note('s', report({ arrived: true, flew: 7, bearingDeg: 90, unit: { x: 1, z: 0 }, origin: { x: 0, y: 64, z: 0 }, from: { x: 0, y: 64, z: 0 },
      to: { x: 7, y: 60, z: 0 }, drop: undefined }), 'overworld', 1000);
    expect(ledger.fix()).toMatchObject({ x: 7, z: 0, errorBlocks: 1, throws: 1 });
    const text = ledger.lines(null, 2000).join('\n');
    expect(text).toContain('目玉が 7m で止まった');
    expect(text).toContain('隔離ラボで 6/6');
  });
});

describe('the endgame of a task', () => {
  it('says nothing for a task that is not after the dragon, and the remembered places (the bed she respawns at too) for one that is', () => {
    const world = { dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: [], rememberedPlaces: { respawn: '4m 南 (0,64,4) respawn' } };
    const endgame = createEndgame(null);
    expect(endgame.lines(frame(world), false)).toEqual({ lines: [], short: [] });
    expect(endgame.lines(frame(world), true).lines.join('\n')).toContain('リスポーン地点 4m 南 (0,64,4) respawn');
    expect(endgame.lines(frame({ ...world, rememberedPlaces: {} }), true).lines).toEqual([]);
  });

  it('keeps the thrown eyes in its checkpoint and drops them once the portal room is in view', () => {
    const world = { dimension: 'overworld', position: { x: 800, y: 64, z: 0 }, inventory: [stack('ender_eye', 9)] };
    const endgame = createEndgame(null, () => 5_000);
    const eye = result({ from: { x: 0, y: 64, z: 0 }, bearingDeg: 26.6, flew: 12, to: { x: 5, y: 70, z: -11 }, broke: false });
    endgame.noteResult('c1', eye, frame(world));
    expect(endgame.lines(frame(world), true).lines.join('\n')).toContain('目玉の帳簿: 投げた 1 個');
    const restored = createEndgame(endgame.checkpoint(), () => 6_000);
    expect(restored.lines(frame(world), true).lines.join('\n')).toContain('目玉の帳簿: 投げた 1 個');
    const inRoom = { ...world, mapLandmarks: ['Q エンドポータルの枠 (10,30,12) 南10m ×12 アイ入り 2'] };
    const room = restored.lines(frame(inRoom), true);
    expect(room.lines.join('\n')).not.toContain('目玉の帳簿');
    expect(room.lines.join('\n')).toContain('あと 10 個はめる・手持ちのアイ 9 個（1 個足りない）');
    expect(room.short.join('\n')).toContain('ポータルの枠');
    expect(restored.checkpoint().minecraftEyes.throws).toEqual([]);
  });
});
