import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedStage, TurnTiming, turnOutcome, turnTimingId } from '../src/infra/observer/turnTiming.js';
import { startEventLoopWatch, timedTick } from '../src/infra/observer/eventLoopWatch.js';
import { foregroundRunner } from '../src/wiring/actionExecutionWiring.js';
import { currentActionExecution } from '../src/infra/context/actionExecution.js';
import { SQLiteObserverStore } from '../src/infra/observer/store/observerStore.js';
import { createFcaSourceGuard, FCA_SOURCE_VERDICT_MS } from '../src/mind/action/fca/fcaConversationSources.js';
import { ShannonToolRunner } from '../src/mind/tools/shannonToolRunner.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { memoryWorld } from './support/memoryWorld.js';
import type { ActionThreads, ActionView } from '../src/contracts/actionThreadContract.js';
import type { ObserverDraft } from '../src/contracts/observerContract.js';
import type { TaskSource, TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

/**
 * 2026-10-12: a voice turn blocked the API's event loop for ~100 s before its model call (the FCA conversation task's
 * provenance re-walked for every tool of every offer), its respond lease expired unrenewed, and nothing in journald said why.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(close => close()); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('turn timing line', () => {
  it('prints stage milliseconds, a short id and a closed outcome, once, and never free text', () => {
    let now = 0; const lines: string[] = [];
    const timing = new TurnTiming('voice', 'a8fa88b3', () => now, line => lines.push(line));
    now = 12; timing.mark('admit');
    timing.measureSync('recall', () => { now += 769; });
    now += 5; timing.add('fca', 94_449); timing.timedOut('tool_menu_timeout');
    now = 2_000; timing.mark('firstToken'); now = 2_100; timing.mark('firstToken');
    now = 104_050; timing.finish('responded'); timing.finish('error');
    expect(lines).toEqual(['Shannon turn timing surface=voice id=a8fa88b3 admit=12ms route=- recall=769ms capability=- fca=94449ms '
      + 'firstToken=2000ms firstSegment=- total=104050ms outcome=responded timeouts=tool_menu_timeout']);
    expect(new TurnTiming('voice', 'x', () => 0, () => {}).line('お返事 with words')).toMatch(/outcome=error$/u);
    expect(turnTimingId('A8FA88B3-1111-2222-3333-444455556666')).toBe('a8fa88b3');
    expect(turnTimingId('not an id')).toMatch(/^[0-9a-f]{8}$/u);
  });

  it('names outcomes by closed codes only', () => {
    expect(turnOutcome({ status: 200, body: { reply: 'はい' } })).toBe('responded');
    expect(turnOutcome({ status: 200, body: { reply: '' } })).toBe('no_response');
    expect(turnOutcome({ status: 409, body: {} })).toBe('http_409');
    expect(turnOutcome(null, new Error('ACTION_STOPPED'))).toBe('action_stopped');
    expect(turnOutcome(null, new Error('the owner said something'))).toBe('error');
    expect(turnOutcome(null, Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('aborted');
  });
});

describe('bounded pre-dispatch stages', () => {
  it('goes on with the fallback at the bound, logs the code, and drops a late rejection', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const timing = new TurnTiming('voice', 'id', () => 0, () => {});
    let reject!: (error: Error) => void;
    const hanging = new Promise<string>((_, no) => { reject = no; });
    const result = boundedStage(hanging, { milliseconds: 2_000, code: 'tool_menu_timeout', timing, fallback: () => 'all tools' });
    await vi.advanceTimersByTimeAsync(1_999);
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('all tools');
    expect(warn).toHaveBeenCalledWith('Shannon turn stage timed out code=tool_menu_timeout surface=voice ms=2000');
    expect(timing.line('responded')).toContain('timeouts=tool_menu_timeout');
    reject(new Error('late')); await vi.advanceTimersByTimeAsync(0); // No unhandled rejection.
  });

  it('returns an input that arrives in time unchanged, without a log line', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = boundedStage(new Promise<number>(resolve => setTimeout(() => resolve(7), 100)), { milliseconds: 2_000, code: 'recall_timeout', fallback: () => 0 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe(7);
    await expect(boundedStage(5, { milliseconds: 10, code: 'x', fallback: () => 0 })).resolves.toBe(5);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('foreground runner', () => {
  const view = (id: string): ActionView => ({ id, scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: `turn-${id}`, parentId: null,
    state: 'running', generation: 1, holder: 'runner-a', leaseUntil: '2026-10-12T03:50:29.316Z', resources: [], ownerInformed: false, deadline: null,
    progress: null, result: null, sent: false, failures: 0, lastFailure: null, createdAt: '', updatedAt: '' }) as unknown as ActionView;
  function threads(renew: () => Promise<ActionView | null>) {
    let next = 0; const finished: string[] = [];
    const actions = { admitRespond: async () => view(`a${next += 1}`), renew, dispatch: async () => true,
      finish: async (_lease: unknown, state: string, code: string) => { finished.push(`${state}:${code}`); return null; } } as unknown as ActionThreads;
    return { actions, finished };
  }

  it('gives up waiting behind an earlier turn at the bound, logged, and never runs beside it', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { actions } = threads(async () => view('a1'));
    const run = foregroundRunner(actions, { queueWaitMs: 45_000 });
    let release!: () => void; const first = run('owner', () => new Promise<string>(resolve => { release = () => resolve('first'); }));
    let secondRan = false;
    const second = run('owner', async () => { secondRan = true; return 'second'; });
    const refused = expect(second).rejects.toThrow('ACTION_FOREGROUND_BUSY');
    await vi.advanceTimersByTimeAsync(45_000);
    await refused;
    expect(secondRan).toBe(false);
    expect(warn).toHaveBeenCalledWith('Shannon foreground turn refused code=ACTION_FOREGROUND_BUSY reason=queue_timeout waitedMs=45000');
    release(); await expect(first).resolves.toBe('first');
  });

  it('names a lost respond lease once, with how long it was held', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { actions, finished } = threads(async () => null); // The scheduler says the lease is no longer this turn's.
    const run = foregroundRunner(actions);
    const turn = run('owner', async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(currentActionExecution()?.signal.aborted).toBe(true);
      throw new Error('ACTION_STOPPED');
    });
    await expect(turn).rejects.toThrow('ACTION_STOPPED');
    expect(warn.mock.calls.filter(([line]) => String(line).startsWith('Shannon foreground lease lost code=ACTION_LEASE_LOST heldMs='))).toHaveLength(1);
    expect(finished).toEqual(['unknown:response_interrupted']);
  });
});

describe('event loop watch', () => {
  it('logs a blocked loop with its length, and nothing for an on-time tick', async () => {
    vi.useFakeTimers();
    let now = 0; const lines: string[] = [];
    const stop = startEventLoopWatch('api', { now: () => now, log: line => lines.push(line) }); cleanups.push(stop);
    now = 1_000; await vi.advanceTimersByTimeAsync(1_000);
    now = 2_000 + 94_000; await vi.advanceTimersByTimeAsync(1_000); // The interval fired 94 s late.
    expect(lines).toEqual(['Shannon event loop blocked process=api ms=94000']);
  });

  it('names the periodic job that held the thread, and nothing for a quick one', () => {
    let now = 0; const lines: string[] = [];
    const options = { now: () => now, log: (line: string) => lines.push(line) };
    expect(timedTick('report_cards', () => { now += 10; return 1; }, options)).toBe(1);
    timedTick('report_cards', () => { now += 2_600; }, options);
    expect(lines).toEqual(['Shannon slow tick name=report_cards ms=2600']);
  });
});

describe('observer retention by origin', () => {
  const draft = (index: number, origin: 'client' | 'server'): ObserverDraft => ({ scopeKey: 'owner', runId: `run-${index}`, spanId: `span-${index}`,
    parentSpanId: null, node: origin === 'client' ? 'pcm' : 'turn', kind: 'span.completed', at: '2026-10-12T03:49:59.313Z', origin, output: { index } }) as ObserverDraft;
  it('keeps a turn\'s server spans while a call floods client pcm spans, and bounds both', () => {
    const store = new SQLiteObserverStore(':memory:', () => 1_000, 5, 900_000, 3); cleanups.push(() => store.close());
    for (let i = 0; i < 4; i++) store.publish(draft(i, 'server'));
    store.flush();
    for (let i = 10; i < 70; i++) { store.publish(draft(i, 'client')); if (i % 8 === 0) store.flush(); }
    store.flush();
    const events = store.read('owner', 0, 200).events;
    expect(events.filter(event => event.origin !== 'client').map(event => event.runId)).toEqual(['run-0', 'run-1', 'run-2', 'run-3']);
    expect(events.filter(event => event.origin === 'client').map(event => event.runId)).toEqual(['run-67', 'run-68', 'run-69']);
    for (let i = 100; i < 110; i++) store.publish(draft(i, 'server'));
    store.flush();
    expect(store.read('owner', 0, 200).events.filter(event => event.origin !== 'client')).toHaveLength(5);
  });
});

describe('observer sidecar written before the lane column', () => {
  it('adds the column in place, counts old rows as the server\'s, and keeps reading them', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const directory = mkdtempSync(join(tmpdir(), 'shannon-observer-lane-')), path = join(directory, 'events.sqlite');
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE observer_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL, recorded_ms INTEGER NOT NULL, payload TEXT NOT NULL)');
    old.prepare('INSERT INTO observer_events(scope_key,recorded_ms,payload) VALUES(?,?,?)').run('owner', 1_000, JSON.stringify({ runId: 'old', node: 'turn' }));
    old.close();
    const store = new SQLiteObserverStore(path, () => 1_000, 5, 900_000, 1); cleanups.push(() => store.close());
    const again = new SQLiteObserverStore(path, () => 1_000, 5, 900_000, 1); cleanups.push(() => again.close()); // Second process.
    store.publish({ scopeKey: 'owner', runId: 'pcm', spanId: 's', parentSpanId: null, node: 'pcm', kind: 'span.completed', at: '', origin: 'client' } as ObserverDraft);
    store.flush();
    expect(store.read('owner', 0, 200).events.map(event => event.runId)).toEqual(['old', 'pcm']);
  });
});

describe('FCA provenance verdicts', () => {
  const emotion = { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const };
  function world() {
    const value = memoryWorld(); cleanups.push(value.close);
    const ids: string[] = [];
    for (let index = 0; index < 30; index++) {
      value.advance(60_000);
      ids.push(value.store.appendTurn('owner', 'thread', `質問${index}${String.fromCharCode(0x4e00 + index)}`, `返答${index}${String.fromCharCode(0x5000 + index)}`, value.now(),
        { capturedStateVersion: 0, messageEmotion: emotion, recalledMemoryIds: ids.slice(-5) }).id);
    }
    const task = { id: 'conversation', scopeKey: 'owner', title: 'voice', goal: 'talk', completionCriteria: '', summary: '' } as unknown as TaskView;
    const sources: TaskSource[] = [{ kind: 'memory', stepId: 'memory:one', experienceId: null, threadId: null, observedAt: value.now(), recalledMemoryIds: ids.slice(5, 25) } as TaskSource];
    let clock = 0; let alone = true;
    const reads = vi.spyOn(value.store, 'experiencesById');
    const guard = createFcaSourceGuard({ runtime: { get: () => task, taskSources: () => sources } as never, state: value.store, conversations: value.store,
      ownerScope: 'owner', ownerAlone: () => alone, clock: () => clock });
    return { value, ids, task, sources, guard, reads, tick: (ms: number) => { clock += ms; }, setAlone: (next: boolean) => { alone = next; } };
  }

  it('walks the provenance once for repeated questions in one turn, and again after the window', () => {
    const w = world();
    expect(w.guard.sources('owner', w.task, w.sources)).toBe(true);
    const walked = w.reads.mock.calls.length; expect(walked).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) expect(w.guard.sources('owner', w.task, w.sources)).toBe(true); // Every tool of every offer.
    expect(w.reads.mock.calls.length).toBe(walked);
    w.tick(FCA_SOURCE_VERDICT_MS);
    expect(w.guard.sources('owner', w.task, w.sources)).toBe(true);
    expect(w.reads.mock.calls.length).toBeGreaterThan(walked);
  });

  it('still asks who can hear every time, and judges afresh after a forget', () => {
    const w = world();
    expect(w.guard.sources('owner', w.task, w.sources)).toBe(true);
    w.setAlone(false); expect(w.guard.sources('owner', w.task, w.sources)).toBe(false); w.setAlone(true);
    w.value.advance(1_000);
    new ShannonMemoryService(w.value.store, w.value.store, w.value.now).mutate('owner', { memoryId: w.ids[10]!, action: 'forget' });
    expect(w.guard.sources('owner', w.task, w.sources)).toBe(false); // Same instant, new state version: not the old verdict.
  });
});

describe('tool offer', () => {
  it('asks each task and memory port once per offer, not once per tool', () => {
    const runner = Object.create(ShannonToolRunner.prototype) as ShannonToolRunner;
    const taskRuntime = { available: vi.fn(() => true), execute: vi.fn() };
    const taskMemory = { available: vi.fn(() => true), execute: vi.fn() };
    Object.assign(runner, { taskRuntime, taskMemory, folder: { boundHosts: () => [] }, aether: {}, reads: null, skills: null, selfRewrite: null,
      minecraftTasks: null, minecraftLifecycle: null, minecraft: null });
    const offered = runner.offered('voice', 'owner_alone', 'owner');
    expect(offered.filter(tool => tool.domain === 'task_runtime').length).toBeGreaterThan(1);
    expect(offered.filter(tool => tool.domain === 'memory_read').length).toBeGreaterThan(1);
    expect(taskRuntime.available).toHaveBeenCalledTimes(1);
    expect(taskMemory.available).toHaveBeenCalledTimes(1);
  });
});

describe('voice turn with a recall that never answers', () => {
  it('answers after the recall bound from the deterministic context, and writes one timing line with the timeout', async () => {
    const { createLocalApiKernel } = await import('../src/wiring/apiKernelWiring.js');
    const { SQLiteShannonStore } = await import('../src/infra/sqlite/sqliteStore.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { TURN_STAGE_BOUNDS } = await import('../src/infra/observer/turnTiming.js');
    const directory = mkdtempSync(join(tmpdir(), 'shannon-voice-stall-'));
    const store = new SQLiteShannonStore({ path: join(directory, 'shannon.sqlite'), now: () => '2026-10-12T03:49:59.000Z' });
    cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests: unknown[] = [];
    const api = createLocalApiKernel(() => '2026-10-12T03:49:59.000Z', {
      chatModel: { mode: 'openai', model: 'test-model', generate: async (request: unknown) => { requests.push(request); return { mode: 'openai', model: 'test-model', reply: '返答' }; } },
      stateStore: store, conversationStore: store,
      voiceDecision: { mode: 'jev', model: 'test-jev', decide: async () => ({
        source: 'jev', shouldRespond: true, replyRequiredProbability: 0.95, solutionWantedProbability: 0.6, conversationClass: 'skill_simple',
        latencyClass: 'under_3s', affect: 'neutral', affectIntensity: 0.2, delivery: 'conversational', selectedSkills: ['conversation_memory'],
        skillScores: { current_web: 0, place_discovery: 0, conversation_memory: 0.95, daily_mind: 0, aether_notes: 0, voyager_tasks: 0, agent_status: 0, device_context: 0 },
        elapsedMilliseconds: 40 }) },
      memoryRecall: { willSearch: () => true, enrich: () => new Promise(() => {}) } as never,
    } as never);
    const turn = api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: { scopeKey: 'owner', transcript: '前に話した旅行の件、覚えてる？' } });
    let done = false; void turn.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(TURN_STAGE_BOUNDS.recall_timeout - 1);
    expect(done).toBe(false); expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(turn).resolves.toMatchObject({ status: 200, body: { reply: '返答' } });
    expect(requests).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('Shannon turn stage timed out code=recall_timeout surface=voice ms=6000');
    const lines = info.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('Shannon turn timing surface=voice'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Shannon turn timing surface=voice id=[0-9a-f]{8} admit=\d+ms route=\d+ms recall=\d+ms .* outcome=responded timeouts=recall_timeout chars=\d+$/u);
    expect(lines[0]).not.toContain('旅行');
  });
});
