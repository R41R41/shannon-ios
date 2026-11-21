import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveMoment } from '@shannon/mind';
import type { BodyObservation, BodyPlanView } from '../src/contracts/bodyControlContract.js';
import type { FcaBodyLifecycle } from '../src/mind/action/fca/fcaPorts.js';
import { MinecraftLive, type LiveFrames, type LiveTaskInfo } from '../src/surfaces/minecraft/minecraftLive.js';
import { withMinecraftLive } from '../src/surfaces/minecraft/minecraftLiveBody.js';
import { LiveCommentary } from '../src/surfaces/minecraft/minecraftLiveCommentary.js';
import { LiveSpeechOutbox } from '../src/surfaces/minecraft/minecraftLiveSpeech.js';

const T0 = Date.parse('2026-11-22T10:00:00.000Z');
let sequence = 0;
const observation = (inventory: Array<{ name: string; count: number }> = []): BodyObservation => ({
  schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: new Date(T0).toISOString(), receivedAt: new Date(T0).toISOString(), connected: true,
  state: { world: { dimension: 'overworld', biome: 'plains', health: 20, food: 18, time: '2000', inventory } },
  facts: { alive: true, dimension: 'overworld' },
});
const node = (id: string, title: string, state: 'done' | 'continue' | 'wait' | 'blocked' = 'continue', parentId: string | null = null, doneWhen?: string) =>
  ({ id, parentId, title, state, ...(doneWhen ? { doneWhen } : {}) });
const view = (revision: number, current: string | null, nodes: BodyPlanView['nodes']): BodyPlanView => ({ revision, current, nodes });

function fixture(options: { origin?: string; phase?: () => string | null } = {}) {
  let clock = T0, current: BodyObservation = observation();
  const frames: LiveFrames = { latest: (_id, maxAge) => ({ observation: current, ageMs: Math.min(maxAge, 0) }), available: () => ['minecraft:world'] };
  const live = new MinecraftLive({ frames, now: () => clock });
  const moments: LiveMoment[] = [];
  live.onMoment(moment => moments.push(moment));
  const task: LiveTaskInfo = { taskId: 'task', scopeKey: 'owner', goal: 'ケーキを作る', origin: options.origin ?? 'owner_request', createdAtMs: T0,
    bodyId: 'minecraft:world', netherReached: null, ...(options.phase ? { phase: options.phase } : {}) };
  live.begin(task);
  const kinds = () => moments.map(moment => moment.kind);
  return { live, moments, kinds, advance(ms: number) { clock += ms; },
    /** One frame of the body with these items, after the detector's interval. */
    see(inventory: Array<{ name: string; count: number }> = []) { clock += 500; current = observation(inventory); live.frame('minecraft:world', current, { newConnection: false }); } };
}

