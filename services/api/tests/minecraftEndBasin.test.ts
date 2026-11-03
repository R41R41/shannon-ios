import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { endViewOf } from '../src/surfaces/minecraft/minecraftEndView.js';
import { dragonBasinLine, endFightLines } from '../src/surfaces/minecraft/minecraftEndFacts.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { factsContext, type LlmcBodyParts } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { inputFacts } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';

// Synthetic coordinates, independent of any island or seed. Fields follow S1's DragonApproach.basin.
const at = (x: number, y = 72, z = -11) => ({ x, y, z });
const footing = (x: number, walkMeters = 8, walkSeconds = 1.9) => ({ ...at(x), walkMeters, walkSeconds,
  headReach: 2.8, inWingPush: false, inBreathNow: false, side: -0.25 });
const approach = () => ({ strike: [{ ...at(23), headReach: 3, walkMeters: 6 }],
  stage: [{ ...at(20), strikeIndex: 0, toStrikeMeters: 3, walkMeters: 3 }], retreat: [{ ...at(15), walkMeters: 8 }],
  basin: [footing(24)] });
const world = (entry: unknown = approach(), phase: number | null = 6) => ({ dimension: 'the_end', position: at(12), health: 20, food: 20, inventory: [],
  dragon: { id: 90, health: 150, phase, perched: true, position: at(25, 76), approach: entry }, perch: at(26, 76),
  crystals: { remaining: 2, gone: 8, caged: 0, unseen: [], list: [],
    openings: [{ id: 11, caged: false, positions: [{ ...at(13), distance: 30 }] }],
    shootSets: [{ at: at(13), crystals: [11, 12], walkMeters: 1 }] },
  dragonBreath: [{ ...at(30), radius: 3, dangerRadius: 7 }], dragonFireballs: 1 });
const frame = (world: object): BodyObservation => ({ schemaVersion: 1, bodyId: 'end-basin-test', sequence: 1,
  stateAt: new Date(0).toISOString(), receivedAt: new Date(0).toISOString(), connected: true, state: { world }, facts: {} }) as unknown as BodyObservation;
const view = (entry: unknown = approach(), phase: number | null = 6) => endViewOf(frame(world(entry, phase)));
const parts = (): LlmcBodyParts => ({ plan: () => undefined, planView: () => null,
  planTree: () => seedPlan('エンドラを討伐して')!, endgame: createEndgame(null) });

