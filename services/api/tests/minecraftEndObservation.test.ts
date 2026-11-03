import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { endViewOf } from '../src/surfaces/minecraft/minecraftEndView.js';
import { crystalOpeningLine, crystalShootSetsLine, dragonApproachLine, dragonLine, endFightLines } from '../src/surfaces/minecraft/minecraftEndFacts.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { factsContext, type LlmcBodyParts } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { inputFacts } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';

// Synthetic positions, independent of any island or seed. Field shapes follow S1's dragonOpenings / dragonApproach.
const at = (x: number, y = 70, z = 12) => ({ x, y, z });
const shot = (x: number, distance = 30) => ({ ...at(x), distance, pitchDeg: 25, flightTicks: 18 });
const strike = (x: number, walkMeters = 10) => ({ ...at(x), headReach: 3.5, walkMeters });
const stage = (x: number, strikeIndex = 0, toStrikeMeters = 4) => ({ ...at(x), strikeIndex, toStrikeMeters, walkMeters: 8 });
const windows = (open = false) => ({ source: 'shannon-lab-2026-11-02', open, secondsUntil: open ? [0, 0] : [3, 4],
  lengthSeconds: [2.45, 2.55], remainingSeconds: open ? [1, 1.1] : null });
const approach = () => ({ strike: [strike(14), strike(18, 12)], stage: [stage(20, 1, 2), stage(22, 0, 6)], retreat: [{ ...at(26), walkMeters: 15 }] });
const world = () => ({ dimension: 'the_end', position: at(10), health: 20, food: 20, inventory: [],
  dragon: { id: 90, health: 150, phase: 5, phaseFor: 6, perched: true, position: at(15, 74), windows: windows(), approach: approach() },
  crystals: { remaining: 3, gone: 7, caged: 0, unseen: [], list: [],
    openings: [{ id: 11, caged: false, positions: [shot(13)] }, { id: 12, caged: false, positions: [shot(11, 42)] }],
    shootSets: [{ at: at(17), crystals: [11, 12], walkMeters: 9 }, { at: at(12), crystals: [11, 12, 13], walkMeters: 2 }],
    stats: { ms: 19.4, examinedCells: 120, gridStep: 2, truncated: true } },
  perch: at(16, 74), dragonBreath: [{ ...at(28), radius: 3, dangerRadius: 7 }], dragonFireballs: 1 });
const frame = (world: object): BodyObservation => ({ schemaVersion: 1, bodyId: 'end-test', sequence: 1, stateAt: new Date(0).toISOString(),
  receivedAt: new Date(0).toISOString(), connected: true, state: { world }, facts: {} }) as unknown as BodyObservation;
const view = (value: object = world()) => endViewOf(frame(value));
const parts = (): LlmcBodyParts => ({ plan: () => undefined, planView: () => null, planTree: () => seedPlan('エンドラを討伐して')!, endgame: createEndgame(null) });

