import { afterEach, describe, expect, it } from 'vitest';
import type { PlanPromise } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { createHitWatch, inputFacts } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { breakingOf } from '../src/surfaces/minecraft/minecraftLlmcPromises.js';
import { burnLine, burnedRecently, dropGuardWords, inputAgeLine, lavaNearLine, LAVA_STEP_BACK, posIn, queueGoal, routeEnemiesLine, waterWords,
  type Goal } from '../src/surfaces/minecraft/minecraftLlmcHazardFacts.js';
import { minecraftLlmcLive, minecraftLlmcUrgentLive, createFoodTrend } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { nearMemory, noteNear, sameShooterBack } from '../src/surfaces/minecraft/minecraftLlmcUrgent.js';
import { nearThreats } from '../src/surfaces/minecraft/minecraftLlmcThreat.js';
import { spareTargetNote } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { schemaProblem } from '../src/surfaces/minecraft/minecraftLlmcShape.js';
import { V2_ALWAYS, V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import { layersMap } from './support/minecraftFootingMaps.js';

/**
 * The facts of the run of 11/26 (6th): burning (the body's `onFire`, or a blow of fire a moment ago), lava a few cells off that the footing line does not
 * count, the enemies beside the line to where the hands go, the age of the input an urgent reply arrives on, a drop with an angry one beside it, and the
 * eye target one short. Each says what is so; none decides a hand.
 */
const FEET = { x: 114, y: 61, z: -298 };
const at = (x: number, y: number, z: number) => ({ x, y, z });
const FEET_AT = at(114.5, 61, -297.5);
function frame(world: Record<string, unknown>, extra: { stateAt?: string; recentHits?: unknown[] } = {}): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: extra.stateAt ?? '2026-11-26T00:00:10.000Z', receivedAt: '2026-11-26T00:00:10Z', connected: true,
    state: { world: world as never, ...extra.recentHits ? { combat: { recentHits: extra.recentHits } } : {} } as never, facts: { alive: true } };
}
// lava 4 cells west of the feet at the feet's height; floor under everything
const lavaWest = (dx: number, _dz: number, dy: number): string => dy === 0 && dx <= -4 ? 'l' : dy < 0 ? '$' : '.';
const lavaBeside = (dx: number, dz: number, dy: number): string => dy === 0 && dx === -2 && dz === 0 ? 'l' : dy < 0 ? '$' : '.';
const noLava = (_dx: number, _dz: number, dy: number): string => dy < 0 ? '$' : '.';

