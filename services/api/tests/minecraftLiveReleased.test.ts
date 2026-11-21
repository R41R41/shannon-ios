import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionStateSnapshot } from '@shannon/cognition';
import type { LiveMoment } from '@shannon/mind';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { MinecraftLive, type LiveTaskInfo } from '../src/surfaces/minecraft/minecraftLive.js';
import { LiveCommentary } from '../src/surfaces/minecraft/minecraftLiveCommentary.js';
import { LiveSpeechOutbox } from '../src/surfaces/minecraft/minecraftLiveSpeech.js';
import { configuredMinecraftLive } from '../src/wiring/minecraftLiveWiring.js';
import { acquireAction } from '../src/wiring/actionExecutionWiring.js';
import { fcaBudget } from '../src/wiring/fcaBudgetWiring.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { anthropicFixture, scriptedAnthropic, type AnthropicMessage } from './support/anthropicFixtures.js';

const T0 = Date.parse('2026-11-22T10:00:00.000Z');

describe('her work is stopped, cancelled or held: what she was about to say of it is not said', () => {
  let clock = T0;
  beforeEach(() => { vi.useFakeTimers(); clock = T0; });
  afterEach(() => vi.useRealTimers());
  const moment = (kind: LiveMoment['kind'], facts: LiveMoment['facts'] = {}, key = `${kind}:${clock}`): LiveMoment => ({ kind, key, at: clock, facts });

  function setup(write?: () => Promise<string | null>) {
    const listeners = new Set<(item: LiveMoment) => void>(), releases = new Set<() => void>();
    const room = { replying: false, sinceHumanMilliseconds: null as number | null };
    const outbox = new LiveSpeechOutbox(() => clock);
    const refresh = () => outbox.receive([], { voice: true, humanSpeaking: false, sinceHumanMs: null });
    refresh();
    setInterval(refresh, 1000);
    const requests: Array<{ main: LiveMoment }> = [];
    const engine = new LiveCommentary({
      live: { onMoment: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        onRelease: listener => { releases.add(listener); return () => releases.delete(listener); }, inDanger: () => false,
        conversation: () => ({ replying: room.replying, sinceHumanMilliseconds: room.sinceHumanMilliseconds }) },
      outbox, write: async request => { requests.push(request); return write ? write() : `言葉:${request.main.kind}`; }, now: () => clock,
      doneFallback: 'できたよ！どこに置けばいい？',
    });
    engine.start();
    return { engine, outbox, room, requests, emit: (item: LiveMoment) => listeners.forEach(listener => listener(item)),
      release: () => releases.forEach(listener => listener()), settle: async () => { await vi.advanceTimersByTimeAsync(10); } };
  }

  it('drops what waits of her work (a thought, a step, a material, a plan change) when it is released', async () => {
    const f = setup();
    f.room.sinceHumanMilliseconds = 100;
    f.emit(moment('thinking', { why: '次は鉄を掘ろう' }, 'w'));
    f.emit(moment('plan_step', { done: '木' }, 's'));
    f.emit(moment('material_needed', { item: 'iron_ingot', count: 3, use: 'バケツ' }, 'm'));
    f.emit(moment('plan_changed', { added: '畑' }, 'p'));
    f.release();
    f.room.sinceHumanMilliseconds = 30_000;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.requests).toEqual([]);
    expect(f.outbox.pending()).toBe(0);
    expect(f.engine.stats().waiting).toBe(0);
    expect(f.engine.stats().released).toBe(1);
  });

  it('does not say a line that was being written when it was released', async () => {
    let finish: (text: string) => void = () => {};
    const f = setup(() => new Promise<string>(resolve => { finish = resolve; }));
    f.emit(moment('thinking', { why: '牛乳はバケツがいる' }, 'w'));
    await f.settle();
    expect(f.requests).toHaveLength(1);
    f.release();
    finish('牛乳ってバケツがいるんだ');
    await f.settle();
    expect(f.outbox.pending()).toBe(0);
    expect(f.engine.stats().write_released).toBe(1);
    expect(f.engine.stats().queued).toBeUndefined();
  });

  it('takes back a line the body has not been handed yet, and leaves one it was handed', async () => {
    const f = setup();
    f.emit(moment('plan_step', { done: '木' }, 's'));
    await f.settle();
    expect(f.outbox.pending()).toBe(1);
    f.release();
    expect(f.outbox.pending()).toBe(0);
    expect(f.outbox.take()).toEqual([]);
    const g = setup();
    g.emit(moment('plan_step', { done: '木' }, 's'));
    await g.settle();
    expect(g.outbox.take()).toHaveLength(1);
    g.release();
    expect(g.outbox.pending()).toBe(1);
  });

  it('still says the end of a request, and what a world event shows, after a release', async () => {
    const f = setup();
    f.emit(moment('thinking', { why: '卵を探す' }, 'w'));
    f.release();
    f.emit(moment('task_done', { goal: 'ケーキを作る' }, 'd'));
    await f.settle();
    expect(f.requests.map(request => request.main.key)).toEqual(['d']);
    expect(f.outbox.take()[0]).toMatchObject({ kind: 'task_done' });
  });

  it('says the end of a request that was being written when the release came', async () => {
    let finish: (text: string) => void = () => {};
    const f = setup(() => new Promise<string>(resolve => { finish = resolve; }));
    f.emit(moment('task_done', { goal: 'ケーキを作る' }, 'd'));
    await f.settle();
    f.release();
    finish('できたよ！');
    await f.settle();
    expect(f.outbox.take()[0]).toMatchObject({ kind: 'task_done', text: 'できたよ！' });
  });

  it('says what the next request gives, as usual, after a release', async () => {
    const f = setup();
    f.emit(moment('thinking', { why: '古い話' }, 'old'));
    f.release();
    await vi.advanceTimersByTimeAsync(2_000);
    clock += 20_000;
    await vi.advanceTimersByTimeAsync(1_000);
    f.emit(moment('thinking', { why: '新しい依頼のために' }, 'new'));
    await f.settle();
    expect(f.requests.map(request => request.main.key)).toEqual(['new']);
    expect(f.outbox.pending()).toBe(1);
  });

  it('does nothing when there is nothing to drop', async () => {
    const f = setup();
    f.release();
    await f.settle();
    expect(f.engine.stats().released).toBeUndefined();
  });
});