describe('her plan, said as it changes', () => {
  it('tells the plan she begins with, a step that is done and the node she goes to, and nodes added or dropped', () => {
    const f = fixture();
    f.live.plan('task', view(1, 'a', [node('a', '木を集める'), node('b', '作業台を作る'), node('c', '鉄を掘る')]));
    expect(f.moments.at(-1)).toMatchObject({ kind: 'plan_changed', facts: { added: '木を集める、作業台を作る、鉄を掘る', first: true } });
    // The same revision again is nothing new.
    f.live.plan('task', view(1, 'a', [node('a', '木を集める'), node('b', '作業台を作る'), node('c', '鉄を掘る')]));
    expect(f.moments).toHaveLength(1);
    f.live.plan('task', view(2, 'b', [node('a', '木を集める', 'done'), node('b', '作業台を作る'), node('c', '鉄を掘る')]));
    expect(f.moments.at(-1)).toMatchObject({ kind: 'plan_step', facts: { done: '木を集める', next: '作業台を作る' } });
    f.live.plan('task', view(3, 'b', [node('a', '木を集める', 'done'), node('b', '作業台を作る'), node('d', 'バケツを作る'), node('c', '鉄を掘る')]));
    expect(f.moments.at(-1)).toMatchObject({ kind: 'plan_changed', facts: { added: 'バケツを作る', dropped: '' } });
    f.live.plan('task', view(4, 'b', [node('a', '木を集める', 'done'), node('b', '作業台を作る'), node('c', '鉄を掘る', 'blocked')]));
    expect(f.moments.at(-1)).toMatchObject({ kind: 'plan_changed', facts: { dropped: 'バケツを作る', blocked: '鉄を掘る' } });
  });

  it('gives the conversation the section she is on and the points left of the plan', () => {
    const f = fixture();
    f.see();
    f.live.plan('task', view(1, 'b', [node('a', '木を集める', 'done'), node('b', '作業台を作る'), node('c', '鉄を掘る'), node('c1', '洞窟へ行く', 'continue', 'c')]));
    const plan = (f.live.snapshot() as { plan?: { section: string | null; points: string[] } } | null)?.plan;
    expect(plan).toEqual({ section: '作業台を作る', points: ['作業台を作る', '鉄を掘る'] });
    expect(fixture().live.snapshot()).not.toHaveProperty('plan');
    expect(f.live.block({ alone: false, participants: true })).toContain('マイクラの体の今');
  });

  it('counts a parent that closed with its last child as one step, the inner one', () => {
    const f = fixture();
    f.live.plan('task', view(1, 'a1', [node('a', '牛乳を用意する'), node('a1', '鉄を掘る', 'continue', 'a'), node('a2', 'バケツを作る', 'continue', 'a')]));
    f.live.plan('task', view(2, null, [node('a', '牛乳を用意する', 'done'), node('a1', '鉄を掘る', 'done', 'a'), node('a2', 'バケツを作る', 'done', 'a')]));
    const steps = f.moments.filter(moment => moment.kind === 'plan_step');
    expect(steps).toHaveLength(1);
    expect(steps[0]?.facts.done).toBe('バケツを作る');
  });

  it('does not count the stages of a run to the dragon for another request', () => {
    const cake = fixture();
    const dragon = fixture();
    dragon.live.begin({ taskId: 'task', scopeKey: 'owner', goal: 'エンドラを討伐してください', origin: 'owner_request', createdAtMs: T0, bodyId: 'minecraft:world', netherReached: null });
    const run = [[], [{ name: 'oak_log', count: 5 }], [{ name: 'iron_pickaxe', count: 1 }, { name: 'iron_ingot', count: 9 }]];
    for (const inventory of run) { cake.see(inventory); dragon.see(inventory); }
    cake.advance(2_000_000);
    dragon.advance(2_000_000);
    cake.see(run[2]);
    dragon.see(run[2]);
    expect(cake.kinds().filter(kind => kind.startsWith('milestone'))).toEqual([]);
    expect(dragon.kinds().filter(kind => kind.startsWith('milestone')).length).toBeGreaterThan(0);
  });

  it('says nothing for a plan with no nodes, a task it does not know, or a plan it cannot read', () => {
    const f = fixture();
    f.live.plan('task', view(1, null, []));
    f.live.plan('other', view(1, 'a', [node('a', '木')]));
    f.live.plan('task', undefined);
    expect(f.moments).toEqual([]);
  });
});

describe('what her work needs, and what she gets of it', () => {
  it('tells a need once, and again only when more is needed', () => {
    const f = fixture();
    f.live.need('task', { item: 'iron_ingot', count: 3, use: 'バケツ' });
    f.live.need('task', { item: 'iron_ingot', count: 3, use: 'バケツ' });
    f.live.need('task', { item: 'iron_ingot', count: 2, use: 'バケツ' });
    f.live.need('task', { item: 'iron_ingot', count: 5, use: 'バケツと鍋' });
    f.live.need('task', { item: 'ignore this', count: 1, use: '' });
    expect(f.moments.map(moment => moment.facts)).toEqual([
      { item: 'iron_ingot', count: 3, use: 'バケツ' }, { item: 'iron_ingot', count: 5, use: 'バケツと鍋' }]);
  });

  it('tells an item the work asked for when she first has one and when she has all of it; any other item is not news', () => {
    const f = fixture();
    f.see();
    f.live.need('task', { item: 'wheat_seeds', count: 3, use: '畑' });
    f.live.need('task', { item: 'planks', count: 4, use: '作業台' });
    f.moments.length = 0;
    f.see([{ name: 'dirt', count: 5 }, { name: 'cobblestone', count: 9 }]);
    expect(f.moments).toEqual([]);
    f.see([{ name: 'wheat_seeds', count: 1 }]);
    f.see([{ name: 'wheat_seeds', count: 2 }]);
    f.see([{ name: 'wheat_seeds', count: 3 }, { name: 'oak_planks', count: 4 }]);
    expect(f.moments.filter(moment => moment.kind === 'material_got').map(moment => [moment.facts.item, moment.facts.count, moment.facts.need])).toEqual([
      ['wheat_seeds', 1, 3], ['wheat_seeds', 3, 3], ['planks', 4, 4]]);
    // Told once: losing and getting them again says nothing.
    f.see([]);
    f.see([{ name: 'wheat_seeds', count: 3 }]);
    expect(f.moments.filter(moment => moment.kind === 'material_got')).toHaveLength(3);
  });

  it('learns what is asked from the condition of a node: iron, eggs, milk and sugar come in without a table of names', () => {
    const f = fixture();
    f.see();
    f.live.plan('task', view(1, 'a', [node('a', '材料を集める'), node('b', '卵', 'continue', 'a', 'have:egg>=1'), node('c', '砂糖', 'continue', 'a', 'have:sugar>=2 かつ have:milk_bucket>=3')]));
    f.moments.length = 0;
    f.see([{ name: 'egg', count: 1 }, { name: 'iron_ingot', count: 1 }]);
    f.see([{ name: 'egg', count: 1 }, { name: 'sugar', count: 2 }, { name: 'milk_bucket', count: 1 }]);
    expect(f.moments.filter(moment => moment.kind === 'material_got').map(moment => moment.facts.item)).toEqual(['egg', 'sugar', 'milk_bucket']);
  });
});

