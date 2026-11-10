import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanNode } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { ActInput } from '../src/contracts/minecraftActContract.js';
import { forgetPlanChoices, furnaceMeanwhileLine, planChoice, rememberPlanChoice } from '../src/surfaces/minecraft/minecraftFurnaceMeanwhile.js';
import { dropWaitBeforeTake, forgetFurnaceStands, FURNACE_STAND_HOLDS, furnaceStandHold } from '../src/surfaces/minecraft/minecraftLlmcFurnaceWait.js';
import { heldBeforeSend, heldOfFrame } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { heldBeforeSendQueued } from '../src/surfaces/minecraft/minecraftLlmcQueueSend.js';
import { nightWaitHold } from '../src/surfaces/minecraft/minecraftLlmcNightWaitHold.js';
import { forgetSleepHolds, sleepFirstHold } from '../src/surfaces/minecraft/minecraftLlmcSleepHold.js';
import { dayBedLine } from '../src/surfaces/minecraft/minecraftNightArms.js';

/**
 * Run 6 (2026-11-11, task 0fa30ba4: 362 s of 1,564 were waits, 270 s of them at the furnace; the ledger's 「別の作業を足す」 named no work, the one-time stand refusal fired
 * once in seven, `wait 30, take` was the head's timer for a take, and sleep was waited for). The scene: the furnace (253,37,-121) holds raw_iron ×9 with 88 s to go, iron
 * ×3 at (255,31,-127) and coal ×13 at (248,35,-123) are on the map 6 to 9 m away, a stone pickaxe is carried.
 */
const job = (patch: Record<string, unknown> = {}) => ({ status: 'waiting_external', remainingEstimateMs: 88_000, input: 'raw_iron', count: 9, expects: 'iron_ingot×9',
  position: { x: 253, y: 37, z: -121 }, completionVerified: false, ...patch });
const MARKS = ['i 鉄鉱石[iron_ore] (255,31,-127) 東2・北5・下6 ×3 見えている', 'c 石炭[coal_ore] (248,35,-123) 西5・南2・下2 ×13 見えている'];
const world = (patch: Record<string, unknown> = {}) => ({ dimension: 'overworld', position: { x: 253, y: 37, z: -122 }, health: 20, food: 20, time: '6000', worn: '',
  inventory: [{ name: 'stone_pickaxe', count: 1 }, { name: 'raw_iron', count: 9 }], jobs: [job()], mapLandmarks: MARKS, ...patch });
const frame = (patch: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: world(patch) as never } });
const act = (...hands: Array<Record<string, unknown>>): ActInput => ({ hands } as unknown as ActInput);
const wait = (seconds: number) => ({ do: 'wait', seconds });
const mine = { do: 'mine', block: 'coal_ore', count: 4 };
const take = { do: 'furnace', at: [{ x: 253, y: 37, z: -121 }], op: 'take' };
const put = { do: 'furnace', at: [{ x: 253, y: 37, z: -121 }], op: 'put', item: 'raw_iron' };
const node = (patch: Partial<PlanNode> & { id: string; title: string }): PlanNode => ({ parentId: null, order: 1, state: 'continue', ...patch } as PlanNode);

beforeEach(() => { forgetFurnaceStands(); forgetPlanChoices(); forgetSleepHolds(); });

