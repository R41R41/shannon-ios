import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { ActInput } from '../src/contracts/minecraftActContract.js';
import type { FcaBodyLifecycle, FcaBodyQueue } from '../src/mind/action/fca/fcaPorts.js';
import { waitForQueue } from '../src/mind/action/fca/fcaStretch.js';
import { createLlmcEvents, forgetLlmcEvents } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { carriedFood, minecraftLlmcLive, minecraftLlmcUrgentLive, createFoodTrend } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { rewriteLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLiveRewrite.js';
import { queueLifecycle } from '../src/surfaces/minecraft/minecraftLlmcQueueBody.js';
import { heldBeforeSendQueued } from '../src/surfaces/minecraft/minecraftLlmcQueueSend.js';
import { queueLines } from '../src/surfaces/minecraft/minecraftLlmcQueueWords.js';
import { surpriseFrame } from '../src/surfaces/minecraft/minecraftLlmcProbe.js';
import { sendItem } from '../src/wiring/fcaMinecraftActItem.js';

/**
 * The small parts of the task queue on the head (design minebot-task-queue, 2026-10-26): the live state's lines, the guards that read an item after the
 * ones ahead of it, what the stretch does on a message, the lifecycle's additions, and the answer for a pre that does not hold.
 */
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });

describe('the queue in the live state', () => {
  const lines = ['▶ q1 [p7] 鉄へ 実行中: 手 2/3・残り約 4 秒', '・ q2 [p7] 掘る 待ち: 前提 near:furnace~4（前の項目の後で体が確かめる）', '足せるのは あと 1 つ（q2 の後）。差し替えは replace'];
  const world = { position: { x: 0.5, y: 64, z: 0.5 }, health: 20, food: 20, localMap: '地図 v1 足=(0,64,0) x=-1..1 z=-1..1 方式=layers 上=北\ny=64\n -1 . . .\n  0 . @ .\n  1 . . .' };
  it('goes in the live of a decision, after the plan\'s now and before the map, and through the rewrite untouched', () => {
    const live = minecraftLlmcLive({ observation: frame(world), elapsedMinutes: 1, trend: createFoodTrend(), events: [], queue: lines, planNow: '[p7] 鉄を掘る' });
    expect(live.queue).toEqual(lines);
    expect(Object.keys(live).indexOf('queue')).toBeGreaterThan(Object.keys(live).indexOf('planNow'));
    expect(Object.keys(live).indexOf('queue')).toBeLessThan(Object.keys(live).indexOf('map'));
    expect((rewriteLlmcLive({ body: live }).live.body as { queue?: unknown }).queue).toEqual(lines);
    expect(carriedFood(world, {}).points).toBe(0);
  });
  it('is in the urgent live too, and absent when there are no lines (a lifecycle without a queue)', () => {
    const urgent = minecraftLlmcUrgentLive({ observation: frame(world), elapsedMinutes: 1, events: [], queue: lines, planNowTitle: '鉄を掘る', answer: 'a' });
    expect(urgent.queue).toEqual(lines);
    expect(minecraftLlmcLive({ observation: frame(world), elapsedMinutes: 1, trend: createFoodTrend(), events: [] })).not.toHaveProperty('queue');
    expect(minecraftLlmcUrgentLive({ observation: frame(world), elapsedMinutes: 1, events: [], planNowTitle: null, answer: 'a' })).not.toHaveProperty('queue');
  });
  it('words: an empty queue says the body stands still; a full one says to replace', () => {
    expect(queueLines([], null, { progress: null, leftMs: 0 })).toEqual(['空（体は止まっている）。mc.act を足すと体が動く']);
    const item = (name: string) => ({ item: name, node: null, why: name, input: { hands: [] } as ActInput, pre: undefined, done: undefined, startedAt: 0, because: null, reason: () => null });
    expect(queueLines([item('q1'), item('q2'), item('q3')], null, { progress: null, leftMs: 3000 }).at(-1)).toBe('列はいっぱい。足すなら replace で消す');
  });
  it('the events of a task still keep their one-time words (forgetLlmcEvents is the test hook)', () => {
    forgetLlmcEvents();
    const events = createLlmcEvents('queue-parts');
    events.keep('q1: 済み');
    expect(events.take()).toEqual([]);
    expect(events.results()).toEqual(['q1: 済み']);
  });
});

describe('the guards read an item after the ones ahead of it', () => {
  /** Rock around the feet (10,10,10) except a corridor along +x two cells long. */
  const rock = () => {
    const rows = ['地図 v1 足=(10,10,10) x=3..17 z=3..17 方式=layers 上=北'];
    for (const dy of [1, 0, -1]) {
      rows.push(`y=${10 + dy}`);
      for (let z = 3; z <= 17; z += 1) rows.push(` ${z} ${Array.from({ length: 15 }, (_, i) => (z === 10 && i + 3 >= 10 && i + 3 <= 12 && dy >= 0 ? (i + 3 === 10 && dy === 0 ? '@' : '.') : '#')).join(' ')}`);
    }
    return frame({ position: { x: 10.5, y: 10, z: 10.5 }, localMap: rows.join('\n'), health: 20 });
  };
  const walk = (x: number): ActInput => ({ hands: [{ do: 'walk', to: { x, y: 10, z: 10 } }] });
  it('a walk into rock is held on its own, and not when the item ahead digs the way (the map is read after its hands)', () => {
    const alone = heldBeforeSendQueued(false, walk(14), rock(), 'q1', []);
    expect(alone?.result?.text).toContain('手 1 walk 一歩ではない');
    const ahead: ActInput = { hands: [{ do: 'dig', at: [{ x: 13, y: 10, z: 10 }, { x: 13, y: 11, z: 10 }, { x: 14, y: 10, z: 10 }, { x: 14, y: 11, z: 10 }] }] };
    const after = heldBeforeSendQueued(false, { hands: [{ do: 'walk', to: { x: 13, y: 10, z: 10 } }] }, rock(), 'q2', [ahead]);
    expect(after?.result).toBeUndefined();
  });
  it('a stop is counted from the item\'s own first hand, and an ahead item that repeats leaves no guard', () => {
    const two: ActInput = { hands: [{ do: 'walk', to: { x: 12, y: 10, z: 10 } }, { do: 'walk', to: { x: 16, y: 10, z: 10 } }] };
    const held = heldBeforeSendQueued(false, two, rock(), 'q3', [walk(11)]);
    expect(held?.tail ?? held?.result?.text ?? '').toContain('手 2');
    const repeating: ActInput = { hands: [{ do: 'wait', seconds: 1 }], repeat: 3 };
    expect(heldBeforeSendQueued(false, walk(14), rock(), 'q4', [repeating])).toBeNull();
  });
});

