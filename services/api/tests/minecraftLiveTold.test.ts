import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveMoment } from '@shannon/mind';
import { LiveCommentary, type LiveWriteRequest } from '../src/surfaces/minecraft/minecraftLiveCommentary.js';
import { LiveSpeechOutbox } from '../src/surfaces/minecraft/minecraftLiveSpeech.js';
import { LiveToldFacts } from '../src/surfaces/minecraft/minecraftLiveTold.js';
import { MinecraftLive, type LiveTaskInfo } from '../src/surfaces/minecraft/minecraftLive.js';
import { liveWriterPrompt } from '../src/surfaces/minecraft/minecraftLiveWriter.js';

const T0 = Date.parse('2026-11-22T10:00:00.000Z');
const moment = (kind: LiveMoment['kind'], facts: LiveMoment['facts'] = {}, key: string = kind, at = T0): LiveMoment => ({ kind, key, at, facts });

describe('what she told is kept as events, not as her own words', () => {
  it('keeps the newest few, once each, and forgets them when the story is closed', () => {
    const told = new LiveToldFacts(3);
    for (const line of ['a', 'b', 'c', 'b', 'd']) told.add(line);
    expect(told.list()).toEqual(['c', 'b', 'd']);
    told.close();
    expect(told.list()).toEqual([]);
  });

  it('shows the writer the events in place of her last words, and her words only when no events are kept', () => {
    const base = { identity: 'I', persona: '', body: '', main: moment('thinking', { why: '草を壊す' }), also: [], recent: ['あ、小麦の種だ！'], voice: true };
    const withTold = liveWriterPrompt({ ...base, told: ['小麦の種が手に入った（いま1個、要るのは3個）。'] }).system;
    expect(withTold).toContain('[さっき話した出来事]');
    expect(withTold).toContain('- 小麦の種が手に入った（いま1個、要るのは3個）。');
    expect(withTold).not.toContain('あ、小麦の種だ！');
    expect(liveWriterPrompt({ ...base, told: [] }).system).not.toContain('[さっき');
    expect(liveWriterPrompt(base).system).toContain('- あ、小麦の種だ！');
  });

  it('does not name a first syllable to avoid, and asks for the content to come first with its reason', () => {
    const { system } = liveWriterPrompt({ identity: 'I', persona: '', body: '', main: moment('thinking'), also: [], recent: [], told: [], voice: true });
    expect(system).toContain('出だしは、その一言でいちばん言いたい中身');
    expect(system).not.toMatch(/「あ[、」]|よーし/u);
  });
});

describe('LiveCommentary keeps the events it told, and closes them with the request', () => {
  let clock = T0;
  beforeEach(() => { vi.useFakeTimers(); clock = T0; });
  afterEach(() => vi.useRealTimers());

  function setup(write?: (request: LiveWriteRequest) => Promise<string | null>) {
    const listeners = new Set<(item: LiveMoment) => void>();
    const outbox = new LiveSpeechOutbox(() => clock);
    const refresh = () => outbox.receive([], { voice: true, humanSpeaking: false, sinceHumanMs: null });
    refresh();
    setInterval(refresh, 1000);
    const requests: LiveWriteRequest[] = [];
    let serial = 0;
    const engine = new LiveCommentary({
      live: { onMoment: listener => { listeners.add(listener); return () => listeners.delete(listener); }, inDanger: () => false,
        conversation: () => ({ replying: false, sinceHumanMilliseconds: null }) },
      outbox, write: async request => { requests.push(request); return write ? write(request) : `言葉${++serial}:${request.main.kind}`; }, now: () => clock,
    });
    engine.start();
    const settle = async () => { await vi.advanceTimersByTimeAsync(10); };
    const say = async () => {
      const [line] = outbox.take();
      if (line) outbox.receive([{ id: line.id, outcome: 'spoken' }], null);
      await settle();
    };
    const next = async () => { clock += 20_000; await vi.advanceTimersByTimeAsync(2_000); };
    return { engine, outbox, requests, settle, say, next, emit: (item: LiveMoment) => listeners.forEach(listener => listener(item)) };
  }

  it('hands the writer the events already spoken of, oldest last, and none of its own words', async () => {
    const f = setup();
    f.emit(moment('material_got', { item: 'wheat_seeds', count: 1, need: 3 }, 'g1'));
    await f.settle();
    expect(f.requests[0]?.told).toEqual([]);
    await f.say();
    await f.next();
    f.emit(moment('structure_found', { name: '難破船', distance: 180 }, 's1', clock));
    await f.settle();
    expect(f.requests[1]?.told).toEqual(['小麦の種が手に入った（いま1個、要るのは3個）。']);
  });

  it('closes the story at the end of the request: what is told after it starts clean', async () => {
    const f = setup();
    f.emit(moment('material_got', { item: 'wheat_seeds', count: 3, need: 3 }, 'g1'));
    await f.settle();
    await f.say();
    await f.next();
    f.emit(moment('task_done', { goal: 'ケーキ' }, 'd1', clock));
    await f.settle();
    expect(f.requests[1]?.told).toEqual(['小麦の種が手に入った（いま3個、要るのは3個）。']);
    await f.say();
    await f.next();
    f.emit(moment('plan_changed', { added: 'ケーキを置く' }, 'p1', clock));
    await f.settle();
    expect(f.requests[2]?.told).toEqual([]);
  });

  it('does not say a line of her work that was being written when the request ended', async () => {
    let finish: (value: string | null) => void = () => undefined;
    const f = setup(request => (request.main.kind === 'thinking' ? new Promise<string | null>(resolve => { finish = resolve; }) : Promise.resolve('できたよ！どこに置く？')));
    f.emit(moment('thinking', { why: '草を壊して種を集める' }, 't1'));
    await f.settle();
    f.emit(moment('task_done', { goal: 'ケーキ' }, 'd1'));
    finish('小麦の種、集めなきゃ');
    await f.settle();
    expect(f.engine.stats().write_released).toBe(1);
    await f.next();
    await f.settle();
    expect(f.outbox.take().map(line => line.kind)).toEqual(['task_done']);
  });
});

describe('what a finished request wanted is not news for the next one', () => {
  it('stops holding the items of a request that was told as done', () => {
    let clock = T0;
    const live = new MinecraftLive({ frames: { latest: () => null, available: () => [] }, now: () => clock });
    let phase = 'running';
    const info: LiveTaskInfo = { taskId: 't1', scopeKey: 's', goal: 'ケーキを作る', origin: 'owner_request', createdAtMs: clock, bodyId: null, netherReached: null, phase: () => phase };
    live.begin(info);
    live.need('t1', { item: 'wheat_seeds', count: 3, use: 'ケーキ' });
    const wanted = () => (live as unknown as { wanted(): ReadonlyMap<string, number> }).wanted();
    expect(wanted().get('wheat_seeds')).toBe(3);
    live.end('t1');
    phase = 'completed';
    clock += 1_000;
    // The body's frame is what tells the end; here it is told the way `finished` reads it.
    (live as unknown as { finished(now: number): LiveMoment[] }).finished(clock);
    expect(wanted().has('wheat_seeds')).toBe(false);
  });
});