describe('the stand at the furnace is held, with the work as hands', () => {
  it('holds a wait of 10 s or more at that hand when a furnace works, behind a mine of the same act (run 6 q22: `mine, wait 20, take`), and says the hands to take instead', () => {
    const held = heldOfFrame(act(mine, wait(20), take), frame(), 't1')!;
    expect(held).toMatchObject({ hand: 2, code: 'furnace_stand', kind: 'wait' });
    for (const word of ['かまど (253,37,-121) の raw_iron×9 はあと約 88 秒', '1/3 回目', '立って待つと焼く間の 20 秒がそのまま止まる', 'take は待たなくてよい',
      'A) 鉄鉱石 (255,31,-127)', 'mine iron_ore 255,31,-127 count=3', 'B) 石炭 (248,35,-123)', 'mine coal_ore 248,35,-123 count=4']) expect(held.line, word).toContain(word);
  });
  it('judges the new item\'s own hands: a `mine` ahead in the queue does not make the new `wait 30` a worker (run 6 q23), and a put ahead counts for it', () => {
    const queued = heldBeforeSendQueued(false, act(wait(30), take), frame(), 't2', [act(mine)]);
    expect(queued?.result?.text).toContain('立って待つ wait（30 秒）は送らない');
    const none = frame({ jobs: [] });
    expect(heldBeforeSendQueued(false, act(wait(30)), none, 't3', [act(put)])?.result?.text).toContain('立って待つ wait');
    expect(heldBeforeSendQueued(false, act(wait(30)), none, 't4', [act(mine)])).toBeNull();
  });
  it('holds a run of short waits that adds up (6 x 5 s), a put in the same act with no furnace in the frame yet, and says the split when one furnace holds 5 or more', () => {
    expect(furnaceStandHold(act(wait(5), wait(5), wait(5), wait(5)), frame(), 'a')).toMatchObject({ hand: 1, kind: 'wait' });
    expect(furnaceStandHold(act(put, wait(30)), frame({ jobs: [] }), 'b')).toMatchObject({ hand: 2 });
    expect(furnaceStandHold(act(wait(30)), frame(), 'c')!.line).toContain('raw_iron×9 を1基で焼くと 90 秒かかる');
  });
  it('holds nothing for a short wait, an urgent decision, no furnace, or a night with no work to put beside it', () => {
    expect(furnaceStandHold(act(wait(5)), frame(), 'd')).toBeNull();
    expect(furnaceStandHold(act(wait(30)), frame(), 'e', true)).toBeNull();
    expect(furnaceStandHold(act(wait(30)), frame({ jobs: [] }), 'f')).toBeNull();
    expect(furnaceStandHold(act(wait(30)), frame({ mapLandmarks: [], inventory: [] }), 'g')).toBeNull();
    expect(furnaceStandHold(act(mine, take), frame(), 'h')).toBeNull();
  });
  it('holds three times and then lets the wait go; the count is of the holds that stopped the act', () => {
    let clock = 0;
    const now = () => clock;
    const first = furnaceStandHold(act(wait(30)), frame(), 'i', false, 0, now)!;
    expect(first.line).toContain('1/3 回目');
    // Not committed: asking again says the same count.
    expect(furnaceStandHold(act(wait(30)), frame(), 'i', false, 0, now)!.line).toContain('1/3 回目');
    first.commit();
    for (let n = 2; n <= FURNACE_STAND_HOLDS; n++) { clock += 1000; const hold = furnaceStandHold(act(wait(30)), frame(), 'i', false, 0, now)!; expect(hold.line).toContain(`${n}/3 回目`); hold.commit(); }
    expect(furnaceStandHold(act(wait(30)), frame(), 'i', false, 0, now)).toBeNull();
    clock += 11 * 60_000;
    expect(furnaceStandHold(act(wait(30)), frame(), 'i', false, 0, now)).not.toBeNull();
  });
  it('is sent as a partial act: the hands before the wait go, the rest comes back as the hold\'s fact', () => {
    const before = heldBeforeSend(false, act(mine, wait(20), take), frame(), 'j')!;
    expect((before.input as { hands: unknown[] }).hands).toHaveLength(1);
    expect(before.tail).toContain('手 2 から先 2 手');
    expect(before.tail).toContain('立って待つ wait（20 秒）は送らない');
  });
});

describe('after the holds, a wait right before a take is taken out of the act', () => {
  const used = (taskId: string) => { for (let n = 0; n < FURNACE_STAND_HOLDS; n++) furnaceStandHold(act(wait(30)), frame(), taskId)!.commit(); };
  it('removes `wait 30` before `furnace take`, says so, and does nothing before the holds are used up or when hands name each other', () => {
    expect(dropWaitBeforeTake(act(wait(30), take), 'k')).toBeNull();
    used('k');
    const dropped = dropWaitBeforeTake(act(mine, wait(30), take), 'k')!;
    expect((dropped.input as { hands: unknown[] }).hands).toEqual([mine, take]);
    expect(dropped.note).toContain('手 2 の wait 30 秒は take の前だったので外した');
    expect(dropWaitBeforeTake(act(wait(5), take), 'k')).toBeNull();
    expect(dropWaitBeforeTake(act(wait(30), { ...take, dependsOn: [1] }), 'k')).toBeNull();
    expect(dropWaitBeforeTake(act(wait(30), mine), 'k')).toBeNull();
  });
  it('is what the tools send: the act without the wait and the fix said as a note', () => {
    used('m');
    const before = heldBeforeSend(false, act(wait(30), take), frame(), 'm')!;
    expect((before.input as { hands: unknown[] }).hands).toEqual([take]);
    expect(before.note).toContain('頭が形を直して送った');
    expect(before.result).toBeUndefined();
  });
});

