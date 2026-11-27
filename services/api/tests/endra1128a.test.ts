import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { arrowBudgetLine, climbNow, createHeightWatch, crystalLine, crystalsBeforeNodeNote, dragonBedLine, dragonBurstLine, dragonLine, endFightLines, noBowLine, waitSpanLine } from '../src/surfaces/minecraft/minecraftEndFacts.js';
import { crystalsLeft, crystalsStandingNow, crystalsUnseenNow, endViewOf, standingCrystals } from '../src/surfaces/minecraft/minecraftEndView.js';

/**
 * Run 17 (11/28): both crystals left were destroyed, but the body's count stayed at 2 (spikes it had not been near enough to read) and the head, told 「檻なしの結晶 2 本」, went back to a destroyed
 * crystal's pillar; and phase 1 stayed 641 s because the head waited in a pit where the dragon had no line of sight (the game ends phase 1 only with a fireball shot).
 * Round 2 (review): the bed and a "no crystal" reading wait for every spike to be read; a close phase 1 dragon rams; the island floor is named; the facts of a run of waits.
 */
const observation = (world: Record<string, unknown>): BodyObservation => ({ state: { world } } as unknown as BodyObservation);
const unseenWorld = (extra: Record<string, unknown> = {}) => ({
  dimension: 'the_end', position: { x: -38.5, y: 66, z: -1.5 },
  crystals: { remaining: 2, gone: 8, caged: 0, list: [], unseen: [{ x: 13, z: -39 }, { x: -13, z: 40 }] },
  dragon: { id: 7, health: 200, phase: 1, phaseName: 'strafe', phaseFor: 300, position: { x: -49, y: 71, z: 4 }, distance: 20, headReach: null, strike: null },
  ...extra });
