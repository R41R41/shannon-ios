import { beforeEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { fullnessMarginWords, furnaceFoodOf } from '../src/surfaces/minecraft/minecraftFoodWords.js';
import { FOOD_POINTS, minecraftLlmcLive, createFoodTrend } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { foodLine, vitalsLine } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { furnaceLedgerLines, ledgerContextOf } from '../src/surfaces/minecraft/minecraftLlmcFurnaceWait.js';
import { preparationShortage, readinessOf } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { forgetSleepHolds, sleepFirstHold, sleepStateLine } from '../src/surfaces/minecraft/minecraftLlmcSleepHold.js';
import { dayBedLine, nightBedLine, AFLOAT_NO_SLEEP } from '../src/surfaces/minecraft/minecraftNightArms.js';
import { heldOfFrame } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';

/**
 * Run 7 of 11/26 (the food and the sleep): 20 raw porkchops in a furnace 84 s from done were 「食料 0 点」; the fullness had 65 minutes in it and the head
 * went for fish; afloat at dusk the sleep gate held a furnace take for a sleep that could not come.
 */
const PORK_JOB = { status: 'waiting_external', remainingEstimateMs: 84_000, input: 'porkchop', count: 20, expects: 'cooked_porkchop×20', position: { x: 214, y: 64, z: -26 } };
const AFLOAT = '深い水の中（足の下も水で床が無い。掘る・置く間も沈むことがあり、頭が水中なら息が減る）。近くの呼吸できる足場は未確認';
const frame = (items: ReadonlyArray<readonly [string, number]>, world: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b',
  sequence: 1, stateAt: '2026-11-26T15:45:00.000Z', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'overworld', position: { x: 221, y: 62, z: 92 }, health: 20, food: 13, saturation: 0, time: '12600',
    inventory: items.map(([name, count]) => ({ name, count })), worn: '', ...world } as never } });

beforeEach(() => forgetSleepHolds());

describe('(a) a furnace that is cooking is food, said beside the 0 points', () => {
  it('reads the jobs: the cooked food, the seconds left and the points', () => {
    expect(furnaceFoodOf([PORK_JOB], FOOD_POINTS)).toEqual({ points: 416, leftSeconds: 84, words: 'かまどに焼き豚肉 20が焼き途中、あと 84 秒で約 416 点' });
    expect(furnaceFoodOf([{ ...PORK_JOB, remainingEstimateMs: 0 }], FOOD_POINTS)!.words).toBe('かまどに焼き豚肉 20が焼き上がり（取れば約 416 点）');
  });
  it('is not food when the furnace smelts iron, is in another dimension, or the shape is unknown', () => {
    expect(furnaceFoodOf([{ ...PORK_JOB, input: 'raw_iron', expects: 'iron_ingot×8', count: 8 }], FOOD_POINTS)).toBeNull();
    expect(furnaceFoodOf([{ ...PORK_JOB, status: 'different_dimension' }], FOOD_POINTS)).toBeNull();
    expect(furnaceFoodOf('x', FOOD_POINTS)).toBeNull();
  });
  it('the vitals line and the shortage say it; without a job they are as before', () => {
    const cooking = frame([['iron_sword', 1]], { jobs: [PORK_JOB] });
    expect(vitalsLine(cooking)).toContain('食べ物 無し（かまどに焼き豚肉 20が焼き途中、あと 84 秒で約 416 点）');
    expect(vitalsLine(frame([['iron_sword', 1]]))).toBe('体力 20/20・満腹 13/20・食べ物 無し');
    const parts = readinessOf(cooking)!;
    const line = preparationShortage({ ...parts, nowKinds: ['stronghold' as const], world: parts.world })!;
    expect(line).toContain('食料 0 点（かまどに焼き豚肉 20が焼き途中、あと 84 秒で約 416 点。目安');
    const plain = readinessOf(frame([['iron_sword', 1]]))!;
    expect(preparationShortage({ ...plain, nowKinds: ['stronghold' as const], world: plain.world })).toMatch(/食料 0 点（目安 \d+）/u);
  });
  it('the live says it in foodPoints, outside the points of the pack', () => {
    const live = minecraftLlmcLive({ observation: frame([['iron_sword', 1]], { jobs: [PORK_JOB] }), elapsedMinutes: 1, trend: createFoodTrend(), events: [], jobs: [PORK_JOB] as never }) as
      { foodPoints: { total: number; inFurnace?: string } };
    expect(live.foodPoints.total).toBe(0);
    expect(live.foodPoints.inFurnace).toContain('あと 84 秒で約 416 点');
  });
});