describe('the furnace line of the live body (planNow): what to do while it burns', () => {
  const nodes = [node({ id: 'p3.1', title: '最初の鉄3で鉄のツルハシ', doneWhen: 'have:iron_pickaxe>=1' }), node({ id: 'p4', title: '水入りバケツ', order: 2, doneWhen: 'have:water_bucket>=1' }),
    node({ id: 'p5', title: '石の剣と丸石 32', order: 3 })];
  const counts = new Map([['stone_pickaxe', 1]]);
  it('says the seconds, that waiting stops everything, the hands as written and the next section that does not need the furnace\'s output', () => {
    const line = furnaceMeanwhileLine(world(), counts, nodes, 'p3.1', 't')!;
    for (const word of ['かまど (253,37,-121) の raw_iron×9 は あと約 88 秒', 'ここで待てば 88 秒 なにも進まない', 'A) 鉄鉱石 (255,31,-127)（8m）', 'mine iron_ore 255,31,-127 count=3',
      'B) 石炭 (248,35,-123)', 'C) 次の節 [p5] 石の剣と丸石 32（かまどの出力に頼らない）', '時間が来たら furnace 253,37,-121 take（早めに足してもよい',
      'wait は A・B・C のどれもできない時だけ']) expect(line, word).toContain(word);
    expect(line).not.toContain('[p4]');
  });
  it('says nothing with no furnace working, or when there is nothing to put beside it; a pickaxe is needed for the iron', () => {
    expect(furnaceMeanwhileLine(world({ jobs: [] }), counts, nodes, 'p3.1')).toBeNull();
    expect(furnaceMeanwhileLine(world({ jobs: [job({ remainingEstimateMs: 0 })] }), counts, nodes, 'p3.1')).toBeNull();
    expect(furnaceMeanwhileLine(world({ mapLandmarks: [] }), counts, [nodes[0]!], 'p3.1')).toBeNull();
    const woodOnly = furnaceMeanwhileLine(world(), new Map([['wooden_pickaxe', 1]]), [], null)!;
    expect(woodOnly).not.toContain('鉄鉱石');
    expect(woodOnly).toContain('A) 石炭');
  });
  it('skips a section whose prep was skipped, and one that needs the furnace\'s output (food for a cooked meat)', () => {
    const skipped = [node({ id: 'p2v', title: '村を回る', prep: { state: 'skipped' } }), node({ id: 'p6', title: '木を切る' })];
    expect(planChoice(skipped, 'p2v', { input: 'raw_iron', expects: 'iron_ingot×9' })).toContain('[p6]');
    expect(planChoice([node({ id: 'p1', title: '食料 40 点' })], 'p1', { input: 'beef', expects: 'cooked_beef×8' })).toBeNull();
  });
  it('gives the hold the plan\'s choice the live body last computed for the task', () => {
    furnaceMeanwhileLine(world({ mapLandmarks: [] }), counts, nodes, 'p3.1', 'task-x');
    expect(furnaceStandHold(act(wait(30)), frame({ mapLandmarks: [] }), 'task-x')!.line).toContain('A) 次の節 [p5]');
    rememberPlanChoice('task-y', null);
    expect(furnaceStandHold(act(wait(30)), frame({ mapLandmarks: [] }), 'task-y')).toBeNull();
  });
});

describe('sleeping is one hand, not a wait', () => {
  const BED = [{ name: 'white_bed', count: 1 }, { name: 'iron_sword', count: 1 }];
  const planks = act({ do: 'mine', block: 'oak_planks', count: 8 });
  it('a sleep hand sent by day is a booking: the night\'s first work hand of that task is not held for "sleep first" (the body lies down itself)', () => {
    const day = frame({ time: '9000', inventory: BED, jobs: [], mapLandmarks: [] });
    const night = frame({ time: '14000', inventory: BED, jobs: [], mapLandmarks: [] });
    expect(sleepFirstHold(planks, night, 'book')).not.toBeNull();
    expect(sleepFirstHold(act({ do: 'sleep' }, mine), day, 'book')).toBeNull();
    expect(sleepFirstHold(planks, night, 'book')).toBeNull();
    expect(sleepFirstHold(planks, night, 'other')).not.toBeNull();
  });
  it('a wait that names an item of the queue is a result wait, not a night wait', () => {
    const waiting = { ...act(wait(30)), dependsOn: ['q12'] };
    const night = frame({ time: '14000', inventory: [{ name: 'stone_pickaxe', count: 1 }], jobs: [], mapLandmarks: [] });
    expect(nightWaitHold(waiting, night, 'dep')).toBeNull();
  });
  it('the day line and the bed line say one sleep hand in the work act, and that nothing is waited for', () => {
    const line = dayBedLine({ timeOfDay: 1000 }, new Map([['white_bed', 1]]), 'overworld')!;
    expect(line).toContain('sleep を作業の act の先頭か末尾に 1 手入れる');
    expect(line).toContain('夜になり次第、体が次の手の前で寝る。待たなくてよい');
  });
});