describe('optional End observations as facts', () => {
  it('reads the full contract, including ranges, shot details, original strike indexes and search stats', () => {
    const end = view()!;
    expect(end.crystals.openings?.[0]).toMatchObject({ id: 11, caged: false, positions: [shot(13)] });
    expect(end.crystals.shootSets?.map(set => set.walkMeters)).toEqual([2, 9]);
    expect(end.crystals.stats).toEqual(world().crystals.stats);
    expect(end.dragon?.windows).toEqual(windows());
    expect(end.dragon?.approach?.strike.map(point => point.index)).toEqual([0, 1]);
    expect(end.dragon?.approach?.stage[0]).toEqual(stage(20, 1, 2));
    const lines = endFightLines(end);
    expect(lines).toHaveLength(6);
    expect(lines.join('\n')).toContain('射点探索: 120 マス・格子 2m・打ち切り');
    expect(lines.join('\n')).not.toContain('19.4');
    expect(lines.join('\n')).toContain('窓まで 3〜4 秒（窓は 2.45〜2.55 秒）（実測目安）');
    expect(dragonApproachLine(end)).toBe('止まり木の位置: 頭の下 strike (18,70,12)・待つ所 stage (20,70,12)（strike まで 2 m）・退く所 retreat (26,70,12)');
    expect(lines.some(line => line.includes('竜の息の雲:') && line.includes('火の玉:'))).toBe(true);
  });

  it('orders shooting places by proximity to the feet, not distance to the crystal, and sets by walking distance', () => {
    expect(crystalOpeningLine(view())).toBe('クリスタルの射点: #12 撃てる位置 (11,70,12) 距離 42m・#11 撃てる位置 (13,70,12) 距離 30m');
    expect(crystalShootSetsLine(view())).toBe('同じ射点: (12,70,12) から 3 基（歩き 2 m） [#11,#12,#13]・(17,70,12) から 2 基（歩き 9 m） [#11,#12]');
  });

  it('keeps a caged position hypothetical and names the blocking block; it never offers positions as clear for a caged crystal', () => {
    const raw = world();
    const end = view({ ...raw, crystals: { ...raw.crystals, openings: [{ id: 13, caged: true, positions: [shot(99)],
      blockedBy: { ...at(24, 86), name: 'iron_bars' }, afterCageRemoved: [shot(12, 35)] }] } });
    expect(crystalOpeningLine(end)).toBe('クリスタルの射点: #13 檻 (iron_bars (24,86,12)) を取ると撃てる位置 (12,70,12) 距離 35m');
    expect(crystalOpeningLine(end)).not.toContain('(99,');
    expect(crystalOpeningLine(view({ crystals: { openings: [{ id: 13, caged: true, positions: [shot(99)] }] } }))).toBeNull();
  });

  it('leaves missing fields unknown without inventing a point, a distance, a window length or a closed window', () => {
    const partial = view({ dragon: { phase: 6, windows: { open: true }, approach: { stage: [{ ...at(20), strikeIndex: 0 }] } },
      crystals: { openings: [{ id: 11, positions: [at(13)] }] } });
    expect(dragonLine(partial)).toContain('窓は開いている');
    expect(dragonLine(partial)).not.toContain('2.5');
    expect(crystalOpeningLine(partial)).toBe('クリスタルの射点: #11 撃てる位置 (13,70,12)');
    expect(dragonApproachLine(partial)).toBe('止まり木の位置: 待つ所 stage (20,70,12)');
    expect(dragonLine(view({ dragon: { windows: {} } }))).toBeNull();
    expect(endFightLines(view({ crystals: {} }))).toEqual([]);
    expect(endFightLines(endViewOf(null))).toEqual([]);
    expect(view({ dragon: { windows: [], approach: true }, crystals: { openings: {}, shootSets: null, stats: false } })?.dragon).not.toHaveProperty('windows');
  });

  it.each([0, 3, 4, 8, null])('ignores approach outside the perched phases, even when the body sends a stale approach (phase %s)', phase => {
    const raw = world();
    const end = view({ ...raw, dragon: { ...raw.dragon, phase, perched: true } });
    expect(end?.dragon).not.toHaveProperty('approach');
    expect(dragonApproachLine(end)).toBeNull();
    expect(endFightLines(end).join('\n')).not.toMatch(/strike|stage|retreat/u);
  });

  it.each([5, 6, 7])('reads the approach in perched phase %s', phase => {
    const raw = world();
    expect(dragonApproachLine(view({ ...raw, dragon: { ...raw.dragon, phase } }))).toContain('頭の下 strike');
  });

  it('bounds and deduplicates shooting places and groups, preserving hazards within six lines', () => {
    const raw = world();
    const end = view({ ...raw, crystals: { ...raw.crystals,
      openings: [{ id: 11, caged: false, positions: [shot(11), shot(11), shot(12)] },
        ...Array.from({ length: 12 }, (_, i) => ({ id: i + 20, caged: false, positions: Array.from({ length: 6 }, (_, n) => shot(13 + i + n)) }))],
      shootSets: [9, 2, 1, 5, 3].map(walkMeters => ({ at: at(10 + walkMeters), walkMeters, crystals: [11, 12, 12] })) } });
    expect(end?.crystals.openings).toHaveLength(10);
    expect(end?.crystals.openings?.every(opening => opening.positions.length <= 3)).toBe(true);
    expect(end?.crystals.shootSets).toHaveLength(3);
    const openings = crystalOpeningLine(end)!;
    expect(openings.match(/撃てる位置/gu)).toHaveLength(3);
    expect(openings.match(/\(11,70,12\)/gu)).toHaveLength(1);
    const sets = crystalShootSetsLine(end)!;
    expect(sets.match(/ から /gu)).toHaveLength(2);
    expect(sets).toContain('歩き 1 m');
    expect(sets).toContain('歩き 2 m');
    expect(sets).not.toContain('歩き 3 m');
    expect(sets).not.toContain('3 基');
    expect(endFightLines(end)).toHaveLength(6);
  });

  it('bounds approach arrays, displaying one associated pair and one retreat', () => {
    const raw = world();
    const end = view({ ...raw, dragon: { ...raw.dragon, approach: { strike: Array.from({ length: 8 }, (_, i) => strike(30 + i)),
      stage: Array.from({ length: 8 }, (_, i) => stage(40 + i, i % 3, i + 2)),
      retreat: Array.from({ length: 8 }, (_, i) => ({ ...at(50 + i), walkMeters: i + 10 })) } } });
    expect(end?.dragon?.approach?.strike).toHaveLength(3);
    expect(end?.dragon?.approach?.stage).toHaveLength(3);
    expect(end?.dragon?.approach?.retreat).toHaveLength(2);
    expect(dragonApproachLine(end)!.match(/頭の下 strike/gu)).toHaveLength(1);
    expect(dragonApproachLine(end)!.match(/退く所 retreat/gu)).toHaveLength(1);
  });

  it.each(['x', 'y', 'z'] as const)('rejects nonfinite %s coordinates in every new positional field', axis => {
    const bad = { ...at(11), [axis]: Infinity };
    const raw = world();
    const end = view({ ...raw, crystals: { ...raw.crystals, openings: [{ id: 11, caged: false, positions: [{ ...shot(11), ...bad }] },
      { id: 12, caged: true, blockedBy: { ...bad, name: 'iron_bars' }, afterCageRemoved: [{ ...shot(11), [axis]: NaN }] }],
      shootSets: [{ at: bad, crystals: [11, 12], walkMeters: 1 }] }, dragon: { ...raw.dragon, approach: {
        strike: [{ ...strike(11), ...bad }], stage: [{ ...stage(12), ...bad }], retreat: [{ ...bad, walkMeters: 3 }] } } });
    expect(end?.crystals.openings?.[1]?.blockedBy).toBeNull();
    expect(crystalOpeningLine(end)).toBeNull();
    expect(crystalShootSetsLine(end)).toBeNull();
    expect(dragonApproachLine(end)).toBeNull();
    expect(endFightLines(end).join('\n')).not.toMatch(/Infinity|NaN/u);
  });

  it('does not shift a stage to another strike after dropping an invalid strike coordinate', () => {
    const raw = world();
    const end = view({ ...raw, dragon: { ...raw.dragon, approach: { strike: [{ ...strike(14), x: -Infinity }, strike(18)],
      stage: [stage(22, 0, 1), stage(20, 1, 2)], retreat: [] } } });
    expect(end?.dragon?.approach?.strike.map(point => point.index)).toEqual([1]);
    expect(dragonApproachLine(end)).toBe('止まり木の位置: 頭の下 strike (18,70,12)・待つ所 stage (20,70,12)（strike まで 2 m）');
    const dangling = view({ dragon: { phase: 6, approach: { strike: [{ ...strike(14), x: NaN }, strike(18)], stage: [stage(22, 0, 1)] } } });
    expect(dragonApproachLine(dangling)).toBe('止まり木の位置: 待つ所 stage (22,70,12)');
  });

  it('keeps malformed numeric ranges, booleans and distances unknown and does not infer windows from phase time', () => {
    const end = view({ dragon: { phase: 6, phaseFor: 1, windows: { open: 'true', secondsUntil: [4, 3], lengthSeconds: [2, Infinity], remainingSeconds: [-1, 2] } },
      crystals: { openings: [{ id: 11, positions: [{ ...shot(11), distance: NaN }] }],
        stats: { ms: Infinity, examinedCells: NaN, gridStep: '2', truncated: 'true' } } });
    expect(end?.dragon?.windows).toMatchObject({ open: null, secondsUntil: null, lengthSeconds: null, remainingSeconds: null });
    expect(dragonLine(end)).not.toContain('窓');
    expect(crystalOpeningLine(end)).not.toContain('距離');
    expect(endFightLines(end).join('\n')).not.toMatch(/Infinity|NaN|射点探索/u);
  });

  it('retains the open window and associated stage/strike through factsContext and both urgent and compressed inputFacts', () => {
    const raw = world();
    const observation = frame({ ...raw, dragon: { ...raw.dragon, windows: windows(true) } });
    const context = factsContext(parts(), observation, {}, undefined);
    for (const urgent of [false, true]) {
      const facts = inputFacts(observation, context, urgent);
      for (const lines of [facts.lines, facts.compressed]) {
        const text = lines.join('\n');
        expect(text).toContain('窓は開いている');
        expect(text).toContain('頭の下 strike (18,70,12)');
        expect(text).toContain('待つ所 stage (20,70,12)（strike まで 2 m）');
        expect(text.match(/窓は開いている/gu)).toHaveLength(1);
        expect(text.match(/待つ所 stage/gu)).toHaveLength(1);
      }
      expect(facts.compressed.join('\n')).not.toMatch(/クリスタルの射点:|同じ射点:|退く所 retreat|射点探索:|2\.45/u);
      if (urgent) expect(facts.lines.join('\n')).not.toMatch(/クリスタルの射点:|同じ射点:|退く所 retreat|射点探索:|2\.45/u);
      else expect(facts.lines.join('\n')).toContain('退く所 retreat');
    }
  });

  it('reads each frame afresh, without retaining an approach after takeoff or adding End facts to another task', () => {
    const body = parts(), raw = world();
    const first = frame(raw);
    expect(inputFacts(first, factsContext(body, first, {}, undefined), false).lines.join('\n')).toContain('待つ所 stage');
    const next = frame({ ...raw, dragon: { id: 90, phase: 4, perched: false }, crystals: { remaining: 0 } });
    expect(inputFacts(next, factsContext(body, next, {}, undefined), false).lines.join('\n')).not.toMatch(/窓|strike|stage|retreat|射点/u);
    const other: LlmcBodyParts = { ...parts(), planTree: () => seedPlan('ネザーに行って')! };
    expect(inputFacts(first, factsContext(other, first, {}, undefined), false).lines.join('\n')).not.toMatch(/窓|strike|stage|retreat|クリスタル/u);
  });
});