describe('what the view keeps apart', () => {
  it('counts a run to the dragon written in English, and still not another request', () => {
    const dragon = fixture();
    dragon.live.begin({ taskId: 'task', scopeKey: 'owner', goal: 'Kill the Ender Dragon', origin: 'owner_request', createdAtMs: T0, bodyId: 'minecraft:world', netherReached: null });
    const run = [[], [{ name: 'oak_log', count: 5 }], [{ name: 'iron_pickaxe', count: 1 }, { name: 'iron_ingot', count: 9 }]];
    for (const inventory of run) dragon.see(inventory);
    expect(dragon.kinds()).toContain('milestone_passed');
  });

  it('keeps what she thinks and plans out of the recent moments the conversations read, which stay those of the world', () => {
    const f = fixture();
    f.see();
    f.see([{ name: 'diamond', count: 1 }]);
    f.live.thought('task', '鉄を探しに洞窟へ行く');
    f.live.plan('task', view(1, 'a', [node('a', '木を集める')]));
    f.live.need('task', { item: 'iron_ingot', count: 3, use: 'バケツ' });
    expect(f.kinds()).toEqual(expect.arrayContaining(['thinking', 'plan_changed', 'material_needed']));
    const recent = f.live.snapshot()?.recent.map(item => item.line) ?? [];
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.join('/')).toContain('ダイヤモンド');
    expect(recent.join('/')).not.toMatch(/いまの手のねらい|計画を直した|要ると分かった/u);
  });

  it('tells an item again to the next request that asks for it on the same body', () => {
    const f = fixture();
    f.see();
    f.live.need('task', { item: 'wheat', count: 3, use: 'ケーキ' });
    f.see([{ name: 'wheat', count: 3 }]);
    expect(f.moments.filter(moment => moment.kind === 'material_got')).toHaveLength(1);
    f.live.end('task');
    f.see([]);
    f.live.begin({ taskId: 'second', scopeKey: 'owner', goal: 'パンを作る', origin: 'owner_request', createdAtMs: T0, bodyId: 'minecraft:world', netherReached: null });
    f.live.need('second', { item: 'wheat', count: 3, use: 'パン' });
    f.see([{ name: 'wheat', count: 3 }]);
    expect(f.moments.filter(moment => moment.kind === 'material_got')).toHaveLength(2);
  });
});

describe('what she means, and the end of a request', () => {
  it('tells what an act is for, as a thought, once for the same words', () => {
    const f = fixture();
    f.live.thought('task', '[p1.2] 牛乳はバケツがいるから、先に鉄を掘る');
    f.live.thought('task', '牛乳はバケツがいるから、先に鉄を掘る');
    f.live.thought('task', 'あ');
    expect(f.moments).toHaveLength(1);
    expect(f.moments[0]).toMatchObject({ kind: 'thinking', facts: { why: '牛乳はバケツがいるから、先に鉄を掘る' } });
  });

  it('tells a request that is done once, when the task says so after its step ended; never her own errand, never one still going', () => {
    let phase: string | null = 'running';
    const f = fixture({ phase: () => phase });
    f.see();
    expect(f.kinds()).toEqual([]);
    f.live.end('task');
    f.see();
    expect(f.kinds()).toEqual([]);
    phase = 'completed';
    f.see();
    f.see();
    expect(f.moments.filter(moment => moment.kind === 'task_done')).toEqual([expect.objectContaining({ key: 'done:task', facts: { goal: 'ケーキを作る' } })]);
    const own = fixture({ origin: 'own_time', phase: () => 'completed' });
    own.see();
    own.live.end('task');
    own.see();
    expect(own.kinds()).toEqual([]);
    const late = fixture({ phase: () => 'completed' });
    late.see();
    late.live.end('task');
    late.advance(130_000);
    late.see();
    expect(late.kinds()).toEqual([]);
  });
});

