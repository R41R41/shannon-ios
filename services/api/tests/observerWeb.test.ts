import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObserverBatch, ObserverEvent } from '../src/contracts/observerContract.js';
import {
  MAX_EVENTS, blockAlerts, createNodeHistory, createObserverClient, runToolCalls, runUsage, turnFlow, createObserverState, createObserverSession, createReceiptGate, linkedRunView, nodeState, observerBasePath,
  reduceObserverEnvelope, runToolEvidence, spanState, validEnvelope,
  type ObserverRequest,
} from '../src/infra/observer/web/observer.js';

const at = '2026-10-08T00:00:00.000Z';
function event(sequence: number, values: Partial<ObserverEvent> = {}): ObserverEvent {
  return { sequence, runId: 'run-a', spanId: 'span-a', parentSpanId: null, node: 'llm', kind: 'span.started', at, ...values };
}
function batch(events: ObserverEvent[] = [], values: Partial<ObserverBatch> = {}): ObserverBatch {
  return { schemaVersion: 1, instanceId: 'instance-a', events, cursor: Math.max(0, ...events.map(item => item.sequence)),
    oldestCursor: 1, gap: false, availability: 'ready', generatedAt: at, ...values };
}
const catalog = { schemaVersion: 1, tools: [], nodes: [], coverage: [] };
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
async function flush(): Promise<void> { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
afterEach(() => vi.useRealTimers());

describe('observer event reduction', () => {
  it('sorts incremental out-of-order arrivals, deduplicates delivery and preserves the selected run', () => {
    let state = reduceObserverEnvelope(createObserverState(), batch([
      event(1, { kind: 'run.started', spanId: 'run' }),
      event(3, { kind: 'span.completed', output: { reply: '実出力' }, elapsedMs: 80 }),
    ]));
    state = reduceObserverEnvelope(state, batch([
      event(3, { kind: 'span.completed', output: { reply: '重複による置換' } }),
      event(2, { input: { words: '実入力' }, model: 'measured-model' }),
      event(4, { runId: 'run-b', kind: 'run.started', spanId: 'run' }),
    ]));
    expect(state.events.map(item => item.sequence)).toEqual([1, 2, 3, 4]);
    expect(state.cursor).toBe(4);
    expect(state.selectedRunId).toBe('run-a');
    const span = state.runs.get('run-a')!.spans.get('span-a')!;
    expect(span.input).toEqual({ words: '実入力' });
    expect(span.output).toEqual({ reply: '実出力' });
    expect(span.model).toBe('measured-model');
    expect(spanState(span, state.runs.get('run-a'))).toBe('completed');
    expect(reduceObserverEnvelope(state, batch([], { cursor: 4 }), true).selectedRunId).toBe('run-b');
  });

  it('never mixes same-named spans across runs and preserves overlapping processing in one node', () => {
    const state = reduceObserverEnvelope(createObserverState(), batch([
      event(1, { kind: 'run.started' }), event(2), event(3, { spanId: 'span-b', input: { branch: 'parallel' } }),
      event(4, { runId: 'run-b', input: { branch: 'different-run' } }),
    ]));
    const active = nodeState(state.runs.get('run-a'), 'llm');
    expect(active.activeCount).toBe(2); expect(active.state).toBe('running');
    expect(state.runs.get('run-a')!.spans.get('span-a')!.input).toBeUndefined();
    expect(state.runs.get('run-b')!.spans.get('span-a')!.input).toEqual({ branch: 'different-run' });
  });

  it('shows the actual root run as a TURN span and closes a failed root without inventing success', () => {
    let state = reduceObserverEnvelope(createObserverState(), batch([event(1, { node: 'turn', kind: 'run.started', spanId: 'root', input: { surface: 'voice' } })]));
    expect(nodeState(state.runs.get('run-a'), 'turn').state).toBe('running');
    state = reduceObserverEnvelope(state, batch([event(2, { node: 'turn', kind: 'span.failed', spanId: 'root', output: { status: 'failed' } })]));
    expect(state.runs.get('run-a')!.state).toBe('failed'); expect(state.runs.get('run-a')!.endedAt).toBe(at);
    expect(nodeState(state.runs.get('run-a'), 'turn').state).toBe('failed');
  });

  it('preserves source provenance and refuses client closure of server spans or runs', () => {
    const state = reduceObserverEnvelope(createObserverState(), batch([
      event(1, { spanId: 'root', node: 'turn', kind: 'run.started', origin: 'server' }),
      event(2, { origin: 'server' }),
      event(3, { node: 'pcm', origin: 'client', kind: 'span.completed', output: { spoofed: true } }),
      event(4, { node: 'pcm', origin: 'client', spanId: 'client-root', kind: 'run.completed' }),
      event(5, { node: 'stt', origin: 'client', spanId: 'stt-span', kind: 'span.completed', output: { model: 'actual-transcription-model', characterCount: 4 } }),
    ]));
    const run = state.runs.get('run-a')!;
    expect(run.state).toBe('running'); expect(run.endedAt).toBeNull();
    expect(nodeState(run, 'llm').state).toBe('running'); expect(run.spans.get('span-a')!.output).toBeUndefined();
    expect(run.spans.get('span-a')!.origin).toBe('server');
    expect(run.spans.get('stt-span')!.origin).toBe('client'); expect(run.spans.get('stt-span')!.model).toBe('actual-transcription-model');
  });

  it('does not infer successful output or a wait state from a start or handoff', () => {
    const state = reduceObserverEnvelope(createObserverState(), batch([
      event(1, { input: { request: true }, output: { premature: true } }),
      event(2, { kind: 'handoff', fromNode: 'llm', toNode: 'tools', sourceSpanId: 'span-a', output: { handoff: true } }),
    ]));
    const value = nodeState(state.runs.get('run-a'), 'llm');
    expect(value.state).toBe('running'); expect(value.latest?.output).toBeUndefined();
    expect(nodeState(state.runs.get('run-a'), 'tools').state).toBe('unobserved');
  });

  it('marks unfinished work unknown after lost transport or its completed parent; failures stay failures', () => {
    let state = reduceObserverEnvelope(createObserverState(), batch([event(1, { kind: 'run.started', spanId: 'root', node: 'turn' }), event(2, { parentSpanId: 'root' }), event(3, { spanId: 'failure', node: 'tools', kind: 'span.failed' })]));
    expect(nodeState(state.runs.get('run-a'), 'llm', 'lost').state).toBe('unknown');
    expect(nodeState(state.runs.get('run-a'), 'tools', 'lost').state).toBe('failed');
    state = reduceObserverEnvelope(state, batch([event(4, { kind: 'run.completed', spanId: 'root', node: 'turn' })]));
    expect(nodeState(state.runs.get('run-a'), 'llm').state).toBe('unknown');
  });

  it('keeps later speech roots and native playback active after the correlated voice response completes', () => {
    let state = reduceObserverEnvelope(createObserverState(), batch([
      event(1, { node: 'turn', kind: 'run.started', spanId: 'voice-root', origin: 'server' }),
      event(2, { node: 'turn', kind: 'run.completed', spanId: 'voice-root', origin: 'server' }),
      event(3, { node: 'turn', kind: 'run.started', spanId: 'speech-root', origin: 'server' }),
      event(4, { node: 'tts', spanId: 'speech', parentSpanId: 'speech-root', origin: 'server' }),
      event(5, { node: 'play', spanId: 'player', origin: 'client' }),
    ]));
    expect(state.runs.get('run-a')!.state).toBe('running'); expect(state.runs.get('run-a')!.endedAt).toBeNull();
    expect(nodeState(state.runs.get('run-a'), 'tts').state).toBe('running');
    expect(nodeState(state.runs.get('run-a'), 'play').state).toBe('running');
    state = reduceObserverEnvelope(state, batch([
      event(6, { node: 'tts', spanId: 'speech', parentSpanId: 'speech-root', kind: 'span.completed', origin: 'server' }),
      event(7, { node: 'turn', kind: 'run.completed', spanId: 'speech-root', origin: 'server' }),
    ]));
    expect(state.runs.get('run-a')!.state).toBe('running'); expect(nodeState(state.runs.get('run-a'), 'play').state).toBe('running');
    state = reduceObserverEnvelope(state, batch([event(8, { node: 'play', spanId: 'player', kind: 'span.completed', origin: 'client' })]));
    expect(state.runs.get('run-a')!.state).toBe('completed'); expect(nodeState(state.runs.get('run-a'), 'play').state).toBe('completed');
  });

  it('erases all private event state while held, even if an invalid producer includes events', () => {
    const initial = reduceObserverEnvelope(createObserverState(), batch([event(1, { input: { private: 'owner input' } })]));
    const held = reduceObserverEnvelope(initial, batch([event(2, { output: 'must not appear' })], { availability: 'held', cursor: 2 }));
    expect(held.events).toEqual([]); expect(held.runs.size).toBe(0); expect(held.selectedRunId).toBeNull();
    expect(JSON.stringify(held)).not.toContain('owner input'); expect(JSON.stringify(held)).not.toContain('must not appear');
    const resumed = reduceObserverEnvelope(held, batch([event(3, { runId: 'next' })]));
    expect(resumed.runs.has('run-a')).toBe(false); expect(resumed.notice).toBe('');
  });

  it.each(['restart', 'cursor-gap', 'publisher-loss'] as const)('resets stale active state after %s', reason => {
    const initial = reduceObserverEnvelope(createObserverState(), batch([event(10, { input: 'private old state' })]));
    const values: Partial<ObserverBatch> = reason === 'restart' ? { instanceId: 'instance-b' } : reason === 'cursor-gap' ? { gap: true } : { dropped: 1 };
    const next = reduceObserverEnvelope(initial, batch([event(reason === 'restart' ? 1 : 12, { runId: 'new-run' })], values));
    expect(next.runs.has('run-a')).toBe(false); expect(next.events).toHaveLength(1);
    expect(next.notice).not.toBe(''); expect(next.cursor).toBe(reason === 'restart' ? 1 : 12);
  });

  it('bounds browser event retention and reports partial history', () => {
    let state = createObserverState();
    for (let base = 0; base < MAX_EVENTS + 200; base += 200) {
      state = reduceObserverEnvelope(state, batch(Array.from({ length: 200 }, (_, index) => event(base + index + 1, { spanId: `s${base + index}`, kind: 'span.completed' }))));
    }
    expect(state.events).toHaveLength(MAX_EVENTS); expect(state.events[0]!.sequence).toBe(201);
    expect(state.runs.get('run-a')!.incomplete).toBe(true); expect(state.notice).toContain('表示上限');
  });

  it('derives tool evidence only from the selected run and named evidence fields', () => {
    const state = reduceObserverEnvelope(createObserverState(), batch([
      event(1, { node: 'jevt', input: { offeredTools: ['study.search', 'study.read'] } }),
      event(2, { node: 'jevt', kind: 'span.completed', output: { selectedTools: ['study.search'] } }),
      event(3, { node: 'tools', spanId: 'tool', input: { name: 'study.search' } }),
      event(4, { node: 'tools', runId: 'elsewhere', input: { name: 'folder.delete' } }),
    ]));
    const evidence = runToolEvidence(state.runs.get('run-a'));
    expect([...evidence.offered]).toEqual(['study.search', 'study.read']);
    expect([...evidence.chosen]).toEqual(['study.search']); expect([...evidence.called]).toEqual(['study.search']);
  });

  it('links exact retained STT source and parent spans while excluding unrelated capture-session PCM and transcripts', () => {
    const state = reduceObserverEnvelope(createObserverState(), batch([
      event(1, { runId: 'capture', node: 'pcm', spanId: 'pcm-chunk', kind: 'span.completed', origin: 'client' }),
      event(2, { runId: 'capture', node: 'stt', spanId: 'accepted-stt', kind: 'span.completed', origin: 'client', output: { characterCount: 5 } }),
      event(3, { runId: 'capture', node: 'stt', spanId: 'other-stt', kind: 'span.completed', origin: 'client' }),
      event(4, { runId: 'utterance', node: 'join', spanId: 'join', parentSpanId: 'accepted-stt', kind: 'span.completed', origin: 'client', input: { captureRunId: 'capture' } }),
      event(5, { runId: 'utterance', node: 'join', spanId: 'handoff', kind: 'handoff', origin: 'client', sourceSpanId: 'accepted-stt', fromNode: 'stt', toNode: 'join', output: { captureRunId: 'capture' } }),
    ]));
    const view = linkedRunView(state, 'utterance')!;
    expect(view.linkedCount).toBe(1); expect([...view.spans.keys()]).toEqual(['join', 'accepted-stt']);
    expect(nodeState(view, 'pcm').state).toBe('unobserved'); expect(nodeState(view, 'stt').state).toBe('completed');
    expect(nodeState(view, 'stt').latest).toMatchObject({ id: 'accepted-stt', runId: 'capture', origin: 'client', linked: true });
    expect(state.runs.get('utterance')!.spans.has('accepted-stt')).toBe(false);
    expect(view.events.every(item => item.runId === 'utterance')).toBe(true);
  });

  it('leaves ambiguous and missing source references unobserved without a matching explicit source run', () => {
    const sourceEvents = [
      event(1, { runId: 'capture-a', node: 'stt', spanId: 'same-id', kind: 'span.completed', origin: 'client' }),
      event(2, { runId: 'capture-b', node: 'stt', spanId: 'same-id', kind: 'span.completed', origin: 'client' }),
    ];
    const link = event(3, { runId: 'utterance', node: 'join', spanId: 'handoff', kind: 'handoff', origin: 'client', sourceSpanId: 'same-id', fromNode: 'stt', toNode: 'join' });
    const ambiguous = reduceObserverEnvelope(createObserverState(), batch([...sourceEvents, link]));
    expect(linkedRunView(ambiguous, 'utterance')!.linkedCount).toBe(0);
    const explicit = reduceObserverEnvelope(createObserverState(), batch([...sourceEvents, { ...link, output: { captureRunId: 'capture-b' } }]));
    expect(nodeState(linkedRunView(explicit, 'utterance'), 'stt').latest?.runId).toBe('capture-b');
    const wrong = reduceObserverEnvelope(createObserverState(), batch([...sourceEvents, { ...link, output: { captureRunId: 'missing' } }]));
    expect(linkedRunView(wrong, 'utterance')!.linkedCount).toBe(0);
  });

  it('rejects unsupported or malformed envelopes', () => {
    expect(validEnvelope(batch())).toBe(true);
    expect(validEnvelope({ ...batch(), schemaVersion: 2 })).toBe(false);
    expect(validEnvelope(batch([event(1, { at: 'not-a-time' })]))).toBe(false);
    expect(validEnvelope(batch([], { cursor: -1 }))).toBe(false);
  });
});

describe('observer connection lifecycle', () => {
  it('pairs through the existing contract, uses a memory bearer header, and preserves reverse-proxy prefixes', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (url: string, _init: ObserverRequest) => response(url.endsWith('/pair') ? { token: 'paired-test-token' } : url.endsWith('/catalog') ? catalog : batch()));
    const client = createObserverClient({ fetch, basePath: observerBasePath('/companion/observer'), onEnvelope: vi.fn() });
    await client.pair('ABCD-EFGH-IJKL'); await flush();
    expect(fetch.mock.calls[0]![0]).toBe('/companion/v1/pair');
    expect(JSON.parse(fetch.mock.calls[0]![1].body!)).toEqual({ code: 'ABCD-EFGH-IJKL', deviceName: 'Shannon Observer' });
    expect(fetch.mock.calls[1]![1].headers).toEqual({ Authorization: 'Bearer paired-test-token' });
    expect(fetch.mock.calls.every(([url, init]) => !url.includes('token') && init.credentials === 'omit' && init.cache === 'no-store' && init.redirect === 'error')).toBe(true);
    expect(observerBasePath('/observer/')).toBe(''); expect(() => observerBasePath('/unrelated')).toThrow();
    client.disconnect(); expect(vi.getTimerCount()).toBe(0);
  });

  it('discards late response bodies after disconnect even when fetch ignores abort', async () => {
    vi.useFakeTimers();
    let complete!: (value: ReturnType<typeof response>) => void;
    const deferred = new Promise<ReturnType<typeof response>>(resolve => { complete = resolve; });
    const fetch = vi.fn(async (url: string, _init: ObserverRequest) => url.endsWith('/catalog') ? response(catalog) : deferred);
    const onEnvelope = vi.fn(), onReset = vi.fn();
    const client = createObserverClient({ fetch, onEnvelope, onReset });
    client.connect('session-one'); await flush();
    const signal = fetch.mock.calls[1]![1].signal;
    client.disconnect(); expect(signal.aborted).toBe(true);
    complete(response(batch([event(1, { input: 'private delayed body' })]))); await flush();
    expect(onEnvelope).not.toHaveBeenCalled(); expect(onReset).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('fences responses from an old authenticated session after changing credentials', async () => {
    vi.useFakeTimers();
    let complete!: (value: ReturnType<typeof response>) => void;
    const deferred = new Promise<ReturnType<typeof response>>(resolve => { complete = resolve; });
    const fetch = vi.fn(async (url: string, init: ObserverRequest) => {
      if (url.endsWith('/catalog')) return response(catalog);
      return init.headers?.Authorization === 'Bearer old-session' ? deferred : response(batch([event(2, { runId: 'new-session-run' })]));
    });
    const onEnvelope = vi.fn(); const client = createObserverClient({ fetch, onEnvelope });
    client.connect('old-session'); await flush(); client.connect('new-session'); await flush();
    complete(response(batch([event(1, { runId: 'private-old-run' })]))); await flush();
    expect(onEnvelope).toHaveBeenCalledTimes(1); expect(onEnvelope.mock.calls[0]![0].events[0].runId).toBe('new-session-run');
    client.disconnect();
  });

  it('clears held state immediately from the catalog endpoint without requesting events', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => response(batch([], { availability: 'held' })));
    const onEnvelope = vi.fn(), onCatalog = vi.fn(), onConnection = vi.fn();
    const client = createObserverClient({ fetch, onEnvelope, onCatalog, onConnection }); client.connect('test'); await flush();
    expect(fetch).toHaveBeenCalledTimes(1); expect(onEnvelope.mock.calls[0]![0].availability).toBe('held');
    expect(onCatalog).toHaveBeenLastCalledWith(null); expect(onConnection).toHaveBeenLastCalledWith('held');
    client.disconnect();
  });

  it('aborts observing while hidden, resumes one poll chain and retries with bounded backoff', async () => {
    vi.useFakeTimers();
    let fail = false;
    const fetch = vi.fn(async (url: string, _init: ObserverRequest) => { if (fail) throw new Error('network'); return response(url.endsWith('/catalog') ? catalog : batch()); });
    const onConnection = vi.fn(); const client = createObserverClient({ fetch, onEnvelope: vi.fn(), onConnection });
    client.connect('test'); await flush(); expect(fetch).toHaveBeenCalledTimes(2);
    client.pause(); client.pause(); await vi.advanceTimersByTimeAsync(10_000); expect(fetch).toHaveBeenCalledTimes(2);
    client.resume(); client.resume(); await flush(); expect(fetch).toHaveBeenCalledTimes(4);
    fail = true; await vi.advanceTimersByTimeAsync(400); expect(onConnection).toHaveBeenLastCalledWith('lost');
    const failedCalls = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(799); expect(fetch).toHaveBeenCalledTimes(failedCalls);
    await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(failedCalls + 1);
    client.disconnect(); expect(vi.getTimerCount()).toBe(0);
  });

  it('clears authentication on refusal and does not retry a rejected session', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => response({ error: 'OBSERVER_OWNER_ONLY' }, 403));
    const onConnection = vi.fn(), onReset = vi.fn();
    const client = createObserverClient({ fetch, onEnvelope: vi.fn(), onConnection, onReset }); client.connect('test'); await flush();
    expect(onConnection).toHaveBeenLastCalledWith('disconnected'); expect(onReset.mock.calls.at(-1)![0]).toContain('認証');
    await vi.advanceTimersByTimeAsync(30_000); expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});


