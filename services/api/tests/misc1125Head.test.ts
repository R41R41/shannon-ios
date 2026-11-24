import { describe, expect, it, beforeEach } from 'vitest';
import { droppedLine, hopsLine, queueLines, reissueLine, underAttack } from '../src/surfaces/minecraft/minecraftLlmcQueueWords.js';
import { heightWords, mergeEnemies } from '../src/surfaces/minecraft/minecraftLlmcLiveEnemies.js';
import { forgetShiftFacts, recentJumpLine, respawnFact, timeJumpFact } from '../src/surfaces/minecraft/minecraftLlmcShiftFacts.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';

const frame = (world: Record<string, unknown>, stateAt = '2026-11-24T15:50:00.000Z'): BodyObservation =>
  ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt, receivedAt: stateAt, connected: true, state: { world }, facts: {} }) as unknown as BodyObservation;

describe('the line of recent moves is not said while she is attacked', () => {
  const timing = { wakeMs: 6000, leftMs: 0, hops: [4, 4, 5], decisionsMs: [2800] };
  it('is said in a calm frame and not with a hostile within 8 m or health 12 or less', () => {
    expect(underAttack(null)).toBe(false);
    expect(underAttack(frame({ health: 20, nearbyThreats: [{ distance: 20 }] }))).toBe(false);
    expect(underAttack(frame({ health: 20, nearbyThreats: [{ distance: 6.9 }] }))).toBe(true);
    expect(underAttack(frame({ health: 12 }))).toBe(true);
    expect(queueLines([], frame({ health: 20 }), { progress: null, leftMs: 0 }, timing)).toContain(hopsLine([4, 4, 5], [2800]));
    expect(queueLines([], frame({ health: 8 }), { progress: null, leftMs: 0 }, timing)).toEqual(['列に項目なし']);
  });
});

describe('the line of stopped moves', () => {
  it('is said from the third stop within a minute', () => {
    expect(reissueLine([50_000, 20_000])).toBeNull();
    expect(reissueLine([70_000, 50_000, 10_000])).toBeNull();
    const line = reissueLine([50_000, 30_000, 10_000])!;
    expect(line).toContain('3 回止めて');
    expect(line).toContain('同じ向きなら出し直さず走らせ');
  });
  it('comes with the lines of an empty queue', () => {
    const lines = queueLines([], null, { progress: null, leftMs: 0 }, { wakeMs: 6000, leftMs: 0, reissuedAgoMs: [50_000, 30_000, 10_000] });
    expect(lines).toEqual(['列に項目なし', reissueLine([50_000, 30_000, 10_000])]);
  });
});

describe('the line of items taken off the queue', () => {
  it('names the last three with the time it covers, and is silent when none', () => {
    expect(droppedLine([])).toBeNull();
    const line = droppedLine(['q12 作る（前の項目 q11 が止まった）', 'q13 装備（前の項目 q11 が止まった）'])!;
    expect(line).toContain('q12');
    expect(line).toContain('q13');
    expect(line).toContain('30 秒');
    expect(queueLines([], null, { progress: null, leftMs: 0 }, { wakeMs: 6000, leftMs: 0, droppedLately: ['q12 a'] })[1]).toContain('q12 a');
  });
});

describe('the far enemies say their height', () => {
  it('words a group by its heights against her feet', () => {
    expect(heightWords([])).toBe('');
    expect(heightWords([-56, -47, -50])).toBe('（下 47〜56）');
    expect(heightWords([-12])).toBe('（下 12）');
    expect(heightWords([5, 9])).toBe('（上 5〜9）');
    expect(heightWords([-1, 2])).toBe('');
    expect(heightWords([-20, 8])).toBe('（下 20〜上 8）');
  });
  it('puts it after each kind of the 「ほか」 line (skeletons 56 blocks down are not on the surface)', () => {
    const body = { threats: ['#6223 creeper 24.4m (-121,68,-111)', '#6510 skeleton 60.4m (-130,12,-124)', '#6508 skeleton 60.5m (-131,12,-126)',
      '#6317 spider 59.4m (-55,71,-156)'] };
    const out = mergeEnemies(body, { x: -109, y: 68, z: -123 });
    const far = out.threats!.find(line => line.startsWith('ほか'))!;
    expect(far).toContain('skeleton（飛び道具） 2（下 56）');
    expect(far).toContain('spider 1・');
  });
});

describe('the clock and the respawn facts', () => {
  beforeEach(() => forgetShiftFacts());
  const at = (seconds: number) => new Date(Date.parse('2026-11-24T15:50:00.000Z') + seconds * 1000).toISOString();
  it('says nothing at the first reading or at the game pace, and a jump once', () => {
    expect(timeJumpFact('t', frame({ timeOfDay: 5000, dimension: 'overworld' }, at(0)))).toBeNull();
    expect(timeJumpFact('t', frame({ timeOfDay: 5000 + 20 * 5, dimension: 'overworld' }, at(5)))).toBeNull();
    const jump = timeJumpFact('t', frame({ timeOfDay: 13_500, dimension: 'overworld' }, at(10)))!;
    expect(jump.text).toContain('昼→夜');
    expect(jump.text).toContain('進んだ');
    expect(recentJumpLine('t', Date.now())).toContain('時刻が急に変わった');
    expect(recentJumpLine('t', Date.now() + 6 * 60_000)).toBeNull();
  });
  it('reads a night skipped by a bed', () => {
    timeJumpFact('s', frame({ timeOfDay: 17_000, dimension: 'overworld' }, at(0)));
    expect(timeJumpFact('s', frame({ timeOfDay: 30 + 24_000 * 0, dimension: 'overworld' }, at(30)))!.text).toContain('夜→');
  });
  it('is not read in the Nether', () => {
    timeJumpFact('n', frame({ timeOfDay: 1000, dimension: 'the_nether' }, at(0)));
    expect(timeJumpFact('n', frame({ timeOfDay: 9000, dimension: 'the_nether' }, at(1)))).toBeNull();
  });
  it('puts a fresh respawn in one line: the empty pack, who stands near, the hour and how far the drops are', () => {
    const world = { lastDeath: '12 秒前 「Zombie」に倒された (-100,64,-30)', position: { x: -103, y: 64, z: -72 }, timeOfDay: 14_000,
      nearbyThreats: [{ name: 'zombie', distance: 1.5 }, { name: 'zombie', distance: 3 }, { name: 'spider', distance: 4.5 }, { name: 'creeper', distance: 30 }] };
    const fact = respawnFact(frame(world))!;
    expect(fact.key).toBe('respawn:-100,64,-30');
    expect(fact.text).toContain('水平 42 m');
    expect(fact.text).toContain('zombie 2・spider 1');
    expect(fact.text).toContain('今は夜');
    expect(fact.text).toContain('身を守る手');
    expect(respawnFact(frame({ ...world, lastDeath: '3 分前 「Zombie」に倒された (-100,64,-30)' }))).toBeNull();
    expect(respawnFact(frame({ position: world.position }))).toBeNull();
  });
});
