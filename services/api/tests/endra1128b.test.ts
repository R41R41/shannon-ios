import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { ACT_CONTRACT_VERSION } from '../src/contracts/minecraftActTypes.js';
import { createHeightWatch, crystalLine, dragonBedLine, dragonBurstLine, dragonWaitLine, endFightLines, noBowLine, waitSpanLine, waitStreakLine, SPIKE_TELLING_WORDS } from '../src/surfaces/minecraft/minecraftEndFacts.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { endViewOf } from '../src/surfaces/minecraft/minecraftEndView.js';

/**
 * Round 3 of 11/28 (the review of 0adb0ebd): the run of waits is counted for the task (the step is made again at every decision), the long phase 1 is facts only, the sword waits for the spikes
 * as the bed does, the hold says the bedsite probe too and holds when the count is missing, and a head aloft over spikes is sent to a spike, not to a waiting cell.
 */
const observation = (world: Record<string, unknown>): BodyObservation => ({ connected: true, facts: { dimension: 'the_end' }, state: { world } } as unknown as BodyObservation);
const wait = [{ x: -12, y: 66, z: 0, walkMeters: 27, walkSeconds: null, side: 0, straight: true }];
const spikes = [{ x: 13, z: -40 }, { x: 34, z: 25 }];
const world = (extra: Record<string, unknown> = {}, dragon: Record<string, unknown> = {}) => ({
  dimension: 'the_end', position: { x: -39, y: 66, z: 0 }, health: 20,
  crystals: { remaining: 2, gone: 8, caged: 0, list: [], unseen: spikes },
  dragon: { id: 7, health: 200, phase: 1, phaseFor: 30, position: { x: -10, y: 70, z: 0 }, distance: 29, approach: { strike: [], stage: [], retreat: [], wait }, ...dragon },
  ...extra });
const viewOf = (extra: Record<string, unknown> = {}, dragon: Record<string, unknown> = {}) => endViewOf(observation(world(extra, dragon)))!;
const waitAct = JSON.stringify({ v: ACT_CONTRACT_VERSION, lines: [{ do: 'wait', status: 'done' }], done: 1, of: 1 });
const goAct = JSON.stringify({ v: ACT_CONTRACT_VERSION, lines: [{ do: 'go', status: 'done' }], done: 1, of: 1 });

describe('the run of waits is the task\'s, not the step\'s (finding 1)', () => {
  const end = (phaseFor: number) => viewOf({}, { phaseFor });

  it('the height watch keeps the count through a checkpoint, and a fresh or malformed one starts at 0', () => {
    const first = createHeightWatch();
    first.view(end(10), 20, 0);
    for (let i = 0; i < 4; i++) { first.noteActs(['wait'], 1_000 + i * 10_000); first.view(end(20 + i), 20, 1_000 + i * 10_000); }
    const again = createHeightWatch(JSON.parse(JSON.stringify(first.checkpoint())));
    for (let i = 4; i < 8; i++) { again.noteActs(['wait'], 1_000 + i * 10_000); again.view(end(20 + i), 20, 1_000 + i * 10_000); }
    const view = again.view(end(40), 20, 100_000);
    expect(view.waits).toBe(8);
    expect(view.waitSeconds).toBe(99);
    expect(view.waitFrom).toMatchObject({ remaining: 2, unseen: 2, phase: 1 });
    expect(waitSpanLine(view, end(40))).toContain('待つ手だけが 8 手・99 秒続いている');
    for (const bad of [undefined, null, 'x', { minecraftHeightWatch: 'x' }, { minecraftHeightWatch: { waits: 'many', waitStart: { at: 'now' } } }]) {
      expect(createHeightWatch(bad).view(end(10), 20, 0).waits).toBe(0);
    }
  });

  it('a step made again at every decision (createEndgame from the checkpoint) still says the streak at 10 waits and the span at 8', () => {
    let at = 1_000_000;
    let endgame = createEndgame(null, () => at);
    const decide = () => { const lines = endgame.lines(observation(world()), true, false, null).lines.join('\n'); at += 10_000; return lines; };
    let last = '';
    for (let i = 0; i < 10; i++) {
      last = decide();
      endgame.noteResult(`a${i}`, waitAct, observation(world()));
      endgame = createEndgame(JSON.parse(JSON.stringify(endgame.checkpoint())), () => at);
    }
    last = decide();
    expect(last).toContain('待つ手が 10 回続いている');
    expect(last).toContain('待つ手だけが 10 手');
    // a hand that is not a wait ends the run, through a checkpoint too
    endgame.noteResult('g', goAct, observation(world()));
    endgame = createEndgame(JSON.parse(JSON.stringify(endgame.checkpoint())), () => at);
    const after = decide();
    expect(after).not.toContain('待つ手が');
    expect(after).not.toContain('待つ手だけが');
  });

  it('the streak line is for the head that waits aloft or on the ground alike', () => {
    expect(waitStreakLine({ minutes: null, hits: 0, lost: 0, waits: 10 }, false)).toContain('待つ手が 10 回続いている');
  });
});