describe('receipt history and recovery', () => {
  it('drains more than one page of old events without presenting them as live, then admits new receipts', () => {
    const gate = createReceiptGate();
    expect(gate.accept(batch(Array.from({length: 200}, (_, i) => event(i + 1))))).toBe(false);
    expect(gate.accept(batch([event(201)]))).toBe(false);
    expect(gate.accept(batch([event(202, {kind: 'handoff', fromNode: 'llm', toNode: 'tools'})]))).toBe(true);
  });
  it('resets catch-up after disconnect, gaps, lost events and a different server instance', () => {
    const gate = createReceiptGate(); gate.accept(batch());
    expect(gate.accept(batch([event(1)]))).toBe(true);
    gate.reset(); expect(gate.accept(batch(Array.from({length: 200}, (_, i) => event(i + 2))))).toBe(false);
    expect(gate.accept(batch([event(202)]))).toBe(false);
    expect(gate.accept(batch([event(203)]))).toBe(true);
    expect(gate.accept(batch([event(204)], {gap: true}))).toBe(false);
    expect(gate.accept(batch([event(205)], {dropped: 1}))).toBe(false);
    expect(gate.accept(batch([event(206)], {dropped: 1}))).toBe(true);
    expect(gate.accept(batch([event(207)], {instanceId: 'new-server', dropped: 1}))).toBe(false);
  });
});

