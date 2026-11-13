import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { createEyeLedger, ledgerLines } from '../src/surfaces/minecraft/minecraftEyeLedger.js';
import { bearingBetween } from '../src/surfaces/minecraft/minecraftEyeTriangulation.js';
import { eyeThrowHold, registerEyeLedger } from '../src/surfaces/minecraft/minecraftEyeThrowHold.js';
import { diamondClusterLine, flintLine, inputFacts } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { createFoodTrend, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { fuelShortage, parallelFurnaceLine } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';

/** The live facts of run 9 (11/13): the furnaces in parallel, the coal before the iron, the diamonds' veins, the flint, the camp cells, the walk to the point. */
const pack = (items: Record<string, number>) => new Map(Object.entries(items));
const MAP = [
  '地図 v1 足=(2,-50,1) x=0..4 z=0..2 方式=test',
  'y=-50 x=0..4 z=0..2',
  '0 . d d . .',
  '1 . . . . .',
  '2 . . . . d',
  'y=-51 x=0..4 z=0..2',
  '0 # # d # #',
  '1 # # # # #',
  '2 # # # # .',
].join('\n');
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  facts: {}, state: { world: { dimension: 'overworld', position: { x: 2, y: -50, z: 1 }, health: 20, food: 20, ...world } as never } }) as BodyObservation;

describe('the furnaces in parallel (G2)', () => {
  const working = (n: number) => Array.from({ length: n }, (_, i) => ({ status: 'waiting_external', remainingEstimateMs: 60_000, position: { x: i, y: 60, z: 0 }, input: 'raw_iron', count: 8 }));
  it('is said with 4 or more raw iron and at most one furnace working, and not otherwise', () => {
    const line = parallelFurnaceLine({ jobs: working(1) }, pack({ raw_iron: 24, coal: 3 }))!;
    expect(line).toContain('smelt raw_iron 24 furnaces=3 fuel=coal fuelCount=3');
    expect(line).toContain('take は残り 15 秒以内だけ体が待つ');
    expect(parallelFurnaceLine({}, pack({ raw_iron: 4, coal: 1 }))).toContain('raw_iron 4 furnaces=3');
    expect(parallelFurnaceLine({ jobs: working(2) }, pack({ raw_iron: 24, coal: 3 }))).toBeNull();
    expect(parallelFurnaceLine({ jobs: [] }, pack({ raw_iron: 3, coal: 3 }))).toBeNull();
    expect(parallelFurnaceLine({ placedFurnaces: [1, 2] }, pack({ raw_iron: 24, coal: 3 }))).toBeNull();
  });
});

describe('the coal before the iron (G7)', () => {
  const world = { position: { x: 0, y: 64, z: 0 }, mapLandmarks: ['c 石炭[coal_ore] (10,40,5) 東10 ×8 見えている'] };
  it('says the count and the nearest coal while the section is the iron and fewer than 4 coal are carried, with no raw iron', () => {
    const line = fuelShortage(world, pack({ coal: 2 }), ['iron'])!;
    expect(line).toContain('石炭 2（鉄 24 と肉に約 4 要る。1 個で 8 個焼ける）。最寄りの石炭 (10,40,5)');
    expect(fuelShortage(world, pack({ coal: 4 }), ['iron'])).toBeNull();
    expect(fuelShortage(world, pack({ coal: 2 }), ['food'])).toBeNull();
    expect(fuelShortage(world, pack({ coal: 2 }))).toBeNull();
    expect(fuelShortage(world, pack({ raw_iron: 8 }), ['iron'])).toContain('燃料: 焼く物 8 個');
  });
});

describe('the diamonds\' veins (M2) and the flint (M4)', () => {
  it('lists the veins with the count, the metres and whether air lies under, only at the diamonds with two or more in view', () => {
    const line = diamondClusterLine({ localMap: MAP, position: { x: 2, y: -50, z: 1 } }, ['diamond'])!;
    expect(line).toBe('ダイヤの群れ: (1,-50,0) 3 個・1m／(4,-50,2) 1 個・2m・下が空所（落ちる）');
    expect(diamondClusterLine({ localMap: MAP }, ['iron'])).toBeNull();
    expect(diamondClusterLine({ localMap: MAP.replace(/ d/gu, ' #') }, ['diamond'])).toBeNull();
    expect(diamondClusterLine({ mapLandmarks: ['d ダイヤ[diamond_ore] (5,-50,5) 東3 ×1 見えている'] }, ['diamond'])).toBeNull();
  });
  it('says the flint with no flint and no flint and steel at the diamonds, the obsidian or the gate, with the nearest gravel the map shows', () => {
    const sandy = MAP.replace('1 . . . . .', '1 . s . . .');
    const line = flintLine(frame({ localMap: sandy }), ['obsidian'])!;
    expect(line).toContain('火打石 0。砂利は掘ると 10% で火打石（10 個で約 35 秒）。片付けは砂利を 10 個まで残す。通り道の砂利を先に掘る');
    expect(line).toContain('(1,-50,1) 1m');
    expect(flintLine(frame({ inventory: { flint: 1 } }), ['diamond'])).toBeNull();
    expect(flintLine(frame({ inventory: { flint_and_steel: 1 } }), ['portal'])).toBeNull();
    expect(flintLine(frame({}), ['stone_tools'])).toBeNull();
  });
  it('puts both in the normal facts only, and nothing extra with no kinds', () => {
    const obs = frame({ localMap: MAP });
    const normal = inputFacts(obs, { nowKinds: ['diamond'] }, false);
    expect(normal.lines.some(line => line.startsWith('ダイヤの群れ'))).toBe(true);
    expect(normal.lines.some(line => line.startsWith('火打石 0'))).toBe(true);
    expect(normal.compressed.some(line => line.startsWith('ダイヤの群れ') || line.startsWith('火打石'))).toBe(false);
    expect(inputFacts(obs, { nowKinds: ['diamond'] }, true).lines.some(line => line.startsWith('ダイヤの群れ'))).toBe(false);
    expect(inputFacts(obs, {}, false).lines.some(line => line.startsWith('ダイヤの群れ') || line.startsWith('火打石'))).toBe(false);
  });
});