describe('a long phase 1 is facts, with no verdict on the distance (finding 2)', () => {
  it('names no distance and no measure when the input has no distance, with the spikes unread', () => {
    const view = viewOf({}, { distance: null, position: null, phaseFor: 300 });
    const line = noBowLine(view);
    expect(line).toContain('火の玉を 1 発撃った時だけ');
    expect(line).toContain('約 130 ブロック飛ばされて');
    expect(line).not.toMatch(/30m より遠い|竜が近い|開けた地表|撃たせてよい|横へ外れ/u);
  });
});

describe('the sword and the bed wait for every spike to be read (findings 3 and 5)', () => {
  const basinOf = (extra: Record<string, unknown> = {}) => {
    const view = viewOf({ position: { x: 0, y: 66, z: 0 }, ...extra }, { phase: 6, phaseFor: 3,
      approach: { strike: [], stage: [], retreat: [], wait, basin: [{ x: 1, y: 63, z: 1, walkMeters: 3, walkSeconds: 1, inWingPush: false, inBreathNow: false }] } });
    return view;
  };

  it('the basin\'s sword hand is not given while a spike is unread, and is given when none is', () => {
    const held = endFightLines(basinOf(), null, false, 0).join('\n');
    expect(held).not.toContain('剣の手: この行の先頭の足場へ');
    const read = endFightLines(basinOf({ crystals: { remaining: 0, gone: 10, caged: 0, list: [], unseen: [] } }), null, false, 0).join('\n');
    if (/窪みの足場/u.test(read)) expect(read).toContain('剣の手: この行の先頭の足場へ');
  });

  it('the hold names the bedsite probe, and holds with the remaining count missing', () => {
    const sitting = viewOf({}, { phase: 2, id: 7 });
    const burst = dragonBurstLine(sitting, 'red_bed')!;
    expect(burst).toContain('今は出さない');
    expect(burst).toContain('mc_probe kind=bedsite');
    expect(burst).not.toContain('ベッド連爆の機会');
    const noCount = viewOf({ crystals: { unseen: spikes, list: [] } }, { phase: 2, id: 7 });
    expect(noCount.crystals.remaining).toBeNull();
    const held = dragonBurstLine(noCount, 'red_bed')!;
    expect(held).toContain('今は出さない');
    expect(held).toContain('結晶の残りの数は体が数えていない');
    expect(dragonBedLine({ ...noCount, dragon: { ...noCount.dragon!, phase: 6, approach: { ...noCount.dragon!.approach!, bed: [{ stand: { x: 1, y: 63, z: 1 }, foot: { x: 2, y: 63, z: 2 }, head: { x: 3, y: 63, z: 2 }, build: [], dragonExpected: 90, selfExpected: 2, walkMeters: 3 }] } } } as never, 'red_bed')).toContain('今は出さない');
  });
});

describe('over the spikes, the way is to a spike, said once (findings 6, 7 and 8)', () => {
  const aloft = () => viewOf({ position: { x: -39, y: 77, z: 0 }, footing: undefined }, { phase: 2, phaseFor: 3, distance: 88, position: { x: 43, y: 107, z: 11 } });

  it('names a go to the spike at the ground\'s height in the wait line, not a waiting cell, and does not say 待つ間に', () => {
    const view = { ...aloft(), drop: 17 } as never;
    const line = dragonWaitLine(view)!;
    expect(line).toContain('待ち場の候補ではなく台座: go 13,60,-40 range=6');
    expect(line).not.toContain('待つ間に');
    const bow = noBowLine(view);
    expect(bow).toContain('降りた後の行き先は待ち場ではなく確かめていない台座');
    expect(bow).toContain('go 13,60,-40 range=6');
  });

  it('says how the body counts again once across the fight lines of a long phase 1, not 2 to 3 times', () => {
    const view = viewOf({}, { phaseFor: 300 });
    const text = endFightLines(view, null, false, 0).join('\n');
    expect(text.split(SPIKE_TELLING_WORDS).length - 1).toBe(1);
    expect(text.split('島の地表の高さ').length - 1).toBeLessThanOrEqual(1);
    expect(crystalLine(view)).toContain(SPIKE_TELLING_WORDS);
  });
});