describe('owner-requested tab connection retention', () => {
  function storage() {
    const values = new Map<string, string>();
    return {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}, removeItem: (key: string) => {values.delete(key);}};
  }
  it('restores the same tab credential across a new viewer instance and clears it on explicit disconnect', async () => {
    vi.useFakeTimers(); const tab = storage(), key = 'observer-tab';
    const first = createObserverSession(() => tab, key);
    const fetch = vi.fn(async (url: string, _init: ObserverRequest) => response(url.endsWith('/pair') ? {token:'controlled-fixture-token',expiresAt:'2099-01-01T00:00:00Z'} : url.endsWith('/catalog') ? catalog : batch()));
    const client = createObserverClient({fetch, onEnvelope: vi.fn(), onCredential: first.write});
    await client.pair('CONTROLLED-FIXTURE-CODE'); await flush();
    // Page hiding/reload aborts polling but keeps this tab's connection.
    client.pause(); expect(first.read()?.token).toBe('controlled-fixture-token');
    expect(tab.getItem(key)).not.toContain('CONTROLLED-FIXTURE-CODE');
    const reloaded = createObserverSession(() => tab, key);
    const second = createObserverClient({fetch, onEnvelope: vi.fn(), onCredential: reloaded.write});
    const saved = reloaded.read()!; second.connect(saved.token, saved.expiresAt); await flush();
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/pair'))).toHaveLength(1);
    expect(fetch.mock.calls.at(-1)![1].headers).toEqual({Authorization:'Bearer controlled-fixture-token'});
    second.disconnect(); expect(reloaded.read()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it('removes refused credentials instead of restoring a revoked connection forever', async () => {
    vi.useFakeTimers(); const tab=storage(), session=createObserverSession(()=>tab,'observer-tab');
    session.write({token:'revoked-fixture-token',expiresAt:null});
    const fetch=vi.fn(async()=>response({error:'AUTH_REFUSED'},401));
    const client=createObserverClient({fetch,onEnvelope:vi.fn(),onCredential:session.write});
    client.connect(session.read()!.token); await flush();
    expect(session.read()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it('drops expired/malformed credentials and tolerates unavailable browser storage', () => {
    const tab=storage(), session=createObserverSession(()=>tab,'observer-tab',()=>Date.parse(at));
    session.write({token:'expired-fixture-token',expiresAt:'2000-01-01T00:00:00Z'}); expect(session.read()).toBeNull();
    tab.setItem('observer-tab','malformed'); expect(session.read()).toBeNull();
    const unavailable=createObserverSession(()=>{throw new Error('storage blocked');},'observer-tab');
    expect(unavailable.write({token:'fixture-token',expiresAt:null})).toBe(false); expect(unavailable.read()).toBeNull();
  });
});


describe('desktop observer uses the existing main-process connection', () => {
  it('polls only the narrow read bridge without fetching or retaining credentials', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (value: {kind: string}) => ({ok:true,status:200,body:value.kind === 'catalog' ? catalog : batch()}));
    const fetch = vi.fn(), onCredential = vi.fn(), onConnection = vi.fn();
    const client = createObserverClient({fetch, desktopBridge:{request}, onCredential, onEnvelope:vi.fn(), onConnection});
    client.connectExisting(); await flush();
    expect(request.mock.calls.map(([value]) => value)).toEqual([{kind:'catalog'},{kind:'events',after:0,limit:200}]);
    expect(fetch).not.toHaveBeenCalled(); expect(onCredential).not.toHaveBeenCalled();
    expect(onConnection).toHaveBeenLastCalledWith('live');
    expect(() => client.connect('unavailable-token')).toThrow('READ_ONLY');
    await expect(client.pair('unavailable-code')).rejects.toThrow('READ_ONLY');
    client.pause(); await vi.advanceTimersByTimeAsync(5000); expect(request).toHaveBeenCalledTimes(2);
    client.resume(); await flush(); expect(request).toHaveBeenCalledTimes(4);
    client.disconnect(); expect(vi.getTimerCount()).toBe(0);
  });
  it('drops old IPC responses when an app connection is replaced', async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: {ok:boolean,status:number,body:unknown}) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => {resolveOld=resolve;}))
      .mockImplementation(async (value: {kind:string}) => ({ok:true,status:200,body:value.kind === 'catalog' ? catalog : batch()}));
    const onCatalog=vi.fn(), onEnvelope=vi.fn();
    const client=createObserverClient({fetch:vi.fn(),desktopBridge:{request},onCatalog,onEnvelope});
    client.connectExisting(); client.connectExisting(); await flush();
    expect(onEnvelope).toHaveBeenCalledTimes(1);
    resolveOld({ok:true,status:200,body:{...catalog,tools:[{name:'old',domain:'old'}]}}); await flush();
    expect(onEnvelope).toHaveBeenCalledTimes(1); expect(onCatalog).toHaveBeenLastCalledWith(catalog);
    client.disconnect();
  });
  it('clears denied observation without deleting the shared app credential and can recover', async () => {
    vi.useFakeTimers(); let refused=true;
    const request=vi.fn(async (value:{kind:string}) => refused ? {ok:false,status:403} : {ok:true,status:200,body:value.kind === 'catalog' ? catalog : batch()});
    const onReset=vi.fn(), onConnection=vi.fn(), onCredential=vi.fn();
    const client=createObserverClient({fetch:vi.fn(),desktopBridge:{request},onReset,onConnection,onCredential,onEnvelope:vi.fn()});
    client.connectExisting(); await flush();
    expect(onConnection).toHaveBeenLastCalledWith('lost'); expect(onReset.mock.calls.at(-1)![0]).toContain('所有者');
    expect(onCredential).not.toHaveBeenCalled(); refused=false;
    await vi.advanceTimersByTimeAsync(800); expect(onConnection).toHaveBeenLastCalledWith('live');
    client.disconnect();
  });
});