describe('the body of a task tells her work to the view', () => {
  function wrapped() {
    const f = fixture();
    let plan = view(1, 'a', [node('a', '木を集める'), node('b', '作業台を作る')]);
    const step = { taskId: 'task', scopeKey: 'owner', snapshot: { checkpoint: null, task: { goal: 'ケーキを作る', origin: 'owner_request', createdAt: new Date(T0).toISOString() } } };
    const control = { store: { body: () => 'minecraft:world' }, available: () => ['minecraft:world'] };
    const inner = { context: () => ({}), noteCall: () => {}, noteResult: () => {}, close: async () => {} };
    const { body } = withMinecraftLive({ body: inner as unknown as FcaBodyLifecycle }, { live: f.live, control: control as never, step: step as never, plan: () => plan,
      phase: () => 'running' });
    return { f, body, setPlan: (next: BodyPlanView) => { plan = next; } };
  }
  const call = (name: string, input: unknown) => ({ id: 'c', name, input }) as never;

  it('reads the plan at each decision and after a plan or an act, a promise and a keep as needs, and an act\'s why as a thought', () => {
    const { f, body, setPlan } = wrapped();
    body.context();
    expect(f.kinds()).toEqual(['plan_changed']);
    const promise = call('plan.update', { ops: [{ op: 'promise', item: 'iron_ingot', count: 3, use: 'バケツ' }, { op: 'add', title: 'x' }] });
    body.noteCall?.(promise, 'op1');
    body.noteCall?.(call('mc.act', { why: '[p1] 木を切って板にする', hands: [], keep: [{ item: 'oak_planks', count: 4, use: '作業台' }] }), 'op2');
    // A promise is a need once the plan took it: a refused one says nothing.
    expect(f.moments.slice(1).map(moment => [moment.kind, moment.facts.item ?? moment.facts.why])).toEqual([
      ['material_needed', 'oak_planks'], ['thinking', '木を切って板にする']]);
    body.noteResult?.(promise, { ok: false, text: 'refused' } as never, 1);
    expect(f.moments.filter(moment => moment.facts.item === 'iron_ingot')).toEqual([]);
    body.noteResult?.(promise, { ok: true, text: '' } as never, 1);
    expect(f.moments.at(-1)).toMatchObject({ kind: 'material_needed', facts: { item: 'iron_ingot', count: 3, use: 'バケツ' } });
    setPlan(view(2, 'b', [node('a', '木を集める', 'done'), node('b', '作業台を作る')]));
    body.noteResult?.(call('plan.update', {}), { ok: true, text: '' } as never, 1);
    expect(f.kinds().at(-1)).toBe('plan_step');
    // A tool that is neither does not read the plan again.
    setPlan(view(3, 'b', [node('a', '木を集める', 'done'), node('b', '作業台を作る', 'done')]));
    body.noteResult?.(call('mc.probe', {}), { ok: true, text: '' } as never, 1);
    expect(f.kinds().at(-1)).toBe('plan_step');
    expect(f.moments.filter(moment => moment.kind === 'plan_step')).toHaveLength(1);
  });

  it('reads a keep written as the short line the model writes (品目:数:用途), one or several', () => {
    const { f, body } = wrapped();
    body.context();
    body.noteCall?.(call('mc.act', { hands: ['mine stone'], keep: ['spruce_planks:4:作業台', '"coal:2:たいまつ: 夜のため"'] }), 'op1');
    body.noteCall?.(call('mc.act', { hands: ['mine stone'], keep: 'iron_ingot:3:バケツ, not a line' }), 'op2');
    expect(f.moments.filter(moment => moment.kind === 'material_needed').map(moment => [moment.facts.item, moment.facts.count, moment.facts.use])).toEqual([
      ['spruce_planks', 4, '作業台'], ['coal', 2, 'たいまつ: 夜のため'], ['iron_ingot', 3, 'バケツ']]);
  });

  it('never fails a decision when the view throws', () => {
    const f = fixture();
    vi.spyOn(f.live, 'plan').mockImplementation(() => { throw new Error('no'); });
    const step = { taskId: 'task', scopeKey: 'owner', snapshot: { checkpoint: null, task: { goal: 'g', origin: 'owner_request', createdAt: new Date(T0).toISOString() } } };
    const { body } = withMinecraftLive({ body: { context: () => ({}), noteCall: () => {} } as unknown as FcaBodyLifecycle }, { live: f.live, control: { store: { body: () => null }, available: () => [] } as never,
      step: step as never, plan: () => view(1, null, [node('a', 'x')]) });
    expect(() => body.context()).not.toThrow();
  });
});

