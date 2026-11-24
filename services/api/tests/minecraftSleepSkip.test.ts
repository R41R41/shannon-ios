import { beforeEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { handProblem } from '../src/contracts/minecraftActHandRules.js';
import { handToLine, lineToHand } from '../src/contracts/minecraftActShortHands.js';
import { ACT_DESCRIPTION, ACT_INPUT_SCHEMA } from '../src/contracts/minecraftActContract.js';
import { SLEEP_CHOICE, SLEEP_COST, SLEEP_MODES } from '../src/contracts/minecraftSleepWords.js';
import { dayNoBedLine } from '../src/surfaces/minecraft/minecraftNightArms.js';
import { forgetSleepHolds, sleepFirstHold, sleepStateLine } from '../src/surfaces/minecraft/minecraftLlmcSleepHold.js';

/**
 * 11/25: "not tonight" is a hand of the head's (`sleep on=false`), kept as a skip that the morning, its time, a death or a sleep of any other mode ends; the body's booking is
 * dropped on the same hand, and the head's input says whether a skip is on, a booking may stand, or what a sleep costs.
 */
const pack = (items: ReadonlyArray<readonly [string, number]>) => items.map(([name, count]) => ({ name, count }));
const BED: Array<[string, number]> = [['white_bed', 1]];
const frame = (time: string, items: ReadonlyArray<readonly [string, number]> = BED, extra: Record<string, unknown> = {}, life?: { deathEpoch: string; deathSeq: number }): BodyObservation => ({
  schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, health: 20, food: 20, time, inventory: pack(items), worn: '', ...extra } as never,
    ...(life ? { life } : {}) } as never });
const work = (...first: object[]) => ({ why: 'hunt the night skeletons', hands: [...first, { do: 'go', to: { x: 3, y: 70, z: 3 } }, { do: 'mine', block: 'oak_log', count: 8 }] });
const SKIP = { do: 'sleep', on: false };
const NIGHT = '14000';

beforeEach(() => forgetSleepHolds());

describe('the sleep skip', () => {
  it('lets the night work go when the act starts with a skip, and for the acts after it', () => {
    expect(sleepFirstHold(work(), frame(NIGHT), 't')).not.toBeNull();
    expect(sleepFirstHold(work(SKIP), frame(NIGHT), 't')).toBeNull();
    expect(sleepFirstHold(work(), frame(NIGHT), 't')).toBeNull();
    expect(sleepFirstHold(work(), frame(NIGHT), 'other task')).not.toBeNull();
  });
  it('says the skip, how long and why, and that the body booking is gone', () => {
    sleepFirstHold(work(SKIP), frame(NIGHT), 't');
    const line = sleepStateLine(frame(NIGHT), 't', null)!;
    for (const word of ['今夜は寝ない', '朝まで', 'hunt the night skeletons', '寝る予約は消してある', 'sleep on=true']) expect(line, word).toContain(word);
  });
  it('ends at its time (until seconds), at the morning, at a death and by a sleep of another mode or resume', () => {
    let clock = 1_000_000;
    const now = () => clock;
    sleepFirstHold(work({ ...SKIP, seconds: 120 }), frame(NIGHT), 'u', now);
    expect(sleepStateLine(frame(NIGHT), 'u', null, now)).toContain('あと');
    clock += 119_000;
    expect(sleepFirstHold(work(), frame(NIGHT), 'u', now)).toBeNull();
    clock += 2_000;
    expect(sleepFirstHold(work(), frame(NIGHT), 'u', now)).not.toBeNull();

    sleepFirstHold(work(SKIP), frame(NIGHT), 'm', now);
    expect(sleepFirstHold(work(), frame(NIGHT), 'm', now)).toBeNull();
    expect(sleepStateLine(frame('1000'), 'm', null, now)).toBeNull();
    expect(sleepFirstHold(work(), frame(NIGHT), 'm', now)).not.toBeNull();

    sleepFirstHold(work(SKIP), frame(NIGHT, BED, {}, { deathEpoch: 'e', deathSeq: 1 }), 'd', now);
    expect(sleepFirstHold(work(), frame(NIGHT, BED, {}, { deathEpoch: 'e', deathSeq: 1 }), 'd', now)).toBeNull();
    expect(sleepFirstHold(work(), frame(NIGHT, BED, {}, { deathEpoch: 'e', deathSeq: 2 }), 'd', now)).not.toBeNull();

    sleepFirstHold(work(SKIP), frame(NIGHT), 'r', now);
    sleepFirstHold(work({ do: 'sleep', on: true }), frame(NIGHT), 'r', now);
    expect(sleepFirstHold(work(), frame(NIGHT), 'r', now)).not.toBeNull();
    sleepFirstHold(work(SKIP), frame(NIGHT), 's', now);
    sleepFirstHold({ hands: [{ do: 'sleep' }, { do: 'wait', seconds: 1 }] }, frame(NIGHT), 's', now);
    expect(sleepFirstHold(work(), frame(NIGHT), 's', now)).not.toBeNull();
  });
  it('lasts through the day to the coming night, and no longer than half an hour', () => {
    let clock = 0;
    const now = () => clock;
    sleepFirstHold(work(SKIP), frame('6000'), 'day', now);
    expect(sleepStateLine(frame('6000'), 'day', null, now)).toContain('今夜は寝ない');
    expect(sleepFirstHold(work(), frame(NIGHT), 'day', now)).toBeNull();
    clock += 31 * 60_000;
    expect(sleepFirstHold(work(), frame(NIGHT), 'day', now)).not.toBeNull();
  });
  it('says the hold as a choice with the reasons and the skip hand', () => {
    const line = sleepFirstHold(work(), frame(NIGHT), 't')!.line;
    for (const word of ['寝る場面', '寝ない場面', 'sleep on=false', SLEEP_COST, '夜に湧く']) expect(line, word).toContain(word);
  });
});