describe('(b) the margin of the fullness', () => {
  it('says the minutes to 6 and to 0 from the measured loss, and that eating can wait', () => {
    expect(fullnessMarginWords(13, 1)).toBe('満腹 13/20・1 減るのに約 5 分 → 走れなくなる 6 まで約 35 分・0 まで約 65 分（目安）。今は食べなくてよい');
  });
  it('does not say eat can wait when health is not coming back, or when it is close; nothing without a measure', () => {
    expect(fullnessMarginWords(13, 1, 12)).toContain('体力が戻っていない');
    expect(fullnessMarginWords(7, 1)).toContain('食べる時が近い');
    expect(fullnessMarginWords(13, null)).toBeNull();
    expect(fullnessMarginWords(13, 0)).toContain('減っていない');
  });
  it('is in the live state beside the measure', () => {
    let clock = 0;
    const trend = createFoodTrend(() => clock);
    trend.note(14, 0); clock += 120_000; trend.note(13, 0); clock += 120_000; trend.note(13, 0);
    const live = minecraftLlmcLive({ observation: frame([['iron_sword', 1]]), elapsedMinutes: 1, trend, events: [] }) as { state: Record<string, unknown> };
    expect(live.state.fullnessLostIn5min).toBe(1);
    expect(String(live.state.fullnessMargin)).toContain('今は食べなくてよい');
  });
});

describe('(c) afloat with no floor, no sleep is held for and the plan says it in one line', () => {
  const BED: Array<[string, number]> = [['white_bed', 2], ['iron_sword', 1]];
  const take = { hands: [{ do: 'furnace', at: [{ x: 214, y: 64, z: -26 }], op: 'take' }] };
  it('holds a furnace take at dusk on land, not afloat', () => {
    expect(sleepFirstHold(take, frame(BED), 'w')).not.toBeNull();
    expect(sleepFirstHold(take, frame(BED, { inside: AFLOAT }), 'w')).toBeNull();
    expect(heldOfFrame(take, frame(BED, { inside: AFLOAT }), 'w')).toBeNull();
    // a named floor candidate is not "no floor": the gate stays
    expect(sleepFirstHold(take, frame(BED, { inside: '深い水の中（足の下も水で床が無い）。水際の足場候補: (1,62,1) は sand（床になる）' }), 'w')).not.toBeNull();
  });
  it('the bed lines are the one line afloat, and the long ones on land', () => {
    const afloat = frame(BED, { inside: AFLOAT, time: '12900' }), land = frame(BED, { time: '12900' });
    const world = (f: BodyObservation) => f.state.world as Record<string, unknown>;
    const counts = new Map([['white_bed', 2]]);
    expect(nightBedLine(world(afloat), counts, 'overworld')).toBe(AFLOAT_NO_SLEEP);
    expect(nightBedLine(world(land), counts, 'overworld')).toContain('ベッドを持っている');
    expect(dayBedLine(world(frame(BED, { inside: AFLOAT, time: '9000' })), counts, 'overworld')).toBe(AFLOAT_NO_SLEEP);
    expect(sleepStateLine(afloat, 'w', null)).toBeNull();
    expect(sleepStateLine(land, 'w', null)).toContain('夜の睡眠: ベッドを持っていて');
  });
});

describe('(d) the furnace ledger says what leaving costs', () => {
  it('adds the metres and the seconds there and back, from where she stands and from the now place', () => {
    const planNow = '次の節 [n1] 地表を南へ歩き（済む条件: at:455,64,1434~30@overworld／今: 未）';
    const context = ledgerContextOf({ position: { x: 221, y: 62, z: 92 } }, planNow);
    expect(context).toEqual({ at: { x: 221, z: 92 }, next: { x: 455, z: 1434 } });
    const [head, line] = furnaceLedgerLines([PORK_JOB], context)!;
    expect(head).toContain('往復の秒数と焼き終わりまでの秒数を比べて決める');
    expect(line).toContain('あと約 84 秒。かまどはいまいる所から 118 m（離れて戻る往復は約 59〜118 秒）・今の節の行き先から 1,480 m（離れて戻る往復は約 740〜1,480 秒）');
    expect(head).not.toContain('待て');
  });
  it('is as before without a context', () => {
    expect(furnaceLedgerLines([PORK_JOB])![1]).toBe('かまど (214,64,-26): porkchop×20 → cooked_porkchop×20、あと約 84 秒');
  });
});

describe('the fish and the beds', () => {
  it('says the reach beside a fish, and not beside land food', () => {
    const fish = frame([['iron_sword', 1]], { nearbyEntities: [{ name: 'cod', id: 7, distance: 20, position: { x: 1, y: 60, z: 1 } }] });
    expect(foodLine(fish, 6)).toContain('目から 3 m 以内でないと届かない');
    const pig = frame([['iron_sword', 1]], { nearbyEntities: [{ name: 'pig', id: 8, distance: 20, position: { x: 1, y: 60, z: 1 } }] });
    expect(foodLine(pig, 6)).not.toContain('目から 3 m');
  });
  it('names 8 for the End check and 10 for the fight beside the beds', () => {
    const parts = readinessOf(frame([['iron_sword', 1], ['white_bed', 6]]))!;
    expect(preparationShortage({ ...parts, nowKinds: ['stronghold' as const], world: parts.world })).toContain('ベッド（エンドの点検は 8・戦いの目標は 10） 6/8');
  });
});
