import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { agedScan, SCAN_FIELD_MS } from '../src/surfaces/minecraft/minecraftLlmcScanAge.js';
import { foodLine } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { foodLeads, ironSearchLine } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { scanForPlan } from '../src/surfaces/minecraft/minecraftLlmcProbe.js';
import { dayBedLine, nightChoiceLine } from '../src/surfaces/minecraft/minecraftNightArms.js';
import { doneStatusWords } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { createMinecraftJourney } from '../src/surfaces/minecraft/minecraftLlmcJourney.js';
import { PERSON_WORDS_LINES } from '../src/surfaces/minecraft/minecraftRequestPeople.js';
import { PLAN_UPDATE_DEFINITION } from '../src/mind/action/fca/fcaPlanTools.js';
import { applyPlanUpdate, planFromSeeds } from '@shannon/mind';

/** The scan is read once and kept: what said its rows as a fact of now is judged in one place (`agedScan`). */
const T0 = Date.parse('2026-01-01T00:00:00Z');
const scan = (rows: string[], extra: Record<string, unknown> = {}) => ({ trigger: 'login', at: new Date(T0).toISOString(), dimension: 'minecraft:overworld',
  center: { x: -113, y: 67, z: -152 }, text: '村・畑', rows, ...extra });
const FIELD = '畑・作物 ×3 最寄り (-115,70,-149) 南西 3m・上 3';
const HAY = '干し草 ×6 最寄り (-100,68,-150) 東 13m・上 1';
const IRON = '鉄鉱石 ×33907 最寄り (-73,61,-119) 東12m・下10 ｜空気に面した最寄り (-91,30,-140) 北23m・下41';
const minutes = (n: number) => T0 + n * 60_000;
const feet = { x: -105, y: 71, z: -157 };

describe('agedScan: one judgment of a scan row by the scan\'s time and base, against now and her feet', () => {
  it('drops the field and crop rows after their time, keeps the still rows with a mark, and works the distance out again from her feet', () => {
    const fresh = agedScan(scan([FIELD, HAY]), minutes(1), feet);
    expect(fresh.rows).toHaveLength(2);
    expect(fresh.mark).toContain('1 分前');
    expect(fresh.mark).toContain('基点 (-113,67,-152)');
    expect(fresh.mark).toContain('今は未確認');
    expect(fresh.rows[0]).toContain('今の足元から水平 13m');
    const later = agedScan(scan([FIELD, HAY]), T0 + SCAN_FIELD_MS + 1, feet);
    expect(later.rows).toHaveLength(1);
    expect(later.rows[0]).toContain('干し草');
    expect(later.dropped).toBe(1);
  });
  it('drops a field row when she is far from the base, whatever the time', () => {
    expect(agedScan(scan([FIELD]), minutes(1), { x: 0, y: 70, z: 0 }).rows).toEqual([]);
  });
  it('says nothing for no scan, and judges only the distance when a time is not known', () => {
    expect(agedScan(null, minutes(1), feet)).toMatchObject({ rows: [], mark: null });
    const unknown = agedScan(scan([FIELD]), null, feet);
    expect(unknown.rows).toHaveLength(1);
    expect(unknown.mark).toContain('時刻不明');
  });
});

describe('the village\'s food: a scan row is said as a scan, never under the name of what is seen', () => {
  const observation = (world: Record<string, unknown>, at: number): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: new Date(at).toISOString(),
    receivedAt: 't', connected: true, state: { world } as never, facts: {} as never });
  const world = (rows: string[]) => ({ position: { ...feet }, food: 10, inventory: [], nearbyEntities: [], scan: scan(rows) });
  it('a fresh row carries the scan\'s age and base; the know-how of hay stays', () => {
    const line = foodLine(observation(world([FIELD, HAY]), minutes(2)), 3)!;
    expect(line).toContain('村の食べ物（走査 2 分前・基点 (-113,67,-152)・今は未確認）');
    expect(line).toContain('干し草は 1 個でパン 3');
  });
  it('after the time the field row is gone from the line (nothing says a field is there), while the hay row and its know-how stay', () => {
    const line = foodLine(observation(world([FIELD, HAY]), minutes(10)), 3)!;
    expect(line).not.toContain('畑・作物');
    expect(line).toContain('干し草');
    expect(line).toContain('干し草は 1 個でパン 3');
  });
  it('when every row is dropped for its age the know-how still stays, and with no hay ever seen there is no line', () => {
    expect(foodLine(observation(world([HAY]), minutes(200)), 3)).toContain('干し草は 1 個でパン 3');
    expect(foodLine(observation(world([FIELD]), minutes(10)), 3)).toBeNull();
  });
});