describe('her work in the commentary', () => {
  let clock = T0;
  beforeEach(() => { vi.useFakeTimers(); clock = T0; });
  afterEach(() => vi.useRealTimers());
  const moment = (kind: LiveMoment['kind'], facts: LiveMoment['facts'] = {}, key = `${kind}:${clock}`): LiveMoment => ({ kind, key, at: clock, facts });

  function setup(write?: () => Promise<string | null>, doneFallback?: string) {
    const listeners = new Set<(item: LiveMoment) => void>();
    const room = { replying: false, sinceHumanMilliseconds: null as number | null };
    const outbox = new LiveSpeechOutbox(() => clock);
    const refresh = () => outbox.receive([], { voice: true, humanSpeaking: false, sinceHumanMs: null });
    refresh();
    setInterval(refresh, 1000);
    const requests: Array<{ main: LiveMoment; also: readonly LiveMoment[] }> = [];
    const engine = new LiveCommentary({
      live: { onMoment: listener => { listeners.add(listener); return () => listeners.delete(listener); }, inDanger: () => false,
        conversation: () => ({ replying: room.replying, sinceHumanMilliseconds: room.sinceHumanMilliseconds }) },
      outbox, write: async request => { requests.push(request); return write ? write() : `言葉:${request.main.kind}`; }, now: () => clock,
      ...(doneFallback ? { doneFallback } : {}),
    });
    engine.start();
    return { engine, outbox, room, requests, emit: (item: LiveMoment) => listeners.forEach(listener => listener(item)),
      settle: async () => { await vi.advanceTimersByTimeAsync(10); } };
  }

  it('says the end of a request at once, in a conversation that spoke four seconds ago, as an urgent line', async () => {
    const f = setup();
    f.room.sinceHumanMilliseconds = 4_000;
    f.emit(moment('task_done', { goal: 'ケーキを作る' }));
    await f.settle();
    expect(f.requests.map(request => request.main.kind)).toEqual(['task_done']);
    expect(f.outbox.take()[0]).toMatchObject({ urgency: 'urgent', kind: 'task_done' });
  });

  it('closes what waits of her work when the request ends: the end says it', async () => {
    const f = setup();
    f.room.sinceHumanMilliseconds = 100;
    f.emit(moment('thinking', { why: '卵を探す' }, 'w'));
    f.emit(moment('material_got', { item: 'cake', count: 1 }, 'm'));
    f.emit(moment('plan_step', { done: '卵' }, 's'));
    f.emit(moment('task_done', { goal: 'ケーキを作る' }, 'd'));
    await f.settle();
    expect(f.engine.stats().waiting).toBe(1);
    f.room.sinceHumanMilliseconds = 30_000;
    await vi.advanceTimersByTimeAsync(1_600);
    expect(f.requests.map(request => [request.main.key, request.also.length])).toEqual([['d', 0]]);
  });

  it('keeps only the newest of the thoughts and plan steps that wait: an older one is about a step that has gone by', async () => {
    const f = setup();
    f.room.sinceHumanMilliseconds = 100;
    f.emit(moment('thinking', { why: 'まず木' }, 'w1'));
    f.emit(moment('plan_step', { done: '木' }, 's1'));
    f.emit(moment('thinking', { why: 'つぎ鉄' }, 'w2'));
    f.emit(moment('plan_step', { done: '板' }, 's2'));
    await f.settle();
    expect(f.engine.stats().superseded).toBe(2);
    expect(f.engine.stats().waiting).toBe(2);
    f.room.sinceHumanMilliseconds = 30_000;
    clock += 1_000;
    await vi.advanceTimersByTimeAsync(1_600);
    expect(f.requests.map(request => request.main.key)).toEqual(['s2']);
    expect(f.requests[0]?.also.map(item => item.key)).toEqual(['w2']);
  });

  it('does not say a thought once the moment it is about has gone by while the line was being written', async () => {
    let release: (text: string) => void = () => {};
    const f = setup(() => new Promise<string>(resolve => { release = resolve; }));
    f.emit(moment('thinking', { why: '牛乳はバケツがいる' }, 'w'));
    await f.settle();
    expect(f.requests).toHaveLength(1);
    clock += 22_000;
    release('牛乳ってバケツがいるんだ');
    await f.settle();
    expect(f.outbox.pending()).toBe(0);
    expect(f.engine.stats().write_dropped_stale).toBe(1);
  });

  it('lets a line that waited past its time go unsaid', async () => {
    const f = setup();
    f.emit(moment('plan_step', { done: '木' }));
    await f.settle();
    expect(f.outbox.pending()).toBe(1);
    clock += 16_000;
    expect(f.outbox.take()).toEqual([]);
  });

  it('gives each kind its own time: a thought is gone in ten seconds, the end of a request waits forty', async () => {
    const f = setup();
    f.emit(moment('thinking', { why: '鉄を探す' }));
    await f.settle();
    clock += 11_000;
    expect(f.outbox.take()).toEqual([]);
    const g = setup();
    g.emit(moment('task_done', { goal: 'ケーキを作る' }));
    await g.settle();
    clock += 30_000;
    expect(g.outbox.take()[0]).toMatchObject({ kind: 'task_done' });
  });

  it('says a fixed line for the end of a request when the writer gave nothing twice, and never for a thought', async () => {
    const f = setup(async () => null, 'できたよ！どこに置けばいい？');
    f.emit(moment('thinking', { why: '卵' }, 'w'));
    f.emit(moment('task_done', { goal: 'ケーキを作る' }, 'd'));
    await f.settle();
    expect(f.outbox.take()).toEqual([]);
    expect(f.engine.stats().revived).toBe(1);
    await vi.advanceTimersByTimeAsync(3_200);
    expect(f.engine.stats().done_fallback).toBe(1);
    expect(f.outbox.take().map(line => [line.kind, line.text])).toEqual([['task_done', 'できたよ！どこに置けばいい？']]);
  });

  it('drops the end of a request after two empty writes when no fixed line is given', async () => {
    const f = setup(async () => null);
    f.emit(moment('task_done', { goal: 'ケーキを作る' }, 'd'));
    await vi.advanceTimersByTimeAsync(3_200);
    expect(f.engine.stats().done_fallback).toBeUndefined();
    expect(f.outbox.take()).toEqual([]);
  });

  it('says the end of a request once more when the body could not say the first line, and no more than once', async () => {
    const f = setup();
    f.emit(moment('task_done', { goal: 'ケーキを作る' }, 'd'));
    await f.settle();
    const first = f.outbox.take()[0]!;
    f.outbox.receive([{ id: first.id, outcome: 'failed', reason: 'human_speaking' }], null);
    await vi.advanceTimersByTimeAsync(1_600);
    expect(f.engine.stats().revived).toBe(1);
    const second = f.outbox.take()[0]!;
    expect(second).toMatchObject({ kind: 'task_done' });
    expect(second.id).not.toBe(first.id);
    f.outbox.receive([{ id: second.id, outcome: 'failed', reason: 'human_speaking' }], null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.outbox.take()).toEqual([]);
    expect(f.requests.map(request => request.main.kind)).toEqual(['task_done', 'task_done']);
  });

  it('writes the end of a request again when the first answer was empty, and lets any other kind go', async () => {
    let calls = 0;
    const f = setup(async () => (++calls === 1 ? null : '言葉'));
    f.emit(moment('task_done', { goal: 'ケーキを作る' }, 'd'));
    await f.settle();
    await vi.advanceTimersByTimeAsync(1_600);
    expect(f.requests.map(request => request.main.kind)).toEqual(['task_done', 'task_done']);
    expect(f.outbox.take()[0]).toMatchObject({ kind: 'task_done', text: '言葉' });
    const g = setup(async () => null);
    g.emit(moment('material_got', { item: 'wheat', count: 1 }, 'm'));
    await g.settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(g.requests).toHaveLength(1);
  });
});
