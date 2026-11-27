import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { arrowBudgetLine, climbNow, crystalLine, crystalsBeforeNodeNote, dragonBedLine, dragonLine, endFightLines, noBowLine } from '../src/surfaces/minecraft/minecraftEndFacts.js';
import { crystalsLeft, crystalsStandingNow, crystalsUnseenNow, endViewOf, standingCrystals } from '../src/surfaces/minecraft/minecraftEndView.js';

/**
 * Run 17 (11/28): both crystals left were destroyed, but the body's count stayed at 2 (spikes it had not been near enough to read) and the head, told 「檻なしの結晶 2 本」, went back to a destroyed
 * crystal's pillar; and phase 1 stayed 641 s because the head waited in a hollow where the dragon could not see it (the game ends phase 1 only with a fireball shot).
 */
const observation = (world: Record<string, unknown>): BodyObservation => ({ state: { world } } as unknown as BodyObservation);
const unseenWorld = (extra: Record<string, unknown> = {}) => ({
  dimension: 'the_end', position: { x: -38.5, y: 66, z: -1.5 },
  crystals: { remaining: 2, gone: 8, caged: 0, list: [], unseen: [{ x: 13, z: -39 }, { x: -13, z: 40 }] },
  dragon: { id: 7, health: 200, phase: 1, phaseName: 'strafe', phaseFor: 300, position: { x: -49, y: 71, z: 4 }, distance: 20, headReach: null, strike: null },
  ...extra });

describe('crystals the body has not been near enough to read', () => {
  it('counts what stands for sure apart from the unseen spikes, and keeps the body count for the plan', () => {
    const obs = observation(unseenWorld());
    expect(crystalsLeft(obs)).toBe(2);
    expect(crystalsStandingNow(obs)).toBe(0);
    expect(crystalsUnseenNow(obs)).toBe(2);
    const view = endViewOf(obs)!;
    expect(view.crystals.unseenSpots).toEqual([{ x: 13, z: -39 }, { x: -13, z: 40 }]);
    expect(standingCrystals(endViewOf(observation({ dimension: 'the_end', crystals: { remaining: 3, unseen: [{ x: 1, z: 2 }], list: [{ position: { x: 0, y: 80, z: 0 }, caged: true }] } })))).toBe(2);
  });

  it('says the crystal line as spikes to check, with where and how far, not as crystals', () => {
    const line = crystalLine(endViewOf(observation(unseenWorld()))!)!;
    expect(line).toContain('残り 2/10');
    expect(line).toContain('見えている結晶は 0 本');
    expect(line).toContain('立っているとは限らない');
    expect(line).toContain('(13,-39) 自分から');
    expect(line).toContain('32m 以内');
  });

  it('does not call them uncaged crystals in the arrow budget, nor hold back the bed for them', () => {
    const view = endViewOf(observation(unseenWorld()))!;
    expect(arrowBudgetLine(view, 0)).toBeNull();
    const sitting = { ...view, dragon: { ...view.dragon!, phase: 6, phaseFor: 3, approach: { bed: [{ stand: { x: 1, y: 63, z: 1 }, foot: { x: 2, y: 63, z: 2 }, head: { x: 3, y: 63, z: 2 }, build: [], walkMeters: 5, dragonExpected: 40, selfExpected: 2 }] } } } as never;
    const bed = dragonBedLine(sitting, 'red_bed')!;
    expect(bed).toContain('ベッドの手（体が測った候補）');
    expect(bed).toContain('確かめていない台座 2 個');
    // A crystal in view still holds it back, as before
    const standing = { ...(sitting as any), crystals: { ...(sitting as any).crystals, remaining: 3, list: [{ id: 1, position: { x: 0, y: 80, z: 0 }, caged: false, distance: 30, healing: false, blast: null }] } } as never;
    expect(dragonBedLine(standing, 'red_bed')).toContain('今は使わない（結晶が 1 本残る間');
  });

  it('with the bow-less line, sends her to look at the spikes, not up a pillar or to a root', () => {
    const view = { ...endViewOf(observation(unseenWorld({ dragon: { id: 7, health: 200, phase: 0, phaseFor: 4, position: { x: -49, y: 71, z: 4 }, distance: 50 } })))!, openings: undefined } as never;
    const line = noBowLine(view);
    expect(line).toContain('見えている結晶は 0 本で、登る柱も殴る的も無い');
    expect(line).toContain('(13,-39)');
    expect(line).not.toContain('柱の根');
    expect(climbNow(view)).toBe(true);
    const lines = endFightLines(view, null, false, 0);
    expect(lines.join('\n')).not.toContain('檻なしの結晶 2 本');
  });

  it('the plan node says the same, and the node note lets the bed node go ahead', () => {
    const note = crystalsBeforeNodeNote(0, '[p3] ベッドで竜を倒す', 2)!;
    expect(note).toContain('見えている結晶は 0 本');
    expect(note).toContain('確かめていない台座 2 個');
    expect(crystalsBeforeNodeNote(0, '[p3] ベッドで竜を倒す')).toBeNull();
    expect(crystalsBeforeNodeNote(0, '[p1] 結晶を全部壊す', 2)).toBeNull();
  });
});

describe('a long phase 1', () => {
  const dragonView = (phaseFor: number) => endViewOf(observation({ dimension: 'the_end', position: { x: 0, y: 66, z: 0 },
    crystals: { remaining: 1, gone: 9, caged: 0, list: [{ id: 5, position: { x: 34, y: 90, z: 24 }, caged: false, distance: 40 }], unseen: [] },
    dragon: { id: 7, health: 200, phase: 1, phaseFor, position: { x: 10, y: 80, z: 0 }, distance: 20, headReach: null, strike: null } }))!;

  it('says what ends phase 1 (a fireball shot at her in sight within 64 m) once it has lasted 20 s, and not before', () => {
    expect(dragonLine(dragonView(5))).not.toContain('64m');
    const long = dragonLine(dragonView(641))!;
    expect(long).toContain('火の玉を 1 発撃つまで');
    expect(long).toContain('64m 以内で間にブロックが無く見通せる時だけ');
    expect(long).toContain('待っても終わらない');
    expect(long).not.toContain('あなたが見えて火の玉を撃つまで');
  });

  it('keeps the no-climb rule for a short phase 1, and for a long one sends her out to be shot at (not up the pillar)', () => {
    expect(noBowLine(dragonView(5))).toContain('今は登らない（竜は火の玉を狙う phase 1');
    const long = noBowLine(dragonView(300));
    expect(long).toContain('今は登らない');
    expect(long).toContain('300 秒続いていて、待っても終わらない');
    expect(long).toContain('上が開けた地表');
    expect(long).toContain('火の玉を 1 発撃たせる');
    expect(climbNow(dragonView(300))).toBe(false);
  });
});