const sittingOf = (view: any) => ({ ...view, dragon: { ...view.dragon, phase: 6, phaseFor: 3, approach: { strike: [], stage: [], retreat: [], bed: [{ stand: { x: 1, y: 63, z: 1 }, foot: { x: 2, y: 63, z: 2 }, head: { x: 3, y: 63, z: 2 }, build: [], walkMeters: 5, dragonExpected: 40, selfExpected: 2 }] } } }) as never;

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

  it('says the crystal line as spikes to check, with where and how far, and the body reach as a range (finding 6)', () => {
    const line = crystalLine(endViewOf(observation(unseenWorld()))!)!;
    expect(line).toContain('残り 2/10');
    expect(line).toContain('いま見えている結晶は 0 本');
    expect(line).toContain('立っているとは限らない');
    expect(line).toContain('(13,-39) 自分から');
    expect(line).toContain('16〜48m');
    expect(line).not.toContain('32m');
  });

  it('does not call them uncaged crystals in the arrow budget', () => {
    expect(arrowBudgetLine(endViewOf(observation(unseenWorld()))!, 0)).toBeNull();
  });

  it('holds the bed while any spike is unread (17th-run shape: remaining 2, unseen 2, list empty), and says to check them first (finding 1)', () => {
    const sitting = sittingOf(endViewOf(observation(unseenWorld()))!);
    const bed = dragonBedLine(sitting, 'red_bed')!;
    expect(bed).toContain('ベッドの手: 今は出さない');
    expect(bed).toContain('確かめていない台座が 2 個');
    expect(bed).toContain('(13,-39)');
    expect(bed).not.toContain('place block=red_bed');
    expect(bed).not.toContain('結晶 0 本');
    expect(endFightLines(sitting, 'red_bed', false, 0).join('\n')).toContain('ベッドの手: 今は出さない');
    // A crystal in view still holds it back, as before
    const standing = { ...(sitting as any), crystals: { ...(sitting as any).crystals, remaining: 3, list: [{ id: 1, position: { x: 0, y: 80, z: 0 }, caged: false, distance: 30, healing: false, blast: null }] } } as never;
    expect(dragonBedLine(standing, 'red_bed')).toContain('今は使わない（結晶が 1 本残る間');
  });

  it('on arrival (remaining 10, unseen 10, list empty) says the spikes are unread, not that no crystal stands, and offers no bed (finding 1)', () => {
    const arrival = endViewOf(observation({ dimension: 'the_end', position: { x: 100, y: 49, z: 0 },
      crystals: { remaining: 10, gone: 0, caged: 0, list: [], unseen: Array.from({ length: 10 }, (_, i) => ({ x: i * 10, z: -i * 7 })) },
      dragon: { id: 7, health: 200, phase: 6, phaseFor: 3, position: { x: 90, y: 66, z: 0 }, distance: 10 } }))!;
    const sitting = sittingOf(arrival);
    const burst = dragonBurstLine({ ...(sitting as any), dragon: { ...(sitting as any).dragon, phase: 2, id: 7 } } as never, 'red_bed')!;
    const lines = [crystalLine(arrival)!, dragonBedLine(sitting, 'red_bed')!, burst, noBowLine(arrival)].join('\n');
    expect(lines).not.toContain('結晶 0 本');
    expect(lines).not.toContain('place block=red_bed');
    expect(lines).not.toContain('bed_burst');
    expect(lines).toContain('確かめていない台座が 10 個');
    expect(lines).toContain('いま見えている結晶は 0 本');
    expect(crystalsBeforeNodeNote(0, '[p3] ベッドで竜を倒す', 10)).not.toContain('進んでよい');
  });

  it('offers the bed when every spike has been read and none stands (unseen 0, remaining 0)', () => {
    const done = endViewOf(observation({ dimension: 'the_end', position: { x: 0, y: 64, z: 0 }, crystals: { remaining: 0, gone: 10, caged: 0, list: [], unseen: [] },
      dragon: { id: 7, health: 200, phase: 6, phaseFor: 3, position: { x: 3, y: 66, z: 6 }, distance: 10 } }))!;
    const bed = dragonBedLine(sittingOf(done), 'red_bed')!;
    expect(bed).toContain('ベッドの手（体が測った候補）');
    expect(bed).not.toContain('今は出さない');
    expect(bed).not.toContain('確かめていない台座');
  });

  it('with the bow-less line, sends her to look at the spikes, not up a pillar or to a root', () => {
    const view = { ...endViewOf(observation(unseenWorld({ dragon: { id: 7, health: 200, phase: 0, phaseFor: 4, position: { x: -49, y: 71, z: 4 }, distance: 50 } })))!, openings: undefined } as never;
    const line = noBowLine(view);
    expect(line).toContain('いま見えている結晶は 0 本で、登る柱も殴る的も無い');
    expect(line).toContain('(13,-39)');
    expect(line).toContain('y=62〜66');
    expect(line).not.toContain('柱の根');
    expect(climbNow(view)).toBe(true);
    const lines = endFightLines(view, null, false, 0);
    expect(lines.join('\n')).not.toContain('檻なしの結晶 2 本');
  });

  it('the plan node says the same, and does not let the bed node go ahead before the spikes are read', () => {
    const note = crystalsBeforeNodeNote(0, '[p3] ベッドで竜を倒す', 2)!;
    expect(note).toContain('いま見えている結晶は 0 本');
    expect(note).toContain('確かめていない台座 2 個');
    expect(note).toContain('進む前に');
    expect(note).not.toContain('進んでよい');
    expect(crystalsBeforeNodeNote(0, '[p3] ベッドで竜を倒す')).toBeNull();
    expect(crystalsBeforeNodeNote(0, '[p1] 結晶を全部壊す', 2)).toBeNull();
  });
});

