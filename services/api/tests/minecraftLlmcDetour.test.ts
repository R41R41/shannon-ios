import { afterEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { detourLines, forgetDetours, noteGoes, scaffoldLine } from '../src/surfaces/minecraft/minecraftLlmcDetour.js';
import { inputFacts } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';

/**
 * A long road walked as relay points: the head went back to the same relay point and did not see that the distance to where it was going did not
 * shrink; and a bridge was begun with 40 blocks that two gos used up. The two lines say the counts as facts (no hand is changed).
 */
afterEach(() => forgetDetours());

const WEST = { x: 40, y: 62, z: -262 }, EAST = { x: 70, y: 62, z: -270 };
const input = (to: { x: number; y: number; z: number }) => ({ hands: [{ do: 'go', to }] });
const result = (stopped: boolean, left?: number) => JSON.stringify({ v: 1, ok: !stopped, done: stopped ? 0 : 1, of: 1, at: { x: 50, y: 62, z: -265 }, hp: 20, food: 20, ms: 5_000,
  lines: [{ i: 1, do: 'go', status: stopped ? 'stopped' : 'done', line: stopped ? 'go 止まった' : 'go 着いた', goal: stopped ? 'partial' : 'done', end: 'finished', motorOps: 2,
    ...(stopped && left !== undefined ? { code: 'search_timeout', progress: { unit: 'meter', done: 3, left, at: { x: 50, y: 62, z: -265 }, fromStopM: left } } : {}) }] });
const MIN = 60_000;

describe('detourLines: the gos of the node, said as facts', () => {
  it('says nothing for a straight road', () => {
    for (let i = 0; i < 4; i += 1) noteGoes('t', 'n1', input({ x: 40 + i * 50, y: 62, z: -262 }), result(false), i * MIN);
    expect(detourLines('t', 'n1', 4 * MIN)).toEqual([]);
  });

  it('counts the returns to a relay point and gives the distance to the present one, first and now', () => {
    const route = [[WEST, 60], [EAST, 61], [WEST, 40], [EAST, 55], [WEST, 38], [EAST, 52]] as const;
    route.forEach(([to, left], i) => noteGoes('t', 'n1', input(to), result(true, left), i * 90_000));
    const [line] = detourLines('t', 'n1', 9 * MIN);
    expect(line).toContain('6 回（止まった 6 回）');
    expect(line).toContain('同じ中継点 (40,62,-262) へ 2 回戻った（間に向かった所: (70,62,-270)）');
    expect(line).toContain('今の行き先 (70,62,-270) までの距離: 最初の go で 61 m → 今 52 m（3 回目）');
    expect(line).toContain('距離の変わり方を見て決める');
  });

  it('a new plan node starts the count again, and a node other than the one told has none', () => {
    for (let i = 0; i < 4; i += 1) noteGoes('t', 'n1', input(i % 2 ? EAST : WEST), result(true, 50), i * MIN);
    expect(detourLines('t', 'n1', 5 * MIN)).not.toEqual([]);
    expect(detourLines('t', 'n2', 5 * MIN)).toEqual([]);
    noteGoes('t', 'n2', input(EAST), result(true, 50), 6 * MIN);
    expect(detourLines('t', 'n1', 6 * MIN)).toEqual([]);
  });

  it('three stops at one relay point are said even with no return, and old gos fall out of the window', () => {
    for (let i = 0; i < 3; i += 1) noteGoes('t', 'n1', input(EAST), result(true, 30 - i), i * MIN);
    expect(detourLines('t', 'n1', 3 * MIN)[0]).toContain('今の行き先 (70,62,-270) までの距離: 最初の go で 30 m → 今 28 m（3 回目）');
    expect(detourLines('t', 'n1', 40 * MIN)).toEqual([]);
  });

  it('takes the path last cell and the goals first, and ignores a go that did not run', () => {
    noteGoes('t', 'n1', { hands: [{ do: 'go', path: [WEST, EAST] }] }, result(true, 10), 0);
    noteGoes('t', 'n1', { hands: [{ do: 'go', goals: [EAST, WEST] }] }, result(true, 9), MIN);
    const skipped = JSON.stringify({ v: 1, ok: false, done: 0, of: 1, at: WEST, hp: 20, food: 20, ms: 1,
      lines: [{ i: 0, do: 'go', status: 'skipped', line: '未実行', goal: 'not_started', end: 'not_run' }] });
    noteGoes('t', 'n1', input(WEST), skipped, 2 * MIN);
    noteGoes('t', 'n1', input(EAST), result(true, 8), 3 * MIN);
    const line = detourLines('t', 'n1', 4 * MIN)[0]!;
    expect(line).toContain('3 回（止まった 3 回）');
    expect(line).toContain('最初の go で 10 m → 今 8 m（3 回目）');
  });

  it('reads the 1-based line numbers of the body: a go alone, and a go before a fight and a pickup', () => {
    const lineOf = (i: number, doWhat: string, stopped = false) => ({ i, do: doWhat, status: stopped ? 'stopped' : 'done', line: doWhat, goal: stopped ? 'partial' : 'done', end: 'finished', motorOps: 1,
      ...(doWhat === 'go' && stopped ? { code: 'search_timeout', progress: { unit: 'meter', done: 3, left: 20, fromStopM: 20 } } : {}) });
    const act = (lines: unknown[]) => JSON.stringify({ v: 1, ok: false, done: 1, of: lines.length, at: { x: 122, y: 62, z: -316 }, hp: 20, food: 20, ms: 5_000, lines });
    const dest = { x: 128, y: 62, z: -318 };
    noteGoes('t', 'n1', { hands: [{ do: 'go', to: dest }] }, act([lineOf(1, 'go', true)]), 0);
    noteGoes('t', 'n1', { hands: [{ do: 'go', to: dest }, { do: 'fight', target: 'enderman' }, { do: 'pickup' }] }, act([lineOf(1, 'go', true), lineOf(2, 'fight'), lineOf(3, 'pickup')]), MIN);
    noteGoes('t', 'n1', { hands: [{ do: 'go', to: dest }, { do: 'fight', target: 'enderman' }, { do: 'pickup' }] }, act([lineOf(1, 'go', true), lineOf(2, 'fight'), lineOf(3, 'pickup')]), 2 * MIN);
    const line = detourLines('t', 'n1', 3 * MIN)[0]!;
    expect(line).toContain('3 回（止まった 3 回）');
    expect(line).toContain('今の行き先 (128,62,-318) までの距離: 最初の go で 20 m → 今 20 m（3 回目）');
  });

  it('a go after a fight in the same act is found by its own number', () => {
    const act = JSON.stringify({ v: 1, ok: true, done: 2, of: 2, at: WEST, hp: 20, food: 20, ms: 1, lines: [
      { i: 1, do: 'fight', status: 'done', line: 'f', goal: 'done', end: 'finished', motorOps: 1 },
      { i: 2, do: 'go', status: 'stopped', line: 'g', goal: 'partial', end: 'finished', motorOps: 1, progress: { unit: 'meter', done: 1, left: 9, fromStopM: 9 } }] });
    for (let i = 0; i < 3; i += 1) noteGoes('t', 'n1', { hands: [{ do: 'fight', target: 'enderman' }, { do: 'go', to: EAST }] }, act, i * MIN);
    expect(detourLines('t', 'n1', 3 * MIN)[0]).toContain('今の行き先 (70,62,-270)');
  });
});

const frame = (dimension: string, inventory: Array<{ name: string; count: number }>): BodyObservation =>
  ({ connected: true, facts: {}, state: { world: { dimension, inventory } } }) as unknown as BodyObservation;

describe('scaffoldLine: what she can place, before a bridge or a climb is chosen', () => {
  it('counts the blocks a go may place in the Nether, and says when they are below the marks of the knowledge', () => {
    const line = scaffoldLine(frame('nether', [{ name: 'netherrack', count: 2 }, { name: 'nether_bricks', count: 6 }, { name: 'cooked_beef', count: 9 }]))!;
    expect(line).toContain('nether_bricks×6・netherrack×2（合計 8 個）');
    expect(line).toContain('16 個を切っている');
    expect(line).not.toContain('cooked_beef');
    expect(scaffoldLine(frame('nether', [{ name: 'netherrack', count: 40 }]))).toContain('64 個の目安に足りない');
    expect(scaffoldLine(frame('nether', [{ name: 'netherrack', count: 99 }]))).not.toContain('目安に足りない');
    expect(scaffoldLine(frame('nether', []))).toContain('なし（合計 0 個）');
  });

  it('is said for the dimension names of the body (the_nether, the_end), with the roof use named', () => {
    const line = scaffoldLine(frame('the_nether', [{ name: 'netherrack', count: 4 }]))!;
    expect(line).toContain('netherrack×4（合計 4 個）');
    expect(line).toContain('fight の屋根');
    expect(scaffoldLine(frame('minecraft:the_nether', [{ name: 'netherrack', count: 4 }]))).not.toBeNull();
    expect(scaffoldLine(frame('the_end', [{ name: 'end_stone', count: 4 }]))).not.toBeNull();
  });

  it('is said in the Nether and the End only, and it is in the facts of a normal input but not of an urgent one', () => {
    expect(scaffoldLine(frame('overworld', [{ name: 'cobblestone', count: 3 }]))).toBeNull();
    const nether = frame('the_nether', [{ name: 'netherrack', count: 40 }]);
    expect(inputFacts(nether, {}, false).lines.some(line => line.startsWith('置ける足場'))).toBe(true);
    expect(inputFacts(nether, {}, true).lines.some(line => line.startsWith('置ける足場'))).toBe(false);
  });

  it('the detour line goes through the facts at every decision (not once)', () => {
    const nether = frame('nether', [{ name: 'netherrack', count: 40 }]);
    const detour = ['この段の go: 例'];
    expect(inputFacts(nether, { detour }, false).lines).toContain(detour[0]);
    expect(inputFacts(nether, { detour }, false).compressed).toContain(detour[0]);
    expect(inputFacts(nether, { detour }, true).lines).toContain(detour[0]);
  });
});