describe('recent calls of a box (owner, 2026-10-14)', () => {
  const call = (sequence: number, run: string, values: Partial<ObserverEvent> = {}) => [
    event(sequence, { runId: run, spanId: `s${sequence}`, kind: 'span.started', input: { round: sequence }, ...values }),
    event(sequence + 1, { runId: run, spanId: `s${sequence}`, kind: 'span.completed', elapsedMs: sequence, output: { stop: 'end_turn' }, ...values }),
  ];
  it('keeps the newest calls of each box across runs, newest first, with the projected input and output', () => {
    const history = createNodeHistory(3);
    const events = [1, 3, 5, 7].flatMap(n => call(n, `run-${n}`, { model: 'claude-haiku-5-5' }));
    events.push(...call(20, 'run-j', { input: { provider: 'jev' } }));
    const state = reduceObserverEnvelope(createObserverState(), batch(events));
    history.observe(state);
    const calls = history.list('haiku', state);
    expect(calls.map(item => item.span.id)).toEqual(['s7', 's5', 's3']);
    expect(calls[0]).toMatchObject({ state: 'completed', inWindow: true });
    expect(calls[0].span.input).toEqual({ round: 7 }); expect(calls[0].span.output).toEqual({ stop: 'end_turn' });
    expect(history.list('jevModel', state).map(item => item.span.id)).toEqual(['s20']);
    expect(history.list('gate', state)).toEqual([]);
  });
  it('keeps a quiet box after the page window drops it, shows an unfinished one as unknown, and clears', () => {
    const history = createNodeHistory(4);
    let state = reduceObserverEnvelope(createObserverState(), batch([...call(1, 'run-a', { node: 'gate' }), event(3, { runId: 'run-b', spanId: 'open', node: 'tools' })]));
    history.observe(state);
    const flood = Array.from({ length: MAX_EVENTS }, (_, index) => event(10 + index, { runId: 'run-c', spanId: `f${index}`, node: 'store', kind: 'span.completed', elapsedMs: 1 }));
    for (let index = 0; index < flood.length; index += 200) { state = reduceObserverEnvelope(state, batch(flood.slice(index, index + 200))); history.observe(state); }
    expect(state.runs.has('run-a')).toBe(false);
    expect(history.list('gate', state).map(item => [item.span.id, item.state, item.inWindow])).toEqual([['s1', 'completed', false]]);
    expect(history.list('tools', state)[0].state).toBe('unknown');
    expect(history.list('store', state)).toHaveLength(4);
    history.clear();
    expect(history.list('gate', state)).toEqual([]);
  });
});