describe('burning: the body\'s onFire, or a blow of fire within 3 s', () => {
  const hit = (attackerType: string, at: number) => ({ damage: 1, at, attackerType });
  it('says it with the fall of health, and what water can do in this dimension (the Nether boils it away)', () => {
    const nether = frame({ dimension: 'the_nether', health: 6.1, position: FEET_AT, onFire: true, inventory: [{ name: 'water_bucket', count: 1 }] });
    const line = burnLine(nether, false)!;
    expect(line).toBe('燃えている（毎秒 1 減る。今の体力 6.1 は毎秒 1 で約 7 秒分。ネザーでは水が蒸発して使えない）');
    expect(line).not.toMatch(/助からない|約 \d+ 秒続く/u);
    const overworld = frame({ dimension: 'overworld', health: 12, onFire: true, inventory: [{ name: 'water_bucket', count: 1 }] });
    expect(burnLine(overworld, false)).toContain('この次元で水は使える（water_bucket を持っている）');
    expect(waterWords(frame({ dimension: 'overworld', inventory: [] }))).toBe('この次元で水は使えるが、水のバケツは持っていない');
  });

  it('is said only while the body says so or a blow of fire is within 3 s: not after it ended, not for a blow of another kind', () => {
    const calm = frame({ dimension: 'the_nether', health: 12, position: FEET_AT });
    expect(burnLine(calm, false)).toBeNull();
    expect(burnLine(calm, true)).not.toBeNull();
    const base = Date.parse('2026-11-26T00:00:10.000Z');
    const watch = createHitWatch(() => base);
    watch.note(frame({ health: 10 }, { recentHits: [hit('enderman', base - 1_000), hit('on_fire', base - 1_500)] }), base);
    expect(burnedRecently(watch.recent(base), base)).toBe(true);
    expect(burnedRecently(watch.recent(base), base + 1_000)).toBe(true);
    // 4 s after the last blow of fire: the old one is not said
    expect(burnedRecently(watch.recent(base), base + 4_000)).toBe(false);
    const other = createHitWatch(() => base);
    other.note(frame({ health: 10 }, { recentHits: [hit('enderman', base - 500), hit('zombie', base - 1_000)] }), base);
    expect(burnedRecently(other.recent(base), base)).toBe(false);
  });

  it('reaches both versions of the input (normal and urgent), the shortened one too', () => {
    const world = frame({ dimension: 'the_nether', health: 6.1, food: 20, position: FEET_AT, onFire: true });
    expect(inputFacts(world, {}, true).lines.some(line => line.startsWith('燃えている（'))).toBe(true);
    expect(inputFacts(world, {}, false).lines.some(line => line.startsWith('燃えている（'))).toBe(true);
    expect(inputFacts(world, {}, false).compressed.some(line => line.startsWith('燃えている（'))).toBe(true);
    // a burn the body does not send (hurtBy only): the context says it
    const quiet = frame({ dimension: 'the_nether', health: 6.1, food: 20, position: FEET_AT });
    expect(inputFacts(quiet, {}, true).lines.some(line => line.startsWith('燃えている（'))).toBe(false);
    expect(inputFacts(quiet, { burning: true }, true).lines.some(line => line.startsWith('燃えている（'))).toBe(true);
  });

  it('what the body\'s onFire switches on in the existing paths: the vitals say it too, and a shooter back in sight is no longer thinned', () => {
    const blaze = { id: 7, name: 'blaze', kind: 'hostile', distance: 4.5, position: at(114, 63, -290), canReachMe: true, canSee: true };
    const world = (extra: Record<string, unknown>) => frame({ position: FEET_AT, health: 13.3, nearbyThreats: [blaze], ...extra });
    const meters = () => 10;
    const memory = nearMemory();
    noteNear(memory, world({ nearbyThreats: [{ ...blaze, canSee: false }] }), meters, 1_000);
    const threat = nearThreats(world({}))[0]!;
    expect(sameShooterBack(threat, world({}), memory, meters, 2_000)).toBe(true);
    expect(sameShooterBack(threat, world({ onFire: true }), memory, meters, 2_000)).toBe(false);
    expect(inputFacts(world({ onFire: true }), {}, true).lines[0]).toContain('効果 燃えている');
    expect(inputFacts(world({}), {}, true).lines[0]).not.toContain('燃えている');
  });
});

describe('lava a few cells off (the footing line only counts the eight cells round her feet)', () => {
  it('says the nearest lava with its place, its height, what it does and what water can do; the step back only when it is one push away', () => {
    const far = frame({ dimension: 'the_nether', position: FEET_AT, localMap: layersMap(FEET, lavaWest) });
    const line = lavaNearLine(far)!;
    expect(line).toContain('溶岩 (110,61,-298) 西 4m・同じ高さ');
    expect(line).toContain('触れると燃える');
    expect(line).toContain('ネザーでは水が蒸発して使えない');
    expect(line).not.toContain(LAVA_STEP_BACK);
    const near = frame({ dimension: 'the_nether', position: FEET_AT, localMap: layersMap(FEET, lavaBeside) });
    expect(lavaNearLine(near)).toContain(`。${LAVA_STEP_BACK}`);
    expect(lavaNearLine(frame({ dimension: 'the_nether', position: FEET_AT, localMap: layersMap(FEET, noLava) }))).toBeNull();
    expect(lavaNearLine(frame({ dimension: 'the_nether', position: FEET_AT }))).toBeNull();
  });

  it('is in the facts whether she stands still or not, urgent or not', () => {
    const world = frame({ dimension: 'the_nether', health: 20, food: 20, position: FEET_AT, localMap: layersMap(FEET, lavaWest) });
    expect(inputFacts(world, {}, true).lines.some(line => line.startsWith('溶岩 ('))).toBe(true);
    expect(inputFacts(world, {}, false).compressed.some(line => line.startsWith('溶岩 ('))).toBe(true);
  });

});