describe('what the stretch does on a message, and the lifecycle\'s additions', () => {
  const port = (calls: string[]): FcaBodyQueue => ({ openIds: () => new Set(), open: () => true, version: () => 0, noteDecision() {}, take: () => [],
    dropWaiting() { calls.push('drop'); return 1; }, cancelAll() { calls.push('cancel'); },
    async ready({ drain }) { calls.push(drain ? 'drain' : 'ready'); return drain ? 'empty' : 'message'; } });
  it('takes what waits off, lets the running item finish and ends the step', async () => {
    const calls: string[] = [];
    const queue = port(calls);
    const ports = { body: { queue } as unknown as FcaBodyLifecycle };
    const runtime = { pendingMessageIds: () => ['m1'] } as never, step = { scopeKey: 's', taskId: 't', messageIds: [] } as never;
    const waited = await waitForQueue({ ports: ports as never, signal: new AbortController().signal, runtime, step, tools: true, stale: false, round: 1, startedAt: Date.now() });
    expect(waited).toEqual({ continuing: false, wake: 'message' });
    expect(calls).toEqual(['ready', 'drop', 'drain']);
  });
  const stub = (stale: boolean, settledCalls: string[]) => ({ stale: () => stale, cancelAll() { settledCalls.push('cancel'); }, stop() { settledCalls.push('stop'); },
    async settled() { settledCalls.push('settled'); } });
  const inner: FcaBodyLifecycle = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
    async guardFor() { return true; }, toolSignal: (_name, parent) => parent, async close() {} };
  it('a call chosen before the queue lost an item is stale; a stopped step cancels its items; the close waits for them first', async () => {
    const log: string[] = [];
    const base = { observe: () => null, arrival: () => null, peek: () => null, keep: () => undefined };
    const fresh = queueLifecycle({ ...base, queue: stub(false, log) as never }, inner);
    const old = queueLifecycle({ ...base, queue: stub(true, log) as never }, inner);
    expect(await fresh.guardFor!(0, { id: 'a', name: 'mc.act', input: {} })).toBe(true);
    expect(await old.guardFor!(0, { id: 'a', name: 'mc.act', input: {} })).toBe(false);
    const controller = new AbortController();
    fresh.start!(controller.signal);
    controller.abort();
    await fresh.close!();
    expect(log).toEqual(['cancel', 'settled', 'stop']);
  });
  it('a surprise is told once until it clears: health lost 5, a fall of 5, air under 10', () => {
    const world = (health: number, y: number, oxygen = 20) => frame({ position: { x: 0, y, z: 0 }, health, oxygen });
    let now = world(20, 64);
    const kept = surpriseFrame(world(20, 64), null);
    const lifecycle = queueLifecycle({ queue: undefined, observe: () => now, arrival: () => null, peek: () => kept, keep: () => undefined }, inner);
    expect(lifecycle.alert!()).toBe(false);
    now = world(13, 64);
    expect(lifecycle.alert!()).toBe(true);
    expect(lifecycle.alert!()).toBe(false);
    now = world(20, 64);
    expect(lifecycle.alert!()).toBe(false);
    now = world(20, 57);
    expect(lifecycle.alert!()).toBe(true);
    now = world(20, 64, 5);
    expect(lifecycle.alert!()).toBe(true);
  });
});

describe('an item whose pre the frame shows unmet', () => {
  const call = (input: object) => ({ scopeKey: 's', taskId: 't', operationId: 'op', name: 'mc.act', input, signal: new AbortController().signal });
  const queueOf = (open: boolean) => ({ open: () => open, async add() { return { ok: true as const, item: 'q1', after: null, startInMs: 10_000 }; } });
  const pre = [[{ k: 'have' as const, item: 'iron_ore', n: 3 }]];
  const parts = (open: boolean) => ({ queue: queueOf(open) as never, control: { observe: () => null } as never, bodyId: 'b', skill: 'act', fixes: [], node: 'p1',
    frame: frame({ inventory: [{ name: 'iron_ore', count: 1 }], position: { x: 0, y: 64, z: 0 } }) });
  it('is not sent when the queue is empty and the item would start at once; the words say what is lacking', async () => {
    const result = await sendItem({ ...parts(false), call: call({ hands: [{ do: 'wait', seconds: 1 }], pre }) });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('送らなかった: 前提 have:iron_ore>=3 を今は満たさない');
    expect(result.text).toContain('体には何も送っていない');
  });
  it('is sent when something is ahead of it (the body checks it when it starts), and says where it stands', async () => {
    const result = await sendItem({ ...parts(true), call: call({ hands: [{ do: 'wait', seconds: 1 }], pre }) });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('列に入れた q1（列は空だった');
  });
});