describe('owner picks of 2026-10-14: flow, critical path, marks and run marks', () => {
  const turn = () => reduceObserverEnvelope(createObserverState(), batch([
    event(1, { runId: 'r', spanId: 'root', node: 'turn', kind: 'run.started', input: { surface: 'text' } }),
    event(2, { runId: 'r', spanId: 'jev', parentSpanId: 'root', node: 'jevt', kind: 'span.completed', input: { surface: 'text', offeredTools: ['a', 'b', 'c'], difficulty: 'normal' }, output: { difficulty: 'normal', toolMenu: 3 }, elapsedMs: 5 }),
    event(3, { runId: 'r', spanId: 'rec', parentSpanId: 'root', node: 'recall', kind: 'span.completed', input: { semantic: true }, output: { recalledCount: 4 }, elapsedMs: 5 }),
    event(4, { runId: 'r', spanId: 'h1', parentSpanId: 'root', node: 'llm', kind: 'span.completed', input: { model: 'claude-haiku-5-5' }, output: { stop: 'tool_use', usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 6000, cacheCreationTokens: 0 } }, elapsedMs: 5 }),
    event(5, { runId: 'r', spanId: 't1', parentSpanId: 'root', node: 'tools', kind: 'span.completed', input: { name: 'memory.search' }, elapsedMs: 5 }),
    event(6, { runId: 'r', spanId: 't2', parentSpanId: 'root', node: 'tools', kind: 'span.failed', input: { name: 'web.search' }, output: { errorKind: 'TypeError' }, elapsedMs: 5 }),
    event(7, { runId: 'r', spanId: 'h2', parentSpanId: 'root', node: 'llm', kind: 'span.completed', input: { model: 'claude-haiku-5-5' }, output: { stop: 'end_turn', cacheReadInputTokens: 6400 }, elapsedMs: 5 }),
    event(8, { runId: 'r', spanId: 'dec', parentSpanId: 'root', node: 'decode', kind: 'span.completed', output: { replyChars: 42 }, elapsedMs: 1 }),
    event(9, { runId: 'r', spanId: 'root', node: 'turn', kind: 'run.completed', elapsedMs: 1900 }),
    event(10, { runId: 'bg', spanId: 'fca', node: 'fca', kind: 'span.started' }),
  ]));
  it('reads the turn as one line of observed stages, each pointing at its box', () => {
    const state = turn(), flow = turnFlow(state.runs.get('r'));
    expect(flow.map(stage => stage.text)).toEqual(['受付 text', 'Jev normal・道具3', '想起 4', 'Haiku ×2', 'memory.search ✓', 'web.search ✗', '返事 42字 · 1.9 s']);
    expect(flow.map(stage => stage.view)).toEqual(['admit', 'router', 'recall', 'haiku', 'tools', 'tools', 'decode']);
    expect(flow[5].failed).toBe(true);
    expect(turnFlow(undefined)).toEqual([]);
  });
  it('sums reported tokens and cache only, and lists executed tools with failures', () => {
    const state = turn(), run = state.runs.get('r')!;
    expect(runUsage(run)).toEqual({ inputTokens: 900, outputTokens: 40, cacheReadTokens: 12400, cacheWriteTokens: 0 });
    expect(runUsage(state.runs.get('bg')!)).toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
    expect(runToolCalls(run).map(call => [call.name, call.failed])).toEqual([['memory.search', false], ['web.search', true]]);
  });
  it('marks each block with failed, running and unknown spans across every run held, not only the selected one', () => {
    const state = turn(), alerts = blockAlerts(state);
    expect(alerts.get('fca')!.failed.map(item => item.key)).toEqual(['r/t2']);
    expect(alerts.get('fca')!.running.map(item => item.key)).toEqual(['bg/fca']);
    expect(alerts.has('conv')).toBe(false);
    const lost = { ...state, transport: 'lost' as const };
    expect(blockAlerts(lost).get('fca')!.unknown.map(item => item.key)).toEqual(['bg/fca']);
  });
});