describe('the enemies beside the line to where the hands go', () => {
  const ender = (id: number, x: number, z: number, angry?: boolean) => ({ id, name: 'enderman', kind: 'neutral', distance: Math.hypot(x - 114, z + 298), position: at(x, 61, z),
    ...angry === undefined ? {} : { angry } });
  const goal: Goal = { at: at(114, 61, -20), from: 'queue' };
  it('counts the kinds within 12 m of the straight line, how far off they stand and the mood of an enderman', () => {
    const threats = [ender(1, 118, -270, false), ender(2, 112, -265, false), ender(3, 116, -250, true), ender(4, 160, -270, false)];
    const line = routeEnemiesLine(frame({ position: FEET_AT, nearbyThreats: threats }), goal)!;
    expect(line).toBe('行き先の線の近く（予定の go (114,61,-20) までの線から 12m 内）: enderman ×3（28〜48m 先・怒っている 1・怒っていない 2）');
    const calm = routeEnemiesLine(frame({ position: FEET_AT, nearbyThreats: [ender(1, 118, -270, false), ender(2, 112, -265, false)] }), { ...goal, from: 'plan' })!;
    expect(calm).toContain('計画の場所 (114,61,-20)');
    expect(calm).toContain('enderman ×2（28〜33m 先・怒っていない）');
    expect(routeEnemiesLine(frame({ position: FEET_AT, nearbyThreats: [ender(4, 160, -270, false)] }), goal)).toBeNull();
    expect(routeEnemiesLine(frame({ position: FEET_AT, nearbyThreats: [ender(1, 118, -270, false)] }), null)).toBeNull();
  });
  it('the goal: the last go of the queue (to, goals, path), else the first coordinates of a plan place', () => {
    expect(queueGoal([{ hands: [{ do: 'go', to: at(1, 2, 3) }] }, { hands: [{ do: 'eat' }, { do: 'walk', path: [at(4, 5, 6), at(7, 8, 9)] }] }])).toEqual(at(7, 8, 9));
    expect(queueGoal([{ hands: [{ do: 'go', goals: [at(5, 5, 5), at(6, 6, 6)] }] }])).toEqual(at(5, 5, 5));
    expect(queueGoal([{ hands: [{ do: 'eat' }] }])).toBeNull();
    expect(posIn('ゲート (24,46,-24) の手前')).toEqual(at(24, 46, -24));
    expect(posIn('場所なし')).toBeNull();
    const world = frame({ position: FEET_AT, nearbyThreats: [ender(1, 118, -270, false)] });
    expect(inputFacts(world, { goal }, false).lines.some(line => line.startsWith('行き先の線の近く'))).toBe(true);
    expect(inputFacts(world, {}, false).lines.some(line => line.startsWith('行き先の線の近く'))).toBe(false);
  });
});

describe('the age of the input an urgent reply arrives on', () => {
  const base = Date.parse('2026-11-26T00:00:10.000Z');
  const near = frame({ position: FEET_AT, nearbyThreats: [{ id: 385, name: 'enderman', kind: 'neutral', distance: 3, position: at(114, 60, -295), angry: true }] });
  it('says the frame\'s age, how long the last urgent decision took, and the enderman\'s way', () => {
    expect(inputAgeLine(near, base + 400, 3_700, false)).toBe('この入力は 0.4 秒前の観測。返事が体に届くまでにさらに約 3.7 秒かかる（直近の急ぎの判断の長さ）。エンダーマンは打たれるとテレポートして消えることがある');
    // no decision before: no wait is said; no enderman near or hit: no teleport said
    const zombie = frame({ position: FEET_AT, nearbyThreats: [{ id: 1, name: 'zombie', kind: 'hostile', distance: 3, position: at(114, 61, -295) }] });
    expect(inputAgeLine(zombie, base + 400, null, false)).toBe('この入力は 0.4 秒前の観測');
    expect(inputAgeLine(zombie, base + 400, null, true)).toContain('テレポート');
    expect(inputAgeLine(frame({}, { stateAt: 'x' }), base, 1_000, false)).toBeNull();
  });
});

describe('a drop with an angry one beside it', () => {
  const pearl = { id: 9, name: 'item', item: 'ender_pearl', distance: 4, position: at(110.5, 57, -300.5) };
  it('names the angry enemy within 1.5 m of the item and how far under her feet it stands; none for a calm one or a far one', () => {
    const angryInHole = { id: 4, name: 'enderman', kind: 'hostile', distance: 5, position: at(110.5, 57, -300), angry: true };
    const world = { position: FEET_AT, nearbyThreats: [angryInHole] };
    expect(dropGuardWords(pearl, world)).toBe('・その 1m に怒った enderman #4（足元より 4 下）');
    expect(dropGuardWords(pearl, { ...world, nearbyThreats: [{ ...angryInHole, angry: false }] })).toBe('');
    expect(dropGuardWords(pearl, { ...world, nearbyThreats: [{ ...angryInHole, position: at(120, 57, -300) }] })).toBe('');
    const live = minecraftLlmcLive({ observation: frame({ ...world, position: FEET_AT, nearbyEntities: [pearl] }), elapsedMinutes: 1, trend: createFoodTrend(), events: [] }) as { near?: string[] };
    expect(live.near?.some(line => line.includes('その 1m に怒った enderman #4'))).toBe(true);
  });
});