describe('the live view of a task that is stopping', () => {
  const task = (phase: () => string | null): LiveTaskInfo => ({ taskId: 'task', scopeKey: 'owner', goal: 'ケーキを作る', origin: 'owner_request', createdAtMs: T0,
    bodyId: 'minecraft:world', netherReached: null, phase });
  const fixture = (phase: () => string | null) => {
    const live = new MinecraftLive({ frames: { latest: () => null, available: () => [] }, now: () => T0 });
    const moments: LiveMoment[] = [];
    live.onMoment(moment => moments.push(moment));
    live.begin(task(phase));
    return { live, moments };
  };

  it('says nothing of the plan, a need or a thought the last step of a stopping or stopped task still shows', () => {
    for (const phase of ['stopping', 'stopped']) {
      const f = fixture(() => phase);
      f.live.thought('task', '次は鉄を掘ろう');
      f.live.need('task', { item: 'iron_ingot', count: 3, use: 'バケツ' });
      f.live.plan('task', { revision: 1, current: 'a', nodes: [{ id: 'a', parentId: null, title: '木を集める', state: 'continue' }] });
      expect(f.moments).toEqual([]);
    }
  });

  it('says them while the task works, and again once it was put back to work', () => {
    let phase = 'stopped';
    const f = fixture(() => phase);
    f.live.thought('task', '休んでいる間の考え');
    expect(f.moments).toEqual([]);
    phase = 'executing';
    f.live.thought('task', '再開した考え');
    expect(f.moments.map(moment => moment.kind)).toEqual(['thinking']);
  });

  it('tells the commentary of a release, and a listener that throws changes nothing', () => {
    const f = fixture(() => 'executing');
    const heard: string[] = [];
    f.live.onRelease(() => { throw new Error('no'); });
    f.live.onRelease(() => heard.push('released'));
    expect(() => f.live.released()).not.toThrow();
    expect(heard).toEqual(['released']);
  });
});

