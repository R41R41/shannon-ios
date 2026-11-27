import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { frameOpenChance, ledgerLines, SEA_FAST, SEA_SLOW, walkWords, type StoredThrow } from '../src/surfaces/minecraft/minecraftEyeLedger.js';
import { eyeThrowHold, registerEyeLedger } from '../src/surfaces/minecraft/minecraftEyeThrowHold.js';
import { bearingBetween, stronghold, type EyeThrow } from '../src/surfaces/minecraft/minecraftEyeTriangulation.js';
import { preparationShortage } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

const flightTo = (from: { x: number; z: number }, to: { x: number; z: number }): EyeThrow => {
  const bearingDeg = bearingBetween(from, to), length = Math.hypot(to.x - from.x, to.z - from.z);
  return { x: from.x, z: from.z, bearingDeg, flew: 12, broke: false, unit: { x: (to.x - from.x) / length, z: (to.z - from.z) / length } };
};

describe('the point from two precise lines', () => {
  it('reads about +-40 m at 0.64 degrees and 1,880 m (the 11/26 run read +-163 m with the old 0.02), and keeps the third throw open', () => {
    const target = { x: 1880, z: 0 };
    const fix = stronghold([flightTo({ x: 0, z: 0 }, target), flightTo({ x: 0, z: 21 }, target)])!;
    expect(fix.errorBlocks).toBeLessThanOrEqual(128);
    expect(fix.errorBlocks).toBeGreaterThan(10);
    const now = 1_000_000;
    const throws: StoredThrow[] = [{ ...flightTo({ x: 0, z: 0 }, target), id: 'a', at: now, toX: 12, toZ: 0 }, { ...flightTo({ x: 0, z: 21 }, target), id: 'b', at: now, toX: 12, toZ: 21 }];
    expect(ledgerLines(throws, { x: 0, z: 21 }, now).join('\n')).toContain('交点');
    // A wide point (lines read from a bearing alone, 1,500 m off) keeps the third throw open in its words.
    const bare = (z: number): StoredThrow => { const { unit: _unit, ...rest } = flightTo({ x: 0, z }, { x: 1500, z: 0 }); return { ...rest, id: `w${z}`, at: now, toX: 1, toZ: 1 }; };
    const far = ledgerLines([bare(0), bare(300)], null, now).join('NL');
    expect(far).toContain('誤差が大きい');
    expect(far).toContain('3 本目を投げてよい');
  });
});

const frame = (items: Array<[string, number]>, at = { x: 0, y: 70, z: 0 }): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't',
  receivedAt: 't', connected: true, facts: {}, state: { world: { dimension: 'overworld', position: at, health: 20, food: 20, inventory: items.map(([name, count]) => ({ name, count })) } as never } });

describe('the frames open with the eyes in hand', () => {
  it('gives 72, 34, 11 and 100 percent', () => {
    expect(Math.round(frameOpenChance(11) * 1000) / 10).toBe(71.8);
    expect(Math.round(frameOpenChance(10) * 1000) / 10).toBe(34.1);
    expect(Math.round(frameOpenChance(9) * 1000) / 10).toBe(11.1);
    expect(frameOpenChance(12)).toBe(1);
  });
  it('says 72% and the gap in the shortage with 11 eyes, 1 powder and no pearl', () => {
    const counts = new Map([['ender_eye', 11], ['blaze_powder', 1]]);
    const text = preparationShortage({ dimension: 'overworld', counts, food: 400, nowKinds: null, world: {}, journeyReadiness: true })!;
    // one measure: the frames' 12 and the spare for the throws still to come (none made yet: 6 of a fifth, 2), not the chance of opening
    expect(text).toContain('エンダーアイ 11/14（枠 12＋予備 2');
    expect(text).toContain('あと 3 個');
    expect(text).not.toContain('開く確率');
    expect(text).toContain('作れるのは 0 個');
  });
  it('names a bed the map shows while fewer than 8 are carried', () => {
    const counts = new Map([['ender_eye', 11], ['white_bed', 6]]);
    const world = { mapLandmarks: ['B ベッド (218,64,-23) 下1 white_bed'] };
    const text = preparationShortage({ dimension: 'overworld', counts, food: 400, nowKinds: null, world, journeyReadiness: true })!;
    expect(text).toContain('(218,64,-23)');
    expect(text).toContain('6→7');
  });
  it('writes the table into the stronghold stage', () => {
    expect(V2_STAGES.stronghold).toContain('11 個 72%');
    expect(V2_STAGES.stronghold).not.toContain('平均 1.2 個なので約 11 個');
  });
});

describe('a go and a throw in one act', () => {
  const kit: Array<[string, number]> = [['ender_eye', 14]];
  const act = (to: { x: number; y: number; z: number }, extra: Record<string, unknown> = {}) => ({ hands: [{ do: 'go', to, ...extra }, { do: 'use', item: 'ender_eye' }] });
  const ledger = (throws: Array<{ x: number; z: number; bearingDeg: number }>) => ({ fix: () => null, throws: () => throws }) as never;
  it('reads the throw from the go\'s destination: 24 m sideways passes, the same line holds, a go that is not told leaves the feet', () => {
    registerEyeLedger('g', ledger([{ x: 0, z: 0, bearingDeg: 180 }]));
    const here = frame(kit, { x: 1, y: 70, z: 40 });
    expect(eyeThrowHold(act({ x: 24, y: 70, z: 40 }), here, 'g')).toBeNull();
    expect(eyeThrowHold(act({ x: 3, y: 70, z: 80 }), here, 'g')!.line).toContain('この act の go の行き先 (3,80)');
    expect(eyeThrowHold({ hands: [{ do: 'use', item: 'ender_eye' }] }, here, 'g')!.line).toContain('同じ線');
    expect(eyeThrowHold(act({ x: 24, y: 70, z: 40 }, { rel: false }), frame(kit, { x: 24, y: 70, z: 0 }), 'g')).toBeNull();
  });
  it('reads a relative go from the feet', () => {
    registerEyeLedger('r', ledger([{ x: 0, z: 0, bearingDeg: 180 }]));
    expect(eyeThrowHold(act({ x: 24, y: 0, z: 0 }, { rel: true }), frame(kit, { x: 1, y: 70, z: 40 }), 'r')).toBeNull();
  });
});

describe('the speeds', () => {
  it('says both land and sea, with the measured sea speed', () => {
    const words = walkWords(1880);
    expect(words).toContain('約 1,880 m');
    expect(words).toContain('0.5 前後');
    expect(words).toContain(`${SEA_SLOW}〜${SEA_FAST} m/s`);
  });
});