describe('what the head is told about the night sleep', () => {
  it('says that a booking made by day may stand in the body, and that a skip takes it away', () => {
    sleepFirstHold({ hands: [{ do: 'sleep' }, { do: 'go', to: { x: 1, y: 70, z: 1 } }] }, frame('6000'), 'b');
    const line = sleepStateLine(frame('6000'), 'b', null)!;
    for (const word of ['寝る予約が残っているかもしれない', '25 分', 'sleep on=false']) expect(line, word).toContain(word);
    sleepFirstHold(work(SKIP), frame('6000'), 'b');
    expect(sleepStateLine(frame('6000'), 'b', null)).not.toContain('予約が残っている');
  });
  it('does not make a booking of a skip or a resume by day', () => {
    sleepFirstHold({ hands: [SKIP, { do: 'go', to: { x: 1, y: 70, z: 1 } }] }, frame('6000'), 'k');
    sleepFirstHold({ hands: [{ do: 'sleep', on: true }] }, frame('6000'), 'k2');
    expect(sleepStateLine(frame('6000'), 'k2', null)).toBeNull();
  });
  it('at dusk and night with a bed names the cost, the plan node and when not to sleep; nothing without a bed or by day', () => {
    const line = sleepStateLine(frame(NIGHT), 'n', '夜の骸骨を倒す')!;
    for (const word of [SLEEP_COST, '夜の骸骨を倒す', 'sleep on=false', '人が寝ないと言った']) expect(line, word).toContain(word);
    expect(sleepStateLine(frame(NIGHT, [['iron_sword', 1]]), 'n', null)).toBeNull();
    expect(sleepStateLine(frame('6000'), 'n', null)).toBeNull();
    expect(sleepStateLine(frame(NIGHT, BED, { dimension: 'the_nether' }), 'n', null)).toBeNull();
    expect(sleepStateLine(null, 'n', null)).toBeNull();
  });
});

describe('the hand', () => {
  it('takes on=false (seconds 60 to 300) and on=true, and writes and reads its short form', () => {
    expect(handProblem({ do: 'sleep', on: false } as never)).toBeNull();
    expect(handProblem({ do: 'sleep', on: false, seconds: 120 } as never)).toBeNull();
    expect(handProblem({ do: 'sleep', on: true } as never)).toBeNull();
    expect(handProblem({ do: 'sleep', on: false, seconds: 30 } as never)).toContain('60〜300');
    expect(handProblem({ do: 'sleep', on: false, seconds: 900 } as never)).toContain('60〜300');
    expect(handProblem({ do: 'sleep', on: true, seconds: 60 } as never)).toContain('on=true');
    expect(handProblem({ do: 'sleep', seconds: 30 } as never)).toBeNull();
    expect(handProblem({ do: 'sleep', seconds: 90 } as never)).toContain('10');
    expect(handToLine({ do: 'sleep', on: false, seconds: 120 } as never)).toBe('sleep seconds=120 on=false');
    expect(lineToHand('sleep seconds=120 on=false')).toEqual({ do: 'sleep', seconds: 120, on: false });
    expect(lineToHand('sleep on=false')).toEqual({ do: 'sleep', on: false });
    expect(handToLine({ do: 'sleep', on: true } as never)).toBe('sleep on=true');
  });
  it('takes no time of its own: the act is not given 300 seconds for a skip of 300', async () => {
    const { actMilliseconds } = await import('../src/contracts/minecraftActTime.js');
    const skip = actMilliseconds({ hands: [{ do: 'sleep', on: false, seconds: 300 }] } as never);
    const lie = actMilliseconds({ hands: [{ do: 'sleep', seconds: 45 }] } as never);
    expect(skip).toBeLessThanOrEqual(5_000);
    expect(lie).toBeGreaterThan(40_000);
    expect(lie - skip).toBeGreaterThan(40_000);
  });
  it('is in the words of the hand, with the reason, and the hand has no new property', () => {
    expect(ACT_DESCRIPTION).toContain(SLEEP_MODES);
    expect(SLEEP_MODES).toContain('on=false');
    expect(SLEEP_CHOICE).toContain('理由');
    expect(JSON.stringify(ACT_INPUT_SCHEMA)).not.toContain('"until"');
  });
});

describe('the bed by day', () => {
  const none = new Map<string, number>(), has = new Map([['white_bed', 1]]);
  const day = (time: string, extra: Record<string, unknown> = {}) => ({ time, ...extra });
  it('says a bed is made first when none is carried, with the reasons', () => {
    const line = dayNoBedLine(day('3000'), none, 'overworld')!;
    for (const word of ['ベッドを持っていない', '先に 1 個作る', '理由', '敵が増えて危ない', '寝て夜を飛ばせる', '羊毛 3']) expect(line, word).toContain(word);
  });
  it('is silent with a bed, with a plan node that makes it, within three minutes of dusk, in a storm, in the nether and with no clock', () => {
    expect(dayNoBedLine(day('3000'), has, 'overworld')).toBeNull();
    expect(dayNoBedLine(day('3000'), none, 'overworld', true)).toBeNull();
    expect(dayNoBedLine(day('9500'), none, 'overworld')).toBeNull();
    expect(dayNoBedLine(day('3000', { weather: 'thunder' }), none, 'overworld')).toBeNull();
    expect(dayNoBedLine(day('3000'), none, 'the_nether')).toBeNull();
    expect(dayNoBedLine({}, none, 'overworld')).toBeNull();
  });
});