describe('the runtime tells of the tasks it stopped', () => {
  it('names the stopped tasks to the listener from every stop, and a listener that throws changes no stop', async () => {
    const h = actionHarness(() => new Date().toISOString());
    try {
      const seen: string[][] = [];
      const wiring = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model: {} as never, scopeKey: 'owner', ownerAlone: () => true,
        stopped: tasks => { seen.push(tasks.map(task => task.id)); throw new Error('listener'); } });
      const root = wiring.runtime.ensureRoot('owner');
      const child = wiring.runtime.createChild('owner', root.id, { kind: 'generic', title: 'ケーキ', goal: 'ケーキを作る', origin: 'owner_request' } as never, 'k1', { sources: 'asking' });
      const stopped = await wiring.stop(root.id, 'owner_stop_all');
      expect(stopped.map(task => task.id)).toContain(child.id);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain(child.id);
    } finally { h.close(); }
  });
});

describe('where the cost of her live word is booked', () => {
  const haikuReply = (): AnthropicMessage => {
    const value = anthropicFixture('structured-answer');
    return { ...value, model: 'claude-haiku-5-5', usage: { ...value.usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 900,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } };
  };

  it('is booked in the usage ledger of the owner whatever the context of the moment, and never in the cap of the task whose moment it was', async () => {
    const h = actionHarness(() => new Date().toISOString());
    const ledger: LlmUsageEvent[] = [];
    const transport = scriptedAnthropic(() => haikuReply());
    const model = new AnthropicChatModel({ apiKey: 'test-only', settings: { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' },
      fetch: transport.fetcher, usageStore: { recordLlmUsage: event => { ledger.push(event); }, backgroundLlmCostUsd: () => 0 } });
    const taskLedger: Array<{ yen: number }> = [];
    const store = { spent: () => ({ steps: 0, yen: 0, openEstimatedYen: 0 }), add: (_id: string, _scope: string, _origin: string, yen: number) => { taskLedger.push({ yen }); },
      addEstimate: () => {}, capped: () => {}, acknowledgeEstimates: () => {} };
    const budget = fcaBudget({ actions: h.actions, store: store as never, now: () => new Date().toISOString() });
    const task = { id: 'task', scopeKey: 'owner', origin: 'owner_request', kind: 'generic', title: 'ケーキ' } as unknown as TaskView;
    const wiring = configuredMinecraftLive({ SHANNON_MINECRAFT_LIVE: 'on', SHANNON_MINECRAFT_LIVE_SPEECH: 'on' })!;
    try {
      wiring.startCommentary({ scopeKey: 'owner', model, store: { snapshot: () => ({}) as CompanionStateSnapshot, appendNoteOnce: () => ({}) as never }, log: () => {} });
      wiring.outbox.receive([], { voice: true, humanSpeaking: false, sinceHumanMs: null });
      wiring.live.begin({ taskId: 'task', scopeKey: 'owner', goal: 'ケーキを作る', origin: 'owner_request', createdAtMs: Date.now(), bodyId: 'minecraft:world', netherReached: null });
      const active = (await acquireAction(h.actions, { scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'task-cost' }))!;
      expect(await budget.before(task, active.execution.lease)).toEqual({ ok: true });
      // The moment is heard from inside the step that made it, as the body wrapper does.
      await inActionExecution(active.execution, async () => { wiring.live.thought('task', '牛乳はバケツがいるから鉄が必要かな'); });
      for (let waited = 0; waited < 40 && ledger.length === 0; waited += 1) await new Promise(resolve => setTimeout(resolve, 50));
      await budget.after(task, active.execution.lease);
      await active.finish('completed', 'done');
      active.stop();
      expect(transport.bodies).toHaveLength(1);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ scopeKey: 'owner', lane: 'chat', model: 'claude-haiku-5-5' });
      expect(ledger[0]!.estimatedCostUsd).toBeGreaterThan(0);
      expect(taskLedger).toEqual([]);
    } finally { wiring.stop(); h.close(); }
  });
});