describe('the eye target one short, and the promise of the frame\'s 12', () => {
  const facts = (eyes: number) => ({ counts: new Map([['ender_eye', eyes]]), dimension: 'the_nether', feet: null, food: 0 }) as never;
  it('says 今 13、あと 1 and the repair, only from 12 eyes and one or two short', () => {
    const target = { item: 'ender_eye', count: 14 };
    expect(spareTargetNote(target, facts(13))).toBe('今 13、あと 1。13 で終わらせるなら目標を 13 に書き直す');
    expect(spareTargetNote(target, facts(12))).toBe('今 12、あと 2。12 で終わらせるなら目標を 12 に書き直す');
    expect(spareTargetNote(target, facts(11))).toBeNull();
    expect(spareTargetNote({ item: 'ender_eye', count: 16 }, facts(13))).toBeNull();
    expect(spareTargetNote({ item: 'blaze_rod', count: 7 }, facts(6))).toBeNull();
    expect(spareTargetNote(undefined, facts(13))).toBeNull();
  });
  it('the 13th eye over a promise of 12 is not counted as breaking it: dropping one is free, dropping two is not', () => {
    const promise: PlanPromise = { id: 1, rev: 1, item: 'ender_eye', count: 12, use: '枠用', state: 'open', ledger: [] };
    const world = frame({ dimension: 'the_nether', inventory: [{ name: 'ender_eye', count: 13 }] });
    const drop = (count: number) => breakingOf([promise], [{ do: 'drop', items: [{ item: 'ender_eye', count }] }] as never, world).lines;
    expect(drop(1)).toEqual([]);
    expect(drop(2)).toHaveLength(1);
  });
});

describe('the words of the act: stopIf in a go, and the urgent knowledge', () => {
  it('a stopIf inside a go is refused with where it goes and how conditions are written', () => {
    const schema = { type: 'object', properties: { hands: { type: 'array', items: { type: 'object', properties: { do: { type: 'string' }, to: { type: 'object' } }, additionalProperties: false } } } };
    const problem = schemaProblem({ hands: [{ do: 'go', to: {}, stopIf: 'hostileWithin=8' }] }, schema as never);
    expect(problem ?? '').toContain('stopIf は act の欄で、手の中には書かない。条件は & でつながない');
    expect(MC_ACT_TOOL).toBeTruthy();
  });
  it('the knowledge says: burning loses health each second and the Nether\'s water is no help; stopIf counts a calm enderman; a hole\'s angry one is not picked from a fight chain', () => {
    expect(V2_ALWAYS).toContain('燃えている間は 1 秒に 1 減る。ネザーでは水で消せない');
    expect(V2_STAGES.pearl).toContain('stopIf hostileWithin は怒っていないエンダーマンも数える');
    expect(V2_STAGES.pearl).toContain('目が合うと怒る（距離だけでは決まらない）');
    expect(V2_STAGES.pearl).toContain('stopIf は act の欄で、go など手の中には書かない');
    expect(V2_STAGES.pearl).toContain('fight の後ろに onFail continue で pickup を並べない');
    expect(V2_ALWAYS).not.toMatch(/8m 以内を通ると怒る/u);
  });
});

describe('the urgent live state keeps the burning, lava and age lines among its facts', () => {
  it('carries the facts it is given as they are', () => {
    const world = frame({ dimension: 'the_nether', health: 6.1, position: FEET_AT, onFire: true, localMap: layersMap(FEET, lavaWest) });
    const facts = inputFacts(world, {}, true).lines;
    const live = minecraftLlmcUrgentLive({ observation: world, elapsedMinutes: 1, events: [], lastResults: [], planNowTitle: null, mode: 'x', facts }) as { facts?: string[] };
    expect(live.facts?.some(line => line.startsWith('燃えている（'))).toBe(true);
    expect(live.facts?.some(line => line.startsWith('溶岩 ('))).toBe(true);
  });
});

afterEach(() => undefined);
