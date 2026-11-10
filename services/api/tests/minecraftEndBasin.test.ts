import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { endViewOf } from '../src/surfaces/minecraft/minecraftEndView.js';
import { climbNow, dragonBasinLine, dragonWaitLine, endFightLines, noBowLine } from '../src/surfaces/minecraft/minecraftEndFacts.js';
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
    expect(after[index + 1]!.startsWith(dragonBasinLine(view())!)).toBe(true);
    expect(after.some(line => line.includes('竜の息の雲:') && line.includes('火の玉:'))).toBe(true);
    expect(after.filter(line => line.includes('phase 6'))).toHaveLength(1);
  });

  it('puts the sword act beside the footing while no bed hand shows (no bed held), and not beside a bed hand or with three crystals standing', () => {
    const basinOf = (lines: string[]) => lines.find(line => line.startsWith('窪みの足場'))!;
    const sword = 'attack target=ender_dragon seconds=30 onFail="continue"';
    expect(basinOf(endFightLines(view()))).toContain(`go range=0.5 seconds=12 → 剣を持って ${sword}`);
    const bed = [{ stand: at(20), walkMeters: 4, foot: at(22), head: at(23), build: [], selfExpected: 3, dragonExpected: 40 }];
    const withBed = endFightLines(view({ ...approach(), bed }), 'white_bed');
    expect(withBed.some(line => line.startsWith('ベッドの手（体が測った候補）'))).toBe(true);
    expect(basinOf(withBed)).toBe(dragonBasinLine(view()));
    const three = world();
    const standing = endViewOf(frame({ ...three, crystals: { ...three.crystals, remaining: 3 } }));
    expect(basinOf(endFightLines(standing))).toBe(dragonBasinLine(standing));
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

describe('the waiting cells beside the perch (phases 3 to 7)', () => {
  const cell = (x: number, walkSeconds: number) => ({ ...at(x), walkMeters: walkSeconds * 4, walkSeconds, side: 0.1 });
  const only = (wait: unknown) => ({ strike: [], stage: [], retreat: [], wait });
  it('says them nearest by walking time, at most three, in the landing and the take-off too', () => {
    for (const phase of [3, 4, 5, 6, 7]) {
      const end = view(only([cell(40, 6), cell(41, 2), cell(42, 9), cell(43, 12)]), phase);
      expect(dragonWaitLine(end)).toBe('待ち場の候補（竜の向きの横 10〜14m の足場）3 件: (41,72,-11) 歩く約 2 秒 / (40,72,-11) 歩く約 6 秒 / (42,72,-11) 歩く約 9 秒');
    }
    expect(endFightLines(view(only([cell(40, 6)]), 3)).some(line => line.startsWith('待ち場の候補'))).toBe(true);
  });
  it.each([0, 1, 2, 8, 10])('says where to wait for the next sit while she flies (phase %s), the far ones as a straight line for go', phase => {
    const far = { ...at(52), walkMeters: 61.4, walkSeconds: 14.2, side: 0.3, straight: true };
    expect(dragonWaitLine(view(only([far, cell(41, 2)]), phase))).toBe('待ち場の候補（次の座りを待つ所、止まり木から 10〜14m）2 件: (41,72,-11) 歩く約 2 秒 / (52,72,-11) 直線約 61m（道は go が引く）');
    expect(endFightLines(view(only([far]), phase)).some(line => line.startsWith('待ち場の候補（次の座り'))).toBe(true);
    expect(endFightLines(view(only([far]), phase)).some(line => line.startsWith('止まり木の位置'))).toBe(false);
  });
  it('tells a body standing on the perch while she flies not to wait there (her landing breath falls in the basin)', () => {
    const near = endViewOf(frame({ ...world(only([cell(41, 2)]), 1), position: at(27) }));
    expect(dragonWaitLine(near)).toBe('今いる (27,72,-11) は止まり木から 1m で、待ち場ではない: 着地の前の息の雲が落ちる所で、窪みから歩いて出る道が無い。ここで待たず下の候補へ go して待つ。'
      + '待ち場の候補（次の座りを待つ所、止まり木から 10〜14m）1 件: (41,72,-11) 歩く約 2 秒');
    expect(dragonWaitLine(endViewOf(frame({ ...world(only([cell(41, 2)]), 6), position: at(27) })))).not.toContain('ここで待たず');
    // The urgent decision after a fireball's reflex keeps it too; away from the perch the short set has no waiting line.
    const short = (position: object) => createEndgame(null).lines(frame({ ...world(only([cell(41, 2)]), 1), position }), true).short.join('\n');
    expect(short(at(27))).toContain('ここで待たず下の候補へ go して待つ。待ち場の候補');
    expect(short(at(12))).not.toContain('待ち場の候補');
  });
  it('says the shooting places cannot be used without a bow or arrows, and keeps them when that is unknown', () => {
    const without = endFightLines(view(), null, false).join('\n');
    expect(without).toContain('クリスタルの射点: 弓か矢が無いので射点は使わない');
    expect(without).toContain('今登れる（竜は止まり木）');
    expect(without).not.toMatch(/撃てる位置|同じ射点/u);
    expect(endFightLines(view()).join('\n')).toContain('同じ射点: (13,72,-11) から 2 基');
    expect(endFightLines(view(), null, true).join('\n')).toContain('撃てる位置 (13,72,-11)');
  });
  it('says from her phase and distance whether to climb a pillar now, with the nearest uncaged crystal (e04e: 250 s waiting at 26-56 m)', () => {
    const crystal = (id: number, x: number, caged: boolean, distance: number) => ({ id, position: at(x, 100), caged, distance });
    const flying = (phase: number, distance: number | null) => {
      const base = world(approach(), phase);
      return endViewOf(frame({ ...base, position: at(12, 64), dragon: { ...base.dragon, perched: false, distance },
        crystals: { ...base.crystals, list: [crystal(14, 40, true, 20), crystal(15, 50, false, 38)] } }));
    };
    const line = (phase: number, distance: number | null) => noBowLine(flying(phase, distance));
    expect(line(0, 32)).toContain('今登れる（竜は phase 0 で自分から 32m、30m 以上');
    expect(line(0, 32)).toContain('檻なしで竜から遠く低い #15 (50,100,-11) 自分から 38m の柱の脇へ walk → vertical pillar up で上端の 1〜2 段下まで（約 34 段）');
    expect(line(0, null)).toContain('今登れる（竜が見えない');
    expect(line(0, 20)).toContain('まだ登らない（竜が自分から 20m、30m 未満）: #15 (50,100,-11) 自分から 38m の柱の根へ寄り');
    for (const phase of [1, 8]) expect(line(phase, 50)).toContain(`今は登らない（竜は`);
    expect(line(6, 10)).toContain('今登れる（竜は止まり木）');
    // Uncaged and away from her first, then the least climb: #17 is low but beside her, #16 is lower than #15.
    const base = world(approach(), 0);
    const choose = endViewOf(frame({ ...base, position: at(12, 64), dragon: { ...base.dragon, perched: false, distance: 40, position: at(80, 90) },
      crystals: { ...base.crystals, list: [crystal(14, 40, true, 20), crystal(15, 50, false, 38), { ...crystal(16, -20, false, 32), position: at(-20, 80) },
        { ...crystal(17, 85, false, 73), position: at(85, 70) }] } }));
    expect(noBowLine(choose)).toContain('#16 (-20,80,-11) 自分から 32m');
    // Only the two caged ones left: the bed, not a pillar.
    const cagedOnly = endViewOf(frame({ ...base, position: at(12, 64), dragon: { ...base.dragon, perched: false, distance: 40 },
      crystals: { ...base.crystals, remaining: 2, list: [crystal(14, 40, true, 20), crystal(18, -40, true, 45)] } }));
    expect(noBowLine(cagedOnly)).toContain('檻なしの結晶はもう無い（残りは檻つき 2 本）');
    expect(noBowLine(cagedOnly)).not.toContain('pillar up');
    expect(climbNow(cagedOnly)).toBe(false);
  });
  it('keeps only the waiting cells of a full approach sent while she flies', () => {
    const end = view({ ...approach(), wait: [cell(41, 2)] }, 8);
    expect(end?.dragon?.approach).toEqual({ strike: [], stage: [], retreat: [], wait: [{ ...cell(41, 2), straight: false }] });
    expect(dragonBasinLine(end)).toBeNull();
  });
  it('says nothing without the field, outside the phases, or with an empty or malformed list', () => {
    expect(dragonWaitLine(view(only(undefined), 3))).toBeNull();
    expect(dragonWaitLine(view(only([cell(40, 6)]), 9))).toBeNull();
    expect(dragonWaitLine(view(only([]), 3))).toBeNull();
    expect(dragonWaitLine(view(only([{ x: 'a', y: 1, z: 2 }]), 3))).toBeNull();
  });
});