describe('a long phase 1', () => {
  const dragonView = (phaseFor: number) => endViewOf(observation({ dimension: 'the_end', position: { x: 0, y: 66, z: 0 },
    crystals: { remaining: 1, gone: 9, caged: 0, list: [{ id: 5, position: { x: 34, y: 90, z: 24 }, caged: false, distance: 40 }], unseen: [] },
    dragon: { id: 7, health: 200, phase: 1, phaseFor, position: { x: 10, y: 80, z: 0 }, distance: 20, headReach: null, strike: null } }))!;

  it('says what ends phase 1 (the source: a fireball, 64 m, 5 ticks in sight, 10 degrees) once it has lasted 20 s, and not before; the run is not given as the cause (finding 3)', () => {
    expect(dragonLine(dragonView(5))).not.toContain('64m');
    const long = dragonLine(dragonView(641))!;
    expect(long).toContain('火の玉を 1 発撃つまで');
    expect(long).toContain('64m 未満');
    expect(long).toContain('累計 5 tick');
    expect(long).toContain('10 度未満');
    expect(long).not.toContain('実走 17 回目');
    expect(long).not.toContain('窪みでは撃てず');
    expect(long).not.toContain('あなたが見えて火の玉を撃つまで');
  });

  it('keeps the no-climb rule for a short phase 1, and for a long one gives the floor height and what ends it (finding 4)', () => {
    expect(noBowLine(dragonView(5))).toContain('今は登らない（竜は火の玉を狙う phase 1');
    const long = noBowLine(dragonView(300));
    expect(long).toContain('今は登らない');
    expect(long).toContain('phase 1 が 300 秒続いている');
    expect(long).toContain('火の玉を 1 発撃った時だけ');
    expect(long).toContain('y=62〜66');
    expect(climbNow(dragonView(300))).toBe(false);
  });

  it('says only facts of a long phase 1 (what ends it, the ram of 11/9), and no measure or distance verdict, near or far (review of 0adb0ebd)', () => {
    const base = dragonView(300);
    const farView = { ...base, dragon: { ...base.dragon!, distance: 60, position: { x: 50, y: 110, z: 0 } } } as never;
    const noDistance = { ...base, dragon: { ...base.dragon!, distance: null, position: null } } as never;
    for (const view of [base, farView, noDistance]) {
      const line = noBowLine(view);
      expect(line).toContain('約 130 ブロック飛ばされて');
      expect(line).toContain('火の玉を 1 発撃った時だけ');
      expect(line).not.toMatch(/30m より遠い|竜が近い|上が開けた地表|開けた地表へ出て|撃たせてよい|横へ外れ|柱や高所に登らず/u);
    }
  });

  it('on a pit bottom (y=49) names the island floor from the waiting cells and says the pit is not it (finding 4)', () => {
    const view = endViewOf(observation({ dimension: 'the_end', position: { x: 10, y: 49, z: 10 },
      crystals: { remaining: 2, gone: 8, caged: 0, list: [], unseen: [{ x: 13, z: -39 }, { x: -13, z: 40 }] },
      dragon: { id: 7, health: 200, phase: 1, phaseFor: 300, position: { x: 0, y: 55, z: 0 }, distance: 20,
        approach: { strike: [], stage: [], retreat: [], wait: [{ x: 5, y: 64, z: 5, walkMeters: 10, walkSeconds: 3, side: 0, straight: true }] } } }))!;
    const line = noBowLine(view);
    expect(line).toContain('島の地表の高さは y=64 付近');
    expect(line).toContain('縦穴・窪みの底');
    expect(line).toContain('約 130 ブロック飛ばされて');
  });
});

describe('a run of waits (finding 5)', () => {
  const end = (distance: number, phaseFor: number, remaining = 2) => endViewOf(observation({ dimension: 'the_end', position: { x: 0, y: 49, z: 0 },
    crystals: { remaining, gone: 10 - remaining, caged: 0, list: [], unseen: Array.from({ length: remaining }, () => ({ x: 1, z: 1 })) },
    dragon: { id: 7, health: 200, phase: 1, phaseFor, position: { x: 0, y: 60, z: 0 }, distance } }))!;
  const run = (waits: number, secondsEach: number) => {
    const watch = createHeightWatch();
    let at = 1_000_000, view = watch.view(end(20, 10), 20, at);
    for (let i = 0; i < waits; i++) { watch.noteActs(['wait'], at + 1); at += secondsEach * 1000; view = watch.view(end(20, 10 + (i + 1) * secondsEach), 20, at); }
    return { view, last: end(20, 10 + waits * secondsEach) };
  };

  it('says nothing under 8 waits and 120 s, and the facts at 8 waits or at 120 s', () => {
    const few = run(3, 10);
    expect(waitSpanLine(few.view, few.last)).toBeNull();
    const eight = run(8, 10);
    const line = waitSpanLine(eight.view, eight.last)!;
    expect(line).toContain('待つ手だけが 8 手');
    expect(line).toContain('この間に変わった物');
    expect(line).toContain('phase 1 が 10→90 秒目');
    const slow = run(3, 60);
    const long = waitSpanLine(slow.view, slow.last)!;
    expect(long).toContain('3 手・180 秒');
  });

  it('is facts, not a hand, and names a change in the crystals when there is one', () => {
    const watch = createHeightWatch();
    watch.view(end(20, 10, 2), 20, 0);
    let view = watch.view(end(20, 10, 2), 20, 0);
    for (let i = 0; i < 8; i++) { watch.noteActs(['wait'], i * 1000); view = watch.view(end(20, 10 + i, 2), 20, i * 1000 + 500); }
    const line = waitSpanLine(view, end(20, 18, 1))!;
    expect(line).toContain('結晶の残り 2→1');
    expect(line).not.toMatch(/go で|近づく|出す/u);
  });

  it('a non-wait act ends the run', () => {
    const watch = createHeightWatch();
    watch.view(end(20, 10), 20, 0);
    for (let i = 0; i < 8; i++) watch.noteActs(['wait'], i);
    watch.noteActs(['go'], 9);
    expect(waitSpanLine(watch.view(end(20, 11), 20, 10_000), end(20, 11))).toBeNull();
  });
});