describe('where food is, the descent note and the survey go through the same judgment', () => {
  it('foodLeads marks the scan rows, drops the old field row and says the dropped ones are not used', () => {
    const w = { position: { ...feet }, nearbyEntities: [], scan: scan([FIELD]) };
    expect(foodLeads(w, 'overworld', [], minutes(1))).toContain('走査 1 分前');
    const old = foodLeads(w, 'overworld', [], minutes(20));
    expect(old).not.toContain('畑・作物 ×3');
    expect(old).toContain('古いので使わない');
  });
  it('the survey keeps no scan row (it would carry the time of this visit)', () => {
    const journey = createMinecraftJourney(null);
    const observation: BodyObservation = { schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: new Date(minutes(1)).toISOString(), receivedAt: 't', connected: true,
      state: { world: { position: { ...feet }, dimension: 'overworld', food: 10, health: 20, nearbyEntities: [], scan: scan([FIELD]),
        localMap: '地図 v1 方式=surface\n' }, life: { life: 1, dimension: 'overworld' } } as never, facts: { dimension: 'overworld' } as never };
    journey.read(observation);
    const saved = JSON.stringify(journey.checkpoint());
    expect(saved).not.toContain('畑・作物');
  });
});

describe('iron: the scan\'s nearest iron stays in the input, and "not visible" is not said over it', () => {
  const now = { id: 'p1.4', title: '鉄を掘る', doneWhen: 'have:iron_ingot>=9' } as never;
  const pack = new Map([['stone_pickaxe', 1]]);
  const world = { position: { ...feet }, mapLandmarks: [], scan: scan([IRON]) };
  it('says the buried iron with the scan\'s age and its distance from her feet, with the reason', () => {
    const line = ironSearchLine(world, pack, 'overworld', now, minutes(3))!;
    expect(line).toContain('鉄鉱石の当て（走査 3 分前');
    expect(line).toContain('(-73,61,-119) 今の足元から水平');
    expect(line).not.toContain('地図に見えていない');
    expect(line).toContain('近くに鉄が無い時だけ');
  });
  it('with no iron row, the stair to y=16 is for when none is near and says iron is in the rock near the surface too', () => {
    const line = ironSearchLine({ ...world, scan: scan([HAY]) }, pack, 'overworld', now, minutes(3))!;
    expect(line).toContain('近くに無い時だけ。鉄は地表〜y=70 の岩・谷・洞窟の壁にも出る');
  });
});

describe('the first plan reads the scan with its time and base; the night and the Nether\'s share', () => {
  it('heads the scan with the time and the base point', () => {
    const text = scanForPlan(scan([FIELD]))!;
    expect(text.split('\n')[0]).toContain('読んだ時刻 2026-01-01T00:00:00');
    expect(text.split('\n')[0]).toContain('基点 (-113,67,-152)');
  });
  const world = { timeOfDay: 18_200, position: { x: 214.5, y: 79, z: 29.5 }, mapLandmarks: [] };
  it('says the Nether target\'s share only while the Nether is the goal, and says the hole is an entrance, not a place to wait', () => {
    const pack = new Map([['stone_pickaxe', 1], ['cobblestone', 20]]);
    const whole = nightChoiceLine(world, pack, 'overworld')!;
    const request = nightChoiceLine(world, pack, 'overworld', false, undefined, false)!;
    expect(whole).toContain('ネザーまで');
    expect(request).not.toContain('ネザーまで');
    expect(request).toContain('朝まで待つ場所ではない');
    expect(dayBedLine({ timeOfDay: 1_000, position: { x: 0, y: 70, z: 0 }, mapLandmarks: [] }, new Map([['white_bed', 1]]), 'overworld', false, false) ?? '').not.toContain('ネザーまで');
  });
});

describe('a wheat shortage says the seeds she holds and that it takes time; the person\'s facts outrank the rows', () => {
  const facts = (counts: Record<string, number>) => ({ counts: new Map(Object.entries(counts)), feet: null, food: 0, dimension: 'overworld', hp: 20, hunger: 20, free: 10,
    night: false, utilities: [], seen: [], crystals: null, village: null, woodNear: null, foodNear: null, foodVillage: null, foodHay: null }) as never;
  it('adds the seeds and the growth time to the unmet wheat, and not once she has it', () => {
    expect(doneStatusWords('have:wheat>=3', facts({ wheat_seeds: 4 }))).toContain('wheat 0/3（種 4 個。育つまで時間がかかる（骨粉で短くなる）');
    expect(doneStatusWords('have:wheat>=3', facts({ wheat: 3 }))).toBe('満たしている');
    expect(doneStatusWords('have:sugar>=2', facts({}))).toBe('未: sugar 0/2');
  });
  it('the words for a person\'s fact say it is stronger than a row, to fix the place, and why', () => {
    const text = PERSON_WORDS_LINES.join('\n');
    expect(text).toContain('走査・記憶・計画の行より強い');
    expect(text).toContain('where を ""');
    expect(text).toContain('理由: 古い走査や記憶の行は毎判断に出る');
  });
  it('plan_update can clear a place with an empty where (the person\'s fact removes the field)', () => {
    expect(JSON.stringify(PLAN_UPDATE_DEFINITION.nativeInputSchema)).toContain('where');
    const tree = planFromSeeds([{ id: 'p1', title: '小麦を集める', where: '畑・作物 (-115,70,-149)', doneWhen: 'have:wheat>=3' }])!;
    const after = applyPlanUpdate(tree, { ops: [{ op: 'set', id: 'p1', where: '', note: '本人: 畑は今は無い' }] }).tree;
    expect(after.nodes.find(node => node.id === 'p1')?.where).toBeUndefined();
    expect(after.nodes.find(node => node.id === 'p1')?.note).toContain('本人');
  });
});