describe('the perched dragon basin as observed facts', () => {
  it('reads every basin field and reports walking seconds, wing push and breath, nearest by walking distance', () => {
    const near = { ...footing(28, 4, 0.9), inWingPush: true, inBreathNow: true, side: 0.5 };
    const end = view({ ...approach(), basin: [footing(24), near] });
    expect(end?.dragon?.approach?.basin).toEqual([near, footing(24)]);
    const line = dragonBasinLine(end)!;
    expect(line).toBe('窪みの足場 2 件: (28,72,-11) 歩く約 0.9 秒・翼の押し ⚠範囲内・息 範囲内 / (24,72,-11) 歩く約 1.9 秒・翼の押し 範囲外・息 範囲外');
    expect(line).not.toMatch(/phase|見回|go|attack|せよ/u);
  });

  it('keeps an absent basin absent and adds no line for a body without that field', () => {
    const { basin: _basin, ...withoutBasin } = approach();
    const end = view(withoutBasin);
    expect(end?.dragon?.approach).not.toHaveProperty('basin');
    expect(dragonBasinLine(end)).toBeNull();
    expect(endFightLines(end)).toHaveLength(6);
    expect(endFightLines(end).join('\n')).not.toContain('窪みの足場');
    expect(dragonBasinLine(endViewOf(null))).toBeNull();
  });

  it.each([
    { name: 'empty array', basin: [] }, { name: 'null', basin: null }, { name: 'object', basin: {} },
    { name: 'boolean', basin: false }, { name: 'string', basin: 'basin' },
  ])('adds no basin line for an empty or malformed field ($name)', ({ basin }) => {
    const end = view({ ...approach(), basin });
    expect(dragonBasinLine(end)).toBeNull();
    expect(endFightLines(end).join('\n')).not.toContain('窪みの足場');
  });

  it('retains partial footings with unknown values and does not turn route metres into seconds', () => {
    const end = view({ basin: [at(24), { ...at(25), walkMeters: 4, inWingPush: true },
      { ...at(26), walkMeters: 0, walkSeconds: 0, inBreathNow: false }, { x: 27, y: 72 }, null] });
    expect(end?.dragon?.approach?.basin).toEqual([
      { ...at(26), walkMeters: 0, walkSeconds: 0, headReach: null, inWingPush: null, inBreathNow: false, side: null },
      { ...at(25), walkMeters: 4, walkSeconds: null, headReach: null, inWingPush: true, inBreathNow: null, side: null },
      { ...at(24), walkMeters: null, walkSeconds: null, headReach: null, inWingPush: null, inBreathNow: null, side: null },
    ]);
    expect(dragonBasinLine(end)).toBe('窪みの足場 3 件: (26,72,-11) 歩く約 0 秒・翼の押し 不明・息 範囲外 / (25,72,-11)・翼の押し ⚠範囲内・息 不明 / (24,72,-11)・翼の押し 不明・息 不明');
  });

  it('keeps malformed optional numbers and booleans unknown', () => {
    const end = view({ basin: [{ ...footing(24), walkMeters: -1, walkSeconds: Infinity, headReach: '2.8',
      inWingPush: 'false', inBreathNow: 0, side: NaN }] });
    expect(end?.dragon?.approach?.basin?.[0]).toEqual({ ...at(24), walkMeters: null, walkSeconds: null, headReach: null,
      inWingPush: null, inBreathNow: null, side: null });
    expect(dragonBasinLine(end)).toBe('窪みの足場 1 件: (24,72,-11)・翼の押し 不明・息 不明');
  });

  it.each(['x', 'y', 'z'] as const)('rejects nonfinite or nonnumeric %s coordinates', axis => {
    const bad = [Infinity, -Infinity, NaN, '24', null].map(value => ({ ...footing(24), [axis]: value }));
    const end = view({ basin: [...bad, footing(28)] });
    expect(end?.dragon?.approach?.basin).toEqual([footing(28)]);
    expect(dragonBasinLine(end)).toContain('窪みの足場 1 件: (28,72,-11)');
    expect(endFightLines(end).join('\n')).not.toMatch(/Infinity|NaN/u);
    expect(dragonBasinLine(view({ basin: bad }))).toBeNull();
  });

  it('keeps only the three nearest valid footings, sorting before truncation', () => {
    const basin = [footing(24, 20), footing(25, 8), footing(26, 12), footing(27, 4), footing(28, 2)];
    const end = view({ basin });
    expect(end?.dragon?.approach?.basin).toEqual([basin[4], basin[3], basin[1]]);
    const line = dragonBasinLine(end)!;
    expect(line).toContain('窪みの足場 3 件: (28,72,-11)');
    expect(line.indexOf('(27,72,-11)')).toBeLessThan(line.indexOf('(25,72,-11)'));
    expect(line).not.toMatch(/\(24,|\(26,/u);
  });

  it.each([5, 6, 7])('reports basin footing in perched phase %s', phase => {
    expect(dragonBasinLine(view(approach(), phase))).toContain('窪みの足場 1 件:');
  });

  it.each([0, 1, 2, 3, 4, 8, 9, 10, null])('omits a stale basin outside perched phases, even with perched=true (phase %s)', phase => {
    const end = view(approach(), phase);
    expect(end?.dragon).not.toHaveProperty('approach');
    expect(dragonBasinLine(end)).toBeNull();
    expect(endFightLines(end).join('\n')).not.toContain('窪みの足場');
  });

  it('adds exactly one line next to approach, preserving every existing fight fact and both hazards', () => {
    const { basin: _basin, ...withoutBasin } = approach();
    const before = endFightLines(view(withoutBasin)), after = endFightLines(view());
    expect(before).toHaveLength(6);
    expect(after).toHaveLength(before.length + 1);
    expect(after.filter(line => !line.startsWith('窪みの足場'))).toEqual(before);
    const index = after.findIndex(line => line.startsWith('止まり木の位置:'));
    expect(after[index + 1]).toBe(dragonBasinLine(view()));
    expect(after.some(line => line.includes('竜の息の雲:') && line.includes('火の玉:'))).toBe(true);
    expect(after.filter(line => line.includes('phase 6'))).toHaveLength(1);
  });

  it('reaches normal inputFacts through factsContext, stays out of urgent/compressed facts, and disappears on the next absent frame', () => {
    const body = parts(), observation = frame(world());
    const context = factsContext(body, observation, {}, undefined);
    for (const urgent of [false, true]) {
      const facts = inputFacts(observation, context, urgent);
      expect(facts.lines.some(line => line.startsWith('窪みの足場'))).toBe(!urgent);
      expect(facts.compressed.join('\n')).not.toContain('窪みの足場');
      expect(facts.lines.join('\n')).toContain('頭の下 strike');
      expect(facts.compressed.join('\n')).toContain('頭の下 strike');
    }
    const { basin: _basin, ...withoutBasin } = approach();
    const next = frame(world(withoutBasin));
    expect(inputFacts(next, factsContext(body, next, {}, undefined), false).lines.join('\n')).not.toContain('窪みの足場');
  });
});