describe('the camp sites and the way back in the live (N1, N2)', () => {
  const live = (world: Record<string, unknown>) => minecraftLlmcLive({ observation: frame(world), elapsedMinutes: null, trend: createFoodTrend(), events: [] });
  it('gives the body\'s lines as they are, two camp sites at most, and no key when the body sends neither', () => {
    const out = live({ campSites: ['野営マス (2,63,1) 屋根なし', '野営マス (-2,63,1) 屋根あり', '三つ目'], routeBack: 'ゲートへ 120m 南' });
    expect(out.route).toEqual(['野営マス (2,63,1) 屋根なし', '野営マス (-2,63,1) 屋根あり', 'ゲートへ 120m 南']);
    expect('route' in live({})).toBe(false);
    expect('route' in live({ campSites: [] })).toBe(false);
  });
});

describe('the walk to the point (G4) and the throw after it (G2, G3)', () => {
  it('adds the metres and the seconds on the ground to the point\'s line, with a position only', () => {
    const target = { x: -1072, z: 928 };
    const report = (from: { x: number; z: number }) => {
      const distance = Math.hypot(target.x - from.x, target.z - from.z), unit = { x: (target.x - from.x) / distance, z: (target.z - from.z) / distance };
      return JSON.stringify({ v: 1, done: 1, of: 1, lines: [{ i: 1, do: 'use', status: 'done' }],
        eye: { from, origin: from, to: { x: from.x + unit.x * 12, z: from.z + unit.z * 12 }, bearingDeg: bearingBetween(from, target), unit, flew: 12, broke: false } });
    };
    const ledger = createEyeLedger(null);
    ledger.note('first', report({ x: 135, z: 104 }), 'overworld', 1000);
    ledger.note('second', report({ x: 121, z: 84 }), 'overworld', 1000);
    const fix = ledger.fix(1000);
    expect(fix).not.toBeNull();
    const near = { x: fix!.x + 400, z: fix!.z };
    expect(ledgerLines(ledger.throws(1000), near, 1000).join('\n')).toContain('交点まで約 400 m・地上の見込み 約 100〜200 秒（水の割合で 2〜4 m/s）');
    expect(ledgerLines(ledger.throws(1000), null, 1000).join('\n')).not.toContain('地上の見込み');
  });
  it('holds a second throw after the point when nothing is left to make eyes from, and says to pick up the fallen eye', () => {
    const fixAt = { x: -1072, z: 928, errorBlocks: 300 };
    const mk = (throws: Array<{ x: number; z: number; bearingDeg: number }>) =>
      ({ fix: () => ({ ...fixAt, throws: 2, ahead: [] }), throws: () => throws }) as never;
    const throwEye = { hands: [{ do: 'use', item: 'ender_eye' }] };
    const f = (items: Array<[string, number]>) => frame({ inventory: items.map(([name, count]) => ({ name, count })) });
    registerEyeLedger('g-none', mk([{ x: 135, z: 104, bearingDeg: 304 }]));
    expect(eyeThrowHold(throwEye, f([['ender_eye', 9]]), 'g-none')).toBeNull();
    registerEyeLedger('g-one', mk([{ x: 135, z: 104, bearingDeg: 304 }, { x: -1050, z: 910, bearingDeg: 291 }]));
    const held = eyeThrowHold(throwEye, f([['ender_eye', 9]]), 'g-one')!.line;
    expect(held).toContain('同じ辺りから投げ直さない');
    expect(held).toContain('落ちたアイ（割れなかった物）は拾う');
    expect(eyeThrowHold(throwEye, f([['ender_eye', 9], ['ender_pearl', 2], ['blaze_powder', 2]]), 'g-one')!.line).toContain('枠に要る数（13）以下');
  });
});
