import { describe, expect, it } from 'vitest';
import { planFromSeeds } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { acquired, doneFacts } from '../src/surfaces/minecraft/minecraftConditions.js';
import { doneStatusWords, nodesSeenDone, parseDoneWhen, predicateHolds } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { crystalsLeft, framesOf, marksOf, seenMarks } from '../src/surfaces/minecraft/minecraftSeenMarks.js';
import { breathLine, crystalLine, deathLine, dragonLine, frameLine, perchLine, phaseNumber, placeLine } from '../src/surfaces/minecraft/minecraftEndFacts.js';
import { createEyeLedger, flightOf } from '../src/surfaces/minecraft/minecraftEyeLedger.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';

const frame = (world: object): BodyObservation => ({ connected: true, state: { world }, facts: {} }) as unknown as BodyObservation;
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
    expect(crystalsLeft({ crystals: { remaining: 4 } })).toBe(4);
    expect(crystalsLeft({ crystals: { remaining: -1 } })).toBeNull();
    expect(crystalsLeft({})).toBeNull();
  });

  it('closes a node by see: and crystals<=, and says what is missing', () => {
    const fortress = parseDoneWhen('see:fortress')!;
    const here = doneFacts(frame({ dimension: 'the_nether', mapLandmarks: landmarks }))!;
    const away = doneFacts(frame({ dimension: 'the_nether', mapLandmarks: [] }))!;
    expect(predicateHolds(fortress, here)).toBe(true);
    expect(predicateHolds(fortress, away)).toBe(false);
    expect(doneStatusWords('see:fortress', away)).toContain('ネザー要塞');
    const crystals = parseDoneWhen('crystals<=0')!;
    expect(predicateHolds(crystals, doneFacts(frame({ dimension: 'the_end', crystals: { remaining: 0 } }))!)).toBe(true);
    expect(predicateHolds(crystals, doneFacts(frame({ dimension: 'the_end', crystals: { remaining: 3 } }))!)).toBe(false);
    // the body does not count them: unknown is never done
    expect(predicateHolds(crystals, doneFacts(frame({ dimension: 'the_end' }))!)).toBe(false);
    expect(doneStatusWords('crystals<=0', doneFacts(frame({ dimension: 'the_end' }))!)).toContain('数えていない');
    expect(parseDoneWhen('see:nothing_known')).toBeNull();
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
  it('says the dragon, its phase, the crystals, the breath and the perch from the structured fields', () => {
    const world = { dragon: { id: 77, health: 142.4, phase: 6, position: { x: 2, y: 66, z: 1 }, headPosition: { x: 3, y: 67, z: 6 }, distance: 14.2 },
      crystals: { remaining: 4, caged: 1, list: [{ id: 12, position: { x: 40, y: 90, z: 5 }, caged: false, distance: 21 },
        { id: 15, position: { x: -30, y: 100, z: 2 }, caged: true, distance: 34 }] },
      dragonBreath: [{ x: 4, z: 8, radius: 6.5 }], perch: { x: 0, y: 64, z: 0 } };
    expect(dragonLine(world)).toBe('竜: 体力 142.4/200・止まり木で見回している（phase 6、頭が剣の届く高さ。矢は効かない）・頭 (3,67,6)・あなたから 14m・#77');
    expect(crystalLine(world)).toBe('エンドクリスタル: 残り 4（檻つき 1）。近い順: #12 (40,90,5) 21m・#15 (-30,100,2) 34m 檻つき');
    expect(breathLine(world)).toBe('竜の息の雲: (4,8) 半径 7（中で立ち止まらない）');
    expect(perchLine(world)).toBe('止まり木: (0,64,0)');
    expect(phaseNumber('sitting_flaming')).toBe(5);
    expect(phaseNumber(11)).toBeNull();
  });

  it('reads the older map marks when the body sends no structured field, and says nothing without a dragon', () => {
    const world = { mapLandmarks: ['! エンダードラゴン (3,80,-4) 北20m・上16 id 77 体力 142/200', '! エンドクリスタル (40,90,5) 東40m id 12',
      'X 止まり木 (0,64,0) 出口ポータルの柱の上'] };
    expect(dragonLine(world)).toContain('体力 142/200');
    expect(crystalLine(world)).toContain('見えている 1 個');
    expect(perchLine(world)).toBe('止まり木: (0,64,0)');
    expect(dragonLine({})).toBeNull();
    expect(crystalLine({})).toBeNull();
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

describe('the ledger of the thrown eyes', () => {
  const truth = { x: 1000, z: -2000 };
  const bearing = (from: { x: number; z: number }) => Math.round((Math.atan2(truth.x - from.x, -(truth.z - from.z)) * 180 / Math.PI) * 10) / 10;
  const eye = (x: number, z: number, extra: object = {}) => result({ from: { x, y: 64, z }, bearingDeg: bearing({ x, z }), flew: 12,
    to: { x: x + 3, y: 70, z: z - 11 }, broke: false, ...extra });

  it('reads a flight from an act result and nothing from other results', () => {
    expect(flightOf(eye(0, 0))).toMatchObject({ x: 0, z: 0, flew: 12, broke: false, down: false });
    expect(flightOf(result({ from: { x: 0, y: 0, z: 0 } }))).toBeNull();
    expect(flightOf('not json')).toBeNull();
    expect(flightOf(undefined)).toBeNull();
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
    ledger.note('d', eye(9100, 60), 'overworld', 46 * 60_000);
    expect(ledger.throws().map(item => item.id.split(':')[0])).toEqual(['d']);
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
